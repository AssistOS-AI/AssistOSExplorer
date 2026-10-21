import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { acquireCleanupLock, applyCleanup, inspectCleanupPath, latchEvidence, workspaceDeletionScript } from '../../../.github/scripts/cleanup-explorer-host.mjs';
import { legacyLockModule, workspaceLockModule } from './qa-fake-lock-modules.mjs';

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
            return { assertHeld: instance => { assert(held); assert.equal(instance, 'ploinky-box-explorerqaworkspace-7a31ab7775eb'); },
                release: () => { held = false; released = true; } };
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
    assert.deepEqual(result.paths, [QA, E2E]);
    assert(f.released());
    assert(!fs.existsSync(path.join(f.root, 'explorerQaWorkspace')));
    assert(fs.existsSync(path.join(f.root, 'explorerWorkspace', 'retained-until-delete')));
    assert(fs.existsSync(path.join(f.root, '.ploinky-box', 'retained-until-delete')));
    assert.deepEqual(f.actions.map(row => row[0]), ['stop', 'container', 'stop', 'container', 'image', 'image', 'path', 'path']);
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

// The fixture's adapters with the real custody of one fake lock module acquired
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
        return { ...lock, release: after(lock.release), ...(lock.location === 'workspace'
            ? { releaseRelocated: after(lock.releaseRelocated), relinquishDeleted: after(lock.relinquishDeleted) } : {}) };
    };
    f.adapters.deletePath = row => { f.actions.push(['path', row.path]); fs.rmSync(path.join(f.root, path.basename(row.path)), { recursive: true }); };
    f.adapters.pathExists = file => fs.existsSync(path.join(f.root, path.basename(file)));
    f.adapters.retainedBoxes = rows => rows.map(row => ({ ...row, name: f.names?.[row.id] || `ploinky_box_${row.id.slice(0, 4)}`, startedAt: '2026-10-01T00:00:00Z' }));
    f.adapters.retirementTime = () => Date.parse('2026-10-20T00:00:00Z');
    f.adapters.latchEvidence = () => latchEvidence(qa);
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

test('E1: with a workspace-generation lock the QA workspace row runs last: rename, relinquish, delete, and the renamed tree is gone', async t => {
    const module = workspaceLockModule(), f = custodyFixture(t, module);
    assert.deepEqual(f.plan.paths.map(row => row.path), [QA, E2E], 'the plan lists the workspace first');
    const result = await applyCleanup(f.plan, f.adapters);
    assert.equal(result.result, 'complete');
    assert.deepEqual(result.paths, [E2E, QA]);
    const rename = f.actions.find(row => row[0] === 'rename');
    assert.match(rename[2], /^explorerQaWorkspace\.deleting-[a-f0-9]{12}$/);
    assert.deepEqual(f.actions.slice(-3).map(row => row[0]), ['path', 'rename', 'delete-renamed']);
    assert.equal(await f.concurrent, 'PLOINKY_BOX_WORKSPACE_ABSENT');
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
    assert.equal(fs.existsSync(path.join(f.qa, '.ploinky-host/locks/workspace.lock')), false);
    assert.equal(fs.readFileSync(path.join(f.qa, 'agent-data'), 'utf8'), 'durable');
});

test('E2: with an earlier-generation lock module the cleanup keeps its former calls and order', async t => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-legacy-home-')));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    const module = legacyLockModule({ stateRoot: home }), f = custodyFixture(t, module, () => acquireCleanupLock(module));
    f.adapters.retainedBoxes = () => assert.fail('the earlier generation does not inspect retained Boxes');
    f.adapters.renameWorkspace = () => assert.fail('the earlier generation deletes the workspace in place');
    const result = await applyCleanup(f.plan, f.adapters);
    assert.deepEqual(result.paths, [QA, E2E], 'the plan order is kept');
    assert.deepEqual(module.calls[0], { op: 'acquire', args: [INSTANCE] }, 'acquire takes the instance alone');
    assert.deepEqual(module.calls.map(call => call.op), ['acquire', 'assertHeld', 'assertHeld', 'assertHeld', 'assertHeld', 'assertHeld', 'assertHeld', 'release']);
    assert.ok(module.calls.filter(call => call.op === 'assertHeld').every(call => call.args[0] === INSTANCE));
    assert.deepEqual(f.actions.filter(row => row[0] === 'path').map(row => row[1]), [QA, E2E]);
});

// A retained rollback Box last started after its retirement, next to the cleanup plan.
function startedRetainedBox(t) {
    const module = workspaceLockModule(), f = custodyFixture(t, module);
    f.retired = [];
    f.adapters.retirementTime = backup => { f.retired.push(backup); return Date.parse('2026-10-20T00:00:00Z'); };
    f.adapters.retainedBoxes = rows => rows.map(row => ({ ...row, name: row.id === A ? `${INSTANCE}-rollback-redeploy-AbCd1234` : 'other',
        startedAt: row.id === A ? '2026-10-21T08:00:00.123456789Z' : '2026-10-01T00:00:00Z' }));
    // Without the workspace row this run would leave the workspace in place.
    f.keepWorkspace = () => { f.plan.paths = f.plan.paths.filter(row => row.path !== QA); };
    return Object.assign(f, { module });
}

test('E10: cleanup refuses a retained rollback Box started after its retirement and names the ploinky stop remedy', async t => {
    const f = startedRetainedBox(t);
    f.keepWorkspace();
    await assert.rejects(applyCleanup(f.plan, f.adapters), error => error.code === 'HOST_CLEANUP_RETAINED_BOX_STARTED'
        && /ploinky stop/.test(error.message) && error.message.includes('/home/admin/explorerQaWorkspace') && error.receipt.result === 'failed');
    assert.deepEqual(f.retired, ['redeploy-AbCd1234']);
    assert.deepEqual(f.actions, [], 'nothing was stopped, removed or deleted');
    assert.equal(f.module.calls.at(-1).op, 'release');
    f.adapters.retirementTime = () => null;
    await assert.rejects(applyCleanup(f.plan, f.adapters), { code: 'HOST_CLEANUP_RETAINED_BOX_UNPROVEN' });
    // Entries that are not Ploinky's evidence keep the refusal.
    f.adapters.retirementTime = () => Date.parse('2026-10-20T00:00:00Z');
    const hostState = path.join(f.qa, '.ploinky-host');
    fs.mkdirSync(path.join(hostState, 'quarantine'), { recursive: true });
    fs.writeFileSync(path.join(f.root, 'elsewhere.json'), '{}');
    fs.symlinkSync(path.join(f.root, 'elsewhere.json'), path.join(hostState, 'latch.json'));
    await assert.rejects(applyCleanup(f.plan, f.adapters), { code: 'HOST_CLEANUP_RETAINED_BOX_STARTED' }, 'empty quarantine, symlinked latch');
    assert.deepEqual(f.actions, []);
    f.adapters.retirementTime = () => Date.parse('2026-10-22T00:00:00Z');
    assert.equal((await applyCleanup(f.plan, f.adapters)).result, 'complete', 'a Box last started before its retirement is removed');
});

test('E10 (a): the Box may be removed when the same cleanup run also deletes the QA workspace', async t => {
    const f = startedRetainedBox(t);
    f.adapters.latchEvidence = () => assert.fail('the workspace deletion alone admits the removal');
    const result = await applyCleanup(f.plan, f.adapters);
    assert.equal(result.result, 'complete');
    assert.ok(result.containers.some(row => row.id === A));
    assert.ok(result.paths.includes(QA));
});

test('E10 (b): the Box may be removed once Ploinky latched the evidence in the workspace', async t => {
    for (const evidence of ['latch', 'quarantine']) {
        const f = startedRetainedBox(t);
        f.keepWorkspace();
        const hostState = path.join(f.qa, '.ploinky-host');
        if (evidence === 'latch') { fs.mkdirSync(hostState, { recursive: true }); fs.writeFileSync(path.join(hostState, 'latch.json'), '{}'); }
        else { fs.mkdirSync(path.join(hostState, 'quarantine/20261021T000000Z-abcd'), { recursive: true }); }
        const result = await applyCleanup(f.plan, f.adapters);
        assert.equal(result.result, 'complete', evidence);
        assert.ok(result.containers.some(row => row.id === A), evidence);
        assert.equal(fs.existsSync(f.qa), true, 'the workspace stays');
    }
});

test('latch evidence is read without following links or writing', t => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-latch-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const workspace = path.join(root, 'ws'), hostState = path.join(workspace, '.ploinky-host');
    assert.equal(latchEvidence(workspace), false, 'absent workspace');
    fs.mkdirSync(path.join(root, 'outside/quarantine/x'), { recursive: true });
    fs.mkdirSync(workspace);
    fs.symlinkSync(path.join(root, 'outside'), hostState);
    assert.equal(latchEvidence(workspace), false, 'symlinked host-state directory');
    fs.unlinkSync(hostState); fs.mkdirSync(hostState);
    fs.writeFileSync(path.join(root, 'latch'), '{}'); fs.linkSync(path.join(root, 'latch'), path.join(hostState, 'latch.json'));
    assert.equal(latchEvidence(workspace), false, 'hard-linked marker');
    fs.unlinkSync(path.join(hostState, 'latch.json'));
    fs.symlinkSync(path.join(root, 'outside/quarantine'), path.join(hostState, 'quarantine'));
    assert.equal(latchEvidence(workspace), false, 'symlinked quarantine');
    const writes = [];
    const fsApi = new Proxy(fs, { get: (target, key) => (/write|mkdir|rm|unlink|rename|chmod|chown|copy|link|open(?!dir)/i.test(String(key))
        ? (...args) => { writes.push(key); return target[key](...args); } : target[key]) });
    fs.unlinkSync(path.join(hostState, 'quarantine')); fs.mkdirSync(path.join(hostState, 'quarantine/entry'), { recursive: true });
    assert.equal(latchEvidence(workspace, fsApi), true);
    assert.deepEqual(writes, []);
});

test('E10: the CLI prints the remedy for a retained Box refusal and only for it', () => {
    const source = fs.readFileSync(new URL('../../../.github/scripts/cleanup-explorer-host.mjs', import.meta.url), 'utf8');
    assert.match(source, /if \(\/\^HOST_CLEANUP_RETAINED_BOX_\/\.test\(error\.code \|\| ''\)\) process\.stderr\.write/);
});

test('the root workspace deletion scripts rename to a reserved sibling, refuse an occupied or foreign name, and delete by identity', t => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-root-scripts-')));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    const qa = path.join(home, 'explorerQaWorkspace');
    fs.mkdirSync(path.join(qa, '.ploinky-host/locks'), { recursive: true });
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
