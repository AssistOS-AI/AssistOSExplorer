// A finished workload is ended on its observed exit, so the namespace pins (open descriptors) and the staging directories of
// repeated workloads in one execution stay bounded by the number of LIVE workloads. Real launcher and supervisor; fake processes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createExecutionSupervisor } from '../../server/sandbox/executionSupervisor.mjs';
import { createSandboxLauncher } from '../../server/sandbox/sandboxLauncher.mjs';
import { readProcMasks } from '../../server/sandbox/procMasks.mjs';
import { SUPERVISOR_PID, createFakeSpawn, createFakeView, fakeClock } from './helpers/fakes.mjs';

const MASKS = readProcMasks({ readFile: () => fs.readFileSync(new URL('./fixtures/podman-nested-mountinfo.txt', import.meta.url), 'utf8') });
const settle = async () => { for (let index = 0; index < 20; index += 1) await new Promise((resolve) => setImmediate(resolve)); };

function rig(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-pins-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const homeFd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    t.after(() => fs.closeSync(homeFd));
    const view = createFakeView();
    view.remove = () => true;
    const { spawnImpl, spawned } = createFakeSpawn(view);
    const open = new Set();
    const launcher = createSandboxLauncher({
        view, spawnImpl, clock: fakeClock(), procMasks: MASKS, supervisorPid: SUPERVISOR_PID, arch: 'x86_64', signal: () => {},
        tools: { setpriv: 'x', unshare: 'x', mount: 'x', umount: 'x', node: 'x', nsenter: 'x' }, fsImpl: { ...fs, existsSync: () => true },
        openNamespace: (pid, type) => {
            const entry = view.process(pid);
            const handle = { pid, type };
            open.add(handle);
            return { inode: type === 'pid' ? entry.pidNs : entry.mntNs, close: () => open.delete(handle) };
        }
    });
    const supervisor = createExecutionSupervisor({
        launcher, view, clock: fakeClock(), supervisorPid: SUPERVISOR_PID, admission: { inventory: [{ name: 'codex' }], streamDirectory: '/stream' },
        roles: { orchestration: { argv: ['node'], roBinds: [] }, endpoint: { argv: ['node'], roBinds: [] }, workload: { roBinds: [] } },
        home: { path: dir, fd: homeFd }, grants: [{ name: 'a', path: '/projects/a', hostPath: dir, access: 'write', fd: homeFd }]
    });
    const ledger = { async publish({ kind, spec }) {
        const created = await supervisor.create({ kind, resourceId: `r${Math.random()}`, marker: `m${Math.random().toString(36).slice(2).padEnd(10, '0')}`, locator: {}, spec });
        await created.gate?.commit();
        return { handle: created.handle };
    } };
    return { dir, view, spawned, open, supervisor, ledger };
}

const request = { processClass: 'run', executable: 'codex', args: [], env: {}, home: '/home/robot', cwd: '/projects/a', folders: [{ path: '/projects/a', access: 'write' }], exclusions: [], network: 'none', requirements: { privateProc: true }, communication: { kind: 'stdio', stdin: 'ignore' } };

test('N sequential workloads in one execution: pinned descriptors, pinned inodes and staging directories stay bounded by the live ones', async (t) => {
    const world = rig(t);
    await world.supervisor.create({ kind: 'runtime-dir', resourceId: 'rt', locator: { path: `${world.dir}/x/${'a'.repeat(32)}` } });
    const sandbox = world.supervisor.providerSandbox(world.ledger);
    const exits = [];
    sandbox.setExitHandler((...args) => exits.push(args));
    for (let number = 1; number <= 12; number += 1) {
        await sandbox.start({ process: number, request, streams: {} });
        assert.equal(world.open.size, 3, `workload ${number} running: its three pins only`);
        assert.equal(world.view.pinned.size, 3);
        world.spawned.at(-1).finish(0, null);
        await settle();
        assert.equal(world.open.size, 0, `workload ${number} exited: its pins are closed`);
        assert.equal(world.view.pinned.size, 0);
        assert.equal(fs.readdirSync(`${world.supervisor.runtimeDir}/stage`).length, 0, 'its staging directory is gone');
    }
    assert.equal(exits.length, 12);
    assert.equal(world.supervisor.stats().trees, 0, 'finished trees are forgotten');
    await sandbox.stop({ process: 3, graceMs: 1 }); // a stop for a finished process is a no-op
});

test('with several live at once the pins are exactly three per live workload, and a workload whose absence cannot be proven keeps them', async (t) => {
    const world = rig(t);
    await world.supervisor.create({ kind: 'runtime-dir', resourceId: 'rt', locator: { path: `${world.dir}/x/${'b'.repeat(32)}` } });
    const sandbox = world.supervisor.providerSandbox(world.ledger);
    for (let number = 1; number <= 4; number += 1) await sandbox.start({ process: number, request, streams: {} });
    assert.equal(world.open.size, 12);
    world.spawned[0].finish(0, null);
    world.spawned[2].finish(0, null);
    await settle();
    assert.equal(world.open.size, 6, 'only the two live ones remain pinned');
    // a lingering process in the sandbox namespace: the exit is observed but absence cannot be proven, so the pins stay
    const stuck = world.spawned[1];
    world.view.add({ pid: 9999, pidNs: world.view.process(stuck.child.pid + 1).pidNs, mntNs: '2000', netNs: '3000', cmdline: ['straggler'] });
    stuck.finish(0, null);
    await settle();
    assert.equal(world.open.size, 6, 'not released while a straggler still shows the namespace');
    assert.equal(world.supervisor.stats().trees, 2, 'the unproven one and the one still live');
});
