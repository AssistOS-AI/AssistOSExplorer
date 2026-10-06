import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { dataRoot } from './settings.mjs';

const SERIES_KEYS = Object.freeze([
    'workspace.cpu',
    'workspace.memory',
    'router.cpu',
    'router.memory',
]);
const RUNTIME_SERIES_PATTERN = /^runtime:[^:]{1,512}:(cpu|memory)$/;

function isSupportedSeriesKey(key) {
    return SERIES_KEYS.includes(key) || RUNTIME_SERIES_PATTERN.test(key);
}

export const RETENTION_MONTHS = 13;
export const RETENTION_MS = RETENTION_MONTHS * 31 * 24 * 60 * 60 * 1000;

export function databasePath(env = process.env) {
    return path.join(dataRoot(env), 'history.sqlite');
}

export function openDatabase(env = process.env) {
    const target = databasePath(env);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const database = new DatabaseSync(target);
    database.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        PRAGMA busy_timeout = 5000;
        CREATE TABLE IF NOT EXISTS resource_exceedances (
            metric TEXT NOT NULL,
            sampled_at INTEGER NOT NULL,
            value REAL NOT NULL,
            threshold REAL NOT NULL,
            PRIMARY KEY (metric, sampled_at)
        ) WITHOUT ROWID;
        CREATE INDEX IF NOT EXISTS resource_exceedances_sampled_at
            ON resource_exceedances (sampled_at);
        CREATE TABLE IF NOT EXISTS resource_samples (
            metric TEXT NOT NULL,
            sampled_at INTEGER NOT NULL,
            value REAL NOT NULL,
            threshold REAL NOT NULL,
            PRIMARY KEY (metric, sampled_at)
        ) WITHOUT ROWID;
        CREATE INDEX IF NOT EXISTS resource_samples_sampled_at
            ON resource_samples (sampled_at);
        INSERT OR IGNORE INTO resource_samples (metric, sampled_at, value, threshold)
            SELECT metric, sampled_at, value, threshold FROM resource_exceedances;
        DELETE FROM resource_exceedances;
    `);
    return database;
}

// Keeps one open database for a long-lived writer so the DDL and migration in
// openDatabase run once per process instead of once per sample. The handle is
// closed and dropped on any persist error, and reopened when the database file
// was removed or replaced, so the next persist starts from a fresh open.
export function createDatabaseHandleProvider({
    env = process.env,
    openDatabaseImpl = openDatabase,
} = {}) {
    let database = null;
    let identity = null;
    function fileIdentity() {
        try {
            const stat = fs.statSync(databasePath(env));
            return `${stat.dev}:${stat.ino}`;
        } catch {
            return null;
        }
    }
    function release() {
        const current = database;
        database = null;
        identity = null;
        if (!current) return;
        try { current.close(); } catch { /* the handle is dropped either way */ }
    }
    return {
        acquire() {
            if (database && fileIdentity() !== identity) release();
            if (!database) {
                database = openDatabaseImpl(env);
                identity = fileIdentity();
            }
            return database;
        },
        release,
        close: release,
    };
}

export function persistSamples(samples, sampledAt, {
    env = process.env,
    now = () => Date.now(),
    openDatabaseImpl = openDatabase,
    databaseProvider = null,
} = {}) {
    if (!Array.isArray(samples) || !samples.length) return;
    const timestamp = Number(sampledAt);
    if (!Number.isFinite(timestamp)) throw new Error('sampledAt must be a finite timestamp.');
    const database = databaseProvider ? databaseProvider.acquire() : openDatabaseImpl(env);
    try {
        const insert = database.prepare(`
            INSERT INTO resource_samples (metric, sampled_at, value, threshold)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(metric, sampled_at) DO UPDATE SET
                value = excluded.value,
                threshold = excluded.threshold
        `);
        database.exec('BEGIN IMMEDIATE');
        try {
            for (const sample of samples) {
                if (!isSupportedSeriesKey(sample.key)
                    || !Number.isFinite(sample.value)
                    || !Number.isFinite(sample.threshold)) {
                    throw new Error('Invalid resource sample.');
                }
                insert.run(sample.key, timestamp, sample.value, sample.threshold);
            }
            database.prepare('DELETE FROM resource_samples WHERE sampled_at < ?')
                .run(now() - RETENTION_MS);
            database.exec('COMMIT');
        } catch (error) {
            database.exec('ROLLBACK');
            throw error;
        }
    } catch (error) {
        if (databaseProvider) databaseProvider.release();
        throw error;
    } finally {
        if (!databaseProvider) database.close();
    }
}

function parseInstant(value, name) {
    const timestamp = Date.parse(String(value || ''));
    if (!Number.isFinite(timestamp)) throw new Error(`${name} must be an ISO-8601 date.`);
    return timestamp;
}

export function normalizeHistoryRequest(input = {}) {
    const fromMs = parseInstant(input.from, 'from');
    const toMs = parseInstant(input.to, 'to');
    if (toMs <= fromMs) throw new Error('to must be later than from.');
    if (toMs - fromMs > RETENTION_MS) {
        throw new Error('History range cannot exceed the thirteen-month retention window.');
    }
    const maxPoints = Math.max(2, Math.min(50_000, Math.round(Number(input.maxPoints || 600))));
    const requested = Array.isArray(input.series) && input.series.length ? input.series : SERIES_KEYS;
    const series = [...new Set(requested.map(String))];
    if (series.some((key) => !isSupportedSeriesKey(key))) {
        throw new Error('series contains an unsupported value.');
    }
    const stepMs = Math.max(1_000, Math.ceil((toMs - fromMs) / (maxPoints - 1) / 1_000) * 1_000);
    return { fromMs, toMs, maxPoints, stepMs, series };
}

export function queryHistory(input, {
    env = process.env,
    openDatabaseImpl = openDatabase,
} = {}) {
    const request = normalizeHistoryRequest(input);
    const database = openDatabaseImpl(env);
    const result = {};
    try {
        const query = database.prepare(`
            WITH bucketed AS (
                SELECT sampled_at, value, threshold,
                       CAST((sampled_at - ?) / ? AS INTEGER) AS bucket
                FROM resource_samples
                WHERE metric = ? AND sampled_at >= ? AND sampled_at <= ?
            )
            SELECT bucket,
                   MAX(value) AS value,
                   (SELECT sampled_at
                      FROM bucketed AS peak
                     WHERE peak.bucket = bucketed.bucket
                     ORDER BY peak.value DESC, peak.sampled_at DESC
                     LIMIT 1) AS value_sampled_at,
                   (SELECT threshold
                      FROM bucketed AS peak
                     WHERE peak.bucket = bucketed.bucket
                     ORDER BY peak.value DESC, peak.sampled_at DESC
                     LIMIT 1) AS value_threshold,
                   (SELECT threshold
                      FROM bucketed AS latest
                     WHERE latest.bucket = bucketed.bucket
                     ORDER BY latest.sampled_at DESC
                     LIMIT 1) AS threshold
              FROM bucketed
             GROUP BY bucket
             ORDER BY bucket
        `);
        for (const key of request.series) {
            const rows = query.all(request.fromMs, request.stepMs, key, request.fromMs, request.toMs);
            result[key] = {
                values: rows.map((row) => [Number(row.value_sampled_at), Number(row.value)]),
                valueThresholds: rows.map((row) => [Number(row.value_sampled_at), Number(row.value_threshold)]),
                thresholds: rows.map((row) => [request.fromMs + Number(row.bucket) * request.stepMs, Number(row.threshold)]),
            };
        }
    } finally {
        database.close();
    }
    return {
        ok: true,
        from: new Date(request.fromMs).toISOString(),
        to: new Date(request.toMs).toISOString(),
        stepSeconds: request.stepMs / 1000,
        maxPoints: request.maxPoints,
        series: result,
    };
}

export const persistExceededSamples = persistSamples;
