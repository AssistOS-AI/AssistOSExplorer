import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { pluginTreeDisposition } from '../server/opencode-plugin-retire.mjs';

const run = promisify(execFile);
const REPORT = new URL('../scripts/robot-storage-report.mjs', import.meta.url).pathname;
const PRUNE = new URL('../scripts/prune-opencode-migration.mjs', import.meta.url).pathname;
const RETIRE = new URL('../server/opencode-plugin-retire.mjs', import.meta.url).pathname;
const ID = 'opencode-v2-1';
const V2 = '@opencode/plugin';
const V1 = '@opencode-ai/plugin';
const gen = digit => digit.repeat(64);
const SCHEMA = 'roboteam-tool-cache-v1';

// util-linux flock does not exist on every development host. Where it is missing, a stand-in with the same command line
// takes a directory as the lock; "held" then means that directory exists. The kernel lock itself runs only where flock does.
const REAL_FLOCK = await run('sh', ['-c', 'command -v flock']).then(() => true, () => false);
let standIn;
async function flockCommand(t) {
    if (REAL_FLOCK) return {};
    if (!standIn) {
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rw-flock-'));
        standIn = path.join(directory, 'flock');
        await fs.writeFile(standIn, '#!/bin/sh\nfile="$3"; shift 3\nmkdir "$file.held" 2>/dev/null || exit 1\ntrap \'rmdir "$file.held"\' EXIT\n"$@"\n', { mode: 0o755 });
    }
    return { ROBOWORK_FLOCK: standIn };
}

async function holdLock(f) {
    const file = path.join(f.migrations, 'migration.lock');
    if (!REAL_FLOCK) { await fs.mkdir(`${file}.held`); return async () => fs.rm(`${file}.held`, { recursive: true, force: true }); }
    const child = spawn('flock', ['--exclusive', '--nonblock', file, 'sleep', '60'], { stdio: 'ignore' });
    await new Promise(resolve => setTimeout(resolve, 300));
    return async () => { child.kill(); };
}

async function layout(t) {
    const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rw-storage-')));
    t.after(() => fs.rm(base, { recursive: true, force: true }));
    const f = { base, dataDir: path.join(base, 'data'), robotsDir: path.join(base, 'robots'), env: await flockCommand(t) };
    f.migrations = path.join(f.dataDir, 'server-state/migrations', ID);
    await fs.mkdir(f.migrations, { recursive: true });
    await fs.mkdir(f.robotsDir, { recursive: true });
    await fs.mkdir(path.join(f.dataDir, 'tool-cache'), { recursive: true });
    return f;
}

async function put(file, text) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text); }

// What a V1 home or a snapshot holds in `.config/opencode`; extra entries make it authored, customized or unsafe.
async function writeTree(config, { name = V1, version = '1.19.6', bytes = 1000, manifest, lock, plugins = true } = {}) {
    const dependencies = { [name]: version };
    await put(path.join(config, 'node_modules', name, 'package.json'), JSON.stringify({ name, version }));
    await put(path.join(config, 'node_modules', name, 'payload.bin'), 'x'.repeat(bytes));
    await put(path.join(config, 'package.json'), JSON.stringify(manifest ?? { dependencies }));
    await put(path.join(config, 'package-lock.json'), JSON.stringify(lock ?? { lockfileVersion: 3, packages: { '': { dependencies }, [`node_modules/${name}`]: { version } } }));
    if (plugins) await put(path.join(config, 'plugins/soul-gateway.js'), 'export default {};\n');
}

const SESSIONS = ['ses_a', 'ses_b'];
async function addRobot(f, id, { label = true, phase = 'complete', sessions = 2, home = 'managed', snapshot = 'managed', bytes = 1000, journal = true } = {}) {
    const robot = path.join(f.robotsDir, id);
    await fs.mkdir(path.join(robot, 'home'), { recursive: true });
    if (label) await put(path.join(robot, 'label'), '{}');
    const config = path.join(robot, 'home/.config/opencode');
    await fs.mkdir(config, { recursive: true });
    await setup(config, home, bytes);
    await put(path.join(robot, 'home/notes.txt'), 'home notes');
    if (!journal) return;
    const backup = path.join(f.migrations, id);
    await put(path.join(backup, 'state.json'), JSON.stringify({ migration: ID, phase, ...(phase === 'complete' ? { sessions } : {}) }));
    await put(path.join(backup, 'snapshot.json'), JSON.stringify({ included: ['.config/opencode'], excluded: [], before: { sessions: SESSIONS, messages: [], credentials: {} } }));
    await put(path.join(backup, 'snapshot/.local/share/opencode/opencode.db'), 'database');
    if (snapshot) await setup(path.join(backup, 'snapshot/.config/opencode'), snapshot, bytes);
}

async function setup(config, kind, bytes = 1000) {
    await fs.mkdir(config, { recursive: true });
    if (kind === 'absent') return;
    if (kind === 'managed') return writeTree(config, { bytes });
    if (kind === 'managed-v2') return writeTree(config, { name: V2, version: '2.4.1', bytes });
    if (kind === 'customized') return writeTree(config, { bytes, manifest: { dependencies: { [V1]: '1.19.6', 'left-pad': '1.3.0' } } });
    if (kind === 'authored') { await writeTree(config, { bytes }); return put(path.join(config, 'opencode.jsonc'), '// mine\n{ "plugin": ["x"], }\n'); }
    if (kind === 'authored-entry') { await writeTree(config, { bytes }); return put(path.join(config, 'plugins/mine.ts'), 'export default {};'); }
    if (kind === 'unsafe') { await writeTree(config, { bytes }); await fs.rm(path.join(config, 'package.json')); return fs.symlink('/nonexistent-target', path.join(config, 'package.json')); }
    throw new Error(`unknown kind ${kind}`);
}

async function digest(directory) {
    const result = {};
    const walk = async (current) => {
        for (const entry of (await fs.readdir(current, { withFileTypes: true }).catch(() => [])).sort((a, b) => a.name.localeCompare(b.name))) {
            const file = path.join(current, entry.name), key = path.relative(directory, file);
            if (entry.isSymbolicLink()) result[key] = `link:${await fs.readlink(file)}`;
            else if (entry.isDirectory()) { result[key] = 'dir'; await walk(file); }
            else result[key] = `file:${(await fs.readFile(file)).toString('base64')}`;
        }
    };
    await walk(directory);
    return result;
}

const exists = file => fs.lstat(file).then(() => true, () => false);
const args = (f, ...more) => ['--data-dir', f.dataDir, '--robots-dir', f.robotsDir, ...more];
const execute = (f, script, ...more) => run(process.execPath, [script, ...args(f, ...more)], { env: { ...process.env, ...f.env } })
    .then(result => ({ code: 0, ...result }), error => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }));
const report = async f => JSON.parse((await execute(f, REPORT, '--json')).stdout);
const prune = (f, ...flags) => execute(f, PRUNE, ...flags);

// ---------------------------------------------------------------- the report ----

test('report: per robot journal phase, disposition and sizes; per bundle generations with the rule that keeps each', async t => {
    const f = await layout(t);
    await addRobot(f, 'aaa', { home: 'managed', bytes: 5000 });
    await addRobot(f, 'bbb', { home: 'authored', phase: 'migrating', snapshot: null });
    await addRobot(f, 'ccc', { home: 'customized' });
    await addRobot(f, 'ddd', { home: 'absent', journal: false });
    await addRobot(f, 'eee', { home: 'authored-entry' });
    await put(path.join(f.robotsDir, 'aaa/home/.cache/chromium/blob'), 'c'.repeat(300));
    await put(path.join(f.robotsDir, 'aaa/home/.npm/_cacache/x'), 'n'.repeat(200));
    await put(path.join(f.robotsDir, 'aaa/home/.opencode/node_modules/p/index.js'), 'p'.repeat(100));
    const result = await report(f);
    const byId = Object.fromEntries(result.robots.map(robot => [robot.id, robot]));
    assert.equal(byId.aaa.journal.phase, 'complete');
    assert.equal(byId.aaa.journal.sessions, 2);
    assert.equal(byId.aaa.disposition.status, 'managed');
    assert.ok(byId.aaa.bytes.configPluginTree >= 5000 && byId.aaa.bytes.configPluginTree < 5000 + 64 * 1024);
    assert.ok(byId.aaa.bytes.cache >= 300 && byId.aaa.bytes.npm >= 200 && byId.aaa.bytes.projectPluginTree >= 100);
    assert.ok(byId.aaa.bytes.home > byId.aaa.bytes.configPluginTree);
    assert.ok(byId.aaa.snapshot.bytes > byId.aaa.snapshot.pluginTreeBytes && byId.aaa.snapshot.pluginTreeBytes >= 5000);
    assert.equal(byId.aaa.snapshot.sessions, 2);
    assert.equal(byId.bbb.journal.phase, 'migrating');
    assert.equal(byId.bbb.disposition.status, 'authored');
    assert.equal(byId.ccc.disposition.status, 'customized');
    assert.equal(byId.ddd.journal, null);
    assert.equal(byId.ddd.disposition.status, 'absent');
    assert.equal(byId.ddd.bytes.configPluginTree, null);
    assert.deepEqual(byId.eee.disposition.entries, { plugins: ['mine.ts'] }, 'names only, not the RoboWork plugin');
    assert.ok(Number.isFinite(result.freeBytes.dataDir) && result.freeBytes.robotsDir > 0);
    const text = (await execute(f, REPORT)).stdout;
    assert.match(text, /^aaa\tcomplete\tmanaged\t/mu);
    assert.match(text, /^bbb\tmigrating\tauthored\t/mu);
});

test('report: an unlabelled robot directory and a backup without a label are named, and ids of 3 and 64 characters are read', async t => {
    const f = await layout(t);
    await addRobot(f, 'abc');
    await addRobot(f, 'a'.repeat(64));
    await addRobot(f, 'ab');
    await addRobot(f, 'a'.repeat(65));
    await addRobot(f, 'gone-robot', { label: false });
    const result = await report(f);
    assert.deepEqual(result.robots.filter(robot => robot.labelled).map(robot => robot.id).sort(), ['a'.repeat(64), 'abc']);
    assert.equal(result.robots.find(robot => robot.id === 'gone-robot').labelled, false);
    assert.deepEqual(result.unlabelledBackups, ['gone-robot']);
});

test('report: a link is reported, never followed, and no file outside the named list is opened', async t => {
    const f = await layout(t);
    await addRobot(f, 'victim', { home: 'managed', bytes: 7000 });
    await addRobot(f, 'linker', { home: 'absent' });
    await fs.rm(path.join(f.robotsDir, 'linker/home/.config'), { recursive: true });
    await fs.symlink(path.join(f.robotsDir, 'victim/home/.config'), path.join(f.robotsDir, 'linker/home/.config'));
    await addRobot(f, 'ccc', { home: 'managed' });
    await fs.rm(path.join(f.robotsDir, 'ccc/home/.config/opencode/node_modules'), { recursive: true });
    await fs.symlink(path.join(f.robotsDir, 'victim/home'), path.join(f.robotsDir, 'ccc/home/.config/opencode/node_modules'));
    // Record every file the script opens.
    const preload = path.join(f.base, 'record-opens.mjs');
    const log = path.join(f.base, 'opens.log');
    await fs.writeFile(preload, `import fsp from 'node:fs/promises'; import { appendFileSync } from 'node:fs';
        for (const name of ['open', 'readFile']) { const original = fsp[name]; fsp[name] = (file, ...rest) => { appendFileSync(${JSON.stringify(log)}, String(file) + '\\n'); return original(file, ...rest); }; }`);
    const output = await run(process.execPath, ['--import', preload, REPORT, ...args(f, '--json')], { env: { ...process.env, ...f.env } });
    const result = JSON.parse(output.stdout);
    const byId = Object.fromEntries(result.robots.map(robot => [robot.id, robot]));
    assert.equal(byId.linker.disposition.status, 'unsafe');
    assert.equal(byId.linker.bytes.configPluginTree, null, 'the other robot home behind the link is not measured');
    assert.equal(byId.ccc.disposition.status, 'unsafe');
    assert.equal(byId.ccc.bytes.configPluginTree, null);
    const opened = (await fs.readFile(log, 'utf8')).split('\n').filter(Boolean);
    const allowed = new Set(['state.json', 'snapshot.json', 'stamp.json', 'current.json', 'package.json', 'package-lock.json', 'opencode.json', 'opencode.jsonc']);
    assert.ok(opened.length > 0);
    for (const file of opened) assert.ok(allowed.has(path.basename(file)), `opened ${file}`);
    assert.equal(opened.some(file => file.startsWith(path.join(f.robotsDir, 'linker/home/.config'))), false, 'nothing behind the .config link is opened');
    assert.equal(opened.filter(file => file.startsWith(path.join(f.robotsDir, 'ccc/home/.config/opencode/node_modules'))).length, 0);
});

test('report: its classification agrees with the retire module for every kind of home', async t => {
    const kinds = ['absent', 'managed', 'managed-v2', 'customized', 'authored', 'authored-entry', 'unsafe'];
    const f = await layout(t);
    const ids = [];
    for (const [index, kind] of kinds.entries()) { const id = `kind-${index}`; ids.push([id, kind]); await addRobot(f, id, { home: kind, journal: false }); }
    // Unusual states that matter: a lock that lists another dependency, a manifest over the size limit, a tree without a manifest, a link above.
    await addRobot(f, 'lock-extra', { home: 'absent', journal: false });
    await writeTree(path.join(f.robotsDir, 'lock-extra/home/.config/opencode'), { lock: { packages: { '': { dependencies: { [V1]: '1', x: '1' } } } } });
    await addRobot(f, 'big-manifest', { home: 'managed', journal: false });
    await fs.writeFile(path.join(f.robotsDir, 'big-manifest/home/.config/opencode/package.json'), `{"dependencies":{"${V1}":"1"}}${' '.repeat(4 * 1024 * 1024)}`);
    await addRobot(f, 'no-manifest', { home: 'managed', journal: false });
    await fs.rm(path.join(f.robotsDir, 'no-manifest/home/.config/opencode/package.json'));
    await addRobot(f, 'config-link', { home: 'absent', journal: false });
    await fs.rm(path.join(f.robotsDir, 'config-link/home/.config'), { recursive: true });
    await fs.symlink(f.base, path.join(f.robotsDir, 'config-link/home/.config'));
    await addRobot(f, 'jsonc-comment', { home: 'managed', journal: false });
    await put(path.join(f.robotsDir, 'jsonc-comment/home/.config/opencode/opencode.json'), '{ /* "plugin": [] */ "model": "a/b" }');
    const result = await report(f);
    const seen = new Set();
    for (const robot of result.robots) {
        const expected = await pluginTreeDisposition(path.join(f.robotsDir, robot.id, 'home'));
        assert.equal(robot.disposition.status, expected.status, `${robot.id}: ${robot.disposition.status} against ${expected.status}`);
        seen.add(expected.status);
    }
    assert.deepEqual([...seen].sort(), ['absent', 'authored', 'customized', 'managed', 'unsafe']);
});

test('report: tool bundles list each generation with its bytes and the rule that keeps it', async t => {
    const f = await layout(t);
    const cache = path.join(f.dataDir, 'tool-cache');
    const make = async (bundle, id, version, bytes) => {
        await put(path.join(cache, bundle, 'generations', id, 'lib/payload'), 'z'.repeat(bytes));
        await put(path.join(cache, bundle, 'generations', id, 'stamp.json'), JSON.stringify({ schema: SCHEMA, name: bundle, generation: id, versions: { [bundle]: version } }));
    };
    await make('opencode', gen('a'), '2.4.2', 4000);
    await make('opencode', gen('b'), '1.19.6', 3000);
    await make('opencode', gen('c'), '2.0.0', 2000);
    await make('codex', gen('d'), '0.1.0', 1000);
    await make('opencode-plugin', gen('e'), '2.4.1', 500);
    await put(path.join(cache, 'opencode/current.json'), JSON.stringify({ schema: SCHEMA, name: 'opencode', generation: gen('a') }));
    await fs.mkdir(path.join(cache, 'shell-generations', gen('f'), 'bin'), { recursive: true });
    await fs.symlink(`../../../opencode/generations/${gen('b')}/lib/payload`, path.join(cache, 'shell-generations', gen('f'), 'bin/opencode'));
    await fs.symlink(path.join('shell-generations', gen('f')), path.join(cache, 'shell-opencode'));
    const { bundles } = (await report(f)).toolCache;
    const rule = (bundle, id) => bundles[bundle].generations.find(entry => entry.generation === gen(id)).keptBy;
    assert.equal(rule('opencode', 'a'), 'current');
    assert.equal(rule('opencode', 'b'), 'view');
    assert.equal(rule('opencode', 'c'), 'none');
    assert.equal(rule('codex', 'd'), 'none');
    assert.equal(rule('opencode-plugin', 'e'), 'retired');
    assert.equal(rule('shell-generations', 'f'), 'view');
    const sizeOf = (bundle, id) => bundles[bundle].generations.find(entry => entry.generation === gen(id)).bytes;
    assert.ok(sizeOf('opencode', 'a') >= 4000 && sizeOf('opencode', 'a') < 4000 + 64 * 1024);
    assert.equal(bundles.opencode.generations.find(entry => entry.generation === gen('b')).version, '1.19.6');
});

test('report: it is one file with no import beyond Node built-ins, and runs when copied alone', async t => {
    const source = await fs.readFile(REPORT, 'utf8');
    for (const [, specifier] of source.matchAll(/^import [^\n]*? from '([^']+)'/gmu)) assert.match(specifier, /^node:/u, specifier);
    const f = await layout(t);
    await addRobot(f, 'aaa');
    const alone = path.join(f.base, 'alone');
    await fs.mkdir(alone);
    await fs.copyFile(REPORT, path.join(alone, 'robot-storage-report.mjs'));
    const result = JSON.parse((await execute(f, path.join(alone, 'robot-storage-report.mjs'), '--json')).stdout);
    assert.equal(result.robots[0].disposition.status, 'managed');
    assert.equal((await run(process.execPath, [REPORT, '--data-dir', 'relative', '--robots-dir', f.robotsDir]).catch(error => error)).code, 2);
});

test('report: it changes nothing', async t => {
    const f = await layout(t);
    await addRobot(f, 'aaa');
    await addRobot(f, 'bbb', { home: 'customized' });
    const before = [await digest(f.dataDir), await digest(f.robotsDir)];
    await report(f);
    assert.deepEqual([await digest(f.dataDir), await digest(f.robotsDir)], before);
});

// ---------------------------------------------------------------- the prune script ----

async function backupTools(f, { v1 = true, v2 = true, current = 'v2' } = {}) {
    const root = path.join(f.migrations, 'v1-tool-cache');
    const make = (id, version) => put(path.join(root, 'generations', id, 'stamp.json'), JSON.stringify({ schema: SCHEMA, name: 'opencode', generation: id, versions: { opencode: version }, preparedAt: '2026-11-01T00:00:00.000Z' }))
        .then(() => put(path.join(root, 'generations', id, 'lib/payload'), `payload-${version}`));
    if (v1) await make(gen('1'), '1.19.6');
    if (v2) await make(gen('a'), '2.4.2');
    await put(path.join(root, 'current.json'), JSON.stringify({ schema: SCHEMA, name: 'opencode', generation: current === 'v2' ? gen('a') : gen('1'), versions: {} }));
    await put(path.join(f.migrations, 'tools-saved'), '1\n');
    return root;
}

async function standardLayout(t) {
    const f = await layout(t);
    await addRobot(f, 'aaa');
    await addRobot(f, 'bbb');
    await addRobot(f, 'ccc', { home: 'absent', snapshot: 'managed' });
    await put(path.join(f.migrations, 'orphan-robot/state.json'), JSON.stringify({ migration: ID, phase: 'complete', sessions: 0 }));
    await put(path.join(f.migrations, 'orphan-robot/snapshot/keep-me'), 'unlabelled backup');
    await backupTools(f);
    return f;
}

test('prune: without --apply every flag prints a plan and changes nothing', async t => {
    const f = await standardLayout(t);
    const before = [await digest(f.dataDir), await digest(f.robotsDir)];
    const result = await prune(f, '--plugin-trees', '--snapshots', '--v1-tools');
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /plan: remove snapshot plugin tree robot=aaa bytes=\d+/u);
    assert.match(result.stdout, /plan: remove snapshot robot=bbb/u);
    assert.match(result.stdout, /plan: remove v1-tool-cache/u);
    assert.match(result.stdout, /backups of robots without a label \(listed, never deleted\): orphan-robot/u);
    assert.match(result.stdout, /dry run/u);
    const normalized = await prune(f, '--normalize-v1-tools');
    assert.equal(normalized.code, 0, normalized.stderr);
    assert.match(normalized.stdout, /plan: name generation 111111111111/u);
    assert.deepEqual([await digest(f.dataDir), await digest(f.robotsDir)], before);
    assert.equal((await prune(f, '--apply')).code, 0, '--apply with no action selects nothing');
    assert.deepEqual([await digest(f.dataDir), await digest(f.robotsDir)], before);
});

test('prune: it refuses while migration.lock is held, with and without --apply, and changes nothing', async t => {
    const f = await standardLayout(t);
    const before = [await digest(f.dataDir), await digest(f.robotsDir)];
    const release = await holdLock(f);
    try {
        for (const flags of [['--apply', '--plugin-trees'], ['--apply', '--snapshots', '--v1-tools'], ['--plugin-trees']]) {
            const result = await prune(f, ...flags);
            assert.notEqual(result.code, 0, flags.join(' '));
            assert.match(result.stderr, /migration\.lock is held/u);
        }
    } finally { await release(); }
    const after = [await digest(f.dataDir), await digest(f.robotsDir)];
    // The stand-in lock directory is the only difference it may leave, and it is gone once released.
    assert.deepEqual(after, before);
    assert.equal((await prune(f, '--apply', '--plugin-trees')).code, 0, 'free again, it runs');
});

test('prune --plugin-trees removes only managed snapshot trees of complete robots and leaves every other snapshot byte-identical', async t => {
    const f = await layout(t);
    await addRobot(f, 'managed-v1', { snapshot: 'managed' });
    await addRobot(f, 'managed-v2', { snapshot: 'managed-v2' });
    await addRobot(f, 'customized', { snapshot: 'customized' });
    await addRobot(f, 'authored', { snapshot: 'authored' });
    await addRobot(f, 'authored-entry', { snapshot: 'authored-entry' });
    await addRobot(f, 'unsafe-snap', { snapshot: 'unsafe' });
    await addRobot(f, 'migrating', { snapshot: 'managed', phase: 'migrating' });
    await addRobot(f, 'failed-robot', { snapshot: 'managed', phase: 'failed' });
    await addRobot(f, 'no-journal', { snapshot: null, journal: false });
    await put(path.join(f.migrations, 'unlabelled/state.json'), JSON.stringify({ migration: ID, phase: 'complete', sessions: 2 }));
    await setup(path.join(f.migrations, 'unlabelled/snapshot/.config/opencode'), 'managed');
    const untouched = ['customized', 'authored', 'authored-entry', 'unsafe-snap', 'migrating', 'failed-robot', 'unlabelled'];
    const before = Object.fromEntries(await Promise.all(untouched.map(async id => [id, await digest(path.join(f.migrations, id))])));
    const homesBefore = await digest(f.robotsDir);
    const result = await prune(f, '--apply', '--plugin-trees');
    assert.equal(result.code, 0, result.stderr);
    for (const id of ['managed-v1', 'managed-v2']) {
        const snapshot = path.join(f.migrations, id, 'snapshot/.config/opencode');
        assert.equal(await exists(path.join(snapshot, 'node_modules')), false, id);
        assert.equal(await exists(path.join(snapshot, 'package.json')) && await exists(path.join(snapshot, 'package-lock.json')), true, `${id}: manifest and lock stay`);
        assert.equal(await exists(path.join(f.migrations, id, 'snapshot/.local/share/opencode/opencode.db')), true, 'the rest of the snapshot stays');
        const record = JSON.parse(await fs.readFile(path.join(f.migrations, id, 'snapshot.json'), 'utf8'));
        assert.ok(record.excluded.includes('.config/opencode/node_modules'));
        assert.deepEqual(record.before.sessions, SESSIONS, 'the rest of the record stays');
    }
    for (const id of untouched) assert.deepEqual(await digest(path.join(f.migrations, id)), before[id], `${id} is byte-identical`);
    assert.deepEqual(await digest(f.robotsDir), homesBefore, 'no home is touched');
    // A second run finds nothing to do and changes nothing.
    const settled = await digest(f.migrations);
    const again = await prune(f, '--apply', '--plugin-trees');
    assert.equal(again.code, 0, again.stderr);
    assert.match(again.stdout, /nothing to do/u);
    assert.deepEqual(await digest(f.migrations), settled);
});

test('prune --plugin-trees finishes an interrupted run that removed the tree before recording it', async t => {
    const f = await layout(t);
    await addRobot(f, 'aaa');
    await fs.rm(path.join(f.migrations, 'aaa/snapshot/.config/opencode/node_modules'), { recursive: true });
    const result = await prune(f, '--apply', '--plugin-trees');
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /record the exclusion/u);
    assert.ok(JSON.parse(await fs.readFile(path.join(f.migrations, 'aaa/snapshot.json'), 'utf8')).excluded.includes('.config/opencode/node_modules'));
});

test('prune --snapshots refuses unless every labelled robot is complete with its sessions, and keeps both journal files', async t => {
    const f = await layout(t);
    await addRobot(f, 'aaa');
    await addRobot(f, 'bbb', { phase: 'failed' });
    await addRobot(f, 'ccc', { journal: false });
    const before = await digest(f.migrations);
    for (const flags of [['--apply', '--snapshots'], ['--snapshots']]) {
        const refused = await prune(f, ...flags);
        assert.equal(refused.code, 1, refused.stderr);
        assert.match(refused.stdout, /refused: robot=bbb journal is failed, not complete/u);
        assert.match(refused.stdout, /refused: robot=ccc journal is missing, not complete/u);
    }
    assert.deepEqual(await digest(f.migrations), before, 'nothing removed, journals intact');
    // Fewer sessions than the snapshot recorded also refuses.
    const g = await layout(t);
    await addRobot(g, 'aaa', { sessions: 1 });
    const few = await prune(g, '--apply', '--snapshots');
    assert.equal(few.code, 1);
    assert.match(few.stdout, /robot=aaa has 1 sessions against 2 in its snapshot/u);
    assert.equal(await exists(path.join(g.migrations, 'aaa/snapshot')), true);
});

test('prune --snapshots with every robot complete removes the snapshots and keeps state.json and snapshot.json', async t => {
    const f = await standardLayout(t);
    const orphan = await digest(path.join(f.migrations, 'orphan-robot'));
    const result = await prune(f, '--apply', '--snapshots');
    assert.equal(result.code, 0, result.stderr);
    for (const id of ['aaa', 'bbb', 'ccc']) {
        assert.equal(await exists(path.join(f.migrations, id, 'snapshot')), false, id);
        assert.equal(await exists(path.join(f.migrations, id, 'state.json')) && await exists(path.join(f.migrations, id, 'snapshot.json')), true, `${id}: journal files stay`);
    }
    assert.deepEqual(await digest(path.join(f.migrations, 'orphan-robot')), orphan, 'a backup without a label is never deleted');
    assert.equal(await exists(path.join(f.migrations, 'v1-tool-cache')), true, 'the V1 tools need their own flag');
});

test('prune --v1-tools refuses with one non-complete robot and otherwise removes only the retained V1 generation directory', async t => {
    const f = await standardLayout(t);
    await addRobot(f, 'ddd', { phase: 'migrating' });
    const before = await digest(f.migrations);
    const refused = await prune(f, '--apply', '--v1-tools');
    assert.equal(refused.code, 1);
    assert.match(refused.stdout, /refused: robot=ddd journal is migrating/u);
    assert.deepEqual(await digest(f.migrations), before);
    await fs.rm(path.join(f.robotsDir, 'ddd'), { recursive: true });
    const result = await prune(f, '--apply', '--v1-tools');
    assert.equal(result.code, 0, result.stderr);
    assert.equal(await exists(path.join(f.migrations, 'v1-tool-cache')), false);
    assert.equal(await exists(path.join(f.migrations, 'tools-saved')), true, 'the marker stays, so the service never retains again');
    assert.equal(await exists(path.join(f.migrations, 'aaa/snapshot')), true, 'snapshots need their own flag');
});

test('prune --normalize-v1-tools names the V1 generation the backup holds and removes only OpenCode 2 generations from the backup', async t => {
    const f = await standardLayout(t);
    const root = path.join(f.migrations, 'v1-tool-cache');
    await put(path.join(root, 'generations', gen('c'), 'stamp.json'), '{ not a stamp');
    const result = await prune(f, '--apply', '--normalize-v1-tools');
    assert.equal(result.code, 0, result.stderr);
    const current = JSON.parse(await fs.readFile(path.join(root, 'current.json'), 'utf8'));
    assert.deepEqual(current, { schema: SCHEMA, name: 'opencode', generation: gen('1'), versions: { opencode: '1.19.6' } });
    assert.deepEqual((await fs.readdir(path.join(root, 'generations'))).sort(), [gen('1'), gen('c')], 'V2 is gone, V1 and an unreadable stamp stay');
    assert.equal(await fs.readFile(path.join(root, 'generations', gen('1'), 'lib/payload'), 'utf8'), 'payload-1.19.6');
    assert.equal(await exists(path.join(f.migrations, 'aaa/snapshot')), true, 'nothing else changes');
    assert.match(result.stdout, /keep: generation cccccccccccc/u);
    const settled = await digest(f.migrations);
    assert.equal((await prune(f, '--apply', '--normalize-v1-tools')).code, 0);
    assert.deepEqual(await digest(f.migrations), settled, 'idempotent');
    const none = await layout(t);
    await addRobot(none, 'aaa');
    await backupTools(none, { v1: false });
    const refused = await prune(none, '--apply', '--normalize-v1-tools');
    assert.equal(refused.code, 1);
    assert.match(refused.stdout, /refused: no OpenCode 1 generation in the backup to name/u);
});

test('prune: an unlabelled robot backup survives every flag together', async t => {
    const f = await standardLayout(t);
    const orphan = await digest(path.join(f.migrations, 'orphan-robot'));
    const result = await prune(f, '--apply', '--plugin-trees', '--snapshots', '--v1-tools', '--normalize-v1-tools');
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(await digest(path.join(f.migrations, 'orphan-robot')), orphan);
    assert.equal(await exists(path.join(f.migrations, 'aaa/snapshot')), false);
    assert.equal(await exists(path.join(f.migrations, 'v1-tool-cache')), false);
});

test('prune: robot ids of 3 and 64 characters are handled, and shorter or longer directory names are ignored', async t => {
    const f = await layout(t);
    await addRobot(f, 'abc');
    await addRobot(f, 'a'.repeat(64));
    await addRobot(f, 'ab', { phase: 'failed' });
    await addRobot(f, 'a'.repeat(65), { phase: 'failed' });
    const result = await prune(f, '--apply', '--snapshots');
    assert.equal(result.code, 0, result.stderr);
    assert.equal(await exists(path.join(f.migrations, 'abc/snapshot')) || await exists(path.join(f.migrations, 'a'.repeat(64), 'snapshot')), false);
    assert.equal(await exists(path.join(f.migrations, 'ab/snapshot')), true, 'not a robot id: untouched');
});

test('prune: it follows no link: a backup, snapshot or tool directory that is a link stops it and nothing outside is touched', async t => {
    const f = await layout(t);
    await addRobot(f, 'aaa');
    const outside = path.join(f.base, 'outside');
    await put(path.join(outside, 'sentinel'), 'keep');
    await fs.rm(path.join(f.migrations, 'aaa/snapshot'), { recursive: true });
    await fs.symlink(outside, path.join(f.migrations, 'aaa/snapshot'));
    const result = await prune(f, '--apply', '--snapshots');
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /refusing to follow a link/u);
    assert.equal(await fs.readFile(path.join(outside, 'sentinel'), 'utf8'), 'keep');
    const g = await layout(t);
    await addRobot(g, 'aaa');
    await fs.rm(path.join(g.migrations, 'aaa'), { recursive: true });
    await put(path.join(outside, 'state.json'), '{}');
    await fs.symlink(outside, path.join(g.migrations, 'aaa'));
    const linked = await prune(g, '--apply', '--plugin-trees', '--snapshots', '--v1-tools');
    assert.notEqual(linked.code, 0);
    assert.deepEqual((await fs.readdir(outside)).sort(), ['sentinel', 'state.json']);
    const h = await layout(t);
    await addRobot(h, 'aaa');
    await fs.symlink(outside, path.join(h.migrations, 'v1-tool-cache'));
    const toolLink = await prune(h, '--apply', '--v1-tools');
    assert.notEqual(toolLink.code, 0);
    assert.equal(await fs.readFile(path.join(outside, 'sentinel'), 'utf8'), 'keep');
});

test('prune: --plugin-trees works from a directory that holds only the script and a copy of the classifier', async t => {
    const f = await layout(t);
    await addRobot(f, 'aaa');
    const alone = path.join(f.base, 'alone');
    await fs.mkdir(alone);
    await fs.copyFile(PRUNE, path.join(alone, 'prune-opencode-migration.mjs'));
    await fs.copyFile(RETIRE, path.join(alone, 'opencode-plugin-retire.mjs'));
    const result = await execute(f, path.join(alone, 'prune-opencode-migration.mjs'), '--apply', '--plugin-trees');
    assert.equal(result.code, 0, result.stderr);
    assert.equal(await exists(path.join(f.migrations, 'aaa/snapshot/.config/opencode/node_modules')), false);
    await fs.rm(path.join(alone, 'opencode-plugin-retire.mjs'));
    const missing = await execute(f, path.join(alone, 'prune-opencode-migration.mjs'), '--plugin-trees');
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /opencode-plugin-retire\.mjs not found/u);
});
