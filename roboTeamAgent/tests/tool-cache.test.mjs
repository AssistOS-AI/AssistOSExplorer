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

test('startup warms every tool and concurrent requests reuse the same installations', async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'roboteam-startup-cache-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const installs = [];
    const cache = new ToolCache({
        root, arch: 'x64', log: () => {},
        execFileImpl: async (_command, args) => {
            if (args[0] === 'view') return { stdout: '"1.2.3"' };
            if (args[0] === 'install') {
                installs.push(args.at(-1));
                const prefix = args[args.indexOf('--prefix') + 1];
                const definition = Object.values(toolCacheInternals.CODING_AGENT_PACKAGES)
                    .find(value => args.at(-1) === `${value.packageName}@1.2.3`);
                await writeExecutable(path.join(prefix, 'bin', definition.executable));
            } else if (args[0] === 'run' && args.includes('/usr/local/bin/npm')) {
                installs.push(args.at(-1));
                const prefix = args[args.indexOf('-v') + 1].slice(0, -':/install'.length);
                const executable = args.at(-1).startsWith('@playwright/mcp@') ? 'playwright-mcp' : 'supergateway';
                await writeExecutable(path.join(prefix, 'node_modules', '.bin', executable));
            }
            return { stdout: '', stderr: '' };
        },
        fetchImpl: async url => String(url).includes('/releases/latest') ? {
            ok: true,
            json: async () => ({ tag_name: 'v1.2.3', assets: [{
                name: 'computer-use-linux-x86_64-unknown-linux-gnu',
                browser_download_url: 'https://downloads.invalid/computer-use-linux',
            }] }),
        } : { ok: true, arrayBuffer: async () => Buffer.from('#!/bin/sh\nexit 0\n') },
    });
    const [results, desktop, browser, shell] = await Promise.all([
        cache.warmup(), cache.prepareMode('desktop'), cache.prepareMode('browser'), cache.prepareShellTools(),
    ]);
    assert.ok(results.every(result => result.status === 'fulfilled'));
    assert.equal(results[0].value, shell);
    assert.equal(results[1].value, desktop);
    assert.equal(results[2].value, browser);
    assert.deepEqual(installs.sort(), [
        '@earendil-works/pi-coding-agent@1.2.3', '@openai/codex@1.2.3',
        '@playwright/mcp@1.2.3', 'opencode-ai@1.2.3', 'supergateway@1.2.3',
    ]);
    await fs.access(path.join(desktop.path, 'computer-use-linux'));
    for (const name of ['codex', 'opencode', 'pi']) await fs.access(path.join(shell.binPath, name));
    await cache.warmup();
    assert.equal(installs.length, 5);
});

test('startup failure leaves other families available and failed preparation can retry', async () => {
    const messages = [];
    const cache = new ToolCache({ log: message => messages.push(message) });
    let attempts = 0;
    cache.prepareShellTools = async () => ({ agents: {} });
    cache._prepareDesktop = async () => ({ path: '/cache/desktop' });
    cache._prepareBrowser = async () => {
        if (++attempts === 1) throw new Error('registry unavailable');
        return { path: '/cache/browser' };
    };
    const results = await cache.warmup();
    assert.deepEqual(results.map(result => result.status), ['fulfilled', 'fulfilled', 'rejected']);
    assert.ok(messages.some(message => message.includes('startup browser preparation failed: registry unavailable')));
    assert.deepEqual(await cache.prepareMode('desktop'), { path: '/cache/desktop' });
    assert.deepEqual(await cache.prepareMode('browser'), { path: '/cache/browser' });
    assert.equal(attempts, 2);
});

test('prepares coding agents once and reuses persistent generations', async (t) => {
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
            const packageSpec = args.at(-1);
            assert.ok(args.includes('--global'));
            const executable = packageSpec.startsWith('@openai/codex@')
                ? 'codex'
                : packageSpec.startsWith('opencode-ai@') ? 'opencode' : 'pi';
            await writeExecutable(path.join(prefix, 'bin', executable));
        }
        return { stdout: '', stderr: '' };
    };
    const cache = new ToolCache({ root, execFileImpl, processEnv: { PATH: '/bin', NODE_OPTIONS: '--preserve-symlinks-main' }, log: () => {} });

    const [first, simultaneous] = await Promise.all([cache.prepareCodex(), cache.prepareCodingAgent('codex')]);
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

    const agents = await cache.prepareCodingAgents(['opencode', 'pi']);
    assert.equal(agents.opencode.versions.opencode, '9.8.7');
    assert.equal(agents.pi.versions.pi, '9.8.7');
    assert.equal(await fs.access(path.join(agents.opencode.binPath, 'opencode')).then(() => true), true);
    assert.equal(await fs.access(path.join(agents.pi.binPath, 'pi')).then(() => true), true);
    assert.throws(() => cache.prepareCodingAgent('unknown'), /unsupported coding agent/);
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
