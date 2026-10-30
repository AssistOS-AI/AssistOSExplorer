// MODEL of a container's kernel state, for the ledger and recovery MODEL CHECKS. It is never A40 or G1 evidence: it
// has no processes, namespaces, mounts or signals, only a table that enforces the rules section 5.5 relies on.
//
//   - processes with a PID namespace, network and mount namespace, parent, argv and an optional gate;
//   - namespaces that exist while a process is a member, a process holds a descriptor, or an nsfs mount binds them;
//   - parent-death SIGKILL, PID-namespace init death killing the whole namespace, mounts and veth pairs vanishing
//     with their namespace, and nftables tables, cgroups, runtime directories and GUI containers outliving every
//     process (the objects section 5.5 says can outlive the supervisor and the sandbox supervisor);
//   - a fake /proc (listProcesses) and fake mountinfo (listMounts), which are the only things the walker reads;
//   - gate pipes whose decision is made by awaitGate of localGate.mjs, read through an injected readSync.

import { awaitGate, GATE_COMMIT } from './localGate.mjs';

export function createModelClock(start = 1_000_000) {
    let time = start;
    const scheduled = [];
    const fire = () => {
        for (;;) {
            const due = scheduled.filter((entry) => entry.at <= time).sort((a, b) => a.at - b.at)[0];
            if (!due) return;
            scheduled.splice(scheduled.indexOf(due), 1);
            due.run();
        }
    };
    return {
        now: () => time,
        // Virtual time: sleeping advances the clock and runs what was scheduled to happen by then.
        sleep: async (ms) => { time += ms; fire(); },
        schedule: (afterMs, run) => { scheduled.push({ at: time + afterMs, run }); }
    };
}

export const SUPERVISOR_PID = 1;

export function createModelWorld({ clock }) {
    let nextPid = 100;
    let nextInode = 4_026_531_000;
    let nextMount = 40;
    let nextHandle = 1;
    const processes = new Map();
    const namespaces = new Map();
    const mounts = [];
    const objects = { 'runtime-dir': new Set(), cgroup: new Set(), 'nft-table': new Map(), veth: new Map(), pty: new Set(), 'gui-container': new Set() };
    const gateWrites = new Set();
    const executions = [];
    const listeners = { execute: [], supervisorLost: [] };
    let supervisorAlive = true;

    // ---- namespaces ---------------------------------------------------------------------------------------------
    const newNamespace = (type) => { const inode = nextInode++; namespaces.set(inode, { type }); return inode; };
    const held = (inode) => [...processes.values()].some((entry) => entry.state !== 'dead'
        && (entry.pidNs === inode || entry.netNs === inode || entry.mntNs === inode || entry.fdNs.has(inode)));

    // Removes what vanishes with a namespace that has no holder left.
    function reap() {
        for (const [inode, namespace] of [...namespaces]) {
            if (held(inode)) continue;
            namespaces.delete(inode);
            if (namespace.type === 'net') for (const [name, veth] of [...objects.veth]) if (veth.netNs === inode) objects.veth.delete(name);
            if (namespace.type === 'mnt') for (let index = mounts.length - 1; index >= 0; index -= 1) if (mounts[index].mntNs === inode) mounts.splice(index, 1);
        }
    }

    // ---- processes ----------------------------------------------------------------------------------------------
    function die(pid) {
        const entry = processes.get(pid);
        if (!entry || entry.state === 'dead') return;
        entry.state = 'dead';
        for (const other of [...processes.values()]) {
            if (other.state === 'dead') continue;
            // The init of a PID namespace takes the namespace with it; parent death kills a child that asked for it.
            // A process stuck in an uninterruptible wait ignores SIGKILL, whatever sent it.
            if (other.unkillable) continue;
            if ((entry.pidNsInit && other.pidNs === entry.pidNs) || (other.ppid === pid && other.pdeathsig)) die(other.pid);
        }
        reap();
    }

    function evaluateGate(entry) {
        if (entry.state !== 'gated' || !entry.gate) return;
        const gate = entry.gate;
        if (gate.queue.length === 0 && !gate.closed) return; // undecided: the process stays blocked at its gate
        const decision = awaitGate(0, {
            readSync: (_fd, buffer) => {
                if (gate.queue.length === 0) return 0;
                buffer[0] = gate.queue.shift();
                return 1;
            }
        });
        if (decision === GATE_COMMIT) {
            entry.state = 'running';
            entry.executed = true;
            entry.cmdline = entry.cmdline.filter((part) => part !== entry.marker && !part.startsWith('--reservation'));
            for (const listener of listeners.execute) listener(entry);
        } else die(entry.pid); // end-of-file or any other byte: the helper aborts before its final exec
    }

    function spawn({ ppid = SUPERVISOR_PID, cmdline, newPidNs = false, netNs = null, mntNs = null, gate = null, role, marker = null, pdeathsig = true }) {
        const pid = nextPid++;
        const parent = processes.get(ppid);
        const pidNs = newPidNs ? newNamespace('pid') : (parent?.pidNs ?? null);
        const entry = {
            pid, ppid, startTime: clock.now() * 1000 + pid, cmdline: [...cmdline], pidNs, pidNsInit: newPidNs, netNs, mntNs,
            fdNs: new Set(), state: gate ? 'gated' : 'running', executed: gate === null, gate, role, marker, pdeathsig,
            unkillable: false, killDelayMs: 0
        };
        processes.set(pid, entry);
        executions.push(entry);
        return entry;
    }

    function kill(pid) {
        const entry = processes.get(pid);
        if (!entry || entry.state === 'dead' || entry.unkillable) return false;
        if (entry.dying) return true; // a kill is already on its way; repeating it changes nothing
        if (entry.killDelayMs > 0) { entry.dying = true; clock.schedule(entry.killDelayMs, () => die(pid)); return true; }
        die(pid);
        return true;
    }

    // ---- gate pipes (the supervisor holds the write end) ----------------------------------------------------------
    function createGatePipe() {
        const gate = { id: nextHandle++, queue: [], closed: false, closeListeners: [], consumer: null };
        const writeEnd = {
            write(buffer, callback) {
                if (gate.closed) { callback(new Error('EPIPE')); return false; }
                for (const byte of buffer) gate.queue.push(byte);
                callback(null);
                if (gate.consumer) evaluateGate(gate.consumer);
                return true;
            },
            end(callback) { closeWrite(); callback?.(); },
            once(event, listener) { if (event === 'close') gate.closeListeners.push(listener); }
        };
        const closeWrite = () => {
            if (gate.closed) return;
            gate.closed = true;
            if (gate.consumer) evaluateGate(gate.consumer);
            for (const listener of gate.closeListeners.splice(0)) listener();
        };
        gate.close = closeWrite;
        gateWrites.add(gate);
        return { gate, writeEnd };
    }
    const attachGate = (entry) => { if (entry.gate) { entry.gate.consumer = entry; evaluateGate(entry); } };

    // ---- objects ------------------------------------------------------------------------------------------------
    const view = {
        listProcesses: () => [...processes.values()].filter((entry) => entry.state !== 'dead').map((entry) => ({
            pid: entry.pid, ppid: entry.ppid, startTime: entry.startTime, cmdline: [...entry.cmdline], pidNs: entry.pidNs,
            netNs: entry.netNs, mntNs: entry.mntNs, fdNs: [...entry.fdNs]
        })),
        listMounts: () => mounts.map((mount) => ({ ...mount })),
        exists: (kind, locator) => {
            switch (kind) {
                case 'runtime-dir': case 'cgroup': return objects[kind].has(locator.path);
                case 'nft-table': return objects[kind].has(locator.table);
                case 'veth': return objects.veth.has(locator.host);
                case 'pty': return objects.pty.has(locator.pty);
                case 'gui-container': return objects['gui-container'].has(locator.name);
                default: return false;
            }
        },
        kill: ({ pid, startTime }) => {
            const entry = processes.get(pid);
            return entry !== undefined && entry.startTime === startTime && kill(pid);
        },
        remove: (kind, locator) => {
            switch (kind) {
                case 'runtime-dir': case 'cgroup': return objects[kind].delete(locator.path);
                case 'nft-table': return objects[kind].delete(locator.table);
                case 'veth': return objects.veth.delete(locator.host);
                case 'pty': return objects.pty.delete(locator.pty);
                case 'gui-container': return objects['gui-container'].delete(locator.name);
                default: return false;
            }
        },
        unmount: ({ mountId, mountpoint }) => {
            const index = mounts.findIndex((mount) => mount.mountId === mountId && mount.mountpoint === mountpoint);
            if (index < 0) return false;
            mounts.splice(index, 1);
            reap();
            return true;
        }
    };

    return {
        view,
        clock,
        newNamespace,
        spawn,
        attachGate,
        createGatePipe,
        kill,
        die: (pid) => { die(pid); },
        process: (pid) => processes.get(pid),
        alive: () => [...processes.values()].filter((entry) => entry.state !== 'dead' && entry.pid !== SUPERVISOR_PID),
        everSpawned: () => [...executions],
        holdNamespace(pid, inode) { processes.get(pid).fdNs.add(inode); },
        dropNamespace(pid, inode) { processes.get(pid)?.fdNs.delete(inode); reap(); },
        addMount({ mountpoint, mntNs, fstype = 'tmpfs', nsInode = null }) {
            const mount = { mountId: nextMount++, mountpoint, mntNs, fstype, nsInode };
            mounts.push(mount);
            return mount;
        },
        // nsfs bind mount that keeps a namespace alive without any process (a bind of /proc/<pid>/ns/net).
        bindNamespace(inode) { return this.addMount({ mountpoint: `/run/netns/bind-${inode}`, mntNs: null, fstype: 'nsfs', nsInode: inode }); },
        createObject(kind, name, value = {}) {
            if (kind === 'nft-table' || kind === 'veth') objects[kind].set(name, value); else objects[kind].add(name);
        },
        objects,
        namespaceExists: (inode) => namespaces.has(inode),
        namespaces: () => [...namespaces.keys()],
        mounts: () => mounts.map((mount) => ({ ...mount })),
        onExecute: (listener) => listeners.execute.push(listener),
        onSupervisorLost: (listener) => listeners.supervisorLost.push(listener),
        // The supervisor dies: every gate it held reaches end-of-file, and the sandbox supervisor (if alive) reacts to the closed channel.
        // leakGates models a defect (a gate descriptor inherited by another process), so that end-of-file never arrives
        // and recovery has to find the gated helper by its marker.
        crashSupervisor({ leakGates = false } = {}) {
            supervisorAlive = false;
            if (!leakGates) for (const gate of gateWrites) gate.close();
            for (const listener of listeners.supervisorLost) listener();
        },
        get supervisorAlive() { return supervisorAlive; },
        residue() {
            return {
                processes: this.alive().map((entry) => entry.cmdline.join(' ')),
                namespaces: [...namespaces.keys()],
                mounts: mounts.map((mount) => mount.mountpoint),
                runtimeDirs: [...objects['runtime-dir']], cgroups: [...objects.cgroup], nftTables: [...objects['nft-table'].keys()],
                veths: [...objects.veth.keys()], ptys: [...objects.pty], guiContainers: [...objects['gui-container']]
            };
        }
    };
}
