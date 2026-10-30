// Fake /proc view and fake process spawner for the sandbox launcher and supervisor tests. Nothing here starts a process.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { PassThrough } from 'node:stream';

import { slotLayout } from '../../../server/sandbox/sandboxLauncher.mjs';

export const SUPERVISOR_PID = 4000;
// Namespace inodes of a fake sandbox started with ChildProcess.pid `pid`.
export const pidNsOf = (pid) => String(100000 + pid);
export const mntNsOf = (pid) => String(200000 + pid);

export function createFakeView() {
    const procs = new Map();
    const registered = [];
    const self = { pidNs: '1000', mntNs: '2000', netNs: '3000' };
    const view = {
        procs, registered, self,
        process: (pid) => procs.get(pid) ?? null,
        listProcesses: () => [...procs.values()].map((entry) => ({ ...entry })),
        selfNamespaces: () => ({ ...self }),
        registerSandboxChild: (entry) => { registered.push(entry); return () => { registered.splice(registered.indexOf(entry), 1); }; },
        add(entry) { procs.set(entry.pid, { ppid: 1, startTime: String(entry.pid * 10), cmdline: ['x'], pidNs: '1000', mntNs: '2000', netNs: '3000', fdNs: [], ...entry }); },
        drop: (pid) => procs.delete(pid)
    };
    return view;
}

// Fake child_process.spawn. `script` shapes what the "chain" does; the default is a healthy sandbox.
//   exitBefore  exit code of the chain before bwrap reports (a prep failure)
//   initPidNs, initMntNs, initNetNs, monitorMntNs, monitorPpid, omitMarker   knobs for identity mismatch
//   spawnError  an Error emitted on 'error'
export function createFakeSpawn(view, script = {}) {
    const spawned = [];
    let nextPid = 5000;
    function spawnImpl(file, args, options) {
        const record = { file, args, options, kills: [], fdContents: {}, children: null };
        spawned.push(record);
        const child = new EventEmitter();
        child.pid = nextPid;
        nextPid += 10;
        record.child = child;
        const stdio = options.stdio;
        // slot layout from the chain: ... prep <marker> <supervisor> <grants> <argsFd> <json>
        const prepAt = args.indexOf('prep');
        const marker = args[prepAt + 1];
        const argsFd = Number(args[prepAt + 4]);
        record.layout = { block: argsFd - 3, info: argsFd - 2, status: argsFd - 1, args: argsFd, seccomp: argsFd - 4 };
        record.marker = marker;
        for (const [name, slot] of Object.entries({ seccomp: record.layout.seccomp, args: record.layout.args })) {
            const fd = stdio[slot];
            const size = fs.fstatSync(fd).size;
            const buffer = Buffer.alloc(size);
            fs.readSync(fd, buffer, 0, size, 0);
            record.fdContents[name] = buffer;
        }
        child.stdio = stdio.map((entry) => (entry === 'pipe' ? new PassThrough() : null));
        record.block = child.stdio[record.layout.block];
        record.info = child.stdio[record.layout.info];
        record.status = child.stdio[record.layout.status];
        let exited = false;
        const finish = (code, signal) => {
            if (exited) return;
            exited = true;
            view.drop(child.pid);
            view.drop(child.pid + 1);
            setImmediate(() => child.emit('exit', code, signal));
        };
        record.finish = finish;
        child.kill = (signal = 'SIGTERM') => { record.kills.push(signal); if (signal === 'SIGKILL') finish(null, 'SIGKILL'); return true; };
        setImmediate(() => {
            if (script.spawnError) { child.emit('error', script.spawnError); return; }
            if (script.exitBefore !== undefined) { finish(script.exitBefore, null); return; }
            view.add({
                pid: child.pid, ppid: script.monitorPpid ?? SUPERVISOR_PID, cmdline: script.omitMarker ? ['/usr/bin/bwrap'] : ['/usr/bin/bwrap', '--unshare-uts', '--hostname', marker, '--args', String(argsFd)],
                pidNs: view.self.pidNs, mntNs: script.monitorMntNs ?? mntNsOf(child.pid), netNs: script.monitorNetNs ?? '3000'
            });
            view.add({
                pid: child.pid + 1, ppid: child.pid, cmdline: ['/bin/sh', 'stage.sh', 'final'], pidNs: script.initPidNs ?? pidNsOf(child.pid),
                mntNs: script.initMntNs ?? mntNsOf(child.pid + 1), netNs: script.initNetNs ?? '3001'
            });
            record.info.write(`{\n    "child-pid": ${child.pid + 1}\n}\n`);
            if (script.beforeGate) script.beforeGate(record);
        });
        return child;
    }
    return { spawnImpl, spawned };
}

export const fakeClock = () => {
    let now = 0;
    return { now: () => now, sleep: async (ms) => { now += ms; await new Promise((resolve) => setImmediate(resolve)); } };
};

export { slotLayout };
