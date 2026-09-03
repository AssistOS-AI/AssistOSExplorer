import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ToolCache, toolCacheInternals } from '../server/tool-cache.mjs';

async function writeExecutable(filePath) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    await fs.chmod(filePath, 0o755);
}

test('prepares Codex once and reuses the persistent generation', async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'roboteam-tool-cache-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const calls = [];
    const execFileImpl = async (command, args, options) => {
        calls.push([command, ...args]);
        if (args[0] === 'view' || args[0] === 'install' || args[0] === '--version') {
            assert.equal(options.env.NODE_OPTIONS, undefined);
        }
        if (args[0] === 'view') return { stdout: '"9.8.7"\n', stderr: '' };
        if (args[0] === 'install') {
            const prefix = args[args.indexOf('--prefix') + 1];
            assert.ok(args.includes('--global'));
            await writeExecutable(path.join(prefix, 'bin', 'codex'));
        }
        return { stdout: '', stderr: '' };
    };
    const cache = new ToolCache({ root, execFileImpl, processEnv: { PATH: '/bin', NODE_OPTIONS: '--preserve-symlinks-main' }, log: () => {} });

    const [first, simultaneous] = await Promise.all([cache.prepareCodex(), cache.prepareCodex()]);
    assert.equal(first.path, simultaneous.path);
    assert.equal(first.versions.codex, '9.8.7');
    assert.equal(calls.filter((call) => call[1] === 'view').length, 1);
    assert.equal(calls.filter((call) => call[1] === 'install').length, 1);

    const offline = new ToolCache({
        root,
        execFileImpl: async () => { throw new Error('offline'); },
        log: () => {},
    });
    const fallback = await offline.prepareCodex();
    assert.equal(fallback.path, first.path);
    assert.equal(fallback.fallback, true);
});

test('removes Ploinky symlink options only from managed tool processes', () => {
    const source = { PATH: '/usr/local/bin:/usr/bin', NODE_OPTIONS: '--preserve-symlinks --preserve-symlinks-main', KEEP: 'yes' };
    const sanitized = toolCacheInternals.toolProcessEnv(source);
    assert.deepEqual(sanitized, { PATH: source.PATH, KEEP: 'yes' });
    assert.equal(source.NODE_OPTIONS, '--preserve-symlinks --preserve-symlinks-main');
});

test('prepares desktop npm and binary tools outside the image', async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'roboteam-desktop-cache-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const payload = Buffer.from('#!/bin/sh\nexit 0\n');
    const podmanRuns = [];
    const execFileImpl = async (_command, args) => {
        if (args[0] === 'view') return { stdout: '"7.6.5"\n', stderr: '' };
        if (args[0] === 'run') podmanRuns.push(args);
        if (args[0] === 'run' && args.includes('/usr/local/bin/npm')) {
            const volume = args[args.indexOf('-v') + 1].split(':')[0];
            await writeExecutable(path.join(volume, 'node_modules', '.bin', 'supergateway'));
        }
        return { stdout: '', stderr: '' };
    };
    const fetchImpl = async (url) => {
        if (String(url).includes('/releases/latest')) {
            return {
                ok: true,
                json: async () => ({
                    tag_name: 'v6.5.4',
                    assets: [{
                        name: 'computer-use-linux-x86_64-unknown-linux-gnu',
                        browser_download_url: 'https://downloads.invalid/computer-use-linux',
                    }],
                }),
            };
        }
        return { ok: true, arrayBuffer: async () => payload };
    };
    const cache = new ToolCache({ root, execFileImpl, fetchImpl, arch: 'x64', log: () => {} });

    const desktop = await cache.prepareMode('desktop');
    assert.deepEqual(desktop.versions, { supergateway: '7.6.5', computerUseLinux: '6.5.4' });
    assert.ok(podmanRuns.length >= 3);
    assert.ok(podmanRuns.every((args) => args.includes('--ipc') && args[args.indexOf('--ipc') + 1] === 'none'));
    assert.equal(await fs.readFile(path.join(desktop.path, 'computer-use-linux'), 'utf8'), payload.toString());
    assert.equal(await fs.readFile(path.join(desktop.path, 'stamp.json'), 'utf8').then((value) => JSON.parse(value).schema), 'roboteam-tool-cache-v1');
});
