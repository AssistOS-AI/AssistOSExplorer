import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fail, WorkerStateError, randomId } from './stateProtocol.mjs';
import { BLOCKER_SCHEMA_SQL } from './stateBlockers.mjs';
import { BINDING_SCHEMA_SQL } from './stateBindings.mjs';
import { OBSERVATION_SCHEMA_SQL } from './stateObservation.mjs';
import { REPLAY_SCHEMA_SQL } from './stateReplay.mjs';
import { SESSION_SCHEMA_SQL } from './stateSessions.mjs';
import { OBLIGATION_SCHEMA_SQL } from './stateObligations.mjs';

// Pre-release: a single schema version constant, bumped once for the Revision 9 blocker
// schema, origin keying and attempt-end columns (2), then once more for the locator_base column and
// unique locator index (3), then for the S1x binding, observation, control and token-replay
// tables (4), then once for the S6 source-only subset (5): the recorded logical kind, the
// session, obligation and outbox tables, observation references and the binding fence
// columns, all in this one bump, then once more for the S6 review fixes under delta K-1 (6):
// the open-continuation index keyed per coordinator and the obligation acceptance sequence.
// There are no deployed stores to migrate (R18).
export const SCHEMA_VERSION = 8;
export const STORE_DIRECTORY = 'execution-store';
export const STORE_FILE = 'worker-state.sqlite';

const REQUIRED_TABLES = [
    'metadata', 'generation', 'robot', 'receipt', 'completion', 'preparation',
    'admission', 'origin', 'reference', 'resource_blocker', 'quarantine_audit',
    'binding', 'reference_event', 'reference_cursor', 'reference_control', 'token_replay',
    'session', 'obligation', 'outbox_revision'
];

const SCHEMA_SQL = `
CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE generation (
    id TEXT PRIMARY KEY,
    state TEXT NOT NULL CHECK (state IN ('active', 'ended')),
    prior_id TEXT REFERENCES generation(id),
    recovery_pending INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX generation_single_active ON generation(state) WHERE state = 'active';
CREATE TABLE robot (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    lifecycle TEXT NOT NULL CHECK (lifecycle IN ('provisioning', 'ready', 'failed', 'deleting', 'deleted')),
    revision INTEGER NOT NULL,
    configuration TEXT,
    owner_id TEXT NOT NULL,
    uncertain INTEGER NOT NULL DEFAULT 0,
    attested_generation TEXT REFERENCES generation(id),
    delete_scope TEXT,
    delete_operation_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE TABLE receipt (
    scope TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    op_type TEXT NOT NULL,
    robot_id TEXT,
    digest TEXT NOT NULL,
    response TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (scope, operation_id)
);
CREATE TABLE completion (
    scope TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    op_type TEXT NOT NULL,
    robot_id TEXT,
    status TEXT NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed', 'interrupted')),
    reason TEXT,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (scope, operation_id)
);
CREATE TABLE preparation (
    robot_id TEXT PRIMARY KEY REFERENCES robot(id),
    scope TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('provision', 'configure')),
    base_revision INTEGER NOT NULL,
    candidate TEXT NOT NULL,
    generation_id TEXT NOT NULL REFERENCES generation(id),
    resource_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'cancelling'))
);
CREATE TABLE admission (
    execution_id TEXT PRIMARY KEY,
    attempt_id TEXT NOT NULL UNIQUE,
    logical_id TEXT NOT NULL,
    logical_kind TEXT NOT NULL CHECK (logical_kind IN ('task', 'session', 'flow')),
    generation_id TEXT NOT NULL REFERENCES generation(id),
    robot_id TEXT NOT NULL REFERENCES robot(id),
    config_revision INTEGER NOT NULL,
    configuration TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('task', 'continuation', 'turn')),
    specification TEXT NOT NULL,
    scope TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    state TEXT NOT NULL,
    end_classification TEXT,
    end_payload TEXT,
    result TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK ((kind = 'turn') = (logical_kind = 'session'))
);
CREATE INDEX admission_logical ON admission(logical_id);
CREATE INDEX admission_robot_state ON admission(robot_id, state);
CREATE TABLE origin (
    namespace TEXT NOT NULL,
    origin_key TEXT NOT NULL,
    origin_id TEXT NOT NULL,
    scope TEXT NOT NULL,
    digest TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    reference_id TEXT NOT NULL UNIQUE,
    execution_id TEXT REFERENCES admission(execution_id),
    obligation_id TEXT REFERENCES obligation(obligation_id),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (namespace, origin_key, origin_id),
    CHECK ((execution_id IS NULL) != (obligation_id IS NULL))
);
CREATE TABLE reference (
    id TEXT PRIMARY KEY,
    version INTEGER NOT NULL,
    provider TEXT NOT NULL,
    namespace TEXT NOT NULL,
    origin_key TEXT NOT NULL,
    origin_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('execution', 'observation')),
    logical_id TEXT,
    attempt_id TEXT UNIQUE,
    execution_id TEXT REFERENCES admission(execution_id),
    obligation_id TEXT UNIQUE REFERENCES obligation(obligation_id),
    scope TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    CHECK ((kind = 'execution') = (execution_id IS NOT NULL)),
    CHECK ((kind = 'execution') = (attempt_id IS NOT NULL)),
    CHECK ((kind = 'execution') = (logical_id IS NOT NULL)),
    CHECK ((kind = 'observation') = (obligation_id IS NOT NULL))
);
CREATE TRIGGER receipt_immutable BEFORE UPDATE ON receipt BEGIN SELECT RAISE(ABORT, 'immutable'); END;
CREATE TRIGGER receipt_no_delete BEFORE DELETE ON receipt BEGIN SELECT RAISE(ABORT, 'immutable'); END;
CREATE TRIGGER origin_immutable BEFORE UPDATE ON origin BEGIN SELECT RAISE(ABORT, 'immutable'); END;
CREATE TRIGGER origin_no_delete BEFORE DELETE ON origin BEGIN SELECT RAISE(ABORT, 'immutable'); END;
CREATE TRIGGER reference_immutable BEFORE UPDATE ON reference BEGIN SELECT RAISE(ABORT, 'immutable'); END;
CREATE TRIGGER reference_no_delete BEFORE DELETE ON reference BEGIN SELECT RAISE(ABORT, 'immutable'); END;
CREATE TRIGGER robot_no_delete BEFORE DELETE ON robot BEGIN SELECT RAISE(ABORT, 'immutable'); END;
CREATE TRIGGER robot_immutable BEFORE UPDATE ON robot
WHEN NEW.id IS NOT OLD.id OR NEW.owner_id IS NOT OLD.owner_id OR NEW.created_at IS NOT OLD.created_at OR OLD.lifecycle = 'deleted'
BEGIN SELECT RAISE(ABORT, 'immutable'); END;
CREATE TRIGGER completion_no_delete BEFORE DELETE ON completion BEGIN SELECT RAISE(ABORT, 'immutable'); END;
CREATE TRIGGER completion_terminal BEFORE UPDATE ON completion
WHEN OLD.status != 'pending' OR NEW.scope IS NOT OLD.scope OR NEW.operation_id IS NOT OLD.operation_id
BEGIN SELECT RAISE(ABORT, 'immutable'); END;
CREATE TRIGGER admission_no_delete BEFORE DELETE ON admission BEGIN SELECT RAISE(ABORT, 'immutable'); END;
CREATE TRIGGER admission_transition BEFORE UPDATE ON admission
WHEN NOT (
        (OLD.state = 'queued' AND NEW.state IN ('running', 'stopping'))
        OR (OLD.state = 'running' AND NEW.state = 'stopping')
        OR (OLD.state = 'stopping' AND NEW.state IN ('completed', 'failed', 'paused', 'human-input', 'cancelled', 'interrupted'))
    )
    OR (NEW.state = 'stopping' AND (NEW.result IS NOT NULL OR NEW.end_classification IS NULL OR NEW.end_payload IS NULL))
    OR (NEW.state IN ('completed', 'failed', 'paused', 'human-input', 'cancelled', 'interrupted') AND NEW.result IS NULL)
    OR (NEW.state IN ('queued', 'running') AND (NEW.result IS NOT NULL OR NEW.end_classification IS NOT NULL))
BEGIN SELECT RAISE(ABORT, 'immutable'); END;
CREATE TRIGGER admission_immutable BEFORE UPDATE ON admission
WHEN NEW.execution_id IS NOT OLD.execution_id OR NEW.attempt_id IS NOT OLD.attempt_id
    OR NEW.logical_id IS NOT OLD.logical_id OR NEW.logical_kind IS NOT OLD.logical_kind OR NEW.generation_id IS NOT OLD.generation_id
    OR NEW.robot_id IS NOT OLD.robot_id OR NEW.config_revision IS NOT OLD.config_revision
    OR NEW.configuration IS NOT OLD.configuration OR NEW.kind IS NOT OLD.kind
    OR NEW.specification IS NOT OLD.specification OR NEW.scope IS NOT OLD.scope
    OR NEW.owner_id IS NOT OLD.owner_id OR NEW.operation_id IS NOT OLD.operation_id
    OR (OLD.end_classification IS NOT NULL AND (NEW.end_classification IS NOT OLD.end_classification OR NEW.end_payload IS NOT OLD.end_payload))
BEGIN SELECT RAISE(ABORT, 'immutable'); END;
${BLOCKER_SCHEMA_SQL}
${BINDING_SCHEMA_SQL}
${OBSERVATION_SCHEMA_SQL}
${REPLAY_SCHEMA_SQL}
${SESSION_SCHEMA_SQL}
${OBLIGATION_SCHEMA_SQL}
`;

// Public error mapping. Observed on Node 25: SQLite failures surface as ERR_SQLITE_ERROR with
// errcode (extended codes included, for example 517 SQLITE_BUSY_SNAPSHOT). The primary code is
// the low byte: 5/6 busy or locked -> runtime_unavailable. Only a UNIQUE or PRIMARY KEY
// violation (extended 2067, 1555) is an operation_conflict; the library's own guards run
// before such an insert, so it is a lost race. Every other failure, a trigger RAISE, CHECK,
// NOT NULL or FOREIGN KEY violation included, means a logically inconsistent row or a library
// bug and is state_corrupt, as is anything else (for example 26 not a database). Details are
// never exposed.
export function mapError(error) {
    if (error instanceof WorkerStateError) return error;
    if (error && error.code === 'ERR_SQLITE_ERROR' && Number.isInteger(error.errcode)) {
        const primary = error.errcode & 0xff;
        if (primary === 5 || primary === 6) return new WorkerStateError('runtime_unavailable');
        if (error.errcode === 2067 || error.errcode === 1555) return new WorkerStateError('operation_conflict');
    }
    return new WorkerStateError('state_corrupt');
}

function lstatOrNull(target) {
    try {
        return fs.lstatSync(target);
    } catch (error) {
        if (error && error.code === 'ENOENT') return null;
        throw mapError(error);
    }
}

function requireRealDirectory(target, create, mode) {
    let stat = lstatOrNull(target);
    if (!stat) {
        if (!create) fail('not_found');
        try {
            fs.mkdirSync(target, { mode });
        } catch (error) {
            if (!error || error.code !== 'EEXIST') throw mapError(error);
        }
        stat = lstatOrNull(target);
    }
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) fail('state_corrupt');
}

function requireRegularOrAbsent(target) {
    const stat = lstatOrNull(target);
    if (stat && (stat.isSymbolicLink() || !stat.isFile())) fail('state_corrupt');
    return stat;
}

export function resolveStorePaths(dataDir) {
    if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir)) fail('invalid_request');
    const directory = path.join(dataDir, STORE_DIRECTORY);
    return { dataDir, directory, file: path.join(directory, STORE_FILE) };
}

export class StateDatabase {
    constructor(db, faults) {
        this.db = db;
        this.faults = faults;
        this.closed = false;
    }

    // Synchronous BEGIN IMMEDIATE transaction. `label` names the transaction for the
    // opt-in test-only fault hooks (beforeCommit/afterCommit).
    transaction(label, operation) {
        if (this.closed) fail('state_corrupt');
        try {
            this.db.exec('BEGIN IMMEDIATE');
        } catch (error) {
            throw mapError(error);
        }
        let result;
        try {
            result = operation(this.db);
            if (result !== null && typeof result === 'object' && typeof result.then === 'function') {
                throw new TypeError('Transactions are synchronous');
            }
            if (this.faults.beforeCommit) this.faults.beforeCommit(label);
            this.db.exec('COMMIT');
        } catch (error) {
            try { this.db.exec('ROLLBACK'); } catch { /* already rolled back */ }
            throw mapError(error);
        }
        if (this.faults.afterCommit) this.faults.afterCommit(label);
        return result;
    }

    read(operation) {
        if (this.closed) fail('state_corrupt');
        try {
            return operation(this.db);
        } catch (error) {
            throw mapError(error);
        }
    }

    // Consistent read: one deferred transaction, so several statements see one snapshot.
    snapshot(operation) {
        if (this.closed) fail('state_corrupt');
        try {
            this.db.exec('BEGIN');
        } catch (error) {
            throw mapError(error);
        }
        try {
            return operation(this.db);
        } catch (error) {
            throw mapError(error);
        } finally {
            try { this.db.exec('ROLLBACK'); } catch { /* nothing to roll back */ }
        }
    }

    close() {
        if (this.closed) return;
        this.closed = true;
        try { this.db.close(); } catch { /* ignore */ }
    }
}

// SQLite does not always run the busy handler for the statement that switches a database to
// WAL (observed: "database is locked" within milliseconds when several processes create the
// same store at once). Setup statements are therefore retried on busy/locked for up to
// BUSY_RETRY_MS, with a short jittered pause.
const BUSY_RETRY_MS = 5000;

function isBusy(error) {
    return mapError(error).code === 'runtime_unavailable';
}

function retryBusy(operation) {
    const deadline = Date.now() + BUSY_RETRY_MS;
    for (;;) {
        try {
            return operation();
        } catch (error) {
            if (!isBusy(error) || Date.now() >= deadline) throw error;
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2 + Math.floor(Math.random() * 18));
        }
    }
}

// Structural check at open: a malformed store is refused with state_corrupt.
function checkIntegrity(db) {
    const rows = db.prepare('PRAGMA quick_check').all();
    if (rows.length !== 1 || Object.values(rows[0])[0] !== 'ok') fail('state_corrupt');
}

const REQUIRED_COLUMNS = {
    resource_blocker: ['resource_id', 'robot_id', 'execution_id', 'attempt_id', 'generation_id', 'kind', 'process_bearing',
        'locator', 'locator_base', 'identity', 'release_state', 'retained', 'created_at', 'committed_at', 'settled_at'],
    admission: ['end_classification', 'end_payload', 'result', 'state', 'logical_kind'],
    origin: ['origin_key', 'obligation_id'],
    obligation: ['accepted_seq'],
    reference: ['origin_key', 'kind', 'obligation_id'],
    binding: ['fence_revision'],
    reference_control: ['source']
};

// A store written by an older layout is refused here, cleanly, instead of failing later.
function verifyLayout(db) {
    for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
        const present = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
        if (!columns.every((column) => present.has(column))) fail('state_corrupt');
    }
    const index = db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'index' AND name = 'resource_blocker_locator'").get();
    if (!index) fail('state_corrupt');
}

function verifyMetadata(db, workspaceId, provider) {
    const names = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
    for (const table of REQUIRED_TABLES) {
        if (!names.has(table)) fail('state_corrupt');
    }
    const meta = new Map(db.prepare('SELECT key, value FROM metadata').all().map((row) => [row.key, row.value]));
    if (meta.get('schema_version') !== String(SCHEMA_VERSION)) fail('state_corrupt');
    verifyLayout(db);
    if (meta.get('workspace_id') !== workspaceId || meta.get('provider') !== provider) fail('state_corrupt');
    const active = db.prepare("SELECT id FROM generation WHERE state = 'active'").all();
    if (active.length !== 1) fail('state_corrupt');
    return active[0].id;
}

function initializeSchema(db, workspaceId, provider, now) {
    db.exec(SCHEMA_SQL);
    const insert = db.prepare('INSERT INTO metadata (key, value) VALUES (?, ?)');
    insert.run('schema_version', String(SCHEMA_VERSION));
    insert.run('workspace_id', workspaceId);
    insert.run('provider', provider);
    const generationId = randomId();
    db.prepare("INSERT INTO generation (id, state, prior_id, recovery_pending, created_at) VALUES (?, 'active', NULL, 0, ?)")
        .run(generationId, now);
    return generationId;
}

function readPragma(db, name) {
    const row = db.prepare(`PRAGMA ${name}`).get();
    const value = Object.values(row)[0];
    return typeof value === 'bigint' ? Number(value) : value;
}

// Per connection, after the pragmas are set: journal_mode must read back `wal`,
// synchronous `2` (FULL) and foreign_keys `1`; anything else refuses with state_corrupt.
export function verifyPragmas(db) {
    if (String(readPragma(db, 'journal_mode')).toLowerCase() !== 'wal') fail('state_corrupt', 'pragma_journal_mode');
    if (readPragma(db, 'synchronous') !== 2) fail('state_corrupt', 'pragma_synchronous');
    if (readPragma(db, 'foreign_keys') !== 1) fail('state_corrupt', 'pragma_foreign_keys');
}

// Opens (and with create: true, first-creates) the supervisor-private store.
export function openStorage({ dataDir, workspaceId, provider, create, now, faults }) {
    const paths = resolveStorePaths(dataDir);
    requireRealDirectory(paths.dataDir, false, 0o700);
    requireRealDirectory(paths.directory, create === true, 0o700);
    const existing = requireRegularOrAbsent(paths.file);
    requireRegularOrAbsent(`${paths.file}-wal`);
    requireRegularOrAbsent(`${paths.file}-shm`);
    if (existing && existing.size === 0 && create !== true) fail('state_corrupt');
    if (!existing) {
        if (create !== true) fail('not_found');
        try {
            fs.closeSync(fs.openSync(paths.file, 'wx', 0o600));
        } catch (error) {
            if (!error || error.code !== 'EEXIST') throw mapError(error);
        }
        requireRegularOrAbsent(paths.file);
    }
    // A store with uncheckpointed WAL frames (the normal state after a killed writer) must not
    // be rewritten by a refused open: closing the last read-write connection checkpoints the
    // WAL into the main file and deletes it. Such a store is validated first through a
    // read-only connection, which never checkpoints or deletes. (SQLite may still rewrite the
    // -shm recovery index on any open; main and -wal stay byte-identical.)
    const walStat = lstatOrNull(`${paths.file}-wal`);
    const pendingWal = walStat !== null && walStat.size > 0;
    if (pendingWal && existing && existing.size > 0) preValidateReadOnly(paths.file, workspaceId, provider, create === true);
    let db;
    let guard = null;
    try {
        db = new DatabaseSync(paths.file, { timeout: 5000 });
        if (pendingWal) {
            // A second connection that survives the read-write close keeps it from being the last
            // one, so a late refusal does not checkpoint the WAL either.
            try {
                guard = new DatabaseSync(paths.file, { readOnly: true, timeout: 5000 });
                guard.prepare('SELECT COUNT(*) AS count FROM sqlite_master').get();
            } catch { guard = null; }
        }
        db.exec('PRAGMA busy_timeout = 5000');
        db.exec('PRAGMA foreign_keys = ON');
        retryBusy(() => db.exec('PRAGMA journal_mode = WAL'));
        db.exec('PRAGMA synchronous = FULL');
        if (faults.afterPragmas) faults.afterPragmas(db);
        verifyPragmas(db);
        const state = new StateDatabase(db, faults);
        const generationId = retryBusy(() => state.transaction('open', () => {
            const tables = db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table'").get().count;
            if (tables === 0) {
                if (create !== true) fail('state_corrupt');
                return initializeSchema(db, workspaceId, provider, now());
            }
            checkIntegrity(db);
            return verifyMetadata(db, workspaceId, provider);
        }));
        if (guard) { try { guard.close(); } catch { /* ignore */ } }
        return { state, generationId, paths };
    } catch (error) {
        try { db?.close(); } catch { /* ignore */ }
        try { guard?.close(); } catch { /* ignore */ }
        throw mapError(error);
    }
}

function preValidateReadOnly(file, workspaceId, provider, create) {
    let probe;
    try {
        probe = new DatabaseSync(file, { readOnly: true, timeout: 5000 });
        const tables = probe.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table'").get().count;
        if (tables === 0) {
            if (!create) fail('state_corrupt');
            return;
        }
        checkIntegrity(probe);
        verifyMetadata(probe, workspaceId, provider);
    } catch (error) {
        throw mapError(error);
    } finally {
        try { probe?.close(); } catch { /* ignore */ }
    }
}
