import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pluginTreeDisposition, retireOpenCodePlugin } from '../server/opencode-plugin-retire.mjs';

const V2 = '@opencode/plugin';
const V1 = '@opencode-ai/plugin';
const NAMES = ['node_modules', 'package.json', 'package-lock.json'];

async function fixture(t) {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rw-retire-')));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const home = path.join(root, 'home');
    const config = path.join(home, '.config', 'opencode');
    await fs.mkdir(path.join(config, 'plugins'), { recursive: true });
    await fs.writeFile(path.join(config, 'plugins', 'soul-gateway.js'), 'export default {};\n');
    return { root, home, config };
}

// What `npm install <plugin package>@<version>` leaves in the configuration directory.
async function writeTree(config, { name = V2, version = '2.4.1', manifest, lock } = {}) {
    const dependencies = { [name]: version };
    await fs.mkdir(path.join(config, 'node_modules', name), { recursive: true });
    await fs.mkdir(path.join(config, 'node_modules', '.bin'), { recursive: true });
    await fs.writeFile(path.join(config, 'node_modules', name, 'package.json'), JSON.stringify({ name, version }));
    await fs.symlink(`../${name}/package.json`, path.join(config, 'node_modules', '.bin', 'link'));
    await fs.writeFile(path.join(config, 'package.json'), JSON.stringify(manifest ?? { dependencies }));
    await fs.writeFile(path.join(config, 'package-lock.json'), JSON.stringify(lock ?? { lockfileVersion: 3,
        packages: { '': { dependencies }, [`node_modules/${name}`]: { version } } }));
}

// Every entry below a directory with its type and content, so "byte-identical" can be asserted.
async function digest(directory) {
    const result = {};
    const walk = async (current, prefix) => {
        for (const entry of (await fs.readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
            const file = path.join(current, entry.name);
            const key = path.posix.join(prefix, entry.name);
            if (entry.isSymbolicLink()) result[key] = `link:${await fs.readlink(file)}`;
            else if (entry.isDirectory()) { result[key] = 'dir'; await walk(file, key); }
            else result[key] = `file:${(await fs.readFile(file)).toString('base64')}`;
        }
    };
    await walk(directory, '');
    return result;
}

const names = async config => (await fs.readdir(config)).sort();
const hasNone = async config => (await names(config)).filter(name => NAMES.includes(name)).length === 0;

for (const [label, name, version] of [['V2', V2, '2.4.1'], ['V1', V1, '1.19.6']]) {
    test(`a ${label} managed copy loses node_modules, the lock and the manifest, keeps the plugin, and a second run finds nothing`, async (t) => {
        const { home, config } = await fixture(t);
        await writeTree(config, { name, version });
        await fs.writeFile(path.join(config, 'soul-gateway-models.mjs'), 'export {};\n');
        assert.equal((await pluginTreeDisposition(home)).status, 'managed');
        assert.deepEqual(await retireOpenCodePlugin(home), { status: 'retired' });
        assert.equal(await hasNone(config), true);
        assert.deepEqual(await names(config), ['plugins', 'soul-gateway-models.mjs']);
        assert.equal(await fs.readFile(path.join(config, 'plugins', 'soul-gateway.js'), 'utf8'), 'export default {};\n');
        assert.deepEqual(await retireOpenCodePlugin(home), { status: 'absent' });
    });
}

test('boundary: an empty configuration directory, a missing one and a missing home are absent', async (t) => {
    const { root, home, config } = await fixture(t);
    await fs.rm(path.join(config, 'plugins'), { recursive: true });
    assert.deepEqual(await names(config), []);
    assert.deepEqual(await retireOpenCodePlugin(home), { status: 'absent' });
    await fs.rm(path.join(home, '.config'), { recursive: true });
    assert.deepEqual(await retireOpenCodePlugin(home), { status: 'absent' });
    assert.deepEqual(await retireOpenCodePlugin(path.join(root, 'no-home')), { status: 'absent' });
});

test('boundary: a managed tree with no files at all, and a manifest with no tree, are retired', async (t) => {
    const { home, config } = await fixture(t);
    await writeTree(config);
    await fs.rm(path.join(config, 'node_modules'), { recursive: true });
    await fs.mkdir(path.join(config, 'node_modules'));
    assert.deepEqual(await retireOpenCodePlugin(home), { status: 'retired' }, 'an empty node_modules');
    await fs.writeFile(path.join(config, 'package.json'), JSON.stringify({ dependencies: { [V1]: '1.19.6' } }));
    assert.deepEqual(await retireOpenCodePlugin(home), { status: 'retired' }, 'a manifest alone, as an interrupted run leaves it');
    assert.equal(await hasNone(config), true);
});

test('boundary: a manifest of exactly 4 MiB is read, one byte more is unsafe and left alone', async (t) => {
    const { home, config } = await fixture(t);
    await writeTree(config);
    const body = JSON.stringify({ dependencies: { [V2]: '2.4.1' } });
    const limit = 4 * 1024 * 1024;
    await fs.writeFile(path.join(config, 'package.json'), body + ' '.repeat(limit - body.length));
    assert.equal((await fs.stat(path.join(config, 'package.json'))).size, limit);
    assert.equal((await pluginTreeDisposition(home)).status, 'managed');
    await fs.writeFile(path.join(config, 'package.json'), body + ' '.repeat(limit - body.length + 1));
    const before = await digest(config);
    assert.equal((await retireOpenCodePlugin(home)).status, 'unsafe');
    assert.deepEqual(await digest(config), before);
});

const leftoverNames = () => [`.roboteam-seed-${randomUUID()}`, `.roboteam-stale-${randomUUID()}`];

test('leftovers of a killed earlier run are removed, and only exact names that are real directories', async (t) => {
    const { home, config } = await fixture(t);
    const [seed, stale] = leftoverNames();
    for (const name of [seed, stale]) {
        await fs.mkdir(path.join(config, name, 'node_modules', 'deep'), { recursive: true });
        await fs.writeFile(path.join(config, name, 'node_modules', 'deep', 'file'), 'x');
    }
    const lookalikes = ['.roboteam-seed-not-a-uuid', `.roboteam-stale-${randomUUID()}.bak`, `.roboteam-keep-${randomUUID()}`];
    for (const name of lookalikes) await fs.mkdir(path.join(config, name));
    const fileNamed = `.roboteam-stale-${randomUUID()}`;
    await fs.writeFile(path.join(config, fileNamed), 'a file with the name is not ours to remove');
    const outside = path.join(path.dirname(home), 'outside');
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'sentinel'), 'keep');
    const linkNamed = `.roboteam-seed-${randomUUID()}`;
    await fs.symlink(outside, path.join(config, linkNamed));
    assert.deepEqual(await retireOpenCodePlugin(home), { status: 'absent' });
    const left = await names(config);
    for (const kept of [...lookalikes, fileNamed, linkNamed, 'plugins']) assert.ok(left.includes(kept), `${kept} stays`);
    assert.equal(left.includes(seed) || left.includes(stale), false);
    assert.equal(await fs.readFile(path.join(outside, 'sentinel'), 'utf8'), 'keep');
});

test('concurrency: a helper killed between the rename and the deletion leaves a state the next run finishes', async (t) => {
    const { home, config } = await fixture(t);
    await writeTree(config);
    // node_modules already renamed aside, nothing deleted yet.
    const [, stale] = leftoverNames();
    await fs.rename(path.join(config, 'node_modules'), path.join(config, stale));
    assert.equal((await pluginTreeDisposition(home)).status, 'managed', 'a manifest and lock without a tree are still ours');
    assert.deepEqual(await retireOpenCodePlugin(home), { status: 'retired' });
    assert.equal(await hasNone(config), true);
    assert.deepEqual(await names(config), ['plugins']);
    // Killed after the tree and the lock went, with the manifest last.
    await writeTree(config);
    await fs.rm(path.join(config, 'node_modules'), { recursive: true });
    await fs.rm(path.join(config, 'package-lock.json'));
    assert.deepEqual(await retireOpenCodePlugin(home), { status: 'retired' });
    assert.deepEqual(await retireOpenCodePlugin(home), { status: 'absent' });
});

async function assertLeftAlone(home, config, expected) {
    const before = await digest(home);
    const result = await retireOpenCodePlugin(home);
    assert.equal(result.status, expected, JSON.stringify(result));
    assert.deepEqual(await digest(home), before, 'byte-identical before and after');
    assert.equal((await pluginTreeDisposition(home)).status, expected);
}

test('authored: another plugin entry or a plugin key in a configuration document keeps the tree', async (t) => {
    for (const [label, setup] of [
        ['a second file in plugins', async config => fs.writeFile(path.join(config, 'plugins', 'mine.ts'), 'export default {};')],
        ['a plugin in the plugin directory', async config => { await fs.mkdir(path.join(config, 'plugin', 'mine'), { recursive: true }); }],
        ['a plugin key in opencode.json', async config => fs.writeFile(path.join(config, 'opencode.json'), '{"plugin":["my-plugin"]}')],
        ['a plugins key in opencode.json', async config => fs.writeFile(path.join(config, 'opencode.json'), '{"plugins":[]}')],
        ['comments and a plugin key in opencode.jsonc', async config => fs.writeFile(path.join(config, 'opencode.jsonc'),
            '// my setup\n{\n  /* load mine */ "plugin": ["file:///x", ], // trailing comma\n}\n')],
        ['a BOM before the plugin key', async config => fs.writeFile(path.join(config, 'opencode.jsonc'), '﻿{"plugin":["x"]}')],
        ['an unparsable configuration document', async config => fs.writeFile(path.join(config, 'opencode.json'), '{ not json')],
        ['a configuration document that is not an object', async config => fs.writeFile(path.join(config, 'opencode.json'), '["plugin"]')],
        ['an unterminated comment', async config => fs.writeFile(path.join(config, 'opencode.jsonc'), '{"model":"a"} /* never closed')],
    ]) {
        await t.test(label, async (sub) => {
            const { home, config } = await fixture(sub);
            await writeTree(config);
            await setup(config);
            await assertLeftAlone(home, config, 'authored');
        });
    }
    await t.test('a configuration document without a plugin key does not make the tree authored', async (sub) => {
        const { home, config } = await fixture(sub);
        await writeTree(config);
        await fs.writeFile(path.join(config, 'opencode.jsonc'), '// only a model\n{ "model": "a/b", "note": "has \\"plugin\\" and // inside a string", }\n');
        assert.deepEqual(await retireOpenCodePlugin(home), { status: 'retired' });
    });
});

test('customized: other dependencies, a foreign manifest or lock, or a tree without a manifest are left alone', async (t) => {
    for (const [label, setup] of [
        ['an extra dependency', config => writeTree(config, { manifest: { dependencies: { [V2]: '2.4.1', 'left-pad': '1.3.0' } } })],
        ['a different dependency only', config => writeTree(config, { manifest: { dependencies: { 'left-pad': '1.3.0' } } })],
        ['both plugin packages', config => writeTree(config, { manifest: { dependencies: { [V2]: '2.4.1', [V1]: '1.19.6' } } })],
        ['a dev dependency', config => writeTree(config, { manifest: { dependencies: { [V2]: '2.4.1' }, devDependencies: { x: '1' } } })],
        ['an extra manifest field', config => writeTree(config, { manifest: { name: 'mine', dependencies: { [V2]: '2.4.1' } } })],
        ['a non-string version', config => writeTree(config, { manifest: { dependencies: { [V2]: 2 } } })],
        ['a manifest that is an array', config => writeTree(config, { manifest: [] })],
        ['a lock that lists another dependency', config => writeTree(config, { lock: { lockfileVersion: 3,
            packages: { '': { dependencies: { [V2]: '2.4.1', 'left-pad': '1' } } } } })],
        ['a lock whose root has a dev dependency', config => writeTree(config, { lock: { lockfileVersion: 3,
            packages: { '': { dependencies: { [V2]: '2.4.1' }, devDependencies: { x: '1' } } } } })],
        ['a lock without a root record', config => writeTree(config, { lock: { lockfileVersion: 1 } })],
        ['an unparsable manifest', async config => { await writeTree(config); await fs.writeFile(path.join(config, 'package.json'), '{ nope'); }],
        ['an unparsable lock', async config => { await writeTree(config); await fs.writeFile(path.join(config, 'package-lock.json'), '{ nope'); }],
        ['a node_modules without a manifest', async config => { await writeTree(config); await fs.rm(path.join(config, 'package.json')); }],
        ['a lock alone', async config => { await writeTree(config); await fs.rm(path.join(config, 'package.json')); await fs.rm(path.join(config, 'node_modules'), { recursive: true }); }],
    ]) {
        await t.test(label, async (sub) => {
            const { home, config } = await fixture(sub);
            await setup(config);
            await assertLeftAlone(home, config, 'customized');
        });
    }
});

test('unsafe: a link or special file at a managed name, a shared inode, or a link above the directory is never followed', async (t) => {
    const make = async (sub, setup) => {
        const f = await fixture(sub);
        f.outside = path.join(f.root, 'outside');
        await fs.mkdir(f.outside);
        await fs.writeFile(path.join(f.outside, 'sentinel'), 'keep');
        await writeTree(f.config);
        await setup(f);
        return f;
    };
    const cases = [
        ['node_modules is a link', async ({ config, outside }) => { await fs.rm(path.join(config, 'node_modules'), { recursive: true }); await fs.symlink(outside, path.join(config, 'node_modules')); }],
        ['package.json is a link', async ({ config, outside }) => { await fs.rm(path.join(config, 'package.json')); await fs.symlink(path.join(outside, 'sentinel'), path.join(config, 'package.json')); }],
        ['package-lock.json is a link', async ({ config, outside }) => { await fs.rm(path.join(config, 'package-lock.json')); await fs.symlink(path.join(outside, 'sentinel'), path.join(config, 'package-lock.json')); }],
        ['package.json has two names', async ({ config, outside }) => { await fs.link(path.join(config, 'package.json'), path.join(outside, 'second-name')); }],
        ['node_modules is a file', async ({ config }) => { await fs.rm(path.join(config, 'node_modules'), { recursive: true }); await fs.writeFile(path.join(config, 'node_modules'), 'x'); }],
        ['package.json is a directory', async ({ config }) => { await fs.rm(path.join(config, 'package.json')); await fs.mkdir(path.join(config, 'package.json')); }],
        ['plugins is a link', async ({ config, outside }) => { await fs.rm(path.join(config, 'plugins'), { recursive: true }); await fs.symlink(outside, path.join(config, 'plugins')); }],
        ['soul-gateway.js is a link', async ({ config, outside }) => { await fs.rm(path.join(config, 'plugins', 'soul-gateway.js')); await fs.symlink(path.join(outside, 'sentinel'), path.join(config, 'plugins', 'soul-gateway.js')); }],
    ];
    for (const [label, setup] of cases) {
        await t.test(label, async (sub) => {
            const f = await make(sub, setup);
            const before = [await digest(f.home), await digest(f.outside)];
            assert.equal((await retireOpenCodePlugin(f.home)).status, 'unsafe');
            assert.deepEqual([await digest(f.home), await digest(f.outside)], before);
        });
    }
    for (const [label, link] of [['.config', path.join('.config')], ['.config/opencode', path.join('.config', 'opencode')]]) {
        await t.test(`${label} is a link to another directory: nothing there is removed`, async (sub) => {
            const f = await fixture(sub);
            const other = path.join(f.root, 'other-home');
            await fs.mkdir(path.join(other, '.config'), { recursive: true });
            const target = link === '.config' ? path.join(other, '.config') : path.join(other, 'opencode');
            await fs.mkdir(path.join(target, link === '.config' ? 'opencode' : ''), { recursive: true });
            const tree = link === '.config' ? path.join(target, 'opencode') : target;
            await writeTree(tree);
            await fs.writeFile(path.join(tree, '.roboteam-seed-' + randomUUID()), 'a file, not a leftover directory');
            await fs.rm(path.join(f.home, link), { recursive: true });
            await fs.symlink(target, path.join(f.home, link));
            const before = [await digest(other), await fs.readlink(path.join(f.home, link))];
            assert.equal((await retireOpenCodePlugin(f.home)).status, 'unsafe');
            assert.deepEqual([await digest(other), await fs.readlink(path.join(f.home, link))], before);
        });
    }
});

test('a failure is reported, never thrown, and leaves the home as it was found', { skip: process.getuid?.() === 0 }, async (t) => {
    const { home, config } = await fixture(t);
    await writeTree(config);
    await fs.chmod(config, 0o500);
    t.after(() => fs.chmod(config, 0o700).catch(() => {}));
    const result = await retireOpenCodePlugin(home);
    assert.equal(result.status, 'failed');
    assert.equal(typeof result.error, 'string');
    await fs.chmod(config, 0o700);
    assert.equal((await pluginTreeDisposition(home)).status, 'managed', 'nothing was partly removed in a way that changes the class');
});

test('static control: the OpenCode binary supplies plugin modules itself and has no dependency installer', {
    skip: process.env.OPENCODE_BIN ? false : 'set OPENCODE_BIN to an OpenCode 2 executable',
}, async () => {
    const binary = await fs.readFile(process.env.OPENCODE_BIN);
    assert.ok(binary.includes('is not provided by OpenCode'));
    for (const absent of ['background dependency install failed', 'add:[{name:"@opencode', 'waitForDependencies']) {
        assert.equal(binary.includes(absent), false, absent);
    }
});
