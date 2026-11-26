import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { migrateOpenCodeHome, upgradeDatabase } from '../server/opencode-home-migration.mjs';

async function fixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'robowork-v2-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const home = path.join(root, 'home'), backup = path.join(root, 'backup'), template = path.join(root, 'template');
    const write = async (file, text) => {
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, text);
    };
    await fs.mkdir(backup);
    await write(path.join(home, '.config/opencode/package.json'),
        JSON.stringify({ dependencies: { '@opencode-ai/plugin': '1.19.6' } }));
    await write(path.join(home, '.local/share/opencode/auth.json'), '{"test":{"type":"api","key":"fake-test-key"}}');
    await write(path.join(home, '.ala/config.json'), '{"codingAgent":"opencode","models":{"opencode":"test/model"}}');
    const manifest = { dependencies: { '@opencode/plugin': '2.4.1' } };
    await write(path.join(template, 'package.json'), JSON.stringify(manifest));
    await write(path.join(template, 'package-lock.json'), JSON.stringify({ packages: {
        '': manifest, 'node_modules/@opencode/plugin': { version: '2.4.1' },
    } }));
    await write(path.join(template, 'node_modules/@opencode/plugin/package.json'), '{"version":"2.4.1"}');
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
    return { home, backup, file, template: { path: template, version: '2.4.1' }, upgrade, binary: '/unused' };
}

test('migration snapshots credentials and session IDs, retains ALA config and is idempotent', async t => {
    const f = await fixture(t);
    const config = await fs.readFile(path.join(f.home, '.ala/config.json'));
    assert.deepEqual(await migrateOpenCodeHome(f), { phase: 'complete', sessions: 1 });
    assert.ok(config.equals(await fs.readFile(path.join(f.home, '.ala/config.json'))));
    assert.equal(await fs.readFile(path.join(f.backup, 'snapshot/.local/share/opencode/auth.json'), 'utf8'),
        '{"test":{"type":"api","key":"fake-test-key"}}');
    assert.deepEqual(await migrateOpenCodeHome({ ...f, upgrade: () => { throw new Error('must not rerun'); } }),
        { phase: 'complete', repeated: true });
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
