import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createWalker } from '../../server/execution/recoveryWalk.mjs';
import { createProcView } from '../../server/execution/procView.mjs';
import { createFakeWorld } from '../execution/helpers/fakeProcWorld.mjs';
import { createEnvironmentImages } from '../../server/runtime/environmentImages.mjs';
import { makeTempDir, openStore, readyRobot, syntheticContext } from '../helpers/synthetic.mjs';

test('real recovery walker and procView remove a cgroup under the effective delegated subtree and prove released', async (t) => {
    const world = createFakeWorld(t);
    const target = path.join(world.cgroupSubtree, `x-${'c'.repeat(32)}`);
    fs.mkdirSync(target);
    fs.symlinkSync('cgroup:[4026531999]', path.join(world.procRoot, 'self', 'ns', 'cgroup'));
    const view = createProcView({ procRoot: world.procRoot, signal: world.signal, runtimeRoot: world.runtimeRoot, cgroupSubtree: world.cgroupSubtree, statfs: world.statfs });
    let time = 0;
    const walker = createWalker({ view, clock: { now: () => time, sleep: async (ms) => { time += ms; } }, releaseDeadlineMs: 100, pollMs: 10, sandboxRecord: () => null });
    const st = fs.statSync(target, { bigint: true });
    const context = view.cgroupContext();
    const blocker = { kind: 'cgroup', locator: { path: target, context }, identity: { path: target, dev: String(st.dev), ino: String(st.ino) } };
    assert.equal(await walker.walk(blocker), 'released');
    assert.equal(fs.existsSync(target), false);
    const changed = { ...blocker, locator: { path: target, context: { ...context, namespace: '4026532000' } } };
    assert.equal(await walker.walk(changed), 'quarantined', 'a replacement container path cannot prove an old delegation absent');
});

test('env-rootfs is nonretainable in worker state, and exact startup lookups preserve quarantine facts', (t) => {
    const store = openStore(makeTempDir(t)); t.after(() => store.close());
    const robotId = readyRobot(store, syntheticContext());
    const locator = { name: `rw-env-${'a'.repeat(32)}`, label: `robo-work.reservation=${'a'.repeat(32)}` };
    assert.throws(() => store.reserveResource({ kind: 'env-rootfs', locator, robotId, retained: true }), { code: 'invalid_request' });
    const resource = store.reserveResource({ kind: 'env-rootfs', locator, robotId });
    assert.throws(() => store.retainResource({ resourceId: resource.resourceId }), { code: 'invalid_request' });
    store.quarantineResource({ resourceId: resource.resourceId, generationId: store.generationId });
    assert.equal(store.findEnvironmentRootfs({ name: locator.name }).state, 'quarantined');
    assert.equal(store.findEnvironmentRootfs({ name: `rw-env-${'b'.repeat(32)}` }), null);
});

test('startup orphan sweep keeps quarantined and other-workspace objects; deletes only exact owned orphan', async (t) => {
    const names = ['a', 'b', 'c'].map((char) => `rw-env-${char.repeat(32)}`);
    const removed = []; const present = new Set(names);
    const podman = { available: true, close() {},
        runSync(args) {
            const name = args.at(-1);
            if (args[0] === 'container') return { status: present.has(name) ? 0 : 1, stdout: '' };
            if (args[0] === 'inspect') return { status: 0, stdout: JSON.stringify([{ Config: { Labels: { 'robo-work.workspace': name === names[2] ? 'other' : 'own', 'robo-work.reservation': name.slice(7) } }, GraphDriver: { Data: { MergedDir: `/store/${name}` } } }]) };
            if (args[0] === 'umount') return { status: 0, stdout: '' };
            if (args[0] === 'rm') { removed.push(name); present.delete(name); return { status: 0, stdout: '' }; }
            return { status: 125, stdout: '' };
        },
        async run(args) {
            if (args[0] === 'container' && args[1] === 'list') return { status: 0, stdout: JSON.stringify(names.map((name) => ({ Names: [name] }))) };
            return this.runSync(args);
        },
    };
    const manager = createEnvironmentImages({ dataDir: makeTempDir(t), podman });
    await manager.recoverOrphans({ workspaceId: 'own', resourceForName: (name) => name === names[0] ? { state: 'quarantined' } : null });
    assert.deepEqual(removed, [names[1]]);
});
