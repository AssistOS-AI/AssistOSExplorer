import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { applySoulSettings, planSoulSettings, reconcileSoulSettings } from '../../../.github/scripts/reconcile-qa-soul-settings.mjs';

const expectedCounts = { providers: 1, models: 4, model_children: 3, provider_accounts: 0, api_keys: 1 };
const schema = `
PRAGMA foreign_keys=ON;
CREATE TABLE providers(id TEXT PRIMARY KEY, provider_key TEXT NOT NULL UNIQUE, enabled INTEGER, created_at TEXT);
CREATE TABLE models(id TEXT PRIMARY KEY, model_key TEXT NOT NULL UNIQUE, provider_id TEXT REFERENCES providers(id), enabled INTEGER, settings TEXT, created_at TEXT);
CREATE TABLE model_children(id TEXT PRIMARY KEY, parent_model_id TEXT REFERENCES models(id), child_model_id TEXT REFERENCES models(id), priority INTEGER NOT NULL CHECK(priority>0), enabled INTEGER, updated_at TEXT, UNIQUE(parent_model_id,child_model_id), UNIQUE(parent_model_id,priority));
CREATE TABLE provider_accounts(id TEXT PRIMARY KEY, secret BLOB);
CREATE TABLE api_keys(id TEXT PRIMARY KEY, subject_id TEXT NOT NULL UNIQUE, subject_type TEXT);
CREATE TABLE retained_data(id TEXT PRIMARY KEY, secret BLOB, value TEXT);
`;

function seed(file, generation) {
    const db = new DatabaseSync(file);
    db.exec(schema);
    db.prepare('INSERT INTO providers VALUES(?,?,?,?)').run(`${generation}-provider`, 'provider-one', 1, generation);
    for (const name of ['parent', 'one', 'two', 'three']) {
        db.prepare('INSERT INTO models VALUES(?,?,?,?,?,?)').run(`${generation}-${name}`, name,
            `${generation}-provider`, name === 'one' && generation === 'prior' ? 0 : 1, 'unchanged', generation);
    }
    const currentOrder = { one: 3, two: 1, three: 2 };
    for (const [index, name] of ['one', 'two', 'three'].entries()) {
        db.prepare('INSERT INTO model_children VALUES(?,?,?,?,?,?)').run(`${generation}-child-${name}`, `${generation}-parent`,
            `${generation}-${name}`, generation === 'prior' ? index + 1 : currentOrder[name], 1, generation);
    }
    db.prepare('INSERT INTO api_keys VALUES(?,?,?)').run(`${generation}-api`, 'agent:repo/agent', 'agent');
    db.prepare('INSERT INTO retained_data VALUES(?,?,?)').run(`${generation}-private`, Buffer.from('private-credential'), generation);
    return db;
}

function fixture(t) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qa-soul-test-')));
    const handles = [];
    t.after(() => {
        for (const db of handles) { try { db.close(); } catch {} }
        fs.rmSync(root, { recursive: true, force: true });
    });
    const roots = Object.fromEntries(['prior', 'current'].map((generation) => {
        const store = path.join(root, generation, '.data', 'soul-gateway');
        fs.mkdirSync(store, { recursive: true, mode: 0o700 });
        fs.writeFileSync(path.join(store, 'encryption.key'), generation === 'prior' ? 'ab'.repeat(32) : 'cd'.repeat(32), { mode: 0o600 });
        return [generation, store];
    }));
    const prior = seed(path.join(roots.prior, 'soul-gateway.sqlite3'), 'prior');
    const current = seed(path.join(roots.current, 'soul-gateway.sqlite3'), 'current');
    handles.push(prior, current);
    return { root, roots, prior, current, handles,
        args: { priorRoot: roots.prior, currentRoot: roots.current, outputRoot: path.join(root, 'soul-semantic-merge-fixture'), expectedCounts } };
}

function rows(db) {
    return db.prepare('SELECT * FROM model_children ORDER BY id').all();
}

test('semantic merge maps stable keys to original UUIDs and rotates colliding priorities in one transaction', (t) => {
    const f = fixture(t);
    const before = rows(f.prior);
    const plan = planSoulSettings(f.prior, f.current, expectedCounts);
    assert.equal(plan.changes.length, 4);
    applySoulSettings(f.prior, plan);
    assert.equal(f.prior.prepare('SELECT enabled FROM models WHERE id=?').get('prior-one').enabled, 1);
    assert.deepEqual(rows(f.prior).map((row) => row.id), before.map((row) => row.id));
    assert.deepEqual(f.prior.prepare('SELECT child_model_id FROM model_children ORDER BY priority').all().map((row) => row.child_model_id),
        ['prior-two', 'prior-three', 'prior-one']);
    assert.ok(rows(f.prior).every((row) => row.updated_at === 'prior'));
    assert.equal(f.prior.prepare('SELECT value FROM retained_data').get().value, 'prior');
});

test('unexpected database effects roll back all four settings, including temporary priorities', (t) => {
    const f = fixture(t);
    const original = rows(f.prior);
    const plan = planSoulSettings(f.prior, f.current, expectedCounts);
    assert.throws(() => applySoulSettings(f.prior, plan, {
        beforeVerification: (db) => db.prepare('UPDATE retained_data SET value=?').run('unrelated mutation'),
    }), { code: 'SOUL_UNRELATED_DATA_CHANGED' });
    assert.deepEqual(rows(f.prior), original);
    assert.equal(f.prior.prepare('SELECT enabled FROM models WHERE id=?').get('prior-one').enabled, 0);
    assert.equal(f.prior.prepare('SELECT value FROM retained_data').get().value, 'prior');
});

test('a change after planning aborts before applying settings', (t) => {
    const f = fixture(t);
    const plan = planSoulSettings(f.prior, f.current, expectedCounts);
    f.prior.prepare('UPDATE models SET settings=? WHERE id=?').run('newer settings', 'prior-two');
    assert.throws(() => applySoulSettings(f.prior, plan), { code: 'SOUL_PRECONDITION_CHANGED' });
    assert.equal(f.prior.prepare('SELECT enabled FROM models WHERE id=?').get('prior-one').enabled, 0);
});

for (const scenario of ['extra-account', 'changed-model-key', 'unrelated-model-value', 'wrong-change-count', 'foreign-key-error']) {
    test(`semantic preflight rejects ${scenario}`, (t) => {
        const f = fixture(t);
        if (scenario === 'extra-account') f.current.prepare('INSERT INTO provider_accounts VALUES(?,?)').run('new-account', Buffer.from('private'));
        if (scenario === 'changed-model-key') f.current.prepare('UPDATE models SET model_key=? WHERE id=?').run('unmatched', 'current-three');
        if (scenario === 'unrelated-model-value') f.current.prepare('UPDATE models SET settings=? WHERE id=?').run('different', 'current-three');
        if (scenario === 'wrong-change-count') f.current.prepare('UPDATE models SET enabled=0 WHERE id=?').run('current-two');
        if (scenario === 'foreign-key-error') {
            f.current.exec('PRAGMA foreign_keys=OFF');
            f.current.prepare('UPDATE models SET provider_id=? WHERE id=?').run('missing', 'current-three');
        }
        assert.throws(() => planSoulSettings(f.prior, f.current, expectedCounts), /^Error: SOUL_/);
    });
}

test('stable DB/WAL copies use SQLite recovery, preserve input bytes and original key, and emit only hashes/counts', async (t) => {
    const f = fixture(t);
    f.prior.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0');
    f.current.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0');
    f.prior.prepare('UPDATE retained_data SET value=?').run('committed original WAL');
    f.current.prepare('UPDATE retained_data SET value=?').run('current WAL');
    const before = new Map();
    for (const root of Object.values(f.roots)) {
        for (const name of ['soul-gateway.sqlite3', 'soul-gateway.sqlite3-wal', 'encryption.key']) {
            before.set(path.join(root, name), fs.readFileSync(path.join(root, name)));
        }
    }
    const receipt = await reconcileSoulSettings(f.args);
    assert.equal(receipt.result, 'passed');
    assert.deepEqual(receipt.changes, { enabled: 1, priorities: 3 });
    assert.equal(receipt.allOtherCellsUnchanged, true);
    assert.ok(!JSON.stringify(receipt).includes('private-credential'));
    assert.ok(!JSON.stringify(receipt).includes('prior-one'));
    for (const [file, bytes] of before) assert.ok(fs.readFileSync(file).equals(bytes));
    const candidate = path.join(f.args.outputRoot, 'candidate');
    assert.equal(fs.readFileSync(path.join(candidate, 'encryption.key'), 'utf8'), 'ab'.repeat(32));
    assert.equal(fs.statSync(candidate).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(candidate, 'soul-gateway.sqlite3')).mode & 0o777, 0o600);
    const db = new DatabaseSync(path.join(candidate, 'soul-gateway.sqlite3'), { readOnly: true });
    f.handles.push(db);
    assert.equal(db.prepare('SELECT value FROM retained_data').get().value, 'committed original WAL');
    assert.equal(db.prepare('SELECT enabled FROM models WHERE id=?').get('prior-one').enabled, 1);
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.equal(fs.existsSync(path.join(candidate, 'soul-gateway.sqlite3-wal')), false);
});

test('output inside either source workspace is refused before creating directories', async (t) => {
    const f = fixture(t);
    const outputRoot = path.join(f.root, 'current', 'soul-semantic-merge-forbidden');
    await assert.rejects(reconcileSoulSettings({ ...f.args, outputRoot }), { code: 'SOUL_OUTPUT_INVALID' });
    assert.equal(fs.existsSync(outputRoot), false);
});

test('an existing output directory is never reused or overwritten', async (t) => {
    const f = fixture(t);
    fs.mkdirSync(f.args.outputRoot, { mode: 0o700 });
    fs.writeFileSync(path.join(f.args.outputRoot, 'preserve'), 'untouched');
    await assert.rejects(reconcileSoulSettings(f.args), { code: 'EEXIST' });
    assert.equal(fs.readFileSync(path.join(f.args.outputRoot, 'preserve'), 'utf8'), 'untouched');
});

test('symlinked source database is rejected without opening SQLite or creating output', async (t) => {
    const f = fixture(t);
    f.prior.close();
    const source = path.join(f.roots.prior, 'soul-gateway.sqlite3');
    fs.renameSync(source, `${source}.original`);
    fs.symlinkSync(`${source}.original`, source);
    await assert.rejects(reconcileSoulSettings(f.args));
    assert.equal(fs.existsSync(f.args.outputRoot), false);
});

test('a changing source key fails the stable byte-copy check before creating output', async (t) => {
    const f = fixture(t);
    const original = fs.readFileSync;
    let reads = 0;
    // This fixture has no WAL. The second verified descriptor read captures
    // the original key, then only this fixture's source key changes.
    t.mock.method(fs, 'readFileSync', (...args) => {
        const result = original(...args);
        if (typeof args[0] === 'number' && ++reads === 2) {
            fs.writeFileSync(path.join(f.roots.prior, 'encryption.key'), 'ef'.repeat(32));
        }
        return result;
    });
    await assert.rejects(reconcileSoulSettings(f.args), { code: 'SOUL_SOURCE_CHANGED' });
    assert.equal(fs.existsSync(f.args.outputRoot), false);
});
