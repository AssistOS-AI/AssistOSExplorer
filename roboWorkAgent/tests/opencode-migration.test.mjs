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
    assert.ok(s.lines.includes('[opencode-migration] robot=ggg plugin cleanup failed; migration state remains complete'));
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
            seen.push(['aaa while bbb runs', migration.status('aaa').state, migration.status('bbb').state, migration.status('ccc').state]);
            assert.doesNotThrow(() => migration.guard('aaa'));
            assert.throws(() => migration.guard('bbb'), { code: 'OPENCODE_MIGRATING' });
            await gate;
        }
        return { phase: 'complete', repeated: true, plugin: 'absent' };
    } });
    migration = s.migration;
    const running = migration.start();
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.deepEqual(seen, [['aaa while bbb runs', 'complete', 'running', 'running']]);
    releaseSecond();
    await running;
    assert.deepEqual(['aaa', 'bbb', 'ccc'].map(id => migration.status(id).state), ['complete', 'complete', 'complete']);
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
