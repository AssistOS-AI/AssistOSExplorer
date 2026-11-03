import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { OPENCODE_PLUGIN_PACKAGE, openCodePluginState, seedOpenCodePlugin } from '../../roboWorkAgent/server/opencode-plugin-seed.mjs';
import { prepareRobotShell } from '../../roboWorkAgent/server/robot-shell.mjs';
import { ToolCache } from '../../roboWorkAgent/server/tool-cache.mjs';

const PLUGIN = OPENCODE_PLUGIN_PACKAGE;

// Writes what `npm install @opencode-ai/plugin@<version>` leaves in a directory.
async function writeInstall(directory, version, { extra = [] } = {}) {
    const dependencies = { [PLUGIN]: version };
    await fs.mkdir(path.join(directory, 'node_modules', PLUGIN), { recursive: true });
    await fs.mkdir(path.join(directory, 'node_modules', '.bin'), { recursive: true });
    await fs.writeFile(path.join(directory, 'node_modules', PLUGIN, 'package.json'), JSON.stringify({ name: PLUGIN, version }));
    await fs.writeFile(path.join(directory, 'node_modules', PLUGIN, `marker-${version}.txt`), version);
    await fs.symlink('../@opencode-ai/plugin/package.json', path.join(directory, 'node_modules', '.bin', 'plugin-link'));
    await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({ dependencies: { ...dependencies, ...Object.fromEntries(extra) } }));
    await fs.writeFile(path.join(directory, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: {
        '': { dependencies }, [`node_modules/${PLUGIN}`]: { version } } }));
}

// OpenCode's Npm.install, as read from the OpenCode 1.18.35 binary: it installs only when
// node_modules is missing, or a dependency name is absent from the lock's root record. It
// never compares versions.
async function openCodeWouldInstall(directory) {
    const exists = await fs.stat(path.join(directory, 'node_modules')).then(() => true, () => false);
    if (!exists) return true;
    const read = file => fs.readFile(path.join(directory, file), 'utf8').then(JSON.parse, () => ({}));
    const manifest = await read('package.json');
    const lock = await read('package-lock.json');
    const wanted = new Set([...Object.keys(manifest.dependencies || {}), PLUGIN]);
    const locked = new Set(Object.keys(lock.packages?.['']?.dependencies || {}));
    return [...wanted].some(name => !locked.has(name));
}

async function fixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'roboteam-plugin-seed-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const home = path.join(root, 'home');
    await fs.mkdir(path.join(home, '.config', 'opencode'), { recursive: true });
    const templatePath = path.join(root, 'template');
    await fs.mkdir(templatePath);
    await writeInstall(templatePath, '2.0.0');
    return { root, home, config: path.join(home, '.config', 'opencode'), template: { path: templatePath, version: '2.0.0' } };
}

const installedVersion = async config => JSON.parse(await fs.readFile(path.join(config, 'node_modules', PLUGIN, 'package.json'), 'utf8')).version;
const leftovers = async config => (await fs.readdir(config)).filter(name => name.startsWith('.roboteam-'));

test('a home with no install is seeded so OpenCode finds nothing to install', async (t) => {
    const { home, config, template } = await fixture(t);
    assert.equal(await openCodeWouldInstall(config), true);
    assert.deepEqual(await seedOpenCodePlugin(home, template), { status: 'seeded' });
    assert.equal(await openCodeWouldInstall(config), false);
    assert.equal(await installedVersion(config), '2.0.0');
    assert.deepEqual((await openCodePluginState(config, '2.0.0')).current, true);
    assert.equal((await fs.lstat(path.join(config, 'node_modules'))).isSymbolicLink(), false);
    // Relative links inside the tree survive the copy and keep resolving inside the home.
    assert.equal(await fs.readlink(path.join(config, 'node_modules', '.bin', 'plugin-link')), '../@opencode-ai/plugin/package.json');
    assert.deepEqual(await leftovers(config), []);
});

test('a matching version is left untouched and writes nothing', async (t) => {
    const { home, config, template } = await fixture(t);
    await seedOpenCodePlugin(home, template);
    const before = await Promise.all(['node_modules', 'package.json', 'package-lock.json'].map(name => fs.stat(path.join(config, name))));
    assert.deepEqual(await seedOpenCodePlugin(home, template), { status: 'current' });
    const after = await Promise.all(['node_modules', 'package.json', 'package-lock.json'].map(name => fs.stat(path.join(config, name))));
    assert.deepEqual(after.map(entry => [entry.ino, entry.mtimeMs]), before.map(entry => [entry.ino, entry.mtimeMs]));
    assert.deepEqual(await leftovers(config), []);
});

test('an install left by another OpenCode version is replaced, since OpenCode never checks versions', async (t) => {
    const { home, config, template } = await fixture(t);
    await writeInstall(config, '1.0.0');
    // OpenCode would not repair this by itself: the dependency name is already in the lock.
    assert.equal(await openCodeWouldInstall(config), false);
    assert.deepEqual(await seedOpenCodePlugin(home, template), { status: 'reseeded' });
    assert.equal(await installedVersion(config), '2.0.0');
    assert.equal(JSON.parse(await fs.readFile(path.join(config, 'package.json'), 'utf8')).dependencies[PLUGIN], '2.0.0');
    await assert.rejects(fs.access(path.join(config, 'node_modules', PLUGIN, 'marker-1.0.0.txt')));
    await fs.access(path.join(config, 'node_modules', PLUGIN, 'marker-2.0.0.txt'));
    assert.deepEqual(await leftovers(config), []);
});

test('a missing or unusable template falls back to normal OpenCode behaviour and leaves the home alone', async (t) => {
    const { home, config, template } = await fixture(t);
    assert.deepEqual(await seedOpenCodePlugin(home, null), { status: 'unavailable' });
    const failed = await seedOpenCodePlugin(home, { path: path.join(template.path, 'absent'), version: '2.0.0' });
    assert.equal(failed.status, 'failed');
    assert.deepEqual(await fs.readdir(config), []);
    assert.equal(await openCodeWouldInstall(config), true);
});

test('dependencies the user added are never overwritten', async (t) => {
    const { home, config, template } = await fixture(t);
    await writeInstall(config, '1.0.0', { extra: [['left-pad', '1.3.0']] });
    const before = await fs.readFile(path.join(config, 'package.json'), 'utf8');
    assert.deepEqual(await seedOpenCodePlugin(home, template), { status: 'customized' });
    assert.equal(await fs.readFile(path.join(config, 'package.json'), 'utf8'), before);
    assert.equal(await installedVersion(config), '1.0.0');
    await fs.rm(path.join(config, 'package.json'));
    assert.deepEqual(await seedOpenCodePlugin(home, template), { status: 'customized' }, 'node_modules without a manifest is not ours');
    assert.equal(await installedVersion(config), '1.0.0');
});

test('links where the seed would read or write are refused and never followed', async (t) => {
    const { root, home, config, template } = await fixture(t);
    const outside = path.join(root, 'outside');
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'sentinel'), 'keep');
    await fs.symlink(outside, path.join(config, 'node_modules'));
    assert.deepEqual(await seedOpenCodePlugin(home, template), { status: 'unsafe' });
    assert.deepEqual(await fs.readdir(outside), ['sentinel']);
    await fs.rm(path.join(config, 'node_modules'));
    await fs.symlink(path.join(outside, 'sentinel'), path.join(config, 'package.json'));
    assert.deepEqual(await seedOpenCodePlugin(home, template), { status: 'unsafe' });
    assert.equal(await fs.readFile(path.join(outside, 'sentinel'), 'utf8'), 'keep');
    // A hard-linked manifest is not read either.
    await fs.rm(path.join(config, 'package.json'));
    await fs.link(path.join(outside, 'sentinel'), path.join(config, 'package.json'));
    assert.deepEqual(await seedOpenCodePlugin(home, template), { status: 'unsafe' });
    assert.equal(await fs.readFile(path.join(outside, 'sentinel'), 'utf8'), 'keep');
});

test('seeding copies the template: changes in the home never reach the shared cache', async (t) => {
    const { home, config, template } = await fixture(t);
    await seedOpenCodePlugin(home, template);
    await fs.writeFile(path.join(config, 'node_modules', PLUGIN, 'package.json'), '{"version":"tampered"}');
    await fs.access(path.join(template.path, 'node_modules', PLUGIN, 'marker-2.0.0.txt'));
    assert.equal(JSON.parse(await fs.readFile(path.join(template.path, 'node_modules', PLUGIN, 'package.json'), 'utf8')).version, '2.0.0');
    // The tampered home reads as stale and is repaired from the template.
    assert.deepEqual(await seedOpenCodePlugin(home, template), { status: 'reseeded' });
    assert.equal(await installedVersion(config), '2.0.0');
});

test('concurrent preparations of one home converge on one complete install', async (t) => {
    const { home, config, template } = await fixture(t);
    const results = await Promise.all(Array.from({ length: 6 }, () => seedOpenCodePlugin(home, template)));
    assert.ok(results.every(result => ['seeded', 'current'].includes(result.status)), JSON.stringify(results));
    assert.ok(results.some(result => result.status === 'seeded'));
    assert.equal(await installedVersion(config), '2.0.0');
    assert.equal(await openCodeWouldInstall(config), false);
    assert.deepEqual(await leftovers(config), []);
});

test('prepareRobotShell seeds the plugin template alongside the Soul Gateway plugin', async (t) => {
    const { home, config, template } = await fixture(t);
    await prepareRobotShell(home);
    assert.equal(await openCodeWouldInstall(config), true, 'no template: unchanged behaviour');
    await prepareRobotShell(home, { openCodePlugin: template });
    assert.equal(await openCodeWouldInstall(config), false);
    assert.equal(await installedVersion(config), '2.0.0');
    await fs.access(path.join(config, 'plugins', 'soul-gateway.js'));
});

// A fake npm that installs the requested plugin the way the real one does.
function fakeNpm(calls, { failWith } = {}) {
    return async (command, args) => {
        calls.push([command, ...args]);
        if (failWith) throw new Error(failWith);
        const prefix = args[args.indexOf('--prefix') + 1];
        const manifest = JSON.parse(await fs.readFile(path.join(prefix, 'package.json'), 'utf8'));
        await writeInstall(prefix, manifest.dependencies[PLUGIN]);
        return { stdout: '', stderr: '' };
    };
}

test('the tool cache prepares one plugin template per exact OpenCode version', async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'roboteam-plugin-template-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const calls = [];
    const cache = new ToolCache({ root, execFileImpl: fakeNpm(calls), log: () => {}, versionPins: {} });
    assert.equal(await cache.peekOpenCodePlugin('1.18.35'), null, 'nothing is installed by a peek');
    assert.equal(calls.length, 0);
    const [first, second] = await Promise.all([cache.prepareOpenCodePlugin('1.18.35'), cache.prepareOpenCodePlugin('1.18.35')]);
    assert.equal(first.path, second.path);
    assert.equal(calls.length, 1, 'concurrent callers share one install');
    const install = calls[0];
    assert.ok(install.includes('--ignore-scripts'));
    assert.ok(!install.includes('--no-package-lock'), 'the lock is what makes OpenCode skip its own install');
    assert.deepEqual(await cache.peekOpenCodePlugin('1.18.35'), { path: first.path, version: '1.18.35' });
    assert.ok((await openCodePluginState(first.path, '1.18.35')).current);
    // A different OpenCode version never sees this template, and gets its own on demand.
    assert.equal(await cache.peekOpenCodePlugin('1.18.36'), null);
    const next = await cache.prepareOpenCodePlugin('1.18.36');
    assert.notEqual(next.path, first.path);
    assert.equal(calls.length, 2);
    assert.equal((await cache.peekOpenCodePlugin('1.18.35')).path, first.path);
    // Another process finds the prepared generation without installing.
    const other = new ToolCache({ root, execFileImpl: fakeNpm(calls), log: () => {}, versionPins: {} });
    assert.equal((await other.prepareOpenCodePlugin('1.18.35')).path, first.path);
    assert.equal(calls.length, 2);
});

test('plugin template validation runs on every peek and rejects damaged or unsafe versions', async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'roboteam-plugin-template-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const cache = new ToolCache({ root, execFileImpl: fakeNpm([]), log: () => {}, versionPins: {} });
    const prepared = await cache.prepareOpenCodePlugin('1.18.35');
    await fs.writeFile(path.join(prepared.path, 'node_modules', PLUGIN, 'package.json'), JSON.stringify({ version: '1.18.34' }));
    assert.equal(await cache.peekOpenCodePlugin('1.18.35'), null, 'an installed version that differs invalidates the template');
    for (const bad of ['', 'latest', '1.2', '../../x', '1.2.3; rm', null, undefined]) {
        assert.equal(await cache.peekOpenCodePlugin(bad), null);
        await assert.rejects(cache.prepareOpenCodePlugin(bad), TypeError);
    }
});

test('a failed plugin install leaves no generation and no fallback to another version', async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'roboteam-plugin-template-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const good = new ToolCache({ root, execFileImpl: fakeNpm([]), log: () => {}, versionPins: {} });
    await good.prepareOpenCodePlugin('1.18.35');
    const offline = new ToolCache({ root, execFileImpl: fakeNpm([], { failWith: 'offline' }), log: () => {}, versionPins: {} });
    await assert.rejects(offline.prepareOpenCodePlugin('1.18.36'), /offline/);
    assert.equal(await offline.peekOpenCodePlugin('1.18.36'), null);
    const generations = path.join(root, 'opencode-plugin', 'generations');
    assert.equal((await fs.readdir(generations)).length, 1, 'no staging directory or partial generation remains');
});

test('a seed aborts before moving anything into a home when the robot is being deleted', async (t) => {
    const { home, config, template } = await fixture(t);
    assert.deepEqual(await seedOpenCodePlugin(home, template, { isCancelled: () => true }), { status: 'aborted' });
    assert.deepEqual(await fs.readdir(config), []);
    let checks = 0;
    const result = await seedOpenCodePlugin(home, template, { isCancelled: () => ++checks > 1 });
    assert.equal(result.status, 'aborted', 'the check also runs after the copy, before the renames');
    assert.deepEqual(await fs.readdir(config), [], 'staging was removed');
});
