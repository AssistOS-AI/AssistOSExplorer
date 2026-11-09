import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LEGACY_RUNTIME_MARKER, removeLegacyRuntimeData } from '../server/legacy-runtime-cleanup.mjs';

async function tmp() {
    return fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'rt-legacy-'));
}
const exists = (p) => fs.lstat(p).then(() => true, () => false);

async function seed(dataDir) {
    for (const d of ['podman/images', 'tool-cache/codex']) {
        await fs.mkdir(path.join(dataDir, d), { recursive: true });
        await fs.writeFile(path.join(dataDir, d, 'f'), 'x');
    }
}

test('removes both trees, writes the marker, and a second call returns []', async () => {
    const dataDir = await tmp();
    await seed(dataDir);
    const lines = [];
    const removed = await removeLegacyRuntimeData({ dataDir, log: (l) => lines.push(l) });
    assert.deepEqual(removed, [path.join(dataDir, 'podman'), path.join(dataDir, 'tool-cache')]);
    assert.equal(await exists(path.join(dataDir, 'podman')), false);
    assert.equal(await exists(path.join(dataDir, 'tool-cache')), false);
    assert.equal(await exists(path.join(dataDir, LEGACY_RUNTIME_MARKER)), true);
    assert.equal(lines.length, 2);
    assert.match(lines[0], /^\[roboTeamAgent\] removed legacy runtime data .*podman$/);
    assert.deepEqual(await removeLegacyRuntimeData({ dataDir }), []);
});

test('first run with nothing to remove logs it and still writes the marker', async () => {
    const dataDir = await tmp();
    const lines = [];
    assert.deepEqual(await removeLegacyRuntimeData({ dataDir, log: (l) => lines.push(l) }), []);
    assert.deepEqual(lines, ['[roboTeamAgent] legacy runtime cleanup: nothing to remove']);
    assert.equal(await exists(path.join(dataDir, LEGACY_RUNTIME_MARKER)), true);
});

test('registry data, roboflow and mcp-config.json survive', async () => {
    const dataDir = await tmp();
    await seed(dataDir);
    await fs.mkdir(path.join(dataDir, 'robots/x'), { recursive: true });
    await fs.mkdir(path.join(dataDir, 'roboflow'), { recursive: true });
    await fs.writeFile(path.join(dataDir, 'robots/x/metadata.json'), '{}');
    await fs.writeFile(path.join(dataDir, 'roboflow/w.json'), '{}');
    await fs.writeFile(path.join(dataDir, 'mcp-config.json'), '{}');
    await removeLegacyRuntimeData({ dataDir });
    for (const f of ['robots/x/metadata.json', 'roboflow/w.json', 'mcp-config.json']) {
        assert.equal(await exists(path.join(dataDir, f)), true, f);
    }
});

test('empty directory is removed; file and symlink are left untouched', async () => {
    const dataDir = await tmp();
    await fs.mkdir(path.join(dataDir, 'podman'));
    await fs.writeFile(path.join(dataDir, 'tool-cache'), 'file');
    assert.deepEqual(await removeLegacyRuntimeData({ dataDir }), [path.join(dataDir, 'podman')]);
    assert.equal((await fs.lstat(path.join(dataDir, 'tool-cache'))).isFile(), true);

    const d2 = await tmp();
    const outside = await tmp();
    await fs.writeFile(path.join(outside, 'keep'), 'k');
    await fs.symlink(outside, path.join(d2, 'podman'));
    await fs.symlink(outside, path.join(d2, 'tool-cache'));
    assert.deepEqual(await removeLegacyRuntimeData({ dataDir: d2 }), []);
    assert.equal((await fs.lstat(path.join(d2, 'podman'))).isSymbolicLink(), true);
    assert.equal(await exists(path.join(outside, 'keep')), true);
});

test('absent data directory is created for the marker', async () => {
    const dataDir = path.join(await tmp(), 'missing');
    assert.deepEqual(await removeLegacyRuntimeData({ dataDir }), []);
    assert.equal(await exists(path.join(dataDir, LEGACY_RUNTIME_MARKER)), true);
});

test('a removal failure propagates, leaves no marker, and a later call removes the tree', async (t) => {
    const dataDir = await tmp();
    await seed(dataDir);
    const original = fs.rm;
    const failing = t.mock.method(fs, 'rm', async (target, options) => {
        if (String(target).endsWith('tool-cache')) throw Object.assign(new Error('denied'), { code: 'EACCES' });
        return original(target, options);
    });
    await assert.rejects(removeLegacyRuntimeData({ dataDir }), { code: 'EACCES' });
    assert.equal(await exists(path.join(dataDir, LEGACY_RUNTIME_MARKER)), false);
    failing.mock.restore();
    const removed = await removeLegacyRuntimeData({ dataDir });
    assert.deepEqual(removed, [path.join(dataDir, 'tool-cache')]);
    assert.equal(await exists(path.join(dataDir, 'tool-cache')), false);
    assert.equal(await exists(path.join(dataDir, LEGACY_RUNTIME_MARKER)), true);
});

test('the marker makes later calls a no-op even if the trees reappear', async () => {
    const dataDir = await tmp();
    await seed(dataDir);
    await removeLegacyRuntimeData({ dataDir });
    await fs.mkdir(path.join(dataDir, 'podman'));
    await fs.mkdir(path.join(dataDir, 'tool-cache'));
    await fs.writeFile(path.join(dataDir, 'podman/x'), 'x');
    await fs.writeFile(path.join(dataDir, 'tool-cache/y'), 'y');
    assert.deepEqual(await removeLegacyRuntimeData({ dataDir }), []);
    assert.equal(await exists(path.join(dataDir, 'podman/x')), true);
    assert.equal(await exists(path.join(dataDir, 'tool-cache/y')), true);
});
