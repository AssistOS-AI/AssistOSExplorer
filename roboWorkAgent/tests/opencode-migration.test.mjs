import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATION_ID, migrateOpenCodeHome, upgradeDatabase } from '../server/opencode-home-migration.mjs';
import { createOpenCodeMigration } from '../server/opencode-migration.mjs';

async function fixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'robowork-v2-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const home = path.join(root, 'home'), backup = path.join(root, 'backup');
    const write = async (file, text) => {
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, text);
    };
    await fs.mkdir(backup);
    await write(path.join(home, '.config/opencode/package.json'),
        JSON.stringify({ dependencies: { '@opencode-ai/plugin': '1.19.6' } }));
    await write(path.join(home, '.local/share/opencode/auth.json'), '{"test":{"type":"api","key":"fake-test-key"}}');
    await write(path.join(home, '.ala/config.json'), '{"codingAgent":"opencode","models":{"opencode":"test/model"}}');
    // What OpenCode 1 and the retired seed left: the manifest, its lock and the dependency tree.
    await write(path.join(home, '.config/opencode/package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: {
        '': { dependencies: { '@opencode-ai/plugin': '1.19.6' } }, 'node_modules/@opencode-ai/plugin': { version: '1.19.6' },
    } }));
    await write(path.join(home, '.config/opencode/node_modules/@opencode-ai/plugin/package.json'), '{"version":"1.19.6"}');
    const file = path.join(home, '.local/share/opencode/opencode.db');
    const db = new DatabaseSync(file);
    db.exec("CREATE TABLE session(id TEXT PRIMARY KEY); INSERT INTO session VALUES('ses_existing');"
        + "CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT); INSERT INTO message VALUES('msg_existing','ses_existing');"
        + 'CREATE TABLE credential(id TEXT PRIMARY KEY); INSERT INTO credential VALUES(\'credential_test\');');
    db.close();
    const upgrade = async () => {
        const db = new DatabaseSync(file);
        try { db.exec('CREATE TABLE IF NOT EXISTS session_v2 AS SELECT * FROM session;'
            + 'CREATE TABLE IF NOT EXISTS session_message AS SELECT * FROM message'); } finally { db.close(); }
    };
    return { home, backup, file, root, upgrade, binary: '/unused' };
}

test('migration snapshots credentials and session IDs, retains ALA config and is idempotent', async t => {
    const f = await fixture(t);
    const config = await fs.readFile(path.join(f.home, '.ala/config.json'));
    assert.deepEqual(await migrateOpenCodeHome(f), { phase: 'complete', sessions: 1, plugin: 'retired' });
    assert.ok(config.equals(await fs.readFile(path.join(f.home, '.ala/config.json'))));
    assert.equal(await fs.readFile(path.join(f.backup, 'snapshot/.local/share/opencode/auth.json'), 'utf8'),
        '{"test":{"type":"api","key":"fake-test-key"}}');
    assert.deepEqual(await migrateOpenCodeHome({ ...f, upgrade: () => { throw new Error('must not rerun'); } }),
        { phase: 'complete', repeated: true, plugin: 'absent' });
});

test('an interrupted migration retries against the original snapshot, never overwriting it', async t => {
    const f = await fixture(t);
    await assert.rejects(migrateOpenCodeHome({ ...f, upgrade: async () => { throw new Error('interrupted'); } }), /interrupted/);
    const before = await fs.readFile(path.join(f.backup, 'snapshot.json'));
    assert.equal(JSON.parse(await fs.readFile(path.join(f.backup, 'state.json'))).phase, 'failed');
    await migrateOpenCodeHome(f);
    assert.ok(before.equals(await fs.readFile(path.join(f.backup, 'snapshot.json'))));
});

test('missing native sessions block activation and retain recoverable original database', async t => {
    const f = await fixture(t);
    await assert.rejects(migrateOpenCodeHome({ ...f, upgrade: async () => {
        const db = new DatabaseSync(f.file);
        db.exec('CREATE TABLE session_v2(id TEXT PRIMARY KEY)');
        db.close();
    } }), /lost session identities/);
    const db = new DatabaseSync(path.join(f.backup, 'snapshot/.local/share/opencode/opencode.db'), { readOnly: true });
    assert.equal(db.prepare('SELECT id FROM session').get().id, 'ses_existing');
    db.close();
});

test('custom dependencies block migration rather than replacing the user manifest', async t => {
    const f = await fixture(t);
    const file = path.join(f.home, '.config/opencode/package.json');
    const customized = '{"dependencies":{"custom-plugin":"1.0.0"}}';
    await fs.writeFile(file, customized);
    await assert.rejects(migrateOpenCodeHome(f), /customized/);
    assert.equal(await fs.readFile(file, 'utf8'), customized);
});

test('preserved session IDs do not hide missing migrated messages', async t => {
    const f = await fixture(t);
    await assert.rejects(migrateOpenCodeHome({ ...f, upgrade: async () => {
        await f.upgrade();
        const db = new DatabaseSync(f.file);
        try { db.exec('DELETE FROM session_message'); } finally { db.close(); }
    } }), /lost message identities/);
});

test('state directory symlinks are refused before snapshot or migration', async t => {
    const f = await fixture(t);
    await fs.rename(path.join(f.home, '.config'), path.join(f.home, 'real-config'));
    await fs.symlink('real-config', path.join(f.home, '.config'));
    await assert.rejects(migrateOpenCodeHome(f), /Unsafe OpenCode state directory/);
    await assert.rejects(fs.access(path.join(f.backup, 'snapshot.json')));
});

test('native readiness waits for asynchronous history import before checking sessions', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'migration-readiness-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const binary = path.join(root, 'opencode.mjs');
    await fs.writeFile(binary, `#!${process.execPath}
import http from 'node:http';
if (process.argv[2] === 'service') process.exit(0);
let checks = 0;
const server = http.createServer((req, res) => {
    let value;
    if (req.url === '/api/info') value = { version: '2.4.1' };
    else if (req.url === '/api/experimental/migration/v1') value = { status: ++checks < 3 ? 'running' : 'completed' };
    else if (req.url === '/api/session/ses_existing' && checks >= 3) value = { data: { id: 'ses_existing' } };
    else { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(value));
});
server.listen(0, '127.0.0.1', () => console.log('server listening on http://127.0.0.1:' + server.address().port));
`, { mode: 0o700 });
    await upgradeDatabase(binary, root, process.env, { sessions: ['ses_existing'] });
});

const exists = file => fs.lstat(file).then(() => true, () => false);
const configNames = async home => (await fs.readdir(path.join(home, '.config/opencode'))).sort();

test('a complete journal only retires the managed tree: upgrade never runs and the robot stays complete', async t => {
    const f = await fixture(t);
    await migrateOpenCodeHome(f);
    // A tree comes back, as an older revision re-seeding the home would leave it.
    const config = path.join(f.home, '.config/opencode');
    await fs.writeFile(path.join(config, 'package.json'), '{"dependencies":{"@opencode/plugin":"2.4.1"}}');
    await fs.mkdir(path.join(config, 'node_modules/@opencode/plugin'), { recursive: true });
    const journal = await fs.readFile(path.join(f.backup, 'state.json'));
    const result = await migrateOpenCodeHome({ ...f, upgrade: () => { throw new Error('must not run'); } });
    assert.deepEqual(result, { phase: 'complete', repeated: true, plugin: 'retired' });
    assert.deepEqual(await configNames(f.home), ['plugins', 'soul-gateway-models.mjs']);
    assert.ok(journal.equals(await fs.readFile(path.join(f.backup, 'state.json'))), 'the journal is not rewritten');
});

test('a retirement failure on a complete journal is reported in the result and never fails the robot', { skip: process.getuid?.() === 0 }, async t => {
    const f = await fixture(t);
    await migrateOpenCodeHome(f);
    const config = path.join(f.home, '.config/opencode');
    await fs.writeFile(path.join(config, 'package.json'), '{"dependencies":{"@opencode/plugin":"2.4.1"}}');
    await fs.chmod(config, 0o500);
    let result;
    try { result = await migrateOpenCodeHome({ ...f, upgrade: () => { throw new Error('must not run'); } }); }
    finally { await fs.chmod(config, 0o700); }
    assert.equal(result.phase, 'complete');
    assert.equal(result.repeated, true);
    assert.equal(result.plugin, 'failed');
    assert.equal(JSON.parse(await fs.readFile(path.join(f.backup, 'state.json'))).phase, 'complete');
});

test('an authored plugin does not block the migration and keeps its tree; an unsafe one blocks it', async t => {
    const f = await fixture(t);
    await fs.writeFile(path.join(f.home, '.config/opencode/opencode.json'), '{"plugin":["mine"]}');
    assert.deepEqual(await migrateOpenCodeHome(f), { phase: 'complete', sessions: 1, plugin: 'authored' });
    assert.equal(await exists(path.join(f.home, '.config/opencode/node_modules/@opencode-ai/plugin/package.json')), true);
    const g = await fixture(t);
    await fs.rm(path.join(g.home, '.config/opencode/package.json'));
    await fs.symlink(path.join(g.root, 'elsewhere'), path.join(g.home, '.config/opencode/package.json'));
    await assert.rejects(migrateOpenCodeHome(g), /OpenCode plugin dependencies require attention: unsafe/);
    assert.equal(JSON.parse(await fs.readFile(path.join(g.backup, 'state.json'))).phase, 'failed');
});

// ---- createOpenCodeMigration: journal classification, per-robot release, log-only errors, the summary line ----

async function service(t, robots, options = {}) {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'robowork-v2-service-')));
    t.after(async () => { await fs.chmod(path.join(root, 'data/server-state/migrations', MIGRATION_ID), 0o700).catch(() => {}); await fs.rm(root, { recursive: true, force: true }); });
    const paths = { dataDir: path.join(root, 'data'), robotsDir: path.join(root, 'robots'), robot: id => path.join(root, 'robots', id) };
    const migrations = path.join(paths.dataDir, 'server-state/migrations', MIGRATION_ID);
    await fs.mkdir(migrations, { recursive: true });
    await fs.writeFile(path.join(migrations, 'tools-saved'), '1\n');
    for (const [id, journal] of Object.entries(robots)) {
        await fs.mkdir(path.join(paths.robot(id), 'home'), { recursive: true });
        await fs.writeFile(path.join(paths.robot(id), 'label'), '{}');
        if (journal) {
            await fs.mkdir(path.join(migrations, id));
            await fs.writeFile(path.join(migrations, id, 'state.json'), typeof journal === 'string' ? journal : JSON.stringify(journal));
        }
    }
    const alaEntry = path.join(root, 'ala/bin/ala.mjs');
    await fs.mkdir(path.dirname(alaEntry), { recursive: true });
    await fs.mkdir(path.join(root, 'ala/src/coding-agents/agents/opencode'), { recursive: true });
    await fs.writeFile(alaEntry, '');
    await fs.writeFile(path.join(root, 'ala/src/coding-agents/agents/opencode/v2-contract.mjs'), 'export const OPENCODE_V2_SUPPORTED = true;\n');
    const lines = [], calls = [], prepared = [];
    const toolCache = { root: path.join(root, 'tool-cache'), prepareCodingAgent: async name => { prepared.push(name); return { binPath: '/tools/bin' }; } };
    let clock = 1000;
    const homeOperation = options.homeOperation ?? (async (id, operation, input) => { calls.push({ id, operation, input }); return { phase: 'complete', repeated: !input.binary, plugin: 'retired' }; });
    const migration = createOpenCodeMigration({ paths, toolCache, homeOperation, alaEntry, log: line => lines.push(line),
        lockImpl: async () => () => {}, now: () => (clock += 7) });
    return { root, paths, migrations, migration, lines, calls, prepared };
}

const complete = { migration: MIGRATION_ID, phase: 'complete', sessions: 1 };

test('only robots without a complete journal need OpenCode; complete robots are released first and need no download', async t => {
    const s = await service(t, { aaa: complete, bbb: complete, ccc: null, ddd: { migration: MIGRATION_ID, phase: 'failed' },
        eee: { migration: 'opencode-v1-0', phase: 'complete' }, fff: '{ not json' });
    assert.equal(s.migration.status('aaa').state, 'running');
    assert.throws(() => s.migration.guard('aaa'), { code: 'OPENCODE_MIGRATING' });
    await s.migration.start();
    assert.deepEqual(s.prepared, ['opencode']);
    assert.deepEqual(s.calls.map(call => call.id), ['aaa', 'bbb', 'ccc', 'ddd', 'eee', 'fff']);
    assert.ok(s.calls.slice(0, 2).every(call => call.input.binary === undefined), 'complete robots get no binary');
    assert.ok(s.calls.slice(2).every(call => call.input.binary === '/tools/bin/opencode'));
    for (const call of s.calls) assert.equal(Object.hasOwn(call.input, 'template'), false);
    for (const id of ['aaa', 'ccc']) assert.equal(s.migration.status(id).state, 'complete');
    assert.doesNotThrow(() => s.migration.guard('aaa'));
});

test('a start with every journal complete prepares no OpenCode and logs one summary line', async t => {
    const s = await service(t, { aaa: complete, bbb: complete });
    await s.migration.start();
    assert.deepEqual(s.prepared, []);
    assert.ok(s.lines.includes('[opencode-migration] robot=aaa already complete'), s.lines.join('\n'));
    const summary = s.lines.filter(line => line.startsWith('[opencode-plugin]'));
    assert.deepEqual(summary, ['[opencode-plugin] retired=2 absent=0 authored=0 customized=0 unsafe=0 failed=0 ms=7']);
});

test('the summary counts every returned status and every failed cleanup of a complete robot', async t => {
    const answers = { aaa: 'retired', bbb: 'absent', ccc: 'authored', ddd: 'customized', eee: 'unsafe', fff: 'failed' };
    const s = await service(t, { aaa: complete, bbb: complete, ccc: complete, ddd: complete, eee: complete, fff: complete, ggg: complete },
        { homeOperation: async (id) => { if (id === 'ggg') throw new Error('helper died'); return { phase: 'complete', repeated: true, plugin: answers[id] }; } });
    await s.migration.start();
    assert.match(s.lines.find(line => line.startsWith('[opencode-plugin]')),
        /^\[opencode-plugin\] retired=1 absent=1 authored=1 customized=1 unsafe=1 failed=2 ms=\d+$/u);
    assert.ok(s.lines.includes('[opencode-migration] robot=ggg plugin cleanup failed (FAILED); migration state remains complete'));
});

test('a helper error for a robot whose journal was complete is logged only; one for another robot marks that robot alone', async t => {
    const s = await service(t, { aaa: complete, bbb: null, ccc: null }, { homeOperation: async (id, operation, input) => {
        if (id === 'aaa' || id === 'bbb') throw new Error('helper died');
        return { phase: 'complete', sessions: 0, plugin: 'absent' };
    } });
    await s.migration.start();
    assert.equal(s.migration.status('aaa').state, 'complete');
    assert.doesNotThrow(() => s.migration.guard('aaa'));
    assert.equal(s.migration.status('bbb').state, 'failed');
    assert.throws(() => s.migration.guard('bbb'), { code: 'OPENCODE_MIGRATION_FAILED' });
    assert.doesNotThrow(() => s.migration.guard('ccc'));
    assert.ok(s.lines.some(line => line.startsWith('[opencode-migration] robot=bbb failed; backup=')));
    assert.equal(s.lines.some(line => line.startsWith('[opencode-migration] robot=aaa failed')), false);
});

test('each robot is released when its own step ends, while later robots still run', async t => {
    let releaseSecond;
    const gate = new Promise(resolve => { releaseSecond = resolve; });
    const seen = [];
    let migration;
    const s = await service(t, { aaa: complete, bbb: complete, ccc: null }, { homeOperation: async (id) => {
        if (id === 'bbb') {
            // Recorded here and asserted outside: a failure inside a complete robot's step is swallowed by design.
            const guarded = name => { try { migration.guard(name); return 'open'; } catch (error) { return error.code; } };
            seen.push(['while bbb runs', migration.status('aaa').state, migration.status('bbb').state, migration.status('ccc').state,
                guarded('aaa'), guarded('bbb'), guarded('ccc')]);
            await gate;
        }
        return { phase: 'complete', repeated: true, plugin: 'absent' };
    } });
    migration = s.migration;
    const running = migration.start();
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.deepEqual(seen, [['while bbb runs', 'complete', 'running', 'running', 'open', 'OPENCODE_MIGRATING', 'OPENCODE_MIGRATING']]);
    releaseSecond();
    await running;
    assert.deepEqual(['aaa', 'bbb', 'ccc'].map(id => migration.status(id).state), ['complete', 'complete', 'complete']);
    assert.equal(s.lines.some(line => line.includes('plugin cleanup failed')), false, s.lines.join('\n'));
    assert.match(s.lines.find(line => line.startsWith('[opencode-plugin]')), /failed=0 /u);
});

test('a failure creating one backup directory marks that robot only', { skip: process.getuid?.() === 0 }, async t => {
    const s = await service(t, { aaa: null, bbb: null });
    await fs.mkdir(path.join(s.migrations, 'aaa'));
    await fs.chmod(s.migrations, 0o500);
    await s.migration.start();
    assert.equal(s.migration.status('aaa').state, 'complete');
    assert.equal(s.migration.status('bbb').state, 'failed');
    assert.deepEqual(s.calls.map(call => call.id), ['aaa']);
});

test('a global failure (ALA without the V2 contract) blocks every robot as before', async t => {
    const s = await service(t, { aaa: complete, bbb: null });
    await fs.writeFile(path.join(s.root, 'ala/src/coding-agents/agents/opencode/v2-contract.mjs'), 'export const OPENCODE_V2_SUPPORTED = false;\n');
    await s.migration.start();
    assert.deepEqual(s.calls, []);
    for (const id of ['aaa', 'bbb']) assert.throws(() => s.migration.guard(id), { code: 'OPENCODE_MIGRATION_FAILED' });
    assert.ok(s.lines.some(line => line.includes('blocked: Deploy V2-compatible ALA')));
});

// ---- snapshot filter and need-based space check ----

const GIB = 1024 ** 3;
const digestOf = async directory => {
    const result = {};
    const walk = async (current) => {
        for (const entry of (await fs.readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
            const file = path.join(current, entry.name);
            if (entry.isDirectory()) await walk(file); else result[path.relative(directory, file)] = (await fs.readFile(file)).toString('base64');
        }
    };
    await walk(directory);
    return result;
};

test('the snapshot omits the managed plugin tree, keeps the manifest and lock, and records the exclusion', async t => {
    const f = await fixture(t);
    await migrateOpenCodeHome(f);
    const snapshot = path.join(f.backup, 'snapshot/.config/opencode');
    assert.equal(await exists(path.join(snapshot, 'node_modules')), false);
    assert.equal(await exists(path.join(snapshot, 'package.json')), true);
    assert.equal(await exists(path.join(snapshot, 'package-lock.json')), true);
    const record = JSON.parse(await fs.readFile(path.join(f.backup, 'snapshot.json')));
    assert.deepEqual(record.excluded, ['.config/opencode/node_modules']);
    assert.ok(record.included.includes('.config/opencode'));
    assert.equal(await configNames(f.home).then(names => names.includes('node_modules')), false, 'the live home lost it too');
});

test('a customized or authored home keeps its tree in the snapshot', async t => {
    const customized = await fixture(t);
    await fs.writeFile(path.join(customized.home, '.config/opencode/package.json'), '{"dependencies":{"@opencode-ai/plugin":"1.19.6","left-pad":"1.3.0"}}');
    await assert.rejects(migrateOpenCodeHome(customized), /customized/);
    assert.equal(await exists(path.join(customized.backup, 'snapshot/.config/opencode/node_modules/@opencode-ai/plugin/package.json')), true);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(customized.backup, 'snapshot.json'))).excluded, []);
    const authored = await fixture(t);
    await fs.writeFile(path.join(authored.home, '.config/opencode/opencode.json'), '{"plugin":["mine"]}');
    await migrateOpenCodeHome(authored);
    assert.equal(await exists(path.join(authored.backup, 'snapshot/.config/opencode/node_modules/@opencode-ai/plugin/package.json')), true);
});

test('below need plus the larger of 1 GiB and the need, the robot is deferred and nothing changes', async t => {
    const f = await fixture(t);
    const before = await digestOf(f.home);
    const probe = await migrateOpenCodeHome({ ...f, freeBytes: () => 0 });
    assert.equal(probe.phase, 'deferred');
    assert.equal(probe.reason, 'INSUFFICIENT_SPACE');
    assert.equal(probe.freeBytes, 0);
    assert.ok(probe.neededBytes > GIB && probe.neededBytes < GIB + 1024 * 1024, 'a small need is covered by the 1 GiB margin');
    assert.deepEqual(await fs.readdir(f.backup), [], 'no journal, no snapshot');
    assert.deepEqual(await digestOf(f.home), before);
    const upgrade = () => { throw new Error('must not run while deferred'); };
    assert.equal((await migrateOpenCodeHome({ ...f, upgrade, freeBytes: () => probe.neededBytes - 1 })).phase, 'deferred');
    assert.deepEqual(await fs.readdir(f.backup), []);
    assert.equal((await migrateOpenCodeHome({ ...f, freeBytes: () => probe.neededBytes })).phase, 'complete');
});

test('a journal-less home with a kilobyte snapshot is migrated at 1.5 GiB free, not paused', async t => {
    const f = await fixture(t);
    assert.equal((await migrateOpenCodeHome({ ...f, freeBytes: () => 1.5 * GIB })).phase, 'complete');
});

test('a large need counts twice: the margin is the larger of 1 GiB and the need itself', async t => {
    const f = await fixture(t);
    await fs.writeFile(path.join(f.home, '.local/share/opencode/big.bin'), Buffer.alloc(3 * 1024 * 1024));
    const first = await migrateOpenCodeHome({ ...f, marginBytes: 0, freeBytes: () => 0 });
    const small = await fixture(t);
    const second = await migrateOpenCodeHome({ ...small, marginBytes: 0, freeBytes: () => 0 });
    // With no fixed margin the requirement is exactly twice the need.
    assert.equal(first.neededBytes % 2, 0);
    assert.ok(first.neededBytes / 2 - second.neededBytes / 2 >= 3 * 1024 * 1024);
    assert.ok(first.neededBytes > 2 * 3 * 1024 * 1024);
    assert.equal((await migrateOpenCodeHome({ ...f, marginBytes: 0, freeBytes: () => first.neededBytes })).phase, 'complete');
});

test('the managed tree is not counted: a huge tree does not raise the need', async t => {
    const f = await fixture(t);
    await fs.writeFile(path.join(f.home, '.config/opencode/node_modules/@opencode-ai/plugin/big.bin'), Buffer.alloc(8 * 1024 * 1024));
    const result = await migrateOpenCodeHome({ ...f, marginBytes: 0, freeBytes: () => 0 });
    assert.ok(result.neededBytes < 4 * 1024 * 1024, `${result.neededBytes}`);
    const customized = await fixture(t);
    await fs.writeFile(path.join(customized.home, '.config/opencode/opencode.json'), '{"plugin":["mine"]}');
    await fs.writeFile(path.join(customized.home, '.config/opencode/node_modules/@opencode-ai/plugin/big.bin'), Buffer.alloc(8 * 1024 * 1024));
    assert.ok((await migrateOpenCodeHome({ ...customized, marginBytes: 0, freeBytes: () => 0 })).neededBytes > 16 * 1024 * 1024, 'an authored tree is copied, so it counts');
});

test('a retry with a snapshot is sized by the database alone and a deferral leaves its failed journal as it was', async t => {
    const f = await fixture(t);
    await assert.rejects(migrateOpenCodeHome({ ...f, upgrade: async () => { throw new Error('interrupted'); } }), /interrupted/);
    const journal = await fs.readFile(path.join(f.backup, 'state.json'));
    const snapshot = await digestOf(f.backup);
    await fs.writeFile(path.join(f.home, '.local/share/opencode/big.bin'), Buffer.alloc(5 * 1024 * 1024));
    const deferred = await migrateOpenCodeHome({ ...f, marginBytes: 0, freeBytes: () => 0 });
    assert.equal(deferred.phase, 'deferred');
    assert.ok(deferred.neededBytes < 2 * 1024 * 1024, 'the snapshot is reused, so only the database counts');
    assert.ok(journal.equals(await fs.readFile(path.join(f.backup, 'state.json'))));
    assert.deepEqual(await digestOf(f.backup), snapshot);
});

test('an error while sizing is a failure, not a deferral', async t => {
    const f = await fixture(t);
    await fs.rename(path.join(f.home, '.local'), path.join(f.root, 'moved-local'));
    await fs.symlink(path.join(f.root, 'moved-local'), path.join(f.home, '.local'));
    await assert.rejects(migrateOpenCodeHome({ ...f, freeBytes: () => 0 }), /Unsafe OpenCode state directory/);
    assert.equal(JSON.parse(await fs.readFile(path.join(f.backup, 'state.json'))).phase, 'failed');
});

// ---- pause below the floor, per-robot deferral and un-pause without a restart ----

const FLOOR = 5 * GIB;

const spaceError = () => Object.assign(new Error('not enough free space to install opencode'), { code: 'INSUFFICIENT_SPACE', neededBytes: FLOOR, freeBytes: FLOOR - 1 });

test('when the tool cache refuses an installation for lack of space, needing robots pause and complete ones are unaffected', async t => {
    let refuse = true;
    const s = await service(t, { aaa: complete, bbb: null, ccc: { migration: MIGRATION_ID, phase: 'failed' } }, {});
    const migration = createOpenCodeMigration({ paths: s.paths, alaEntry: path.join(s.root, 'ala/bin/ala.mjs'), log: line => s.lines.push(line),
        lockImpl: async () => () => {}, retryIntervalMs: 3600000,
        toolCache: { root: path.join(s.root, 'tool-cache'), prepareCodingAgent: async () => { if (refuse) throw spaceError(); s.prepared.push('opencode'); return { binPath: '/tools/bin' }; } },
        homeOperation: async (id, operation, input) => { s.calls.push({ id, input }); return { phase: 'complete', repeated: !input.binary, plugin: 'absent', sessions: 0 }; } });
    await migration.start();
    assert.deepEqual(s.prepared, []);
    assert.deepEqual(s.calls.map(call => call.id), ['aaa'], 'only the complete robot ran');
    assert.equal(migration.status('aaa').state, 'complete');
    assert.doesNotThrow(() => migration.guard('aaa'));
    for (const id of ['bbb', 'ccc']) {
        assert.equal(migration.status(id).state, 'paused');
        assert.throws(() => migration.guard(id), { code: 'OPENCODE_MIGRATION_PAUSED', statusCode: 503 });
    }
    assert.ok(s.lines.some(line => line === `[opencode-migration] robot=bbb paused: INSUFFICIENT_SPACE needed=${FLOOR} free=${FLOOR - 1}`), s.lines.join('\n'));
    // Space returns: the retry prepares OpenCode, re-runs only the paused robots and opens their guards, with no restart.
    await new Promise(resolve => setTimeout(resolve, 20));
    refuse = false;
    await migration.retryPaused();
    assert.deepEqual(s.prepared, ['opencode']);
    assert.deepEqual(s.calls.map(call => call.id), ['aaa', 'bbb', 'ccc']);
    assert.ok(s.calls.slice(1).every(call => call.input.binary === '/tools/bin/opencode'));
    for (const id of ['bbb', 'ccc']) { assert.equal(migration.status(id).state, 'complete'); assert.doesNotThrow(() => migration.guard(id)); }
    assert.ok(s.lines.includes('[opencode-migration] robot=bbb resumed'));
    migration.close();
});

test('with a usable OpenCode already cached and 1.5 GiB free, a journal-less robot completes and nothing is paused', async t => {
    const f = await fixture(t);
    const s = await service(t, { aaa: null });
    const cacheRoot = path.join(s.root, 'tool-cache');
    // A real tool cache over a stub npm: the first preparation installs, the second (at 1.5 GiB free) must reuse.
    const { ToolCache } = await import('../server/tool-cache.mjs');
    let installs = 0, free = 100 * GIB;
    const cache = new ToolCache({ root: cacheRoot, versionPins: {}, log: () => {}, freeBytes: async () => free,
        execFileImpl: async (command, args) => {
            if (args[0] === 'view') return { stdout: '"2.4.2"\n', stderr: '' };
            if (args.includes('install')) {
                installs++;
                const prefix = args[args.indexOf('--prefix') + 1];
                await fs.mkdir(path.join(prefix, 'bin'), { recursive: true });
                await fs.writeFile(path.join(prefix, 'bin', 'opencode'), '#!/bin/sh\n', { mode: 0o755 });
            }
            return { stdout: '2.4.2\n', stderr: '' };
        } });
    await cache.prepareCodingAgent('opencode');
    assert.equal(installs, 1);
    free = 1.5 * GIB;
    const second = new ToolCache({ root: cacheRoot, versionPins: {}, log: () => {}, freeBytes: async () => free, execFileImpl: cache.execFileImpl });
    const migration = createOpenCodeMigration({ paths: s.paths, alaEntry: path.join(s.root, 'ala/bin/ala.mjs'), log: line => s.lines.push(line),
        lockImpl: async () => () => {}, toolCache: second,
        homeOperation: async (id, operation, input) => migrateOpenCodeHome({ home: f.home, backup: input.migrationBackup, binary: input.binary,
            upgrade: f.upgrade, freeBytes: () => 100 * GIB }) });
    await migration.start();
    assert.equal(installs, 1, 'no second installation');
    assert.equal(migration.status('aaa').state, 'complete');
    assert.equal(s.lines.some(line => line.includes('paused')), false, s.lines.join('\n'));
    assert.equal(JSON.parse(await fs.readFile(path.join(s.migrations, 'aaa/state.json'))).phase, 'complete');
});

test('a lock another process holds for a moment does not fail the robots: the service waits and then runs', async t => {
    let attempts = 0;
    const s = await service(t, { aaa: complete });
    const migration = createOpenCodeMigration({ paths: s.paths, alaEntry: path.join(s.root, 'ala/bin/ala.mjs'), log: line => s.lines.push(line),
        lockWaitMs: 100, lockRetryMs: 5,
        lockImpl: async () => { if (++attempts <= 3) throw Object.assign(new Error('Another OpenCode migration holds the lock'), { code: 'LOCK_HELD' }); return () => {}; },
        toolCache: { root: path.join(s.root, 'tool-cache'), prepareCodingAgent: async () => ({ binPath: '/tools/bin' }) },
        homeOperation: async () => ({ phase: 'complete', repeated: true, plugin: 'absent' }) });
    await migration.start();
    assert.equal(attempts, 4);
    assert.equal(migration.status('aaa').state, 'complete');
    assert.doesNotThrow(() => migration.guard('aaa'));
    assert.deepEqual(s.lines.filter(line => line.includes('waiting for migration.lock')), ['[opencode-migration] waiting for migration.lock, held by another process']);
    assert.equal(s.lines.some(line => line.includes('blocked')), false);
});

test('a lock that stays held past the wait blocks every robot, as a global failure always did', async t => {
    const s = await service(t, { aaa: complete });
    const migration = createOpenCodeMigration({ paths: s.paths, alaEntry: path.join(s.root, 'ala/bin/ala.mjs'), log: line => s.lines.push(line),
        lockWaitMs: 20, lockRetryMs: 5, lockImpl: async () => { throw Object.assign(new Error('Another OpenCode migration holds the lock'), { code: 'LOCK_HELD' }); },
        toolCache: { root: path.join(s.root, 'tool-cache'), prepareCodingAgent: async () => ({ binPath: '/tools/bin' }) },
        homeOperation: async () => { throw new Error('must not run'); } });
    await migration.start();
    assert.throws(() => migration.guard('aaa'), { code: 'OPENCODE_MIGRATION_FAILED' });
    assert.ok(s.lines.some(line => line.includes('blocked: Another OpenCode migration holds the lock')));
});

test('a robot whose own need does not fit is paused alone and resumes when it does, retried by timer and by a guarded request', async t => {
    let fits = false;
    let clock = 0;
    let migration;
    const s = await service(t, { aaa: null, bbb: null }, { homeOperation: async (id, operation, input) => {
        s.calls.push({ id, input });
        if (id === 'bbb' && !fits) return { phase: 'deferred', reason: 'INSUFFICIENT_SPACE', neededBytes: 2 * GIB, freeBytes: GIB };
        return { phase: 'complete', sessions: 0, plugin: 'absent' };
    } });
    migration = createOpenCodeMigration({ paths: s.paths, alaEntry: path.join(s.root, 'ala/bin/ala.mjs'), log: line => s.lines.push(line),
        lockImpl: async () => () => {}, now: () => clock, retryIntervalMs: 3600000, retryRequestMs: 60000,
        toolCache: { root: path.join(s.root, 'tool-cache'), prepareCodingAgent: async () => ({ binPath: '/tools/bin' }) },
        homeOperation: async (id, operation, input) => s.calls.push({ id, input }) && (id === 'bbb' && !fits
            ? { phase: 'deferred', reason: 'INSUFFICIENT_SPACE', neededBytes: 2 * GIB, freeBytes: GIB }
            : { phase: 'complete', sessions: 0, plugin: 'absent' }) });
    t.after(() => migration.close());
    await migration.start();
    assert.equal(migration.status('aaa').state, 'complete');
    assert.equal(migration.status('bbb').state, 'paused');
    assert.ok(s.lines.includes(`[opencode-migration] robot=bbb paused: INSUFFICIENT_SPACE needed=${2 * GIB} free=${GIB}`));
    // A guarded request retries at most once a minute; it still answers 503 itself.
    const before = s.calls.length;
    assert.throws(() => migration.guard('bbb'), { code: 'OPENCODE_MIGRATION_PAUSED' });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(s.calls.length, before + 1, 'the first request retried');
    assert.throws(() => migration.guard('bbb'), { code: 'OPENCODE_MIGRATION_PAUSED' });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(s.calls.length, before + 1, 'within a minute it does not retry again');
    clock += 61000;
    fits = true;
    assert.throws(() => migration.guard('bbb'), { code: 'OPENCODE_MIGRATION_PAUSED' }, 'the request that triggers the retry is itself refused');
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(migration.status('bbb').state, 'complete');
    assert.doesNotThrow(() => migration.guard('bbb'));
    assert.ok(s.lines.includes('[opencode-migration] robot=bbb resumed'));
});

test('the retry timer resumes a paused robot by itself', async t => {
    let fits = false;
    const s = await service(t, { aaa: null });
    const migration = createOpenCodeMigration({ paths: s.paths, alaEntry: path.join(s.root, 'ala/bin/ala.mjs'), log: line => s.lines.push(line),
        lockImpl: async () => () => {}, retryIntervalMs: 15,
        toolCache: { root: path.join(s.root, 'tool-cache'), prepareCodingAgent: async () => ({ binPath: '/tools/bin' }) },
        homeOperation: async () => (fits ? { phase: 'complete', sessions: 0, plugin: 'absent' }
            : { phase: 'deferred', reason: 'INSUFFICIENT_SPACE', neededBytes: 2 * GIB, freeBytes: GIB }) });
    t.after(() => migration.close());
    await migration.start();
    assert.equal(migration.status('aaa').state, 'paused');
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(migration.status('aaa').state, 'paused', 'a retry that still does not fit changes nothing');
    fits = true;
    for (let waited = 0; migration.status('aaa').state === 'paused' && waited < 2000; waited += 10) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(migration.status('aaa').state, 'complete');
});

test('a retry fails when the lock is held elsewhere, and a failing resume marks the robot failed', async t => {
    let held = true;
    let result = { phase: 'deferred', reason: 'INSUFFICIENT_SPACE', neededBytes: 2 * GIB, freeBytes: GIB };
    const s = await service(t, { aaa: null });
    let first = true;
    const migration = createOpenCodeMigration({ paths: s.paths, alaEntry: path.join(s.root, 'ala/bin/ala.mjs'), log: line => s.lines.push(line),
        lockImpl: async () => { if (!first && held) throw new Error('Another OpenCode migration holds the lock'); first = false; return () => {}; },
        retryIntervalMs: 3600000,
        toolCache: { root: path.join(s.root, 'tool-cache'), prepareCodingAgent: async () => ({ binPath: '/tools/bin' }) },
        homeOperation: async () => { if (result instanceof Error) throw result; return result; } });
    t.after(() => migration.close());
    await migration.start();
    await migration.retryPaused();
    assert.equal(migration.status('aaa').state, 'paused', 'the lock is held, so nothing ran');
    held = false;
    result = new Error('helper died');
    await migration.retryPaused();
    assert.equal(migration.status('aaa').state, 'failed');
    assert.throws(() => migration.guard('aaa'), { code: 'OPENCODE_MIGRATION_FAILED' });
});

test('a robot created during the gated window stays gated until the pass ends, then reports complete', async t => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const s = await service(t, { aaa: complete }, { homeOperation: async () => { await gate; return { phase: 'complete', repeated: true, plugin: 'absent' }; } });
    const running = s.migration.start();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(s.migration.status('late-robot').state, 'running');
    assert.throws(() => s.migration.guard('late-robot'), { code: 'OPENCODE_MIGRATING' });
    release();
    await running;
    assert.equal(s.migration.status('late-robot').state, 'complete');
});

test('restarts over real homes: the first start migrates and retires, later starts only retire, and nothing is migrated twice', async t => {
    const homes = { aaa: await fixture(t), bbb: await fixture(t) };
    const s = await service(t, { aaa: null, bbb: null });
    const upgrades = [];
    const start = async (upgrade) => {
        const lines = [], prepared = [];
        const migration = createOpenCodeMigration({ paths: s.paths, alaEntry: path.join(s.root, 'ala/bin/ala.mjs'), log: line => lines.push(line),
            lockImpl: async () => () => {}, now: () => 0,
            toolCache: { root: path.join(s.root, 'tool-cache'), prepareCodingAgent: async () => { prepared.push('opencode'); return { binPath: '/tools/bin' }; } },
            homeOperation: async (id, operation, input) => migrateOpenCodeHome({ home: homes[id].home, backup: input.migrationBackup, binary: input.binary,
                upgrade: async (...rest) => { upgrades.push(id); return upgrade(id)(...rest); }, freeBytes: () => 100 * GIB }) });
        await migration.start();
        return { lines, prepared, migration, summary: lines.find(line => line.startsWith('[opencode-plugin]')) };
    };
    const first = await start(id => homes[id].upgrade);
    assert.equal(first.summary, '[opencode-plugin] retired=2 absent=0 authored=0 customized=0 unsafe=0 failed=0 ms=0');
    assert.deepEqual(first.prepared, ['opencode']);
    assert.deepEqual(upgrades, ['aaa', 'bbb']);
    for (const id of ['aaa', 'bbb']) {
        assert.equal(first.migration.status(id).state, 'complete');
        assert.deepEqual(await configNames(homes[id].home), ['plugins', 'soul-gateway-models.mjs']);
        assert.equal(JSON.parse(await fs.readFile(path.join(s.migrations, id, 'state.json'))).phase, 'complete');
    }
    // An older revision seeds one home again; the next start retires it without migrating or downloading anything.
    await fs.writeFile(path.join(homes.bbb.home, '.config/opencode/package.json'), '{"dependencies":{"@opencode/plugin":"2.4.1"}}');
    await fs.mkdir(path.join(homes.bbb.home, '.config/opencode/node_modules/@opencode/plugin'), { recursive: true });
    const second = await start(() => () => { throw new Error('a completed robot must not be migrated again'); });
    assert.equal(second.summary, '[opencode-plugin] retired=1 absent=1 authored=0 customized=0 unsafe=0 failed=0 ms=0');
    assert.deepEqual(second.prepared, []);
    assert.deepEqual(await configNames(homes.bbb.home), ['plugins', 'soul-gateway-models.mjs']);
    const third = await start(() => () => { throw new Error('a completed robot must not be migrated again'); });
    assert.equal(third.summary, '[opencode-plugin] retired=0 absent=2 authored=0 customized=0 unsafe=0 failed=0 ms=0');
    assert.deepEqual(upgrades, ['aaa', 'bbb']);
});

test('a home left alone is logged with its reason, and a complete robot stays complete', async t => {
    const s = await service(t, { aaa: complete, bbb: complete }, { homeOperation: async id => ({ phase: 'complete', repeated: true,
        plugin: id === 'aaa' ? 'customized' : 'failed', pluginDetail: id === 'aaa' ? 'lock lists other dependencies' : 'EACCES: permission denied' }) });
    await s.migration.start();
    assert.ok(s.lines.includes('[opencode-migration] robot=aaa plugin tree left alone (customized): lock lists other dependencies'), s.lines.join('\n'));
    assert.ok(s.lines.includes('[opencode-migration] robot=bbb plugin tree left alone (failed): EACCES: permission denied'));
    assert.deepEqual(['aaa', 'bbb'].map(id => s.migration.status(id).state), ['complete', 'complete']);
});

test('a complete journal over a failing removal reports the reason in the result', { skip: process.getuid?.() === 0 }, async t => {
    const f = await fixture(t);
    await migrateOpenCodeHome(f);
    const config = path.join(f.home, '.config/opencode');
    await fs.writeFile(path.join(config, 'package.json'), '{"dependencies":{"@opencode/plugin":"2.4.1"}}');
    await fs.chmod(config, 0o500);
    let result;
    try { result = await migrateOpenCodeHome({ ...f, upgrade: () => { throw new Error('must not run'); } }); }
    finally { await fs.chmod(config, 0o700); }
    assert.equal(result.plugin, 'failed');
    assert.match(result.pluginDetail, /EACCES|EPERM/u);
});
