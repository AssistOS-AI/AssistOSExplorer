import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { argumentsFrom, assertDeniedPaths, runIsolationProbe, victimPaths, SENTINEL } from './isolation.mjs';
import { checkPersistence } from './persistence.mjs';

const options = { robot: 'robot-a', victim: 'robot-b', workspace: '/fixture' };
const denied = () => { throw Object.assign(new Error('absent'), { code: 'ENOENT' }); };

test('path probe rejects readable and writable sibling paths, including proc aliases', async () => {
    const files = victimPaths({ ...options, servicePid: 42 });
    assert.equal(files.length, 5);
    assert.ok(files.includes('/proc/42/root/data/robots/robot-b/home/marker-B'));
    for (const admitted of ['r', 'r+']) {
        assert.throws(() => assertDeniedPaths(files, { openSync: (file, flags) => flags === admitted ? 9 : denied(), closeSync() {} }), /Protected path admitted/u);
    }
    const result = await runIsolationProbe({ ...options, probe: 'paths' }, {
        io: { openSync: denied }, run: async () => ({ stdout: '' }),
    });
    assert.equal(result.sentinel, SENTINEL); assert.equal(result.checks.length, 2);
    await assert.rejects(runIsolationProbe({ ...options, probe: 'paths' }, {
        io: { openSync: denied }, run: async () => ({ stdout: '/leaked/marker-B\n' }),
    }));
});

test('unexpected I/O errors and missing controls never count as isolation', async () => {
    assert.throws(() => assertDeniedPaths(['/victim'], { openSync() { throw new Error('broken reader'); } }));
    await assert.rejects(runIsolationProbe({ ...options, probe: 'gui' }), /requires/u);
    await assert.rejects(runIsolationProbe({ ...options, probe: 'symlink' }), /controller acceptance/u);
    assert.throws(() => argumentsFrom(['--probe']), /needs a value/u);
    assert.throws(() => argumentsFrom(['--probe', 'paths', '--probe', 'proc']), /Duplicate/u);
});

test('service probe fails on leaked credentials and unsigned successful calls', async () => {
    const common = { run: async () => ({ stdout: '' }), request: async () => ({ status: 403 }), env: {} };
    await assert.rejects(runIsolationProbe({ ...options, probe: 'service', router: 'http://router/tool' }, {
        ...common, env: { PLOINKY_AGENT_SECRET: 'synthetic' },
    }));
    await assert.rejects(runIsolationProbe({ ...options, probe: 'service', router: 'http://router/tool' }, {
        ...common, request: async () => ({ status: 200 }),
    }));
    const result = await runIsolationProbe({ ...options, probe: 'service', router: 'http://router/tool' }, common);
    assert.equal(result.checks.length, 3);
});

test('GUI probe requires all forbidden ports to refuse and its own port to answer', async () => {
    const input = { ...options, probe: 'gui', denied: 'http://127.0.0.1:7000,http://127.0.0.1:3001', own: 'http://127.0.0.1:4567' };
    const run = async (_command, args) => {
        if (args.at(-1) === input.own) return { stdout: '' };
        throw Object.assign(new Error('refused'), { code: 7 });
    };
    assert.equal((await runIsolationProbe(input, { run })).checks.length, 3);
    await assert.rejects(runIsolationProbe(input, { run: async () => ({ stdout: '' }) }));
    await assert.rejects(runIsolationProbe(input, { run: async () => { throw Object.assign(new Error('timeout'), { code: 28 }); } }));
});

test('masks probe walks every level from the workspace root to the working folder', async () => {
    const view = tree => ({
        lstatSync: file => { if (tree[path.posix.dirname(file)]?.includes(path.posix.basename(file))) return {}; throw denied(); },
        readdirSync: dir => tree[dir] ?? denied(), openSync: () => 9, closeSync() {},
    });
    const probe = (tree, control) => runIsolationProbe({ ...options, probe: 'masks', control }, { io: view(tree) });
    assert.equal((await probe({ '/fixture': ['app'], '/fixture/app': ['x'] }, '/fixture/app/control')).checks.length, 5);
    assert.equal((await probe({ '/fixture': ['a'], '/fixture/a': ['b'], '/fixture/a/b': ['c'] }, '/fixture/a/b/control')).checks.length, 5);
    await assert.rejects(probe({ '/fixture': ['app', 'sibling'] }, '/fixture/app/control'), /Unexpected entries in \/fixture/u);
    await assert.rejects(probe({ '/fixture': ['a'], '/fixture/a': ['b', 'other'], '/fixture/a/b': [] }, '/fixture/a/b/control'), /Unexpected entries in \/fixture\/a/u);
    await assert.rejects(probe({ '/fixture': ['app', '.data'] }, '/fixture/app/control'));
    await assert.rejects(probe({ '/fixture': ['app'] }, undefined), /control file/u);
    await assert.rejects(probe({ '/fixture': ['control'] }, '/fixture/control'), /control file/u);
    await assert.rejects(probe({ '/fixture': ['app'] }, '/elsewhere/control'), /control file/u);
});

test('fd probe detects an inherited non-CLOEXEC descriptor', async () => {
    const standard = 'lr-x------ 1 root root 64 Oct 1 00:00 0 -> /dev/null\nl-wx------ 1 root root 64 Oct 1 00:00 1 -> pipe:[123]\nl-wx------ 1 root root 64 Oct 1 00:00 2 -> pipe:[124]\nlr-x------ 1 root root 64 Oct 1 00:00 3 -> /proc/123/fd\n';
    await runIsolationProbe({ ...options, probe: 'fds' }, { run: async () => ({ stdout: standard }) });
    await assert.rejects(runIsolationProbe({ ...options, probe: 'fds' }, { run: async () => ({ stdout: standard + 'lr-x------ 1 root root 64 Oct 1 00:00 9 -> /data/robots/robot-b/home/marker-B\n' }) }));
});

test('persistence checks exact bytes, refuses symlinks and requires an explicit lifecycle stage', () => {
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
        assert.equal(checkPersistence(input, io).stage, 'restart');
        fs.writeFileSync(local, 'changed'); assert.throws(() => checkPersistence(input, io), /changed or disappeared/u);
        fs.unlinkSync(local); fs.symlinkSync(path.join(root, 'elsewhere'), local); assert.throws(() => checkPersistence(input, io));
        assert.throws(() => checkPersistence({ ...input, stage: 'claimed' }, io));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('CLI failure has no success sentinel, including an unsupported controller-only probe', () => {
    const script = fileURLToPath(new URL('./isolation.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [script, '--probe', 'symlink', '--robot', 'robot-a', '--victim', 'robot-b', '--workspace', '/fixture'], { encoding: 'utf8' });
    assert.equal(result.status, 1); assert.equal(result.stdout, ''); assert.match(result.stderr, /controller acceptance/u);
});
