import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { applyCleanup, inspectCleanupPath } from '../../../.github/scripts/cleanup-explorer-host.mjs';

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
        podman: { available: true, containers: [{ id: A, image: C, mounts: [{ type: 'bind', source: QA, destination: '/workspace' }] }], images: [C] },
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
