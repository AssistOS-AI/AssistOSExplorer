import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { acquireCleanupLock, applyCleanup, assertQaBoxMounts, inspectCleanupPath, workspaceDeletionScript, workspaceLockLayout } from '../../../.github/scripts/cleanup-explorer-host.mjs';
import { workspaceLockModule } from './qa-fake-lock-modules.mjs';

const A = 'a'.repeat(64), B = 'b'.repeat(64), C = 'c'.repeat(64), D = 'd'.repeat(64);
const QA = '/home/admin/explorerQaWorkspace';
const E2E = '/home/admin/.qa-e2e';
function fixture(t) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'explorer-host-cleanup-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    for (const name of ['explorerQaWorkspace', '.qa-e2e', 'explorerWorkspace', '.ploinky-box']) {
        fs.mkdirSync(path.join(root, name));
        fs.writeFileSync(path.join(root, name, 'retained-until-delete'), 'fixture');
    }
    const identity = file => {
        const stat = fs.lstatSync(path.join(root, path.basename(file)), { bigint: true });
        return { path: file, device: String(stat.dev), inode: String(stat.ino), uid: 1001 };
    };
    const engines = {
        podman: { available: true, containers: [{ id: A, image: C, mounts: [{ type: 'bind', source: QA, destination: QA }] }], images: [C] },
        podmanRoot: { available: true, containers: [{ id: B, image: D, mounts: [] }], images: [D] },
        docker: { available: false }, dockerRoot: { available: false },
    };
    const plan = { version: 1, host: 'proxiesserve', user: 'admin', engines: structuredClone(engines), paths: [identity(QA), identity(E2E)] };
    const actions = [];
    let held = false, released = false;
    const mapPath = row => ({ ...row, path: path.join(root, path.basename(row.path)), uid: process.getuid() });
    const checkPath = row => inspectCleanupPath(mapPath(row), { home: root, uid: process.getuid() });
    const adapters = {
        host: () => ({ host: 'proxiesserve', user: 'admin', uid: 1001, home: '/home/admin' }),
        inventory: () => structuredClone(engines),
        mountPoints: () => ['/', '/home'],
        acquireLock: async () => {
            held = true;
            const give = () => { held = false; released = true; };
            return { assertHeld: instance => { assert(held); assert.equal(instance, 'ploinky-box-explorerqaworkspace-7a31ab7775eb'); },
                release: give, releaseRelocated: give, relinquishDeleted: give };
        },
        stopContainer: (context, id) => { assert(held); actions.push(['stop', context, id]); },
        removeContainer: (context, id) => {
            assert(held); actions.push(['container', context, id]);
            engines[context].containers = engines[context].containers.filter(row => row.id !== id);
        },
        removeImage: (context, id) => {
            assert(held); actions.push(['image', context, id]);
            assert.equal(engines[context].containers.some(row => row.image === id), false);
            engines[context].images = engines[context].images.filter(value => value !== id);
        },
        inspectPath: checkPath,
        deletePath: row => {
            assert(held); checkPath(row); actions.push(['path', row.path]);
            fs.rmSync(mapPath(row).path, { recursive: true });
        },
        pathExists: file => fs.existsSync(mapPath({ path: file }).path),
        workspaceLockLayout: () => true, qaBoxes: () => [],
        // The QA workspace row: rename away, relinquish, delete the renamed tree.
        renameWorkspace: (row, renamed) => {
            assert(held); actions.push(['rename', row.path, path.basename(renamed)]);
            fs.renameSync(mapPath(row).path, path.join(root, path.basename(renamed)));
        },
        deleteRenamedWorkspace: (row, renamed) => {
            assert(!held); actions.push(['delete-renamed', path.basename(renamed)]);
            fs.rmSync(path.join(root, path.basename(renamed)), { recursive: true });
        },
    };
    return { root, plan, engines, actions, adapters, released: () => released };
}

test('cleanup pins both Podman contexts, removes images without container references, and deletes only planned real directories', async t => {
    const f = fixture(t);
    fs.symlinkSync(path.join(f.root, 'explorerWorkspace'), path.join(f.root, '.qa-e2e', 'outside-link'));
    const result = await applyCleanup(f.plan, f.adapters);
    assert.equal(result.result, 'complete');
    assert.deepEqual(result.containers, [{ context: 'podman', id: A }, { context: 'podmanRoot', id: B }]);
    assert.deepEqual(result.images, [{ context: 'podman', id: C }, { context: 'podmanRoot', id: D }]);
    assert.deepEqual(result.paths, [E2E, QA], 'the workspace row runs last');
    assert(f.released());
    assert(!fs.existsSync(path.join(f.root, 'explorerQaWorkspace')));
    assert(fs.existsSync(path.join(f.root, 'explorerWorkspace', 'retained-until-delete')));
    assert(fs.existsSync(path.join(f.root, '.ploinky-box', 'retained-until-delete')));
    assert.deepEqual(f.actions.map(row => row[0]), ['stop', 'container', 'stop', 'container', 'image', 'image', 'path', 'rename', 'delete-renamed']);
});

test('a failed container stop prevents removals and always releases the mutation lock', async t => {
    const f = fixture(t);
    f.adapters.stopContainer = () => { throw Object.assign(new Error('stop failed'), { code: 'HOST_CLEANUP_STOP_FAILED' }); };
    await assert.rejects(applyCleanup(f.plan, f.adapters), { code: 'HOST_CLEANUP_STOP_FAILED' });
    assert.deepEqual(f.actions, []);
    assert(f.released());
    assert(fs.existsSync(path.join(f.root, 'explorerQaWorkspace')));
    assert.equal(f.engines.podman.containers.length, 1);
});

test('production cleanup uses exact non-force removals without prune, volume, or external control-plane operations', () => {
    const source = fs.readFileSync(new URL('../../../.github/scripts/cleanup-explorer-host.mjs', import.meta.url), 'utf8');
    assert.match(source, /\['container', 'rm', container\]/);
    assert.match(source, /\['image', 'rm', image\]/);
    assert.match(source, /\/usr\/bin\/sudo.*'-n', '\/usr\/bin\/node'/);
    assert.doesNotMatch(source, /--force|\bprune\b|\['volume'|https?:\/\//);
});

test('changed container and image sets fail before any mutation', async t => {
    for (const change of ['container', 'image', 'availability']) {
        const f = fixture(t);
        if (change === 'container') f.engines.podman.containers[0].id = 'e'.repeat(64);
        if (change === 'image') f.engines.podman.images.push('f'.repeat(64));
        if (change === 'availability') f.engines.docker = { available: true, containers: [], images: [] };
        await assert.rejects(applyCleanup(f.plan, f.adapters), { code: 'HOST_CLEANUP_INVENTORY_CHANGED' });
        assert.deepEqual(f.actions, []);
    }
});

test('replacement, symlink, mountpoint and protected path candidates fail before stopping containers', async t => {
    for (const change of ['inode', 'symlink', 'mount', 'protected']) {
        const f = fixture(t);
        const target = path.join(f.root, 'explorerQaWorkspace');
        if (change === 'inode' || change === 'symlink') {
            fs.renameSync(target, `${target}-original`);
            if (change === 'inode') fs.mkdirSync(target);
            else fs.symlinkSync(`${target}-original`, target);
        }
        if (change === 'mount') f.adapters.mountPoints = () => [`${QA}/.data/mounted`];
        if (change === 'protected') f.plan.paths[0].path = '/home/admin/explorerWorkspace';
        await assert.rejects(applyCleanup(f.plan, f.adapters));
        assert.deepEqual(f.actions, []);
        assert(fs.existsSync(path.join(f.root, 'explorerWorkspace')));
    }
});

test('remaining Docker references block path or image removal without stopping Docker or Podman', async t => {
    for (const pathReference of [true, false]) {
        const f = fixture(t);
        f.engines.docker = { available: true, containers: [{ id: 'e'.repeat(64), image: 'f'.repeat(64),
            mounts: pathReference ? [{ type: 'bind', source: E2E, destination: '/data' }] : [] }],
        images: pathReference ? [] : ['f'.repeat(64)] };
        f.plan.engines.docker = structuredClone(f.engines.docker);
        await assert.rejects(applyCleanup(f.plan, f.adapters), {
            code: pathReference ? 'HOST_CLEANUP_PATH_REFERENCED' : 'HOST_CLEANUP_DOCKER_IMAGE_REFERENCED',
        });
        assert.deepEqual(f.actions, []);
    }
});

test('cross-context container ambiguity and wrong host identity are rejected', async t => {
    const f = fixture(t);
    f.plan.engines.podmanRoot.containers[0].id = A;
    await assert.rejects(applyCleanup(f.plan, f.adapters), { code: 'HOST_CLEANUP_CROSS_CONTEXT_CONTAINER' });
    f.plan.host = 'another-host';
    await assert.rejects(applyCleanup(f.plan, f.adapters), { code: 'HOST_CLEANUP_HOST_MISMATCH' });
    assert.deepEqual(f.actions, []);
});

test('a resource appearing during cleanup aborts before any filesystem deletion and releases the workspace lock', async t => {
    const f = fixture(t);
    f.adapters.stopContainer = (context, id) => {
        f.actions.push(['stop', context, id]);
        f.engines.podmanRoot.containers.push({ id: 'e'.repeat(64), image: D, mounts: [] });
    };
    await assert.rejects(applyCleanup(f.plan, f.adapters), error => (
        error.code === 'HOST_CLEANUP_INVENTORY_CHANGED' && error.receipt.result === 'failed'
        && error.receipt.stopped.length === 1 && error.receipt.paths.length === 0
    ));
    assert.deepEqual(f.actions.map(row => row[0]), ['stop']);
    assert(f.released());
    assert(fs.existsSync(path.join(f.root, 'explorerQaWorkspace')));
});

const INSTANCE = 'ploinky-box-explorerqaworkspace-7a31ab7775eb';

const currentRuntimeMounts = () => [
    { Source: QA, Destination: QA, RW: true, Type: 'bind' },
    { Source: `${QA}/.runtime/ploinky`, Destination: '/opt/ploinky', RW: false, Type: 'bind' },
    { Source: `${QA}/.runtime/ploinky`, Destination: `${QA}/.runtime/ploinky`, RW: false, Type: 'bind' },
    { Source: `${QA}/.ploinky-box/empty`, Destination: `${QA}/.ploinky-box`, RW: false, Type: 'bind' },
];

// The fixture's adapters with the real custody of the lock module acquired
// on the fixture's QA workspace directory.
function custodyFixture(t, module, acquire = qa => acquireCleanupLock(module, { workspaceRoot: qa })) {
    const f = fixture(t);
    const qa = path.join(f.root, 'explorerQaWorkspace');
    fs.writeFileSync(path.join(qa, 'agent-data'), 'durable');
    // The fixture's own lock still gates every injected mutation.
    const gate = f.adapters.acquireLock;
    f.adapters.acquireLock = async () => {
        const held = await gate(), lock = await acquire(qa);
        const after = action => (...args) => { const value = action(...args); held.release(); return value; };
        const mapped = root => path.join(f.root, path.basename(root));
        return { ...lock, release: after(lock.release), releaseRelocated: after(root => lock.releaseRelocated(mapped(root))), relinquishDeleted: after(lock.relinquishDeleted) };
    };
    // The layout proof reads the real fixture directory; the QA Box is built by the current runtime.
    f.adapters.workspaceLockLayout = () => workspaceLockLayout(qa);
    f.adapters.qaBoxes = () => [{ context: 'podman', id: A, mounts: currentRuntimeMounts() }];
    f.adapters.deletePath = row => { f.actions.push(['path', row.path]); fs.rmSync(path.join(f.root, path.basename(row.path)), { recursive: true }); };
    f.adapters.pathExists = file => fs.existsSync(path.join(f.root, path.basename(file)));
    f.adapters.renameWorkspace = (row, renamed) => {
        f.actions.push(['rename', row.path, path.basename(renamed)]);
        // A concurrent acquirer sees the workspace gone while the lock is still ours.
        fs.renameSync(qa, path.join(f.root, path.basename(renamed)));
        f.concurrent = module.createMutationLockManager().acquire(INSTANCE, { workspaceRoot: qa }).catch(error => error.code);
    };
    f.adapters.deleteRenamedWorkspace = (row, renamed) => {
        f.actions.push(['delete-renamed', path.basename(renamed)]);
        fs.rmSync(path.join(f.root, path.basename(renamed)), { recursive: true });
    };
    return Object.assign(f, { qa });
}

test('E1: the QA workspace row runs last: rename, relinquish, delete, and the renamed tree is gone', async t => {
    const module = workspaceLockModule(), f = custodyFixture(t, module);
    assert.deepEqual(f.plan.paths.map(row => row.path), [QA, E2E], 'the plan lists the workspace first');
    const result = await applyCleanup(f.plan, f.adapters);
    assert.equal(result.result, 'complete');
    assert.deepEqual(result.paths, [E2E, QA]);
    const rename = f.actions.find(row => row[0] === 'rename');
    assert.match(rename[2], /^explorerQaWorkspace\.deleting-[a-f0-9]{12}$/);
    assert.deepEqual(f.actions.slice(-3).map(row => row[0]), ['path', 'rename', 'delete-renamed']);
    assert.equal(await f.concurrent, 'PLOINKY_BOX_WORKSPACE_ABSENT');
    assert.deepEqual(module.calls[0], { op: 'acquire', args: [INSTANCE, { workspaceRoot: f.qa }] }, 'the lock is taken on the workspace root');
    const ops = module.calls.map(call => call.op);
    assert.equal(ops.at(-1), 'relinquishDeleted', 'nothing asserts or releases the lock after relinquishment');
    assert.equal(ops.filter(op => op === 'release').length, 0);
    assert.deepEqual(fs.readdirSync(f.root).filter(name => name.startsWith('explorerQaWorkspace')), [], 'the renamed tree is deleted');
    assert.ok(fs.existsSync(path.join(f.root, 'explorerWorkspace', 'retained-until-delete')));
});

test('E1: a renamed tree that survives deletion fails the cleanup after relinquishment', async t => {
    const module = workspaceLockModule(), f = custodyFixture(t, module);
    f.adapters.deleteRenamedWorkspace = (row, renamed) => { f.actions.push(['delete-renamed', path.basename(renamed)]); };
    await assert.rejects(applyCleanup(f.plan, f.adapters), error => error.code === 'HOST_CLEANUP_PATH_DELETE_UNCONFIRMED'
        && error.receipt.result === 'failed' && !error.receipt.paths.includes(QA));
    assert.equal(module.calls.at(-1).op, 'relinquishDeleted');
});

test('E1: a failed workspace rename keeps the lock where it is and releases it there', async t => {
    const module = workspaceLockModule(), f = custodyFixture(t, module);
    f.adapters.renameWorkspace = () => { throw Object.assign(new Error('rename refused'), { code: 'HOST_CLEANUP_RENAME_TARGET_EXISTS' }); };
    await assert.rejects(applyCleanup(f.plan, f.adapters), { code: 'HOST_CLEANUP_RENAME_TARGET_EXISTS' });
    assert.equal(module.calls.at(-1).op, 'release');
    assert.equal(fs.existsSync(path.join(f.qa, '.ploinky-box/locks/workspace.lock')), false);
    assert.equal(fs.readFileSync(path.join(f.qa, 'agent-data'), 'utf8'), 'durable');
});

// An earlier runtime keeps its lock outside the workspace and offers neither
// releaseRelocated nor relinquishDeleted.
function oldRuntimeModule() {
    const calls = [];
    return { calls, createMutationLockManager: () => ({ async acquire(...args) {
        calls.push(['acquire', ...args]);
        return { assertHeld(value) { calls.push(['assertHeld', value]); }, release() { calls.push(['release']); } };
    } }) };
}

test('E12: an old-runtime lock is refused before any stop, removal, rename or deletion, released plainly, with the receipt kept', async t => {
    const module = oldRuntimeModule(), f = custodyFixture(t, module, qa => acquireCleanupLock(module, { workspaceRoot: qa }));
    assert.ok(f.plan.paths.some(row => row.path === QA), 'the workspace row is planned');
    await assert.rejects(applyCleanup(f.plan, f.adapters), error => error.code === 'HOST_CLEANUP_WORKSPACE_LOCK_LAYOUT_INVALID'
        && error.receipt.result === 'failed' && error.receipt.code === 'HOST_CLEANUP_WORKSPACE_LOCK_LAYOUT_INVALID'
        && error.receipt.stopped.length === 0 && error.receipt.paths.length === 0 && error.secondary === undefined);
    assert.deepEqual(f.actions, [], 'no stop, removal, rename or deletion');
    assert.deepEqual(module.calls.map(call => call[0]), ['acquire', 'release'], 'released through the plain release path');
    assert.equal(fs.readFileSync(path.join(f.qa, 'agent-data'), 'utf8'), 'durable');
    assert.equal(f.engines.podman.containers.length, 1);
    assert.equal(f.released(), true, 'the fixture\'s own lock state was released');
});

test('E12: the layout proof is structural: real directories only, no symlink at any component', t => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-layout-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const ws = path.join(root, 'ws');
    assert.equal(workspaceLockLayout(ws), false, 'absent workspace');
    fs.mkdirSync(path.join(ws, '.ploinky-box/locks/workspace.lock'), { recursive: true });
    assert.equal(workspaceLockLayout(ws), true);
    fs.rmdirSync(path.join(ws, '.ploinky-box/locks/workspace.lock'));
    assert.equal(workspaceLockLayout(ws), false, 'no lock directory');
    fs.mkdirSync(path.join(root, 'elsewhere'));
    fs.symlinkSync(path.join(root, 'elsewhere'), path.join(ws, '.ploinky-box/locks/workspace.lock'));
    assert.equal(workspaceLockLayout(ws), false, 'symlinked lock');
    fs.unlinkSync(path.join(ws, '.ploinky-box/locks/workspace.lock'));
    fs.writeFileSync(path.join(ws, '.ploinky-box/locks/workspace.lock'), 'file');
    assert.equal(workspaceLockLayout(ws), false, 'a file');
    fs.rmSync(path.join(ws, '.ploinky-box'), { recursive: true });
    fs.mkdirSync(path.join(root, 'outside/locks/workspace.lock'), { recursive: true });
    fs.symlinkSync(path.join(root, 'outside'), path.join(ws, '.ploinky-box'));
    assert.equal(workspaceLockLayout(ws), false, 'symlinked .ploinky-box');
});

test('E12: a QA Box without the checkout shadow or the state mask is refused before any mutation, when the workspace row is planned', async t => {
    const mutations = [
        ['no mask and no shadow', mounts => mounts.slice(0, 2)],
        ['mask missing', mounts => mounts.filter(mount => mount.Destination !== `${QA}/.ploinky-box`)],
        ['shadow missing', mounts => mounts.filter(mount => mount.Destination !== `${QA}/.runtime/ploinky`)],
        ['mask writable', mounts => mounts.map(mount => mount.Destination === `${QA}/.ploinky-box` ? { ...mount, RW: true } : mount)],
        ['mask from another source', mounts => mounts.map(mount => mount.Destination === `${QA}/.ploinky-box` ? { ...mount, Source: `${QA}/.ploinky-box` } : mount)],
        ['shadow writable', mounts => mounts.map(mount => mount.Destination === `${QA}/.runtime/ploinky` ? { ...mount, RW: true } : mount)],
        ['no checkout mount', mounts => mounts.filter(mount => mount.Destination !== '/opt/ploinky')],
    ];
    for (const [label, change] of mutations) {
        const module = workspaceLockModule(), f = custodyFixture(t, module);
        f.adapters.qaBoxes = () => [{ context: 'podman', id: A, mounts: change(currentRuntimeMounts()) }];
        await assert.rejects(applyCleanup(f.plan, f.adapters), error => error.code === 'HOST_CLEANUP_QA_BOX_SOURCE_INVALID'
            && error.receipt.stopped.length === 0, label);
        assert.deepEqual(f.actions, [], label);
        assert.equal(module.calls.at(-1).op, 'release', label);
        assert.equal(fs.existsSync(path.join(f.qa, '.ploinky-box/locks/workspace.lock')), false, `${label}: the lock was released`);
    }
    assert.doesNotThrow(() => assertQaBoxMounts(currentRuntimeMounts()));
    // Without the workspace row no Box proof is needed.
    const module = workspaceLockModule(), f = custodyFixture(t, module);
    f.plan.paths = f.plan.paths.filter(row => row.path !== QA);
    f.adapters.qaBoxes = () => assert.fail('the Box proof is only for a planned workspace row');
    assert.equal((await applyCleanup(f.plan, f.adapters)).result, 'complete');
});

test('E13: the workspace lock is released where it now lives when relinquishment fails after the rename', async t => {
    const module = workspaceLockModule(), f = custodyFixture(t, module);
    const acquire = f.adapters.acquireLock;
    f.adapters.acquireLock = async () => ({ ...(await acquire()),
        relinquishDeleted() { throw Object.assign(new Error('injected'), { code: 'HOST_CLEANUP_INJECTED' }); } });
    await assert.rejects(applyCleanup(f.plan, f.adapters), error => error.code === 'HOST_CLEANUP_INJECTED'
        && error.receipt.result === 'failed' && error.receipt.code === 'HOST_CLEANUP_INJECTED' && error.secondary === undefined);
    const renamed = f.actions.find(row => row[0] === 'rename')[2];
    assert.deepEqual(module.calls.at(-1), { op: 'releaseRelocated', args: [path.join(f.root, renamed)] }, 'released at the renamed path');
    assert.equal(fs.existsSync(path.join(f.root, renamed, '.ploinky-box/locks/workspace.lock')), false, 'the lock directory is gone');
    assert.equal(fs.existsSync(path.join(f.root, renamed, 'agent-data')), true, 'the renamed tree is kept for the operator');
});

test('E13: a lock release failure is secondary information and never replaces the primary error or its receipt', async t => {
    const f = fixture(t);
    const acquire = f.adapters.acquireLock;
    f.adapters.acquireLock = async () => ({ ...(await acquire()), release() { throw new TypeError('release is broken'); } });
    f.adapters.stopContainer = () => { throw Object.assign(new Error('stop failed'), { code: 'HOST_CLEANUP_STOP_FAILED' }); };
    await assert.rejects(applyCleanup(f.plan, f.adapters), error => error.code === 'HOST_CLEANUP_STOP_FAILED'
        && error.receipt.result === 'failed' && error.receipt.code === 'HOST_CLEANUP_STOP_FAILED'
        && error.receipt.releaseFailure === 'HOST_CLEANUP_LOCK_RELEASE_FAILED' && error.secondary instanceof TypeError);
    // On success a release failure is itself the failure, with the completed work in the receipt.
    const g = fixture(t), acquireG = g.adapters.acquireLock;
    g.adapters.acquireLock = async () => ({ ...(await acquireG()), release() { throw new TypeError('release is broken'); } });
    g.plan.paths = g.plan.paths.filter(row => row.path !== QA);
    await assert.rejects(applyCleanup(g.plan, g.adapters), error => error.receipt.result === 'failed'
        && error.receipt.code === 'HOST_CLEANUP_LOCK_RELEASE_FAILED' && error.receipt.paths.length === 1);
});

test('the root workspace deletion scripts rename to a reserved sibling, refuse an occupied or foreign name, and delete by identity', t => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-root-scripts-')));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    const qa = path.join(home, 'explorerQaWorkspace');
    fs.mkdirSync(path.join(qa, '.ploinky-box/locks'), { recursive: true });
    const stat = fs.lstatSync(qa, { bigint: true });
    const row = { path: qa, device: String(stat.dev), inode: String(stat.ino), uid: process.getuid() };
    const run = (step, renamed, mountInfo = '1 1 0:1 / / rw - x x rw\n') => spawnSync(process.execPath, ['--input-type=module', '-e',
        workspaceDeletionScript(step, { home, uid: process.getuid(), requireRoot: false, mountInfo })],
    { input: JSON.stringify({ row, renamed }), encoding: 'utf8', timeout: 10000 });
    for (const script of ['rename', 'delete']) {
        assert.match(workspaceDeletionScript(script), /if\(process\.getuid\(\)!==0\)fail\('ROOT_REQUIRED'\);/);
    }
    const renamed = path.join(home, 'explorerQaWorkspace.deleting-0123456789ab');
    assert.notEqual(run('rename', path.join(home, 'elsewhere')).status, 0, 'a foreign name is refused');
    fs.mkdirSync(renamed);
    assert.notEqual(run('rename', renamed).status, 0, 'an occupied name is refused');
    fs.rmdirSync(renamed);
    assert.notEqual(run('rename', renamed, `1 1 0:1 / ${qa}/.data rw - x x rw\n`).status, 0, 'a mount inside the workspace is refused');
    assert.equal(fs.existsSync(qa), true);
    const renaming = run('rename', renamed);
    assert.equal(renaming.status, 0, renaming.stderr);
    assert.deepEqual([fs.existsSync(qa), fs.existsSync(renamed)], [false, true]);
    fs.mkdirSync(qa);
    assert.notEqual(run('delete', qa).status, 0, 'deletion accepts only the reserved renamed tree');
    const deleting = run('delete', renamed);
    assert.equal(deleting.status, 0, deleting.stderr);
    assert.equal(fs.existsSync(renamed), false);
    assert.equal(fs.existsSync(qa), true, 'the new directory at the workspace path is untouched');
});
