import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { retainV1OpenCode } from '../server/opencode-v1-tools.mjs';

const SCHEMA = 'roboteam-tool-cache-v1';
const gen = digit => digit.repeat(64);
const V1 = gen('1'), V1_NEWER = gen('2'), V2 = gen('a');

async function fixture(t) {
    const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rw-v1-')));
    t.after(() => fs.rm(base, { recursive: true, force: true }));
    const cacheRoot = path.join(base, 'tool-cache');
    const root = path.join(base, 'server-state/migrations/opencode-v2-1');
    return { base, cacheRoot, root, args: { cacheRoot, root, cacheSchema: SCHEMA } };
}

async function generation(f, id, version, { preparedAt = '2026-11-01T00:00:00.000Z', stamp = {} } = {}) {
    const directory = path.join(f.cacheRoot, 'opencode', 'generations', id);
    await fs.mkdir(path.join(directory, 'lib'), { recursive: true });
    await fs.mkdir(path.join(directory, 'bin'), { recursive: true });
    await fs.writeFile(path.join(directory, 'lib', 'payload.bin'), `payload-${version}-${id.slice(0, 4)}`);
    await fs.symlink('../lib/payload.bin', path.join(directory, 'bin', 'opencode'));
    await fs.writeFile(path.join(directory, 'stamp.json'), JSON.stringify({ schema: SCHEMA, name: 'opencode', generation: id,
        identity: { package: version.startsWith('1.') ? 'opencode-ai' : '@opencode/cli', version }, versions: { opencode: version }, preparedAt, ...stamp }));
    return directory;
}

const setCurrent = (f, id, version) => fs.writeFile(path.join(f.cacheRoot, 'opencode', 'current.json'),
    JSON.stringify({ schema: SCHEMA, name: 'opencode', generation: id, versions: { opencode: version } }));

// Every entry below a directory with its type, link target and content.
async function digest(directory) {
    const result = {};
    const walk = async (current, prefix) => {
        for (const entry of (await fs.readdir(current, { withFileTypes: true }).catch(() => [])).sort((a, b) => a.name.localeCompare(b.name))) {
            const file = path.join(current, entry.name), key = `${prefix}/${entry.name}`;
            if (entry.isSymbolicLink()) result[key] = `link:${await fs.readlink(file)}`;
            else if (entry.isDirectory()) { result[key] = 'dir'; await walk(file, key); }
            else result[key] = `file:${(await fs.readFile(file, 'utf8')).replace(/"at":"[^"]*"/u, '')}`;
        }
    };
    await walk(directory, '');
    return result;
}

const exists = file => fs.lstat(file).then(() => true, () => false);
const backupGenerations = f => fs.readdir(path.join(f.root, 'v1-tool-cache/generations')).then(names => names.sort(), () => null);

test('with the live descriptor naming V2, the backup holds exactly the V1 generation and describes it; the live cache lets go of it', async t => {
    const f = await fixture(t);
    await generation(f, V1, '1.19.6');
    await generation(f, V2, '2.4.2');
    await setCurrent(f, V2, '2.4.2');
    const payload = await fs.readFile(path.join(f.cacheRoot, 'opencode/generations', V1, 'lib/payload.bin'), 'utf8');
    assert.deepEqual(await retainV1OpenCode(f.args), { generation: V1, action: 'moved' });
    assert.deepEqual(await backupGenerations(f), [V1], 'no V2 generation in the backup');
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.root, 'v1-tool-cache/current.json'), 'utf8')),
        { schema: SCHEMA, name: 'opencode', generation: V1, versions: { opencode: '1.19.6' } });
    assert.equal(await fs.readFile(path.join(f.root, 'v1-tool-cache/generations', V1, 'lib/payload.bin'), 'utf8'), payload);
    assert.equal(await fs.readlink(path.join(f.root, 'v1-tool-cache/generations', V1, 'bin/opencode')), '../lib/payload.bin');
    assert.equal(await exists(path.join(f.cacheRoot, 'opencode/generations', V1)), false, 'moved, not duplicated');
    assert.equal(await exists(path.join(f.cacheRoot, 'opencode/generations', V2, 'stamp.json')), true, 'V2 is untouched');
    assert.equal(JSON.parse(await fs.readFile(path.join(f.cacheRoot, 'opencode/current.json'), 'utf8')).generation, V2);
    assert.equal(await exists(path.join(f.root, 'tools-saved')), true);
});

test('a second call changes nothing', async t => {
    const f = await fixture(t);
    await generation(f, V1, '1.19.6');
    await generation(f, V2, '2.4.2');
    await setCurrent(f, V2, '2.4.2');
    await retainV1OpenCode(f.args);
    const before = [await digest(f.root), await digest(f.cacheRoot)];
    assert.deepEqual(await retainV1OpenCode(f.args), { generation: null, action: 'present' });
    assert.deepEqual([await digest(f.root), await digest(f.cacheRoot)], before);
});

test('the V1 generation current.json names wins; otherwise the newest prepared one', async t => {
    const named = await fixture(t);
    await generation(named, V1, '1.19.6', { preparedAt: '2026-10-01T00:00:00.000Z' });
    await generation(named, V1_NEWER, '1.19.7', { preparedAt: '2026-11-01T00:00:00.000Z' });
    await setCurrent(named, V1, '1.19.6');
    assert.equal((await retainV1OpenCode(named.args)).generation, V1);
    for (const prepare of [f => setCurrent(f, V2, '2.4.2'), f => setCurrent(f, gen('9'), '1.0.0'), () => null]) {
        const f = await fixture(t);
        await generation(f, V1, '1.19.6', { preparedAt: '2026-10-01T00:00:00.000Z' });
        await generation(f, V1_NEWER, '1.19.7', { preparedAt: '2026-11-01T00:00:00.000Z' });
        await generation(f, V2, '2.4.2');
        await prepare(f);
        assert.deepEqual(await retainV1OpenCode(f.args), { generation: V1_NEWER, action: 'moved' });
        assert.deepEqual(await backupGenerations(f), [V1_NEWER]);
        assert.equal(await exists(path.join(f.cacheRoot, 'opencode/generations', V1)), true, 'the older V1 generation is not this call\'s concern');
    }
});

test('nothing to retain: no OpenCode directory, only V2, or stamps that do not name their generation', async t => {
    const none = await fixture(t);
    assert.deepEqual(await retainV1OpenCode(none.args), { generation: null, action: 'none' });
    assert.equal(await exists(path.join(none.root, 'tools-saved')), false, 'no marker, so a later V1 generation is still found');
    assert.equal(await exists(path.join(none.root, 'v1-tool-cache')), false);
    const v2 = await fixture(t);
    await generation(v2, V2, '2.4.2');
    await setCurrent(v2, V2, '2.4.2');
    assert.deepEqual(await retainV1OpenCode(v2.args), { generation: null, action: 'none' });
    const odd = await fixture(t);
    await generation(odd, V1, '1.19.6', { stamp: { generation: gen('f') } });
    await generation(odd, V1_NEWER, '1.19.7', { stamp: { schema: 'other' } });
    await generation(odd, gen('3'), '1.19.7', { stamp: { name: 'codex' } });
    await fs.mkdir(path.join(odd.cacheRoot, 'opencode/generations/not-a-generation'));
    await fs.writeFile(path.join(odd.cacheRoot, 'opencode/generations', gen('4')), 'a file');
    assert.deepEqual(await retainV1OpenCode(odd.args), { generation: null, action: 'none' });
    assert.equal(await exists(path.join(odd.root, 'v1-tool-cache')), false);
});

test('an interrupted earlier backup: a complete destination is kept as is; a partial one is set aside inside the backup, not deleted', async t => {
    const complete = await fixture(t);
    await generation(complete, V1, '1.19.6');
    const destination = path.join(complete.root, 'v1-tool-cache/generations', V1);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.cp(path.join(complete.cacheRoot, 'opencode/generations', V1), destination, { recursive: true, verbatimSymlinks: true });
    assert.deepEqual(await retainV1OpenCode(complete.args), { generation: V1, action: 'present' });
    assert.equal(await exists(path.join(complete.cacheRoot, 'opencode/generations', V1)), true, 'the live copy is left for collection');
    assert.equal(await exists(path.join(complete.root, 'tools-saved')), true);
    assert.equal(JSON.parse(await fs.readFile(path.join(complete.root, 'v1-tool-cache/current.json'), 'utf8')).generation, V1);

    const partial = await fixture(t);
    await generation(partial, V1, '1.19.6');
    const half = path.join(partial.root, 'v1-tool-cache/generations', V1);
    await fs.mkdir(path.join(half, 'lib'), { recursive: true });
    await fs.writeFile(path.join(half, 'lib/payload.bin'), 'half');
    assert.deepEqual(await retainV1OpenCode(partial.args), { generation: V1, action: 'moved' });
    assert.equal(await fs.readFile(path.join(half, 'lib/payload.bin'), 'utf8'), `payload-1.19.6-${V1.slice(0, 4)}`, 'the real generation is in place');
    const aside = await fs.readdir(path.join(partial.root, 'v1-tool-cache/partial'));
    assert.equal(aside.length, 1);
    assert.match(aside[0], new RegExp(`^${V1}-[0-9a-f-]{36}$`, 'u'));
    assert.equal(await fs.readFile(path.join(partial.root, 'v1-tool-cache/partial', aside[0], 'lib/payload.bin'), 'utf8'), 'half');
});

test('what an earlier whole-bundle copy left in the backup is never removed, and its descriptor is replaced by one naming V1', async t => {
    const f = await fixture(t);
    await generation(f, V1, '1.19.6');
    const old = path.join(f.root, 'v1-tool-cache');
    await fs.mkdir(path.join(old, 'generations', V2), { recursive: true });
    await fs.writeFile(path.join(old, 'generations', V2, 'stamp.json'), '{}');
    await fs.writeFile(path.join(old, 'current.json'), JSON.stringify({ schema: SCHEMA, name: 'opencode', generation: V2 }));
    await retainV1OpenCode(f.args);
    assert.deepEqual(await backupGenerations(f), [V1, V2], 'the V2 copy stays for the operator step');
    assert.equal(JSON.parse(await fs.readFile(path.join(old, 'current.json'), 'utf8')).generation, V1);
});

test('across filesystems the generation is copied, the live one stays, and a killed copy is never taken for a backup', async t => {
    const f = await fixture(t);
    await generation(f, V1, '1.19.6');
    const exdev = async () => { throw Object.assign(new Error('cross-device link not permitted'), { code: 'EXDEV' }); };
    // A copy killed earlier left its staging directory behind.
    const staging = path.join(f.root, 'v1-tool-cache/generations', `.copying-${V1}`);
    await fs.mkdir(staging, { recursive: true });
    await fs.writeFile(path.join(staging, 'half'), 'half');
    assert.deepEqual(await retainV1OpenCode({ ...f.args, rename: async (from, to) => { if (from.startsWith(f.cacheRoot)) return exdev(); return fs.rename(from, to); } }),
        { generation: V1, action: 'copied' });
    assert.deepEqual(await backupGenerations(f), [V1], 'no staging directory remains');
    assert.equal(await exists(path.join(f.cacheRoot, 'opencode/generations', V1, 'stamp.json')), true);
    assert.equal(await fs.readlink(path.join(f.root, 'v1-tool-cache/generations', V1, 'bin/opencode')), '../lib/payload.bin');
    const aside = await fs.readdir(path.join(f.root, 'v1-tool-cache/partial'));
    assert.equal(aside.length, 1);
    assert.equal(await fs.readFile(path.join(f.root, 'v1-tool-cache/partial', aside[0], 'half'), 'utf8'), 'half');
});

test('a failure throws with a count of consecutive starts, writes no marker, and success clears the count', async t => {
    const f = await fixture(t);
    await generation(f, V1, '1.19.6');
    const denied = async () => { throw Object.assign(new Error('permission denied'), { code: 'EACCES' }); };
    for (const expected of [1, 2, 3]) {
        await assert.rejects(retainV1OpenCode({ ...f.args, rename: denied }), error => error.code === 'EACCES' && error.consecutiveFailures === expected);
    }
    assert.equal(await exists(path.join(f.root, 'tools-saved')), false);
    assert.equal(await exists(path.join(f.cacheRoot, 'opencode/generations', V1, 'stamp.json')), true, 'the live generation is untouched');
    assert.equal(JSON.parse(await fs.readFile(path.join(f.root, 'v1-retention-failures.json'), 'utf8')).count, 3);
    assert.deepEqual(await retainV1OpenCode(f.args), { generation: V1, action: 'moved' });
    assert.equal(await exists(path.join(f.root, 'v1-retention-failures.json')), false);
});

test('the marker of an earlier run, even over an empty or odd backup, changes nothing at all', async t => {
    const f = await fixture(t);
    await generation(f, V1, '1.19.6');
    await fs.mkdir(f.root, { recursive: true });
    await fs.writeFile(path.join(f.root, 'tools-saved'), '1\n');
    const before = [await digest(f.root), await digest(f.cacheRoot)];
    assert.deepEqual(await retainV1OpenCode(f.args), { generation: null, action: 'present' });
    assert.deepEqual([await digest(f.root), await digest(f.cacheRoot)], before);
});
