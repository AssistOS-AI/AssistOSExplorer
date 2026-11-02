import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertDeniedPaths, runIsolationProbe, victimPaths } from './isolation.mjs';
import { checkPersistence } from './persistence.mjs';

// One failing control per probe: each probe must be able to fail.
const options = { robot: 'robot-a', victim: 'robot-b', workspace: '/fixture' };
const denied = () => { throw Object.assign(new Error('absent'), { code: 'ENOENT' }); };

test('paths probe fails on a readable sibling path and on a leaked marker', async () => {
    const files = victimPaths({ ...options, servicePid: 42 });
    assert.throws(() => assertDeniedPaths(files, { openSync: (file, flags) => flags === 'r' ? 9 : denied(), closeSync() {} }), /Protected path admitted/u);
    await assert.rejects(runIsolationProbe({ ...options, probe: 'paths' }, {
        io: { openSync: denied }, run: async () => ({ stdout: '/leaked/marker-B\n' }),
    }));
});

test('service probe fails on a leaked credential', async () => {
    await assert.rejects(runIsolationProbe({ ...options, probe: 'service', router: 'http://router/tool' }, {
        run: async () => ({ stdout: '' }), request: async () => ({ status: 403 }), env: { PLOINKY_AGENT_SECRET: 'synthetic' },
    }));
});

test('GUI probe fails when a forbidden port answers', async () => {
    const input = { ...options, probe: 'gui', denied: 'http://127.0.0.1:7000', own: 'http://127.0.0.1:4567' };
    await assert.rejects(runIsolationProbe(input, { run: async () => ({ stdout: '' }) }));
});

test('masks probe fails on a sibling entry and without its control file', async () => {
    const view = tree => ({
        lstatSync: file => { if (tree[path.posix.dirname(file)]?.includes(path.posix.basename(file))) return {}; throw denied(); },
        readdirSync: dir => tree[dir] ?? denied(), openSync: () => 9, closeSync() {},
    });
    const probe = (tree, control) => runIsolationProbe({ ...options, probe: 'masks', control }, { io: view(tree) });
    await assert.rejects(probe({ '/fixture': ['app', 'sibling'] }, '/fixture/app/control'), /Unexpected entries in \/fixture/u);
    await assert.rejects(probe({ '/fixture': ['app'] }, undefined), /control file/u);
});

test('fd probe fails on an inherited descriptor', async () => {
    const standard = 'lr-x------ 1 root root 64 Oct 1 00:00 0 -> /dev/null\n';
    await assert.rejects(runIsolationProbe({ ...options, probe: 'fds' }, { run: async () => ({ stdout: standard + 'lr-x------ 1 root root 64 Oct 1 00:00 9 -> /data/robots/robot-b/home/marker-B\n' }) }));
});

test('persistence fails on changed bytes or a symlink', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'robowork-probe-'));
    const local = path.join(root, 'marker'); fs.writeFileSync(local, 'owned marker');
    const marker = '/home/robot-a/marker';
    const map = file => file === marker ? local : file;
    const io = new Proxy(fs, { get(target, key) {
        if (['lstatSync', 'openSync'].includes(key)) return (file, ...args) => target[key](map(file), ...args);
        return target[key];
    } });
    const input = { robot: 'robot-a', marker, stage: 'restart', sha256: createHash('sha256').update('owned marker').digest('hex') };
    try {
        fs.writeFileSync(local, 'changed'); assert.throws(() => checkPersistence(input, io), /changed or disappeared/u);
        fs.unlinkSync(local); fs.symlinkSync(path.join(root, 'elsewhere'), local); assert.throws(() => checkPersistence(input, io));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a failed probe prints no success sentinel', () => {
    const script = fileURLToPath(new URL('./isolation.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [script, '--probe', 'symlink', '--robot', 'robot-a', '--victim', 'robot-b', '--workspace', '/fixture'], { encoding: 'utf8' });
    assert.equal(result.status, 1); assert.equal(result.stdout, '');
});
