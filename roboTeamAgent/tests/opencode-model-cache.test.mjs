import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MODELS_FRESH_WINDOW_MS, createOpenCodeModelCache, openCodeVersionOf } from '../server/opencode-model-cache.mjs';

const GATEWAY_CATALOG = { data: [{ id: 'axl/fast', name: 'Fast' }, { id: 'axl/deep', name: 'Deep' }] };
const LISTING = [{ id: 'opencode/big-pickle', label: 'Big Pickle', efforts: [] },
    { id: 'soul-gateway/axl/fast', label: 'Fast', efforts: [] }, { id: 'soul-gateway/axl/deep', label: 'Deep', efforts: ['high'] }];

async function write(file, content) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
}

// An executable laid out like the npm platform package: <package>/bin/opencode beside <package>/package.json.
async function installBinary(directory, version = '1.18.35') {
    const binary = path.join(directory, 'node_modules', 'opencode-test', 'bin', 'opencode');
    await write(binary, '#!/bin/sh\necho 1.18.35\n');
    await write(path.join(directory, 'node_modules', 'opencode-test', 'package.json'), JSON.stringify({ name: 'opencode-test', version }));
    return binary;
}

async function fixture(t, { gateway = GATEWAY_CATALOG } = {}) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'roboteam-model-cache-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const home = path.join(root, 'home');
    const cwd = path.join(root, 'workspace', 'project');
    const ala = path.join(root, 'ala');
    await Promise.all([fs.mkdir(path.join(home, '.config', 'opencode'), { recursive: true }), fs.mkdir(cwd, { recursive: true })]);
    const binary = await installBinary(path.join(root, 'tools'));
    await write(path.join(ala, 'package.json'), '{"name":"advanced-language-agent","version":"1.0.0"}');
    await write(path.join(ala, 'src', 'coding-agents', 'opencode.mjs'), 'export const a = 1;\n');
    await write(path.join(ala, 'src', 'coding-agents', 'opencode-server.mjs'), 'export const b = 1;\n');
    await write(path.join(home, '.config', 'opencode', 'plugins', 'soul-gateway.js'), 'export const SoulGateway = 1;\n');
    await write(path.join(home, '.cache', 'opencode', 'models.json'), '{"opencode":{"models":{}}}');
    const state = { gateway, requests: 0 };
    const cache = createOpenCodeModelCache({ directory: path.join(root, 'runtime', 'model-catalog'),
        connect: async () => state.gateway === null ? null : { request: async (operation) => {
            assert.equal(operation, 'models');
            state.requests++;
            return state.gateway;
        } } });
    const config = (overrides = {}) => ({ backend: 'opencode', home, cwd, env: { HOME: home, PATH: '/bin' },
        api: { packageRoot: ala }, agents: [{ name: 'opencode', binary, available: true }], ...overrides });
    return { root, home, cwd, ala, binary, cache, config, state };
}

test('an unchanged robot reuses its stored list and a stored list is returned for exactly its key', async (t) => {
    const f = await fixture(t);
    const first = await f.cache.probe(f.config());
    assert.equal(first.models, null);
    assert.equal(await f.cache.store(first, LISTING), true);
    const second = await f.cache.probe(f.config());
    assert.equal(second.key, first.key);
    assert.deepEqual(second.models, LISTING);
    // The gateway is read live on every lookup; there is no cached gateway answer.
    assert.equal(f.state.requests, 2);
});

// Every entry changes one real input of OpenCode's model list and must force a recompute.
const MUTATIONS = {
    'OpenCode executable content': f => write(f.binary, '#!/bin/sh\necho 1.18.36 with a different size\n'),
    'OpenCode executable path': async f => {
        f.binary = await installBinary(path.join(f.root, 'tools2'));
    },
    'ALA launcher code': f => write(path.join(f.ala, 'src', 'coding-agents', 'opencode-server.mjs'), 'export const b = 2;\n'),
    'ALA launcher file added': f => write(path.join(f.ala, 'src', 'coding-agents', 'service.mjs'), 'export {};\n'),
    'ALA version': f => write(path.join(f.ala, 'package.json'), '{"name":"advanced-language-agent","version":"1.0.1"}'),
    'environment value': f => { f.env = { ...f.env, HTTPS_PROXY: 'http://proxy.invalid' }; },
    'environment removal': f => { delete f.env.PATH; },
    'working directory': f => { f.cwd = path.dirname(f.cwd); },
    'global config.json': f => write(path.join(f.home, '.config', 'opencode', 'config.json'), '{"model":"a/b"}'),
    'global opencode.json': f => write(path.join(f.home, '.config', 'opencode', 'opencode.json'), '{"provider":{}}'),
    'global opencode.jsonc': f => write(path.join(f.home, '.config', 'opencode', 'opencode.jsonc'), '// provider\n{}'),
    'local plugin edited': f => write(path.join(f.home, '.config', 'opencode', 'plugins', 'soul-gateway.js'), 'export const SoulGateway = 2;\n'),
    'local plugin added': f => write(path.join(f.home, '.config', 'opencode', 'plugins', 'extra.js'), 'export const Extra = 1;\n'),
    'plugin dependency manifest': f => write(path.join(f.home, '.config', 'opencode', 'package.json'), '{"dependencies":{"x":"1.0.0"}}'),
    'OpenCode auth': f => write(path.join(f.home, '.local', 'share', 'opencode', 'auth.json'), '{"openai":{"type":"api","key":"k"}}'),
    'models.dev catalog': f => write(path.join(f.home, '.cache', 'opencode', 'models.json'), '{"opencode":{"models":{"new":{}}}}'),
    'project opencode.json': f => write(path.join(f.cwd, 'opencode.json'), '{"provider":{}}'),
    'ancestor opencode.jsonc': f => write(path.join(path.dirname(f.cwd), 'opencode.jsonc'), '{}'),
    'project .opencode config': f => write(path.join(f.cwd, '.opencode', 'opencode.json'), '{}'),
    'project .opencode plugin': f => write(path.join(f.cwd, '.opencode', 'plugins', 'p.js'), 'export const P = 1;\n'),
    'home .opencode directory': f => write(path.join(f.home, '.opencode', 'opencode.json'), '{}'),
    'OPENCODE_CONFIG file': async f => {
        const file = path.join(f.root, 'extra.json');
        await write(file, '{"a":1}');
        f.env = { ...f.env, OPENCODE_CONFIG: file };
    },
    'OPENCODE_CONFIG_DIR tree': async f => {
        const directory = path.join(f.root, 'extra-config');
        await write(path.join(directory, 'opencode.json'), '{}');
        f.env = { ...f.env, OPENCODE_CONFIG_DIR: directory };
    },
    'Soul Gateway model added': f => { f.state.gateway = { data: [...GATEWAY_CATALOG.data, { id: 'axl/new' }] }; },
    'Soul Gateway model renamed': f => { f.state.gateway = { data: [{ id: 'axl/fast', name: 'Faster' }, GATEWAY_CATALOG.data[1]] }; },
    'Soul Gateway model limits': f => { f.state.gateway = { data: [{ ...GATEWAY_CATALOG.data[0], _context: { window: 1000, max_output_tokens: 100 } }, GATEWAY_CATALOG.data[1]] }; },
    'Soul Gateway unavailable for this deployment': f => { f.state.gateway = null; },
};

for (const [name, mutate] of Object.entries(MUTATIONS)) {
    test(`changing the ${name} recomputes the list`, async (t) => {
        const f = await fixture(t);
        f.env = { HOME: f.home, PATH: '/bin' };
        const config = () => f.config({ env: f.env, cwd: f.cwd, agents: [{ name: 'opencode', binary: f.binary, available: true }] });
        const before = await f.cache.probe(config());
        await f.cache.store(before, LISTING);
        assert.deepEqual((await f.cache.probe(config())).models, LISTING, 'control: unchanged inputs hit');
        await mutate(f);
        const after = await f.cache.probe(config());
        assert.notEqual(after.key, before.key);
        assert.equal(after.models, null);
    });
}

test('state OpenCode itself rewrites during a run is excluded: dependencies, sockets and staging', async (t) => {
    const f = await fixture(t);
    const before = await f.cache.probe(f.config());
    await write(path.join(f.home, '.config', 'opencode', 'node_modules', 'pkg', 'index.js'), 'x');
    await write(path.join(f.home, '.config', 'opencode', '.roboteam-seed-1', 'x'), 'x');
    assert.equal((await f.cache.probe(f.config())).key, before.key);
});

test('a list that is not complete for the gateway is never stored', async (t) => {
    const f = await fixture(t);
    const probe = await f.cache.probe(f.config());
    const withoutGateway = LISTING.filter(model => !model.id.startsWith('soul-gateway/'));
    assert.equal(await f.cache.store(probe, withoutGateway), false, 'the plugin failed to load');
    assert.equal(await f.cache.store(probe, LISTING.slice(0, 2)), false, 'one gateway model is missing');
    assert.equal(await f.cache.store(probe, []), false);
    assert.equal(await f.cache.store(probe, 'nope'), false);
    assert.equal((await f.cache.probe(f.config())).models, null);
    // Without a gateway in this deployment the OpenCode providers alone are complete.
    const bare = await fixture(t, { gateway: null });
    const bareProbe = await bare.cache.probe(bare.config());
    assert.equal(await bare.cache.store(bareProbe, [LISTING[0]]), true);
    assert.deepEqual((await bare.cache.probe(bare.config())).models, [LISTING[0]]);
});

test('a damaged, foreign or linked cache file is a miss, never an error or a followed link', async (t) => {
    const f = await fixture(t);
    const probe = await f.cache.probe(f.config());
    await f.cache.store(probe, LISTING);
    const file = path.join(f.root, 'runtime', 'model-catalog', 'opencode.json');
    const good = await fs.readFile(file, 'utf8');
    for (const bad of ['', '{', 'null', JSON.stringify({ ...JSON.parse(good), schema: 'other' }),
        JSON.stringify({ ...JSON.parse(good), key: 'f'.repeat(64) }), JSON.stringify({ ...JSON.parse(good), models: [{ nope: 1 }] }),
        JSON.stringify({ ...JSON.parse(good), models: [] })]) {
        await fs.writeFile(file, bad);
        assert.equal((await f.cache.probe(f.config())).models, null, bad.slice(0, 40));
    }
    await fs.rm(file);
    await fs.writeFile(path.join(f.root, 'elsewhere.json'), good);
    await fs.symlink(path.join(f.root, 'elsewhere.json'), file);
    assert.equal((await f.cache.probe(f.config())).models, null);
});

test('inputs that cannot be read as bounded inputs bypass the cache instead of being ignored', async (t) => {
    const f = await fixture(t);
    await write(path.join(f.home, '.cache', 'opencode', 'models.json'), '{}');
    await fs.chmod(path.join(f.home, '.cache', 'opencode', 'models.json'), 0o000);
    if (process.getuid?.() !== 0) await assert.rejects(f.cache.probe(f.config()), /EACCES/);
    await fs.chmod(path.join(f.home, '.cache', 'opencode', 'models.json'), 0o600);
    // A gateway that cannot answer: the caller lists models as before.
    f.state.gateway = null;
    const failing = createOpenCodeModelCache({ directory: path.join(f.root, 'c'), connect: async () => { throw new Error('router down'); } });
    await assert.rejects(failing.probe(f.config()), /router down/);
    // Too many configuration entries cannot be keyed.
    await fs.mkdir(path.join(f.cwd, '.opencode'), { recursive: true });
    await Promise.all(Array.from({ length: 405 }, (_, i) => fs.writeFile(path.join(f.cwd, '.opencode', `f${i}`), 'x')));
    await assert.rejects(f.cache.probe(f.config()), /too many entries/);
});

test('no OpenCode agent means no key', async (t) => {
    const f = await fixture(t);
    assert.equal(await f.cache.probe(f.config({ agents: [{ name: 'codex', binary: f.binary, available: true }] })), null);
    assert.equal(await f.cache.probe(f.config({ agents: [{ name: 'opencode', binary: f.binary, available: false }] })), null);
});

const MODELS_FILE = f => path.join(f.home, '.cache', 'opencode', 'models.json');
const age = (file, ms) => fs.utimes(file, new Date(Date.now() - ms), new Date(Date.now() - ms));
const WINDOW = MODELS_FRESH_WINDOW_MS['1.18.35'];

test('a list is served only while OpenCode itself would not refetch its models.json', async (t) => {
    const f = await fixture(t);
    const first = await f.cache.probe(f.config());
    await f.cache.store(first, LISTING);
    await age(MODELS_FILE(f), WINDOW - 30_000);
    assert.deepEqual((await f.cache.probe(f.config())).models, LISTING, 'inside the window: OpenCode would not refresh either');
    // The key is unchanged by age (mtime is not content), yet an aged file must miss.
    await age(MODELS_FILE(f), WINDOW + 1000);
    const aged = await f.cache.probe(f.config());
    assert.equal(aged.key, first.key);
    assert.equal(aged.models, null);
    assert.equal(aged.fresh, false);
    // The listing OpenCode runs then refreshes the file; nothing is remembered under the stale key.
    assert.equal(await f.cache.store(aged, LISTING), false);
    await write(MODELS_FILE(f), '{"opencode":{"models":{"refreshed":{}}}}');
    const refreshed = await f.cache.probe(f.config());
    assert.notEqual(refreshed.key, first.key);
    assert.equal(refreshed.models, null);
    assert.equal(await f.cache.store(refreshed, LISTING), true);
    assert.deepEqual((await f.cache.probe(f.config())).models, LISTING);
});

test('a refresh that leaves the content unchanged only restarts the fresh window', async (t) => {
    const f = await fixture(t);
    const first = await f.cache.probe(f.config());
    await f.cache.store(first, LISTING);
    await age(MODELS_FILE(f), WINDOW + 60_000);
    assert.equal((await f.cache.probe(f.config())).models, null);
    await fs.utimes(MODELS_FILE(f), new Date(), new Date());
    assert.deepEqual((await f.cache.probe(f.config())).models, LISTING);
});

test('the freshness boundary is OpenCode\'s strict less-than', async (t) => {
    const f = await fixture(t);
    const first = await f.cache.probe(f.config());
    await f.cache.store(first, LISTING);
    await age(MODELS_FILE(f), WINDOW + 5);
    assert.equal((await f.cache.probe(f.config())).models, null, 'exactly at or past the window is stale');
});

test('a missing models.json, a custom models URL and an unpinned OpenCode version never hit', async (t) => {
    const f = await fixture(t);
    const first = await f.cache.probe(f.config());
    await f.cache.store(first, LISTING);
    await fs.rm(MODELS_FILE(f));
    const absent = await f.cache.probe(f.config());
    assert.equal(absent.models, null);
    assert.equal(absent.fresh, false);
    await write(MODELS_FILE(f), '{"opencode":{"models":{}}}');
    assert.deepEqual((await f.cache.probe(f.config())).models, LISTING);
    assert.equal(await f.cache.probe(f.config({ env: { HOME: f.home, PATH: '/bin', OPENCODE_MODELS_URL: 'https://models.invalid' } })), null);
    const unpinned = await installBinary(path.join(f.root, 'future'), '99.0.0');
    assert.equal(await f.cache.probe(f.config({ agents: [{ name: 'opencode', binary: unpinned, available: true }] })), null);
    const unknown = path.join(f.root, 'plain', 'opencode');
    await write(unknown, '#!/bin/sh\n');
    assert.equal(await openCodeVersionOf(unknown), null);
    assert.equal(await f.cache.probe(f.config({ agents: [{ name: 'opencode', binary: unknown, available: true }] })), null);
});

// The pinned window is only as good as the binary it was read from. With an OpenCode executable
// (OPENCODE_BIN, e.g. the tool cache's) this asserts the predicate is still the pinned one.
const OPENCODE_BIN = process.env.OPENCODE_BIN;
test('the pinned freshness window matches the OpenCode binary', { skip: OPENCODE_BIN ? false : 'OPENCODE_BIN is not set' }, async () => {
    const version = await openCodeVersionOf(OPENCODE_BIN);
    assert.ok(MODELS_FRESH_WINDOW_MS[version], `no window is pinned for OpenCode ${version}`);
    const binary = await fs.readFile(await fs.realpath(OPENCODE_BIN));
    const around = (needle, before, after) => {
        const index = binary.indexOf(needle);
        assert.notEqual(index, -1, `${needle} is not in the binary`);
        return binary.subarray(Math.max(0, index - before), index + after).toString('latin1');
    };
    const definition = around('`models-dev:${', 200, 700);
    // c=me.minutes(5),l=`models-dev:${a}`,d=n.fnUntraced(function*(){let w=yield*o.stat(a)...;
    // let T=...getTime();return Date.now()-T<me.toMillis(c)})
    const minutes = definition.match(/(\w+)=\w+\.minutes\((\d+)\),\w+=`models-dev:/);
    assert.ok(minutes, 'window definition');
    assert.equal(Number(minutes[2]) * 60_000, MODELS_FRESH_WINDOW_MS[version]);
    assert.match(definition, new RegExp(`return Date\\.now\\(\\)-\\w+<\\w+\\.toMillis\\(${minutes[1]}\\)\\}\\)`), 'strict less-than against the window');
    assert.match(definition, /\.stat\((\w+)\)\.pipe\(\w+\.catch\(\(\)=>\w+\.succeed\(void 0\)\)\);if\(!\w+\)return!1;let \w+=\w+\.getOrElse\(\w+\.mtime/, 'mtime of the cache file; absent is stale');
    const cachePath = around('"https://models.opencode.ai"?"models.json"', 120, 60);
    assert.match(cachePath, /\.Path\.cache,/, 'the checked file is models.json in the cache directory');
    const refresh = around('"ModelsDev.refresh")', 0, 220);
    assert.match(refresh, /function\*\((\w+)=!1\)\{if\(!\1&&\(yield\*\w+\(\)\)\)return;/, 'refresh skips only while fresh');
});
