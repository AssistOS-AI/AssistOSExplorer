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

// ---- Operator version pins (ROBOTEAM_{CODEX,OPENCODE,PI}_VERSION) ----

const PIN = '0.160.0';
const OTHER = '0.160.1';
const RUNTIME = process.versions.node;
const CODEX = '@openai/codex';

async function tempRoot(t, prefix = 'roboteam-pin-') {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    return root;
}

// Fake npm/CLI. `latest` is what `npm view` answers; the options make installs or `--version` probes fail.
function fakeExec({ latest = OTHER, failInstall = false, failProbe = false, calls = [] } = {}) {
    const execFileImpl = async (command, args) => {
        calls.push([command, ...args]);
        if (args[0] === 'view') return { stdout: JSON.stringify(latest), stderr: '' };
        if (args[0] === 'install') {
            if (failInstall) throw new Error('registry install failed');
            const prefix = args[args.indexOf('--prefix') + 1];
            const spec = args.at(-1);
            const executable = spec.startsWith(`${CODEX}@`) ? 'codex' : spec.startsWith('opencode-ai@') ? 'opencode' : 'pi';
            await writeExecutable(path.join(prefix, 'bin', executable));
        }
        if (args[0] === '--version' && failProbe) throw new Error('probe failed');
        return { stdout: '', stderr: '' };
    };
    return { execFileImpl, calls };
}

const views = (calls, packageName = CODEX) => calls.filter(call => call[1] === 'view' && call[2] === `${packageName}@latest`);
const installs = (calls) => calls.filter(call => call[1] === 'install');
const makeCache = (root, env, exec, extra = {}) => new ToolCache({ root, processEnv: { PATH: '/bin', ...env }, execFileImpl: exec.execFileImpl, log: () => {}, ...extra });
const identityOf = (version, runtime = RUNTIME) => ({ package: CODEX, version, runtime });
const generationOf = (version, runtime = RUNTIME) => toolCacheInternals.generationName(identityOf(version, runtime));

// Writes a stamped, executable codex generation and a current.json pointing at it, by hand.
async function seedGeneration(root, { version, runtime = RUNTIME, descriptorVersion = version, stampVersion = version, stamp = true, point = true }) {
    const generation = generationOf(version, runtime);
    const directory = path.join(root, 'codex', 'generations', generation);
    await writeExecutable(path.join(directory, 'bin', 'codex'));
    if (stamp) {
        await fs.writeFile(path.join(directory, 'stamp.json'), JSON.stringify({
            schema: toolCacheInternals.CACHE_SCHEMA, name: 'codex', generation, identity: identityOf(stampVersion, runtime), versions: { codex: stampVersion },
        }));
    }
    if (point) {
        await fs.writeFile(path.join(root, 'codex', 'current.json'), JSON.stringify({
            schema: toolCacheInternals.CACHE_SCHEMA, name: 'codex', generation, versions: { codex: descriptorVersion },
        }));
    }
    return directory;
}

test('T5 pin parsing: empty means unpinned, exact versions are accepted, everything else throws in the constructor', () => {
    const exec = fakeExec();
    const unpinned = [{}, { ROBOTEAM_CODEX_VERSION: '' }, { ROBOTEAM_CODEX_VERSION: undefined }];
    for (const env of unpinned) {
        assert.deepEqual(makeCache('/tmp/unused-pin-root', env, exec).versionPins, {});
        assert.deepEqual({ ...toolCacheInternals.codingAgentVersionPins(env) }, {});
    }
    for (const value of [PIN, '0.0.0', '999999.0.0', '1.2.3-rc.1', '1.2.3-beta-2', '1.2.3-0', '1.2.3-rc.0', '1.2.3-0a', '1.2.3--', '10.20.30']) {
        assert.equal(makeCache('/tmp/unused-pin-root', { ROBOTEAM_CODEX_VERSION: value }, exec).versionPins.codex, value);
    }
    const bad = ['latest', '^0.160.0', '~0.160.0', '0.160', '0', 'v0.160.0', ' 0.160.0', '0.160.0 ', '0.160.0\n', '0.160.0;x', '0.160.0+build',
        '１.160.0', '０.160.0', '0.160.0-', '0.160.00', '00.160.0', '01.2.3', '1.2.3-', '1.2.3-a..b', '1.2.3-a.', '1.2.3-.a', '1.2.3-01', '1.2.3-rc.01', '1.2.3-rc_1', '>=0.160.0', '0.160.x', '1.2.3-' + 'a'.repeat(60), 'a'.repeat(200)];
    for (const variable of ['ROBOTEAM_CODEX_VERSION', 'ROBOTEAM_OPENCODE_VERSION', 'ROBOTEAM_PI_VERSION']) {
        for (const value of bad) {
            assert.throws(() => makeCache('/tmp/unused-pin-root', { [variable]: value }, exec), { name: 'TypeError', message: `invalid ${variable}` }, `${variable}=${JSON.stringify(value)}`);
        }
    }
    assert.throws(() => makeCache('/tmp/unused-pin-root', { ROBOTEAM_CODEX_VERSION: PIN }, exec, { versionPins: { codex: 'latest' } }), /invalid ROBOTEAM_CODEX_VERSION/);
    assert.throws(() => makeCache('/tmp/unused-pin-root', {}, exec, { versionPins: { codex: PIN, claude: PIN } }), { name: 'TypeError', message: 'unknown version pin: claude' });
    assert.equal(makeCache('/tmp/unused-pin-root', {}, exec, { versionPins: { pi: '2.0.0' } }).versionPins.pi, '2.0.0');
    assert.ok(Object.isFrozen(toolCacheInternals.codingAgentVersionPins({ ROBOTEAM_CODEX_VERSION: PIN })));
});

test('T5 a bad pin fails before any tool preparation runs', async (t) => {
    const root = await tempRoot(t);
    const exec = fakeExec();
    assert.throws(() => makeCache(root, { ROBOTEAM_PI_VERSION: 'latest' }, exec), /invalid ROBOTEAM_PI_VERSION/);
    assert.equal(exec.calls.length, 0);
    await assert.rejects(fs.access(path.join(root, 'codex')), { code: 'ENOENT' });
});

test('T1/T2 a pinned coding agent skips npm view, installs the exact version and keeps the generation identity', async (t) => {
    const root = await tempRoot(t);
    const exec = fakeExec({ latest: OTHER });
    const cache = makeCache(root, { ROBOTEAM_CODEX_VERSION: PIN }, exec);
    const result = await cache.prepareCodingAgent('codex');
    assert.equal(views(exec.calls).length, 0);
    assert.equal(installs(exec.calls).length, 1);
    assert.equal(installs(exec.calls)[0].at(-1), `${CODEX}@${PIN}`);
    assert.deepEqual(result.versions, { codex: PIN });
    assert.equal(result.path, path.join(root, 'codex', 'generations', generationOf(PIN)));
    const stamp = JSON.parse(await fs.readFile(path.join(result.path, 'stamp.json'), 'utf8'));
    assert.deepEqual(stamp.identity, identityOf(PIN));
    assert.deepEqual(stamp.versions, { codex: PIN });
    const current = JSON.parse(await fs.readFile(path.join(root, 'codex', 'current.json'), 'utf8'));
    assert.deepEqual(current, { schema: toolCacheInternals.CACHE_SCHEMA, name: 'codex', generation: generationOf(PIN), versions: { codex: PIN } });
    // The identity hashes exactly as in the accepted qualification run (Node 24.18.1).
    assert.equal(toolCacheInternals.generationName({ package: CODEX, version: PIN, runtime: '24.18.1' }).slice(0, 12), '4766a1b2276f');
});

test('T1 a pin affects only its own coding agent', async (t) => {
    const root = await tempRoot(t);
    const exec = fakeExec({ latest: '5.4.3' });
    const cache = makeCache(root, { ROBOTEAM_OPENCODE_VERSION: '1.2.3' }, exec);
    const agents = await cache.prepareCodingAgents(['codex', 'opencode', 'pi']);
    assert.equal(agents.opencode.versions.opencode, '1.2.3');
    assert.equal(agents.codex.versions.codex, '5.4.3');
    assert.equal(agents.pi.versions.pi, '5.4.3');
    assert.equal(views(exec.calls, 'opencode-ai').length, 0);
    assert.equal(views(exec.calls).length, 1);
    assert.equal(views(exec.calls, '@earendil-works/pi-coding-agent').length, 1);
});

test('T3 unpinned and empty-pin behaviour is unchanged: one view lookup, newest version installed, same identity', async (t) => {
    const root = await tempRoot(t);
    const exec = fakeExec({ latest: OTHER });
    const cache = makeCache(root, { ROBOTEAM_CODEX_VERSION: '' }, exec);
    const [first, second] = await Promise.all([cache.prepareCodex(), cache.prepareCodingAgent('codex')]);
    assert.equal(first.path, second.path);
    assert.equal(views(exec.calls).length, 1);
    assert.equal(first.versions.codex, OTHER);
    assert.equal(installs(exec.calls)[0].at(-1), `${CODEX}@${OTHER}`);
    assert.equal(first.path, path.join(root, 'codex', 'generations', generationOf(OTHER)));
});

test('a pin and the same version resolved from upstream yield the identical generation', async (t) => {
    const root = await tempRoot(t);
    const viaLatest = await makeCache(root, {}, fakeExec({ latest: PIN })).prepareCodex();
    const exec = fakeExec({ latest: OTHER });
    const viaPin = await makeCache(root, { ROBOTEAM_CODEX_VERSION: PIN }, exec).prepareCodex();
    assert.equal(viaPin.path, viaLatest.path);
    assert.equal(installs(exec.calls).length, 0);
});

test('T4 pinned install failure enters the fallback and reuses a stamped generation of the same version', async (t) => {
    const root = await tempRoot(t);
    const ok = await makeCache(root, { ROBOTEAM_CODEX_VERSION: PIN }, fakeExec()).prepareCodex();
    // Same-version generation exists, but it cannot pass validation now and the reinstall fails: the fallback path is taken.
    const messages = [];
    const exec = fakeExec({ failInstall: true, failProbe: true });
    const cache = makeCache(root, { ROBOTEAM_CODEX_VERSION: PIN }, exec, { log: message => messages.push(message) });
    const result = await cache.prepareCodex();
    assert.equal(installs(exec.calls).length, 1, 'the normal path was attempted and failed before falling back');
    assert.equal(result.fallback, true);
    assert.equal(result.path, ok.path);
    assert.deepEqual(result.versions, { codex: PIN });
    assert.ok(messages.some(message => message.includes('update unavailable (registry install failed)')));
    assert.equal(views(exec.calls).length, 0);
});

test('T4 pinned fallback may reuse a same-version generation built under another runtime', async (t) => {
    const root = await tempRoot(t);
    const directory = await seedGeneration(root, { version: PIN, runtime: '0.0.1-other-runtime' });
    const exec = fakeExec({ failInstall: true });
    const result = await makeCache(root, { ROBOTEAM_CODEX_VERSION: PIN }, exec).prepareCodex();
    assert.equal(installs(exec.calls).length, 1);
    assert.equal(result.fallback, true);
    assert.equal(result.path, directory);
    assert.notEqual(path.basename(directory), generationOf(PIN));
});

test('T4 pinned fallback rejects a cache that only holds a different version', async (t) => {
    const root = await tempRoot(t);
    await makeCache(root, {}, fakeExec({ latest: OTHER })).prepareCodex();
    const exec = fakeExec({ failInstall: true });
    const cache = makeCache(root, { ROBOTEAM_CODEX_VERSION: PIN }, exec);
    await assert.rejects(cache.prepareCodex(), /could not prepare codex tools: registry install failed; no valid fallback cache: cached generation is not the pinned codex version 0\.160\.0/);
    assert.equal(views(exec.calls).length, 0);
    // The same cache still serves an unpinned instance: only the pin removes the cross-version fallback.
    const offline = await makeCache(root, {}, { execFileImpl: async () => { throw new Error('offline'); } }).prepareCodex();
    assert.equal(offline.fallback, true);
    assert.deepEqual(offline.versions, { codex: OTHER });
});

test('T4 pinned fallback refuses mismatched descriptors, mismatched stamps, missing stamps and malformed current.json', async (t) => {
    const cases = {
        'descriptor names another version': { version: PIN, descriptorVersion: OTHER },
        'stamp names another version': { version: PIN, stampVersion: OTHER },
        'generation has no stamp': { version: PIN, stamp: false },
    };
    for (const [label, seed] of Object.entries(cases)) {
        const root = await tempRoot(t);
        await seedGeneration(root, seed);
        const exec = fakeExec({ failInstall: true, failProbe: true });
        await assert.rejects(makeCache(root, { ROBOTEAM_CODEX_VERSION: PIN }, exec).prepareCodex(), /no valid fallback cache/, label);
    }
    const root = await tempRoot(t);
    await seedGeneration(root, { version: PIN });
    await fs.writeFile(path.join(root, 'codex', 'current.json'), '{not json');
    await assert.rejects(makeCache(root, { ROBOTEAM_CODEX_VERSION: PIN }, fakeExec({ failInstall: true, failProbe: true })).prepareCodex(), /no valid fallback cache/);
});

test('pinned fallback does not weaken the unpinned stamped-generation fallback', async (t) => {
    const root = await tempRoot(t);
    const directory = await seedGeneration(root, { version: OTHER });
    const result = await makeCache(root, {}, { execFileImpl: async () => { throw new Error('offline'); } }).prepareCodex();
    assert.equal(result.fallback, true);
    assert.equal(result.path, directory);
    const unstamped = await tempRoot(t);
    await seedGeneration(unstamped, { version: OTHER, stamp: false });
    await assert.rejects(makeCache(unstamped, {}, { execFileImpl: async () => { throw new Error('offline'); } }).prepareCodex(), /no valid fallback cache/);
});

test('orphan pin: a version that cannot be installed errors clearly and creates no generation of another version', async (t) => {
    const root = await tempRoot(t);
    const exec = fakeExec({ latest: OTHER, failInstall: true });
    const cache = makeCache(root, { ROBOTEAM_CODEX_VERSION: '0.0.0-doesnotexist' }, exec);
    await assert.rejects(cache.prepareCodex(), /could not prepare codex tools: registry install failed; no valid fallback cache/);
    assert.equal(views(exec.calls).length, 0);
    assert.deepEqual(await fs.readdir(path.join(root, 'codex', 'generations')), []);
    await assert.rejects(fs.access(path.join(root, 'codex', 'current.json')), { code: 'ENOENT' });
});

test('T6 separate instances with the same pin on one root agree and install once', async (t) => {
    const root = await tempRoot(t);
    const exec = fakeExec();
    const env = { ROBOTEAM_CODEX_VERSION: PIN };
    const first = await makeCache(root, env, exec).prepareCodex();
    const second = await makeCache(root, env, exec).prepareCodex();
    assert.equal(second.path, first.path);
    assert.equal(installs(exec.calls).length, 1);
    assert.equal(views(exec.calls).length, 0);
});

test('concurrent pinned preparation from two instances converges on one valid generation', async (t) => {
    const root = await tempRoot(t);
    const exec = fakeExec();
    const env = { ROBOTEAM_CODEX_VERSION: PIN };
    const [a, b] = await Promise.all([makeCache(root, env, exec).prepareCodex(), makeCache(root, env, exec).prepareCodex()]);
    assert.equal(a.path, b.path);
    assert.equal(a.path, path.join(root, 'codex', 'generations', generationOf(PIN)));
    assert.ok(installs(exec.calls).length >= 1 && installs(exec.calls).length <= 2);
    assert.equal(views(exec.calls).length, 0);
    assert.deepEqual(await fs.readdir(path.join(root, 'codex', 'generations')), [generationOf(PIN)]);
    const current = JSON.parse(await fs.readFile(path.join(root, 'codex', 'current.json'), 'utf8'));
    assert.deepEqual(current.versions, { codex: PIN });
});

test('T7 shell selection for a pinned codex resolves into the pinned generation', async (t) => {
    const root = await tempRoot(t);
    const exec = fakeExec({ latest: OTHER });
    const env = { ROBOTEAM_CODEX_VERSION: PIN };
    const shell = await makeCache(root, env, exec).prepareShellTools(['codex']);
    const real = await fs.realpath(path.join(shell.binPath, 'codex'));
    const generations = await fs.realpath(path.join(root, 'codex', 'generations', generationOf(PIN)));
    assert.ok(real.startsWith(generations + path.sep), `${real} is under ${generations}`);
    assert.equal(shell.agents.codex.versions.codex, PIN);
    assert.equal(views(exec.calls).length, 0);
    // A second, separate instance (a robot CLI start) selects the same launcher and installs nothing more.
    const again = await makeCache(root, env, exec).prepareShellTools(['codex']);
    assert.equal(await fs.realpath(path.join(again.binPath, 'codex')), real);
    assert.equal(again.path, shell.path);
    assert.equal(installs(exec.calls).length, 1);
});

test('idempotency: repeated warm-ups and shell selections from separate instances give one install and one generation', async (t) => {
    const root = await tempRoot(t);
    const exec = fakeExec({ latest: '5.4.3' });
    const env = { ROBOTEAM_CODEX_VERSION: PIN };
    const caches = [makeCache(root, env, exec), makeCache(root, env, exec)];
    for (const cache of caches) { await cache.prepareShellTools(['codex']); await cache.prepareShellTools(['codex']); }
    assert.equal(installs(exec.calls).filter(call => call.at(-1).startsWith(`${CODEX}@`)).length, 1);
    assert.deepEqual(await fs.readdir(path.join(root, 'codex', 'generations')), [generationOf(PIN)]);
});
