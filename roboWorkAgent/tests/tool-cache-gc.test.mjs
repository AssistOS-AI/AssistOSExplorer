import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ToolCache, toolCacheInternals } from '../server/tool-cache.mjs';

const { CACHE_SCHEMA, IN_PLACE_LOCK_STALE_MS } = toolCacheInternals;
const NOW = Date.UTC(2026, 10, 23, 12, 0, 0);
const MINUTE = 60 * 1000;
const PLUGIN = '@opencode/plugin';

// A 64-digit lowercase hexadecimal generation name for a number or a repeated digit.
const gen = value => (typeof value === 'number' ? value.toString(16).padStart(64, '0') : value.repeat(64));
const exists = target => fs.lstat(target).then(() => true, () => false);

async function fixture(t, options = {}) {
    const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rw-gc-')));
    t.after(() => fs.rm(base, { recursive: true, force: true }));
    const root = path.join(base, 'tool-cache');
    await fs.mkdir(root);
    const lines = [];
    const cache = new ToolCache({ root, log: line => lines.push(line), now: () => NOW, versionPins: {}, ...options });
    return { base, root, lines, cache, terminals: path.join(base, 'server-state', 'terminal') };
}

// Runs the startup pass, then the cleanup that main.mjs runs after listen.
async function collect(f, options = {}) {
    const collection = await f.cache.collectGarbage({ terminalStateDir: f.terminals, ...options });
    return collection.cleanup;
}

async function makeGeneration(root, bundle, generation, { versions = {}, identity, stamp = true } = {}) {
    const directory = path.join(root, bundle, 'generations', generation);
    await fs.mkdir(path.join(directory, 'bin'), { recursive: true });
    if (stamp) {
        await fs.writeFile(path.join(directory, 'stamp.json'), JSON.stringify({ schema: CACHE_SCHEMA, name: bundle, generation, versions, ...(identity ? { identity } : {}) }));
    }
    return directory;
}

async function setCurrent(root, bundle, generation, raw) {
    await fs.mkdir(path.join(root, bundle), { recursive: true });
    await fs.writeFile(path.join(root, bundle, 'current.json'), raw ?? JSON.stringify({ schema: CACHE_SCHEMA, name: bundle, generation, versions: {} }));
}

// A shell generation whose bin/ links to the given agent generations, as prepareShellTools writes it.
async function makeShell(root, shell, links = {}) {
    const directory = path.join(root, 'shell-generations', shell);
    await fs.mkdir(path.join(directory, 'bin'), { recursive: true });
    for (const [executable, [bundle, generation]] of Object.entries(links)) {
        await fs.symlink(path.relative(path.join(directory, 'bin'), path.join(root, bundle, 'generations', generation, 'bin', executable)), path.join(directory, 'bin', executable));
    }
    return directory;
}

const viewLink = (root, name, shell) => fs.symlink(path.join('shell-generations', shell), path.join(root, name));
async function selectionLink(root, name, shell) {
    await fs.mkdir(path.join(root, 'shell-selections'), { recursive: true });
    await fs.symlink(path.join('..', 'shell-generations', shell), path.join(root, 'shell-selections', name));
}

async function age(target, minutes) {
    const date = new Date(NOW - minutes * MINUTE);
    await fs.lutimes(target, date, date);
}

const names = directory => fs.readdir(directory).catch(() => []);

test('T1: the current generation stays, a superseded one is renamed into the trash and deleted by the cleanup', async (t) => {
    const f = await fixture(t);
    const a = await makeGeneration(f.root, 'codex', gen(1), { versions: { codex: '1.0.0' } });
    const b = await makeGeneration(f.root, 'codex', gen(2), { versions: { codex: '0.9.0' } });
    await setCurrent(f.root, 'codex', gen(1));
    const cleanup = await collect(f);
    assert.equal(await exists(a), true);
    assert.equal(await exists(b), false);
    assert.equal((await names(path.join(f.root, '.trash'))).length, 1, 'the victim waits in the trash until the cleanup');
    assert.ok(f.lines.includes(`[tool-cache] removed codex generation ${gen(2).slice(0, 12)}`), f.lines.join('\n'));
    await cleanup();
    assert.deepEqual(await names(path.join(f.root, '.trash')), []);
    assert.equal(await exists(path.join(f.root, 'codex', 'current.json')), true);
    // An immediate second pass removes nothing.
    f.lines.length = 0;
    await (await collect(f))();
    assert.equal(await exists(a), true);
    assert.deepEqual(f.lines.filter(line => line.includes('removed')), []);
    assert.deepEqual(await names(path.join(f.root, '.trash')), []);
});

test('T2: view-linked generations stay and an orphan shell generation goes, with every view unchanged', async (t) => {
    const f = await fixture(t);
    const claudeA = await makeGeneration(f.root, 'claude', gen(1));
    const claudeB = await makeGeneration(f.root, 'claude', gen(2));
    const claudeC = await makeGeneration(f.root, 'claude', gen(3));
    await setCurrent(f.root, 'claude', gen(1));
    const s1 = await makeShell(f.root, gen(10), { claude: ['claude', gen(2)] });
    const s2 = await makeShell(f.root, gen(11), { claude: ['claude', gen(3)] });
    await viewLink(f.root, 'shell-claude', gen(10));
    await selectionLink(f.root, 'shell-claude', gen(10));
    const before = { root: await fs.readlink(path.join(f.root, 'shell-claude')), selection: await fs.readlink(path.join(f.root, 'shell-selections', 'shell-claude')) };
    await (await collect(f))();
    for (const kept of [claudeA, claudeB, s1]) assert.equal(await exists(kept), true, kept);
    for (const gone of [s2, claudeC]) assert.equal(await exists(gone), false, gone);
    assert.deepEqual({ root: await fs.readlink(path.join(f.root, 'shell-claude')), selection: await fs.readlink(path.join(f.root, 'shell-selections', 'shell-claude')) }, before);
    assert.equal(await exists(path.join(f.root, 'shell-claude', 'bin', 'claude')), true, 'the kept view still resolves its agent');
});

test('T2b: the plain shell view and a selection alone keep their generations; a view to a missing shell generation is skipped', async (t) => {
    const f = await fixture(t);
    const codexA = await makeGeneration(f.root, 'codex', gen(1));
    const codexB = await makeGeneration(f.root, 'codex', gen(2));
    const codexC = await makeGeneration(f.root, 'codex', gen(3));
    await setCurrent(f.root, 'codex', gen(1));
    const viaView = await makeShell(f.root, gen(10), { codex: ['codex', gen(2)] });
    const viaSelection = await makeShell(f.root, gen(11), { codex: ['codex', gen(3)] });
    await viewLink(f.root, 'shell', gen(10));
    await selectionLink(f.root, 'shell-codex', gen(11));
    // A dangling view, and a bin link to a generation that no longer exists.
    await viewLink(f.root, 'shell-gone', gen(99));
    await fs.symlink('../../codex/generations/' + gen(77) + '/bin/codex', path.join(viaView, 'bin', 'orphan'));
    const stray = await makeGeneration(f.root, 'codex', gen(4));
    await collect(f);
    for (const kept of [codexA, codexB, codexC, viaView, viaSelection]) assert.equal(await exists(kept), true, kept);
    assert.equal(await exists(stray), false);
    assert.equal(f.lines.some(line => line.includes('skipped')), false, f.lines.join('\n'));
});

test('T3: an OpenCode plugin template stays for the version of each retained OpenCode generation', async (t) => {
    const f = await fixture(t);
    await makeGeneration(f.root, 'opencode', gen(1), { versions: { opencode: '1.2.0' } });
    await makeGeneration(f.root, 'opencode', gen(2), { versions: { opencode: '1.1.0' } });
    await makeGeneration(f.root, 'opencode', gen(3), { versions: { opencode: '0.9.0' } });
    await setCurrent(f.root, 'opencode', gen(1));
    // 1.1.0 is retained through a shell view only.
    await makeShell(f.root, gen(10), { opencode: ['opencode', gen(2)] });
    await selectionLink(f.root, 'shell', gen(10));
    const plugin = (n, version) => makeGeneration(f.root, 'opencode-plugin', gen(n), { identity: { package: PLUGIN, version } });
    const p12 = await plugin(21, '1.2.0'), p11 = await plugin(22, '1.1.0'), p10 = await plugin(23, '1.0.0'), p09 = await plugin(24, '0.9.0');
    await (await collect(f))();
    assert.equal(await exists(p12), true);
    assert.equal(await exists(p11), true);
    assert.equal(await exists(p10), false);
    assert.equal(await exists(p09), false, 'the 0.9.0 OpenCode generation is superseded, so its template goes too');
    assert.equal(await exists(path.join(f.root, 'opencode', 'generations', gen(3))), false);
});

test('T3b: a retained OpenCode generation with an unreadable version keeps every plugin template', async (t) => {
    const f = await fixture(t);
    await makeGeneration(f.root, 'opencode', gen(1), { stamp: false });
    await setCurrent(f.root, 'opencode', gen(1));
    const plugin = await makeGeneration(f.root, 'opencode-plugin', gen(21), { identity: { package: PLUGIN, version: '0.0.1' } });
    await collect(f);
    assert.equal(await exists(plugin), true);
});

test('T8: generations a terminal descriptor names stay, and bad or hidden descriptors do not stop the pass', async (t) => {
    const f = await fixture(t);
    const alaX = await makeGeneration(f.root, 'ala', gen(1));
    const alaCurrent = await makeGeneration(f.root, 'ala', gen(2));
    const bwrapY = await makeGeneration(f.root, 'bwrap', gen(3));
    const bwrapCurrent = await makeGeneration(f.root, 'bwrap', gen(4));
    const hidden = await makeGeneration(f.root, 'ala', gen(5));
    await setCurrent(f.root, 'ala', gen(2));
    await setCurrent(f.root, 'bwrap', gen(4));
    await fs.mkdir(f.terminals, { recursive: true });
    await fs.writeFile(path.join(f.terminals, 'robot-a.default.json'), JSON.stringify({ alaEntry: path.join(alaX, 'bin', 'ala.mjs'), bwrap: path.join(bwrapY, 'bin', 'bwrap'), binPath: '/ignored' }));
    await fs.writeFile(path.join(f.terminals, 'bad.json'), '{ not json');
    await fs.writeFile(path.join(f.terminals, 'big.json'), JSON.stringify({ alaEntry: path.join(hidden, 'bin', 'ala.mjs'), pad: 'x'.repeat(40000) }));
    await fs.writeFile(path.join(f.terminals, '.hidden.json'), JSON.stringify({ alaEntry: path.join(hidden, 'bin', 'ala.mjs') }));
    await fs.writeFile(path.join(f.terminals, 'naming-a-missing-generation.json'), JSON.stringify({ alaEntry: path.join(f.root, 'ala', 'generations', gen(9), 'bin', 'ala.mjs'), bwrap: 7 }));
    await collect(f);
    for (const kept of [alaX, alaCurrent, bwrapY, bwrapCurrent]) assert.equal(await exists(kept), true, kept);
    assert.equal(await exists(hidden), false);
    const { terminalDescriptorPaths } = await import('../server/tool-cache-gc.mjs');
    assert.deepEqual((await terminalDescriptorPaths(f.terminals)).sort(), [path.join(alaX, 'bin', 'ala.mjs'), path.join(bwrapY, 'bin', 'bwrap'),
        path.join(f.root, 'ala', 'generations', gen(9), 'bin', 'ala.mjs')].sort());
    assert.deepEqual(await terminalDescriptorPaths(path.join(f.base, 'missing')), []);
});

test('T12: every host npm call uses its own throwaway cache below the tool cache and leaves none behind', async (t) => {
    const f = await fixture(t);
    const calls = [];
    f.cache.execFileImpl = async (command, args) => {
        const index = args.indexOf('--cache');
        const record = { command, args, cache: index >= 0 ? args[index + 1] : null, present: null };
        if (record.cache) record.present = await exists(path.dirname(record.cache));
        calls.push(record);
        if (args[0] === 'view') return { stdout: '"1.2.3"\n', stderr: '' };
        if (args[0] === 'install') {
            const prefix = args[args.indexOf('--prefix') + 1];
            const manifest = JSON.parse(await fs.readFile(path.join(prefix, 'package.json'), 'utf8').catch(() => '{"dependencies":{}}'));
            const version = manifest.dependencies?.[PLUGIN];
            if (version) await writePluginInstall(prefix, version);
            else await fs.mkdir(path.join(prefix, 'bin'), { recursive: true });
        }
        return { stdout: '', stderr: '' };
    };
    assert.equal(await f.cache._npmVersion('semver'), '1.2.3');
    await f.cache._npmInstallHost(path.join(f.base, 'install'), ['codex-pkg@1.0.0', 'bun@2.0.0'], null, { global: true });
    await fs.mkdir(path.join(f.base, 'install-two'));
    await f.cache._npmInstallHost(path.join(f.base, 'install-two'), 'plain', '3.0.0');
    await f.cache.prepareOpenCodePlugin('1.18.35');
    assert.deepEqual(calls.map(call => call.args[0]), ['view', 'install', 'install', 'install']);
    const caches = new Set();
    for (const call of calls) {
        assert.ok(call.cache, `no --cache in ${call.args.join(' ')}`);
        assert.equal(path.basename(call.cache), 'cache');
        assert.match(path.relative(f.root, path.dirname(call.cache)), /^\.npm-[^/]+$/u);
        assert.equal(call.present, true, 'the throwaway directory exists while npm runs');
        assert.ok(call.args.includes('--update-notifier=false'));
        caches.add(call.cache);
        if (call.args[0] === 'install') assert.ok(call.args.indexOf('--cache') < call.args.indexOf('--prefix'), 'install flags come before --prefix');
    }
    assert.equal(caches.size, calls.length, 'every call gets a different directory');
    assert.deepEqual(calls[0].args.slice(0, 4), ['view', 'semver@latest', 'version', '--json']);
    assert.equal(calls[1].args.at(-1), 'bun@2.0.0');
    assert.deepEqual(calls[1].args.slice(calls[1].args.indexOf('--prefix') + 2), ['codex-pkg@1.0.0', 'bun@2.0.0']);
    assert.equal(calls[2].args.at(-1), 'plain@3.0.0');
    assert.ok(calls[3].args.includes('--ignore-scripts') && !calls[3].args.includes('--no-package-lock'));
    assert.deepEqual((await names(f.root)).filter(name => name.startsWith('.npm-')), []);
    // A failing npm leaves nothing behind either.
    f.cache.execFileImpl = async () => { throw new Error('registry unreachable'); };
    await assert.rejects(f.cache._npmVersion('semver'), /registry unreachable/u);
    assert.deepEqual((await names(f.root)).filter(name => name.startsWith('.npm-')), []);
});

// What `npm install @opencode-ai/plugin@<version>` leaves in a directory.
async function writePluginInstall(directory, version) {
    await fs.mkdir(path.join(directory, 'node_modules', PLUGIN), { recursive: true });
    await fs.writeFile(path.join(directory, 'node_modules', PLUGIN, 'package.json'), JSON.stringify({ name: PLUGIN, version }));
    await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({ dependencies: { [PLUGIN]: version } }));
    await fs.writeFile(path.join(directory, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3,
        packages: { '': { dependencies: { [PLUGIN]: version } }, [`node_modules/${PLUGIN}`]: { version } } }));
}

test('T13: abandoned leftovers older than thirty minutes go; fresh ones, a fresh lock with its target, and unknown names stay', async (t) => {
    const f = await fixture(t);
    const stale = IN_PLACE_LOCK_STALE_MS / MINUTE + 1, fresh = 5;
    await makeGeneration(f.root, 'codex', gen(1));
    await setCurrent(f.root, 'codex', gen(1));
    // Staging and temporary files.
    const staging = path.join(f.root, 'codex', 'staging');
    await fs.mkdir(path.join(staging, 'old-uuid'), { recursive: true });
    await fs.mkdir(path.join(staging, 'fresh-uuid'));
    await age(path.join(staging, 'old-uuid'), stale); await age(path.join(staging, 'fresh-uuid'), fresh);
    const oldTmp = path.join(f.root, 'codex', 'current.json.1.abc.tmp'), freshTmp = path.join(f.root, 'codex', 'current.json.2.def.tmp');
    await fs.writeFile(oldTmp, '{}'); await fs.writeFile(freshTmp, '{}'); await age(oldTmp, stale); await age(freshTmp, fresh);
    const shellStaging = [['.staging-é-old', stale], ['.staging-fresh', fresh]];
    for (const [name, minutes] of shellStaging) {
        const directory = path.join(f.root, 'shell-generations', name);
        await fs.mkdir(directory, { recursive: true }); await age(directory, minutes);
    }
    const pluginStaging = path.join(f.root, 'opencode-plugin', 'generations', '.staging-old');
    await fs.mkdir(pluginStaging, { recursive: true }); await age(pluginStaging, stale);
    for (const [where, name, minutes] of [['.', '.shell-old', stale], ['.', '.shell-fresh', fresh], ['shell-selections', '.shell-old', stale]]) {
        await fs.mkdir(path.join(f.root, where), { recursive: true });
        await fs.symlink('nowhere', path.join(f.root, where, name)); await age(path.join(f.root, where, name), minutes);
    }
    for (const [name, minutes] of [['.npm-old', stale], ['.npm-fresh', fresh]]) {
        await fs.mkdir(path.join(f.root, name, 'cache'), { recursive: true }); await age(path.join(f.root, name), minutes);
    }
    // Locks beside generations: stale beside a superseded target, stale beside the current one, fresh beside an unstamped target.
    const generations = path.join(f.root, 'codex', 'generations');
    const staleTarget = await makeGeneration(f.root, 'codex', gen(2), { stamp: false });
    const freshTarget = await makeGeneration(f.root, 'codex', gen(3), { stamp: false });
    const locks = { staleSuperseded: `${gen(2)}.lock`, staleCurrent: `${gen(1)}.lock`, fresh: `${gen(3)}.lock` };
    for (const [key, name] of Object.entries(locks)) {
        await fs.writeFile(path.join(generations, name), ''); await age(path.join(generations, name), key === 'fresh' ? fresh : stale);
    }
    await fs.writeFile(path.join(generations, 'README'), 'keep me');
    await fs.mkdir(path.join(f.root, 'mystery'), { recursive: true });
    await (await collect(f))();
    const gone = [path.join(staging, 'old-uuid'), oldTmp, path.join(f.root, 'shell-generations', '.staging-é-old'), pluginStaging, path.join(f.root, '.shell-old'),
        path.join(f.root, 'shell-selections', '.shell-old'), path.join(f.root, '.npm-old'), staleTarget, path.join(generations, locks.staleSuperseded), path.join(generations, locks.staleCurrent)];
    const kept = [path.join(staging, 'fresh-uuid'), freshTmp, path.join(f.root, 'shell-generations', '.staging-fresh'), path.join(f.root, '.shell-fresh'), path.join(f.root, '.npm-fresh'),
        freshTarget, path.join(generations, locks.fresh), path.join(generations, gen(1)), path.join(generations, 'README'), path.join(f.root, 'mystery'), staging];
    for (const target of gone) assert.equal(await exists(target), false, `${target} should be removed`);
    for (const target of kept) assert.equal(await exists(target), true, `${target} should stay`);
});

test('T15: the legacy npm cache directory is removed at startup; a link is never followed', async (t) => {
    const f = await fixture(t);
    const legacy = path.join(f.base, '.npm');
    await fs.mkdir(path.join(legacy, '_cacache'), { recursive: true });
    await fs.writeFile(path.join(legacy, '_cacache', 'entry'), 'x');
    await (await collect(f, { legacyNpmCache: legacy }))();
    assert.equal(await exists(legacy), false);
    assert.ok(f.lines.includes('[tool-cache] removed legacy npm cache'));

    const outside = path.join(f.base, 'outside');
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'keep'), 'k');
    await fs.symlink(outside, legacy);
    await (await collect(f, { legacyNpmCache: legacy }))();
    assert.equal((await fs.lstat(legacy)).isSymbolicLink(), true, 'the link is left alone');
    assert.equal(await exists(path.join(outside, 'keep')), true, 'nothing behind the link was removed');
    await fs.rm(legacy);
    await fs.writeFile(legacy, 'file');
    await (await collect(f, { legacyNpmCache: legacy }))();
    assert.equal(await fs.readFile(legacy, 'utf8'), 'file', 'a plain file is left alone');
});

test('T16: a bad current.json keeps its whole bundle; a link or file for the trash skips the pass and nothing behind it is touched', async (t) => {
    const f = await fixture(t);
    const d1 = await makeGeneration(f.root, 'desktop', gen(1));
    const d2 = await makeGeneration(f.root, 'desktop', gen(2));
    await setCurrent(f.root, 'desktop', null, '{}');
    const m1 = await makeGeneration(f.root, 'browser', gen(3));
    const m2 = await makeGeneration(f.root, 'browser', gen(4));
    await setCurrent(f.root, 'browser', gen(3), '');
    const empty = await makeGeneration(f.root, 'pi', gen(5));
    const dangling = await makeGeneration(f.root, 'pi', gen(6));
    await setCurrent(f.root, 'pi', gen(7));
    const codexA = await makeGeneration(f.root, 'codex', gen(8));
    const codexB = await makeGeneration(f.root, 'codex', gen(9));
    await setCurrent(f.root, 'codex', gen(8));
    await collect(f);
    for (const kept of [d1, d2, m1, m2, empty, dangling, codexA]) assert.equal(await exists(kept), true, kept);
    assert.equal(await exists(codexB), false, 'the pass ran and removed the superseded generation of a healthy bundle');

    const g = await fixture(t);
    const stay = await makeGeneration(g.root, 'codex', gen(1));
    const stay2 = await makeGeneration(g.root, 'codex', gen(2));
    await setCurrent(g.root, 'codex', gen(1));
    const outside = path.join(g.base, 'outside');
    await fs.mkdir(path.join(outside, 'inner'), { recursive: true });
    await fs.writeFile(path.join(outside, 'inner', 'keep'), 'k');
    await fs.symlink(outside, path.join(g.root, '.trash'));
    const legacy = path.join(g.base, '.npm');
    await fs.mkdir(legacy);
    await (await collect(g, { legacyNpmCache: legacy }))();
    assert.equal(await exists(stay2), true, 'a symlinked trash skips the whole pass');
    assert.equal(await exists(stay), true);
    assert.ok(g.lines.some(line => line.startsWith('[tool-cache] garbage collection skipped')), g.lines.join('\n'));
    assert.equal(await exists(path.join(outside, 'inner', 'keep')), true, 'the cleanup does not delete through the link');
    assert.equal((await fs.lstat(path.join(g.root, '.trash'))).isSymbolicLink(), true);
    assert.equal(await exists(legacy), false, 'the legacy npm cache is removed whether or not the pass ran');

    const h = await fixture(t);
    const kept = await makeGeneration(h.root, 'codex', gen(2));
    await setCurrent(h.root, 'codex', gen(1));
    await makeGeneration(h.root, 'codex', gen(1));
    await fs.writeFile(path.join(h.root, '.trash'), 'a file');
    await (await collect(h))();
    assert.equal(await exists(kept), true);
    assert.equal(await fs.readFile(path.join(h.root, '.trash'), 'utf8'), 'a file');
});

test('a symlinked root, generations directory or bundle skips the pass', async (t) => {
    const f = await fixture(t);
    const outside = path.join(f.base, 'outside');
    await makeGeneration(outside, 'codex', gen(1));
    await makeGeneration(outside, 'codex', gen(2));
    await fs.mkdir(path.join(outside, '.trash', 'entry'), { recursive: true });
    const link = path.join(f.base, 'linked-cache');
    await fs.symlink(outside, link);
    const cache = new ToolCache({ root: link, log: line => f.lines.push(line), now: () => NOW, versionPins: {} });
    await (await cache.collectGarbage({})).cleanup();
    assert.equal(await exists(path.join(outside, 'codex', 'generations', gen(1))), true);
    assert.equal(await exists(path.join(outside, 'codex', 'generations', gen(2))), true);
    assert.equal(await exists(path.join(outside, '.trash', 'entry')), true, 'the cleanup does not empty a trash reached through a linked root');

    const g = await fixture(t);
    await makeGeneration(g.root, 'pi', gen(1));
    await fs.rm(path.join(g.root, 'pi', 'generations'), { recursive: true });
    await fs.symlink(path.join(outside, 'codex', 'generations'), path.join(g.root, 'pi', 'generations'));
    const sibling = await makeGeneration(g.root, 'codex', gen(5));
    await collect(g);
    assert.equal(await exists(path.join(outside, 'codex', 'generations', gen(1))), true);
    assert.equal(await exists(sibling), true, 'one unexpected link skips every bundle');
    assert.ok(g.lines.some(line => line.includes('garbage collection skipped')));
});

test('boundary names: 63 digits, uppercase hex and a link named like a generation are left alone', async (t) => {
    const f = await fixture(t);
    await makeGeneration(f.root, 'codex', gen(1));
    await setCurrent(f.root, 'codex', gen(1));
    const short = await makeGeneration(f.root, 'codex', 'a'.repeat(63));
    const upper = await makeGeneration(f.root, 'codex', 'A'.repeat(64));
    const outside = path.join(f.base, 'outside');
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'keep'), 'k');
    await fs.symlink(outside, path.join(f.root, 'codex', 'generations', gen(2)));
    await fs.writeFile(path.join(f.root, 'codex', 'generations', gen(3)), 'a file named like a generation');
    await (await collect(f))();
    for (const kept of [short, upper, path.join(f.root, 'codex', 'generations', gen(2)), path.join(f.root, 'codex', 'generations', gen(3)), path.join(outside, 'keep')]) {
        assert.equal(await exists(kept), true, kept);
    }
});

test('a missing tool cache, bundle or generations directory is not an error and creates nothing', async (t) => {
    const f = await fixture(t);
    await (await collect(f))();
    assert.deepEqual(await names(f.root), [], '0 generations: nothing to do, no trash created');
    await fs.mkdir(path.join(f.root, 'codex'));
    await setCurrent(f.root, 'codex', gen(1));
    await collect(f);
    assert.equal(f.lines.some(line => line.includes('skipped')), false, f.lines.join('\n'));
    const missing = new ToolCache({ root: path.join(f.base, 'absent'), log: line => f.lines.push(line), now: () => NOW, versionPins: {} });
    await (await missing.collectGarbage({ terminalStateDir: f.terminals })).cleanup();
    assert.equal(await exists(path.join(f.base, 'absent')), false);
});

test('200 superseded generations are all renamed before listen and deleted afterwards', async (t) => {
    const f = await fixture(t);
    await makeGeneration(f.root, 'claude', gen(1), { versions: { claude: '9.9.9' } });
    await setCurrent(f.root, 'claude', gen(1));
    for (let index = 0; index < 200; index += 1) await makeGeneration(f.root, 'claude', gen(1000 + index));
    const cleanup = await collect(f);
    assert.deepEqual(await names(path.join(f.root, 'claude', 'generations')), [gen(1)]);
    assert.equal((await names(path.join(f.root, '.trash'))).length, 200);
    await cleanup();
    assert.deepEqual(await names(path.join(f.root, '.trash')), []);
    assert.equal(f.lines.filter(line => line.startsWith('[tool-cache] removed claude generation')).length, 200);
});

test('a rename failure for one victim leaves it, processes the others, logs, and never rejects', async (t) => {
    const f = await fixture(t);
    await makeGeneration(f.root, 'codex', gen(1));
    await setCurrent(f.root, 'codex', gen(1));
    const victims = [2, 3, 4].map(n => path.join(f.root, 'codex', 'generations', gen(n)));
    for (const victim of victims) await fs.mkdir(victim, { recursive: true });
    const original = fs.rename;
    t.mock.method(fs, 'rename', (from, to) => (from === victims[1] ? Promise.reject(Object.assign(new Error('cross-device'), { code: 'EXDEV' })) : original(from, to)));
    const cleanup = await collect(f);
    assert.equal(await exists(victims[0]), false);
    assert.equal(await exists(victims[1]), true, 'the failed victim stays');
    assert.equal(await exists(victims[2]), false);
    assert.ok(f.lines.some(line => line.includes('could not remove') && line.includes('EXDEV')), f.lines.join('\n'));
    await cleanup();
    assert.deepEqual(await names(path.join(f.root, '.trash')), []);
});

test('K3 and K1 read errors that are not "missing" skip the pass instead of guessing', async (t) => {
    const f = await fixture(t);
    await makeGeneration(f.root, 'codex', gen(1));
    const victim = await makeGeneration(f.root, 'codex', gen(2));
    // current.json is a directory: reading it fails with EISDIR, which is neither missing nor a JSON problem.
    await fs.mkdir(path.join(f.root, 'codex', 'current.json'));
    await collect(f);
    assert.equal(await exists(victim), true);
    assert.ok(f.lines.some(line => line.includes('garbage collection skipped')), f.lines.join('\n'));
});

test('a collection failure never rejects: an unreadable terminal state directory is logged and removes nothing', async (t) => {
    const f = await fixture(t);
    const victim = await makeGeneration(f.root, 'codex', gen(2));
    await makeGeneration(f.root, 'codex', gen(1));
    await setCurrent(f.root, 'codex', gen(1));
    await fs.mkdir(path.dirname(f.terminals), { recursive: true });
    await fs.writeFile(f.terminals, 'not a directory');
    const cleanup = await collect(f);
    await cleanup();
    assert.equal(await exists(victim), true);
    assert.ok(f.lines.some(line => line.startsWith('[tool-cache] garbage collection skipped')));
});

// T17: the real main.mjs, copied beside stub modules, runs collection after both kill steps, awaits its rename phase before
// listening, defers the trash cleanup and the warmups until after listen, and survives a failing collection.
const MAIN = await fs.readFile(new URL('../server/main.mjs', import.meta.url), 'utf8');

async function runMain(t, mode) {
    const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rw-main-')));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    await fs.mkdir(path.join(directory, 'proxy-pool'));
    const deep = "const deep = () => new Proxy(function () {}, { get: (_t, key) => (key === 'then' ? undefined : deep()), apply: () => deep(), construct: () => deep() });\n"
        + "const trace = (...event) => console.log('TRACE ' + JSON.stringify(event));\n";
    const overrides = {
        './robot-paths.mjs': 'export class RobotPaths { dataDir = "/root"; robotsDir = "/robots"; workspaceRoot = "/workspace"; soul() { return "/soul"; } }',
        './constants.mjs': 'export const DATA_DIR = "/root"; export const PUBLIC_BASE_PATH = "/public/";',
        './tool-cache.mjs': `export class ToolCache {
            async collectGarbage(options) {
                trace('collect.start', options);
                await new Promise(resolve => setTimeout(resolve, 40));
                if (process.env.STUB_MODE === 'reject') throw Object.assign(new Error('boom'), { code: 'EBOOM' });
                trace('collect.done');
                return { cleanup: async () => trace('cleanup') };
            }
            warmup() { trace('toolCache.warmup'); return Promise.resolve(); }
        }`,
        './runtime-bundle.mjs': "export class RuntimeBundle { warmup() { trace('runtimeBundle.warmup'); return Promise.resolve(); } close() {} }",
        './opencode-migration.mjs': "export function createOpenCodeMigration() { return { guard() {}, status() {}, start() { trace('migration.start'); return Promise.resolve().then(() => trace('migration.done')); } }; }",
        './run-manager.mjs': "export class RunManager { async initialize() { trace('runs.initialize'); } list() { return []; } async close() {} }",
        './robot-manager.mjs': "export class RobotManager { async initialize() {} async restoreGitCredentials() {} async status() { return { robots: [] }; } }",
        './gui-manager.mjs': "export class GuiManager { images = {}; async initialize() { trace('gui.initialize'); } async shutdown() {} }\nexport const proxySessionHttp = deep(); export const proxySessionWebSocket = deep();",
        './http-server.mjs': "export function createRoboWorkServer() { return { listen(_port, _host, ready) { trace('listen'); ready(); }, close() {}, closeAllConnections() {} }; }",
    };
    const specifiers = [...MAIN.matchAll(/import \{([^}]+)\} from '(\.\/[^']+)'/gu)].map(match => ({ names: match[1].split(',').map(name => name.trim()), file: match[2] }));
    for (const { names: exported, file } of specifiers) {
        const body = overrides[file] ?? exported.map(name => `export const ${name} = deep();`).join('\n');
        await fs.mkdir(path.dirname(path.join(directory, file)), { recursive: true });
        await fs.writeFile(path.join(directory, file), `${deep}${body}\n`);
    }
    await fs.writeFile(path.join(directory, 'main.mjs'), MAIN);
    const child = spawn(process.execPath, ['main.mjs'], { cwd: directory, env: { PATH: process.env.PATH, ROBOWORK_INTERNAL_TOKEN: 'token', STUB_MODE: mode } });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
    const events = stdout.split('\n').filter(line => line.startsWith('TRACE ')).map(line => JSON.parse(line.slice(6)));
    return { code, stderr, events, order: events.map(event => event[0]) };
}

test('T17: the startup entry point collects after both kill steps, before listen and every warmup', async (t) => {
    const { code, stderr, events, order } = await runMain(t, 'ok');
    assert.equal(code, 0, stderr);
    const at = name => order.indexOf(name);
    for (const name of ['runs.initialize', 'gui.initialize', 'collect.start', 'collect.done', 'listen', 'cleanup', 'runtimeBundle.warmup', 'toolCache.warmup']) assert.notEqual(at(name), -1, `${name} in ${order}`);
    assert.ok(at('runs.initialize') < at('collect.start') && at('gui.initialize') < at('collect.start'), order.join(' '));
    assert.ok(at('collect.done') < at('listen'), 'the rename phase is awaited before listen');
    assert.ok(at('gui.initialize') < at('migration.start') && at('migration.done') < at('toolCache.warmup'));
    for (const name of ['cleanup', 'runtimeBundle.warmup', 'toolCache.warmup']) assert.ok(at('listen') < at(name), `${name} runs after listen`);
    assert.deepEqual(events.find(event => event[0] === 'collect.start')[1], { terminalStateDir: '/root/server-state/terminal', legacyNpmCache: '/root/.npm' });
});

test('T17: a failing collection does not prevent startup', async (t) => {
    const { code, stderr, order } = await runMain(t, 'reject');
    assert.equal(code, 0, stderr);
    assert.match(stderr, /\[tool-cache\] garbage collection failed: EBOOM/u);
    assert.equal(order.includes('collect.done'), false);
    for (const name of ['listen', 'runtimeBundle.warmup', 'toolCache.warmup']) assert.ok(order.includes(name), `${name} in ${order}`);
});
