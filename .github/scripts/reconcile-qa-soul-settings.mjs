#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const DB_NAME = 'soul-gateway.sqlite3';
const KEY_NAME = 'encryption.key';
const FILES = [DB_NAME, `${DB_NAME}-wal`, KEY_NAME];
const EXPECTED = { providers: 12, models: 42, model_children: 41, provider_accounts: 0, api_keys: 12 };
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function fail(code) {
    const error = new Error(code);
    error.code = code;
    throw error;
}

function requireProof(value, code) {
    if (!value) fail(code);
}

function hash(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function json(value) {
    return JSON.stringify(value, (_, item) => {
        if (typeof item === 'bigint') return { bigint: item.toString() };
        if (item instanceof Uint8Array) return { bytes: Buffer.from(item).toString('base64') };
        return item;
    });
}

async function sqliteApi() {
    try {
        const api = await import('node:sqlite');
        requireProof(typeof api.DatabaseSync === 'function' && typeof api.backup === 'function', 'SOUL_SQLITE_UNAVAILABLE');
        return api;
    } catch { fail('SOUL_SQLITE_UNAVAILABLE'); }
}

function readSource(root) {
    requireProof(path.isAbsolute(root) && fs.realpathSync(root) === path.resolve(root), 'SOUL_SOURCE_INVALID');
    return Object.fromEntries(FILES.map((name) => {
        let descriptor;
        try {
            descriptor = fs.openSync(path.join(root, name), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
            requireProof(fs.fstatSync(descriptor).isFile(), 'SOUL_SOURCE_INVALID');
            return [name, fs.readFileSync(descriptor)];
        } catch (error) {
            if (name.endsWith('-wal') && error.code === 'ENOENT') return [name, null];
            throw error;
        } finally {
            if (descriptor !== undefined) fs.closeSync(descriptor);
        }
    }));
}

function sourceDigests(source) {
    return Object.fromEntries(FILES.map((name) => [name, source[name] === null ? null : hash(source[name])]));
}

function unchanged(root, source) {
    requireProof(json(sourceDigests(readSource(root))) === json(sourceDigests(source)), 'SOUL_SOURCE_CHANGED');
}

function protectDirectory(root) {
    fs.mkdirSync(root, { mode: 0o700 });
    const info = fs.lstatSync(root);
    requireProof(info.isDirectory() && !info.isSymbolicLink() && (info.mode & 0o777) === 0o700
        && info.uid === process.getuid(), 'SOUL_OUTPUT_UNPROTECTED');
}

function integrity(db) {
    requireProof(json(db.prepare('PRAGMA integrity_check').all()) === '[{"integrity_check":"ok"}]', 'SOUL_INTEGRITY_FAILED');
    requireProof(db.prepare('PRAGMA foreign_key_check').all().length === 0, 'SOUL_FOREIGN_KEY_FAILED');
}

function quote(name) {
    requireProof(IDENTIFIER.test(name), 'SOUL_SCHEMA_UNEXPECTED');
    return `"${name}"`;
}

function rows(db) {
    const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    return Object.fromEntries(tables.map(({ name }) => [name, db.prepare(`SELECT * FROM ${quote(name)}`).all()]));
}

function schema(db) {
    return json(db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all());
}

function tableSnapshot(tables) {
    return Object.fromEntries(Object.entries(tables).map(([name, values]) => [name, values.map(json).sort()]));
}

function keyed(values, keyFor) {
    requireProof(Array.isArray(values), 'SOUL_SCHEMA_UNEXPECTED');
    const result = new Map();
    for (const row of values) {
        const key = keyFor(row);
        requireProof(typeof key === 'string' && key && !result.has(key), 'SOUL_AMBIGUOUS_IDENTITY');
        result.set(key, row);
    }
    return result;
}

function sameKeys(a, b) {
    requireProof(json([...a.keys()].sort()) === json([...b.keys()].sort()), 'SOUL_KEY_SET_CHANGED');
}

function semanticView(tables) {
    const providers = keyed(tables.providers, (row) => row.provider_key);
    const models = keyed(tables.models, (row) => row.model_key);
    const ids = new Map();
    for (const [key, row] of [...providers, ...models]) {
        requireProof(typeof row.id === 'string' && row.id && !ids.has(row.id), 'SOUL_AMBIGUOUS_IDENTITY');
        ids.set(row.id, key);
    }
    const children = keyed(tables.model_children, (row) => {
        requireProof(ids.has(row.parent_model_id) && ids.has(row.child_model_id), 'SOUL_FOREIGN_KEY_FAILED');
        return json([ids.get(row.parent_model_id), ids.get(row.child_model_id)]);
    });
    const normalize = (row) => Object.fromEntries(Object.entries(row)
        .filter(([key]) => !['id', 'created_at', 'updated_at'].includes(key))
        .map(([key, value]) => [key, ids.get(value) || value]));
    return { providers, models, children, normalize };
}

export function planSoulSettings(priorDb, currentDb, expectedCounts = EXPECTED) {
    integrity(priorDb);
    integrity(currentDb);
    requireProof(schema(priorDb) === schema(currentDb), 'SOUL_SCHEMA_CHANGED');
    const prior = rows(priorDb);
    const current = rows(currentDb);
    for (const [table, count] of Object.entries(expectedCounts)) {
        requireProof(prior[table]?.length === count && current[table]?.length === count, 'SOUL_COUNTS_CHANGED');
    }
    requireProof(prior.provider_accounts.length === 0 && current.provider_accounts.length === 0
        && prior.api_keys.every((row) => row.subject_type === 'agent')
        && current.api_keys.every((row) => row.subject_type === 'agent'), 'SOUL_ACCOUNTS_CHANGED');
    sameKeys(keyed(prior.api_keys, (row) => row.subject_id), keyed(current.api_keys, (row) => row.subject_id));
    const a = semanticView(prior);
    const b = semanticView(current);
    const changes = [];
    for (const [collection, table, allowedField] of [
        ['providers', 'providers', null], ['models', 'models', 'enabled'], ['children', 'model_children', 'priority'],
    ]) {
        sameKeys(a[collection], b[collection]);
        for (const [key, original] of a[collection]) {
            const latest = b[collection].get(key);
            const oldValue = a.normalize(original);
            const newValue = b.normalize(latest);
            requireProof(json(Object.keys(oldValue)) === json(Object.keys(newValue)), 'SOUL_SCHEMA_CHANGED');
            for (const field of Object.keys(oldValue)) {
                if (json(oldValue[field]) === json(newValue[field])) continue;
                requireProof(field === allowedField, 'SOUL_UNEXPECTED_SETTING_CHANGE');
                if (field === 'enabled') requireProof([0, 1].includes(original[field]) && [0, 1].includes(latest[field]), 'SOUL_SETTING_INVALID');
                else requireProof(Number.isSafeInteger(original[field]) && original[field] > 0
                    && Number.isSafeInteger(latest[field]) && latest[field] > 0, 'SOUL_SETTING_INVALID');
                changes.push({ table, id: original.id, field, before: original[field], after: latest[field],
                    parentId: original.parent_model_id, identity: key });
            }
        }
    }
    requireProof(changes.filter((change) => change.field === 'enabled').length === 1
        && changes.filter((change) => change.field === 'priority').length === 3, 'SOUL_FOUR_CHANGES_REQUIRED');
    return { changes, before: tableSnapshot(prior), currentChildren: b.children, originalView: a };
}

export function applySoulSettings(db, plan, { beforeVerification } = {}) {
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('BEGIN IMMEDIATE');
    try {
        requireProof(json(tableSnapshot(rows(db))) === json(plan.before), 'SOUL_PRECONDITION_CHANGED');
        const priorities = plan.changes.filter((change) => change.field === 'priority');
        const maximums = new Map();
        for (const change of priorities) {
            if (!maximums.has(change.parentId)) {
                maximums.set(change.parentId, db.prepare('SELECT MAX(priority) AS maximum FROM model_children WHERE parent_model_id = ?').get(change.parentId).maximum);
            }
            const temporary = maximums.get(change.parentId) + 1;
            requireProof(Number.isSafeInteger(temporary), 'SOUL_PRIORITY_OVERFLOW');
            maximums.set(change.parentId, temporary);
            requireProof(db.prepare('UPDATE model_children SET priority = ? WHERE id = ? AND parent_model_id = ? AND priority = ?')
                .run(temporary, change.id, change.parentId, change.before).changes === 1, 'SOUL_ROW_PRECONDITION_FAILED');
            change.temporary = temporary;
        }
        for (const change of plan.changes) {
            const oldValue = change.field === 'priority' ? change.temporary : change.before;
            requireProof(db.prepare(`UPDATE ${quote(change.table)} SET ${quote(change.field)} = ? WHERE id = ? AND ${quote(change.field)} = ?`)
                .run(change.after, change.id, oldValue).changes === 1, 'SOUL_ROW_PRECONDITION_FAILED');
        }
        beforeVerification?.(db);
        const actual = rows(db);
        const updated = semanticView(actual);
        sameKeys(updated.children, plan.currentChildren);
        for (const [key, child] of updated.children) {
            requireProof(child.priority === plan.currentChildren.get(key).priority, 'SOUL_ORDER_MISMATCH');
        }
        // Undo just the four intended values in the observation, never in the DB.
        // Every other table, UUID, timestamp, encrypted value and column must match.
        for (const change of plan.changes) {
            const row = actual[change.table].find((item) => item.id === change.id);
            requireProof(row && row[change.field] === change.after, 'SOUL_ROW_RESULT_INVALID');
            row[change.field] = change.before;
        }
        requireProof(json(tableSnapshot(actual)) === json(plan.before), 'SOUL_UNRELATED_DATA_CHANGED');
        integrity(db);
        db.exec('COMMIT');
    } catch (error) {
        db.exec('ROLLBACK');
        throw error;
    }
}

async function snapshot(sourceRoot, source, target, api) {
    protectDirectory(target);
    const raw = path.join(target, 'raw-copy');
    protectDirectory(raw);
    for (const [name, bytes] of Object.entries(source)) {
        if (bytes !== null) fs.writeFileSync(path.join(raw, name), bytes, { flag: 'wx', mode: 0o600 });
    }
    // SQLite itself checks and replays the copied WAL. It never opens a live or
    // retained source database, and no copied SHM can carry stale process locks.
    const copied = new api.DatabaseSync(path.join(raw, DB_NAME));
    const normalized = path.join(target, DB_NAME);
    try {
        copied.exec('PRAGMA foreign_keys = ON');
        integrity(copied);
        await api.backup(copied, normalized);
    } finally { copied.close(); }
    fs.chmodSync(normalized, 0o600);
    fs.writeFileSync(path.join(target, KEY_NAME), source[KEY_NAME], { flag: 'wx', mode: 0o600 });
    unchanged(sourceRoot, source);
    return normalized;
}

export async function reconcileSoulSettings({ priorRoot, currentRoot, outputRoot, expectedCounts = EXPECTED }) {
    const api = await sqliteApi();
    requireProof(priorRoot !== currentRoot && path.isAbsolute(outputRoot)
        && path.basename(outputRoot).startsWith('soul-semantic-merge-')
        && fs.realpathSync(path.dirname(outputRoot)) === path.resolve(path.dirname(outputRoot)), 'SOUL_OUTPUT_INVALID');
    for (const root of [priorRoot, currentRoot]) {
        const workspace = path.basename(root) === 'soul-gateway' && path.basename(path.dirname(root)) === '.data'
            ? path.dirname(path.dirname(root)) : root;
        const relative = path.relative(path.resolve(workspace), path.resolve(outputRoot));
        requireProof(relative.startsWith(`..${path.sep}`) || relative === '..', 'SOUL_OUTPUT_INVALID');
    }
    const priorSource = readSource(priorRoot);
    const currentSource = readSource(currentRoot);
    for (const source of [priorSource, currentSource]) {
        const value = source[KEY_NAME].toString('utf8').trim();
        const key = Buffer.from(value, /^[a-f0-9]{64}$/i.test(value) ? 'hex' : 'base64');
        requireProof(key.length === 32, 'SOUL_ENCRYPTION_KEY_INVALID');
    }
    unchanged(priorRoot, priorSource);
    unchanged(currentRoot, currentSource);
    protectDirectory(outputRoot);
    const priorPath = await snapshot(priorRoot, priorSource, path.join(outputRoot, 'prior'), api);
    const currentPath = await snapshot(currentRoot, currentSource, path.join(outputRoot, 'current'), api);
    const prior = new api.DatabaseSync(priorPath, { readOnly: true });
    const current = new api.DatabaseSync(currentPath, { readOnly: true });
    let merged;
    let receipt;
    try {
        const plan = planSoulSettings(prior, current, expectedCounts);
        const candidateRoot = path.join(outputRoot, 'candidate');
        protectDirectory(candidateRoot);
        const candidatePath = path.join(candidateRoot, DB_NAME);
        await api.backup(prior, candidatePath);
        fs.chmodSync(candidatePath, 0o600);
        fs.writeFileSync(path.join(candidateRoot, KEY_NAME), priorSource[KEY_NAME], { flag: 'wx', mode: 0o600 });
        merged = new api.DatabaseSync(candidatePath);
        applySoulSettings(merged, plan);
        merged.exec('PRAGMA wal_checkpoint(TRUNCATE)');
        merged.exec('PRAGMA journal_mode = DELETE');
        integrity(merged);
        merged.close();
        merged = null;
        unchanged(priorRoot, priorSource);
        unchanged(currentRoot, currentSource);
        requireProof(fs.readFileSync(path.join(candidateRoot, KEY_NAME)).equals(priorSource[KEY_NAME]), 'SOUL_KEY_CHANGED');
        receipt = { version: 1, kind: 'qa-soul-settings-merge', result: 'passed', changes: { enabled: 1, priorities: 3 },
            counts: expectedCounts, sourceBytesUnchanged: true, originalKeyPreserved: true, allOtherCellsUnchanged: true,
            integrity: 'ok', foreignKeys: 'ok', completeChildOrderingMatches: true,
            sources: { prior: sourceDigests(priorSource), current: sourceDigests(currentSource) },
            candidate: { databaseSha256: hash(fs.readFileSync(candidatePath)), keySha256: hash(priorSource[KEY_NAME]),
                settingsSha256: hash(json(plan.changes.map(({ temporary, ...change }) => change))) } };
        fs.writeFileSync(path.join(outputRoot, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
        return receipt;
    } finally {
        merged?.close();
        prior.close();
        current.close();
    }
}

export async function main() {
    process.umask(0o077);
    try {
        requireProof(process.argv.length === 5, 'SOUL_ARGUMENTS_INVALID');
        const receipt = await reconcileSoulSettings({ priorRoot: process.argv[2], currentRoot: process.argv[3], outputRoot: process.argv[4] });
        process.stdout.write(`${JSON.stringify(receipt)}\n`);
    } catch (error) {
        process.stdout.write(`${JSON.stringify({ version: 1, kind: 'qa-soul-settings-merge', result: 'failed',
            code: /^SOUL_[A-Z_]+$/.test(error?.code || '') ? error.code : 'SOUL_RECONCILIATION_FAILED' })}\n`);
        process.exitCode = 1;
    }
}

if (process.argv[1] === '-' || (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))) await main();
