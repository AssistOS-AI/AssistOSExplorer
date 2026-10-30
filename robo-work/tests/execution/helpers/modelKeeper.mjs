// MODEL of the Node sandbox supervisor (bwrap) behind the ledger's sandbox interface, acting on the model world. It extends the
// existing fake sandbox supervisor (provider start/stop streams) with the resource-creation and end-path methods of section 5.5.
// Never A40 or G1 evidence.
//
// Rules it enforces, so that a ledger that gets them wrong fails:
//   - it creates nothing until its own gate has been committed (R3-1);
//   - it creates every process GATED, with the reservation ID in argv;
//   - at step 4 it closes its network-namespace descriptor, and at step 5 its mount-namespace descriptor, after the
//     endpoint has ended (R3-5), so that those steps can be verified;
//   - on end-of-file from a lost supervisor it kills and tears down everything it owns, then exits.
// Fault options (all off by default) make a sandbox supervisor that does its part wrongly:
//   forgetNetnsFd, forgetMntnsFd, ignoresEof, stuckTrees (the process trees ignore SIGKILL), slowTrees (ms until a
//   killed tree is gone), neverExits.

import { createGate } from './localGate.mjs';
import { createFakeKeeper } from './fakeKeeper.mjs';

export class KeeperRefusal extends Error {
    constructor(code) { super(code); this.name = 'KeeperRefusal'; this.code = code; }
}

export function createModelKeeper(world, options = {}) {
    const base = createFakeKeeper();
    let keeper = null;
    const created = { trees: [], endpoint: null, netns: [], mntns: [], veths: [], tables: [], mounts: [], ptys: [], dirs: [], cgroups: [] };
    const byReservation = new Map();

    function gatedProcess({ kind, resourceId, marker, ppid, newPidNs, netNs = null, mntNs = null, role }) {
        const { gate, writeEnd } = world.createGatePipe();
        const entry = world.spawn({
            ppid, cmdline: ['/usr/bin/bwrap', '--hostname', marker, '--args', '3'], newPidNs, netNs, mntNs, gate, role, marker
        });
        world.attachGate(entry);
        const identity = kind === 'keeper' ? { pid: entry.pid, startTime: entry.startTime }
            : { pid: entry.pid, startTime: entry.startTime, pidNs: entry.pidNs };
        return { entry, identity, gate: createGate(writeEnd) };
    }

    const api = {
        ...base,
        model: created,
        get pid() { return keeper?.pid ?? null; },
        alive() { return keeper !== null && world.process(keeper.pid)?.state !== 'dead'; },

        // The end path asks a healthy keeper to abandon what was created for reservations that were never committed.
        async abortUncommitted(resourceIds) {
            for (const resourceId of resourceIds) {
                const made = byReservation.get(resourceId);
                if (!made) continue;
                if (made.entry) world.die(made.entry.pid);
                if (made.inode !== undefined) { world.dropNamespace(keeper.pid, made.inode); }
                if (made.remove) made.remove();
                byReservation.delete(resourceId);
            }
        },

        async create({ kind, resourceId, marker, locator }) {
            const result = await api.createInner({ kind, resourceId, marker, locator });
            // What this reservation made, so that an uncommitted creation can be abandoned.
            const identity = result.identity;
            const made = {};
            if (['keeper', 'endpoint', 'process-tree'].includes(kind)) made.entry = world.everSpawned().find((entry) => entry.marker === marker);
            else if (kind === 'netns') made.inode = identity.netNs;
            else if (kind === 'mount') { made.inode = identity.mntNs; made.remove = () => world.view.unmount({ mountId: identity.mountId, mountpoint: identity.mountpoint }); }
            else made.remove = () => world.view.remove(kind, locator);
            byReservation.set(resourceId, made);
            return result;
        },

        async createInner({ kind, resourceId, marker, locator }) {
            if (kind === 'keeper') {
                const made = gatedProcess({ kind, resourceId, marker, ppid: 1, newPidNs: false, role: 'keeper' });
                keeper = made.entry;
                return { identity: made.identity, gate: made.gate };
            }
            // R3-1: the keeper creates nothing until its own identity is committed and its gate released.
            if (!keeper || !keeper.executed) throw new KeeperRefusal('keeper_not_released');
            if (!api.alive()) throw new KeeperRefusal('keeper_gone');
            switch (kind) {
                case 'endpoint': {
                    const made = gatedProcess({ kind, resourceId, marker, ppid: keeper.pid, newPidNs: true, netNs: created.netns[0] ?? null, role: 'endpoint' });
                    created.endpoint = made.entry;
                    return { identity: made.identity, gate: made.gate };
                }
                case 'process-tree': {
                    const made = gatedProcess({ kind, resourceId, marker, ppid: keeper.pid, newPidNs: true, netNs: created.netns[0] ?? null, role: 'tree' });
                    made.entry.unkillable = options.stuckTrees === true;
                    made.entry.killDelayMs = options.slowTrees ?? 0;
                    created.trees.push(made.entry);
                    return { identity: made.identity, gate: made.gate };
                }
                case 'netns': {
                    const inode = world.newNamespace('net');
                    world.holdNamespace(keeper.pid, inode);
                    created.netns.push(inode);
                    return { identity: { netNs: inode }, gate: null };
                }
                case 'veth': {
                    const index = 10 + created.veths.length;
                    world.createObject('veth', locator.host, { netNs: created.netns[0], index });
                    created.veths.push(locator.host);
                    return { identity: { index, name: locator.host, nsInode: created.netns[0] }, gate: null };
                }
                case 'nft-table': {
                    world.createObject('nft-table', locator.table, { handle: 5 });
                    created.tables.push(locator.table);
                    return { identity: { name: locator.table, handle: 5 }, gate: null };
                }
                case 'mount': {
                    const mntNs = world.newNamespace('mnt');
                    world.holdNamespace(keeper.pid, mntNs);
                    const mount = world.addMount({ mountpoint: '/projects/g', mntNs });
                    created.mntns.push(mntNs);
                    created.mounts.push(mount);
                    return { identity: { mountId: mount.mountId, mountpoint: mount.mountpoint, mntNs }, gate: null };
                }
                case 'pty': world.createObject('pty', locator.pty); created.ptys.push(locator.pty); return { identity: { pty: locator.pty }, gate: null };
                case 'runtime-dir': world.createObject('runtime-dir', locator.path); created.dirs.push(locator.path); return { identity: { path: locator.path, inode: 900 + created.dirs.length }, gate: null };
                case 'cgroup': world.createObject('cgroup', locator.path); created.cgroups.push(locator.path); return { identity: { path: locator.path, cgroupId: 700 + created.cgroups.length }, gate: null };
                case 'gui-container': world.createObject('gui-container', locator.name); return { identity: { name: locator.name }, gate: null };
                case 'gui-view': {
                    const mount = world.addMount({ mountpoint: locator.mountpoint, mntNs: null });
                    return { identity: { mountId: mount.mountId, mountpoint: mount.mountpoint, mntNs: 1 }, gate: null };
                }
                default: throw new KeeperRefusal('unknown_kind');
            }
        },

        // ---- the keeper's part of each end-path step ------------------------------------------------------------
        async endProcessTrees() {
            for (const tree of created.trees) world.kill(tree.pid);
            for (const pty of created.ptys) world.view.remove('pty', { pty });
        },
        async endEndpoint() { if (created.endpoint) world.kill(created.endpoint.pid); },
        async releaseEgress() {
            for (const name of created.veths) world.view.remove('veth', { host: name });
            for (const table of created.tables) world.view.remove('nft-table', { table });
            // Step 4: the keeper is the last holder of the network namespace, and gives it up here (R3-5).
            if (options.forgetNetnsFd !== true) for (const inode of created.netns) world.dropNamespace(keeper.pid, inode);
        },
        async releaseViews() {
            for (const mount of created.mounts) world.view.unmount({ mountId: mount.mountId, mountpoint: mount.mountpoint });
            if (options.forgetMntnsFd !== true) for (const inode of created.mntns) world.dropNamespace(keeper.pid, inode);
        },
        async removeRuntime() {
            for (const path of created.dirs) world.view.remove('runtime-dir', { path });
            for (const path of created.cgroups) world.view.remove('cgroup', { path });
            if (options.neverExits !== true) world.die(keeper.pid);
        },

        // ---- loss -----------------------------------------------------------------------------------------------
        crash() { if (keeper) world.die(keeper.pid); },
        crashEndpoint() { if (created.endpoint) world.die(created.endpoint.pid); }
    };

    // End-of-file on the supervisor channel: kill and tear down everything this keeper owns, then exit.
    world.onSupervisorLost(() => {
        if (!api.alive() || options.ignoresEof === true) return;
        for (const entry of world.alive()) if (entry.ppid === keeper.pid) world.kill(entry.pid);
        for (const inode of [...created.netns, ...created.mntns]) world.dropNamespace(keeper.pid, inode);
        world.die(keeper.pid);
    });
    return api;
}
