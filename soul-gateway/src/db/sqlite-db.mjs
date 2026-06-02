/**
 * Embedded SQLite database facade for Soul Gateway.
 *
 * Wraps node:sqlite's synchronous DatabaseSync behind a small async,
 * compatibility surface (`query(sql, params) -> { rows, rowCount }`,
 * `connect()`, `end()`) so the existing DAO layer keeps working.
 *
 * The facade owns four behaviours the runtime relies on:
 *   - `$1`-style placeholders are rewritten to SQLite numbered `?1`
 *     placeholders. Numbering is preserved so a query that references the
 *     same `$n` twice (e.g. a case-insensitive keyword filter) keeps the
 *     original reuse semantics under a single bound parameter.
 *   - JSON text columns are parsed back into objects/arrays on read.
 *   - SQLite returns BLOBs as Uint8Array; encryption callers expect Node
 *     Buffer, so BLOB columns are normalized back to Buffer.
 *   - All access is serialized through a promise-chain lock. DatabaseSync is
 *     a single connection, so an explicit transaction (connect() + BEGIN ...
 *     COMMIT) must hold exclusive access for its whole lifetime; otherwise an
 *     interleaved autocommit write would join the open transaction.
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const JSON_COLUMNS = new Set([
    'metadata', 'settings', 'capabilities', 'tags', 'rate_limit_override',
    'budget_override', 'loop_override', 'response_filter_override',
    'retry_policy', 'default_settings', 'middleware_default_settings',
    'facts_json',
    'recent_fingerprints', 'recent_similarity', 'retry_trace',
    'middleware_trace', 'request_headers', 'request_payload',
    'response_payload', 'flags',
]);

const BOOLEAN_COLUMNS = new Set([
    'enabled', 'supports_streaming', 'supports_tools',
    'supports_messages_api', 'supports_responses_api', 'is_free',
    'case_sensitive', 'cache_hit', 'blocked', 'loop_detected',
    'truncated', 'slow', 'oversized', 'streaming', 'retryable',
    'cascaded', 'budget_exempt',
]);

const BLOB_COLUMNS = new Set([
    'key_hash', 'key_ciphertext', 'key_iv', 'key_auth_tag',
    'secret_ciphertext', 'secret_iv', 'secret_auth_tag',
]);

const TXN_CONTROL_RE = /^(BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b/i;
const ROW_RETURNING_PREFIX_RE = /^(SELECT|WITH|PRAGMA|VALUES|EXPLAIN)\b/i;

export async function openDatabase(env) {
    const sqlitePath = env.SQLITE_PATH || './data/soul-gateway.sqlite3';
    await mkdir(dirname(sqlitePath), { recursive: true });
    const raw = new DatabaseSync(sqlitePath, { timeout: 5000 });
    raw.exec('PRAGMA foreign_keys = ON');
    raw.exec('PRAGMA journal_mode = WAL');
    raw.exec('PRAGMA synchronous = NORMAL');
    raw.exec('PRAGMA busy_timeout = 5000');
    // Provide now() returning an ISO-8601 UTC timestamp. DAO SQL that uses
    // now() keeps working unchanged, and the value stays consistent
    // with the schema's strftime ISO defaults and application-supplied
    // (new Date().toISOString()) timestamps so comparisons and sorts agree.
    raw.function('now', () => new Date().toISOString());
    return new SqliteDb(raw);
}

export async function initializeSchema(db) {
    const schemaPath = new URL('./schema/sqlite-current.sql', import.meta.url);
    const sql = await readFile(schemaPath, 'utf8');
    await db.exec(sql);
}

export class SqliteDb {
    constructor(raw) {
        this.raw = raw;
        // Promise-chain mutex serializing all access to the single connection.
        this._lock = Promise.resolve();
    }

    async _acquire() {
        const prev = this._lock;
        let release;
        this._lock = new Promise((resolve) => { release = resolve; });
        await prev;
        return release;
    }

    async exec(sql) {
        const release = await this._acquire();
        try {
            this.raw.exec(sql);
        } finally {
            release();
        }
    }

    async query(sql, params = []) {
        const release = await this._acquire();
        try {
            return this._runSync(sql, params);
        } finally {
            release();
        }
    }

    /**
     * Synchronous statement execution. Callers must already hold the lock:
     * standalone query()/exec() acquire it; a connect()ed client holds it for
     * the whole transaction and runs statements through here directly.
     */
    _runSync(sql, params = []) {
        const trimmed = sql.trim();

        // Transaction-control statements carry no params and return no rows.
        if (TXN_CONTROL_RE.test(trimmed)) {
            this.raw.exec(sql);
            return { rows: [], rowCount: 0 };
        }

        const stmt = this.raw.prepare(translatePlaceholders(sql));
        const normalizedParams = params.map(toSqliteValue);

        if (ROW_RETURNING_PREFIX_RE.test(trimmed) || /\bRETURNING\b/i.test(sql)) {
            const rows = stmt.all(...normalizedParams).map(normalizeRow);
            return { rows, rowCount: rows.length };
        }

        const result = stmt.run(...normalizedParams);
        return { rows: [], rowCount: Number(result.changes ?? 0) };
    }

    async connect() {
        const release = await this._acquire();
        return new SqliteClient(this, release);
    }

    async end() {
        const release = await this._acquire();
        try {
            this.raw.close();
        } finally {
            release();
        }
    }
}

class SqliteClient {
    constructor(db, release) {
        this.db = db;
        this._release = release;
    }

    // The transaction lock is already held; run directly without re-acquiring.
    async query(sql, params = []) {
        return this.db._runSync(sql, params);
    }

    release() {
        if (this._release) {
            this._release();
            this._release = null;
        }
    }
}

function translatePlaceholders(sql) {
    return sql.replace(/\$(\d+)/g, '?$1');
}

function toSqliteValue(value) {
    if (value === undefined) return null;
    if (Buffer.isBuffer(value)) return value;
    if (value instanceof Uint8Array) return Buffer.from(value);
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'boolean') return value ? 1 : 0;
    return value;
}

function normalizeRow(row) {
    const out = {};
    for (const [key, value] of Object.entries(row)) {
        if (value == null) {
            out[key] = value;
        } else if (JSON_COLUMNS.has(key) && typeof value === 'string') {
            out[key] = parseJson(value, key);
        } else if (BOOLEAN_COLUMNS.has(key)) {
            out[key] = Boolean(value);
        } else if (BLOB_COLUMNS.has(key) && value instanceof Uint8Array && !Buffer.isBuffer(value)) {
            out[key] = Buffer.from(value);
        } else {
            out[key] = value;
        }
    }
    return out;
}

function parseJson(value, key) {
    try {
        return JSON.parse(value);
    } catch (err) {
        throw new Error(`Invalid JSON in SQLite column ${key}: ${err.message}`);
    }
}
