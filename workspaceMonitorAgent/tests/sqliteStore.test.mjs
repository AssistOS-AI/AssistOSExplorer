import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    createDatabaseHandleProvider,
    databasePath,
    normalizeHistoryRequest,
    openDatabase,
    persistExceededSamples,
    queryHistory,
    RETENTION_MS,
} from '../lib/sqliteStore.mjs';

async function temporaryEnvironment(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-monitor-sqlite-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    return { WORKSPACE_MONITOR_DATA_ROOT: root };
}

test('history requests support minute resolution and remain bounded', () => {
    const request = normalizeHistoryRequest({
        from: '2026-08-01T00:00:00Z',
        to: '2026-08-02T00:00:00Z',
        maxPoints: 100_000,
    });
    assert.equal(request.maxPoints, 50_000);
    assert.equal(request.stepMs, 2_000);

    const minuteRequest = normalizeHistoryRequest({
        from: '2026-08-01T00:00:00Z',
        to: '2026-08-02T00:00:00Z',
        maxPoints: 1_441,
    });
    assert.equal(minuteRequest.stepMs, 60_000);
});

test('SQLite history keeps the maximum value with its threshold and the latest bucket threshold', async (t) => {
    const env = await temporaryEnvironment(t);
    const start = Date.parse('2026-08-11T10:00:00Z');
    persistExceededSamples([{ key: 'workspace.cpu', value: 81, threshold: 80 }], start, { env, now: () => start });
    persistExceededSamples([{ key: 'workspace.cpu', value: 95, threshold: 90 }], start + 10_000, { env, now: () => start + 10_000 });
    persistExceededSamples([{ key: 'workspace.cpu', value: 88, threshold: 85 }], start + 20_000, { env, now: () => start + 20_000 });

    const result = queryHistory({
        from: new Date(start).toISOString(),
        to: new Date(start + 60_000).toISOString(),
        maxPoints: 2,
        series: ['workspace.cpu'],
    }, { env });

    assert.deepEqual(result.series['workspace.cpu'].values, [[start + 10_000, 95]]);
    assert.deepEqual(result.series['workspace.cpu'].valueThresholds, [[start + 10_000, 90]]);
    assert.deepEqual(result.series['workspace.cpu'].thresholds, [[start, 85]]);
    assert.equal(result.stepSeconds, 60);
    await fs.access(databasePath(env));
});

test('SQLite persistence removes samples outside the thirteen-month retention window', async (t) => {
    const env = await temporaryEnvironment(t);
    const now = Date.parse('2026-08-11T10:00:00Z');
    persistExceededSamples([{ key: 'router.memory', value: 900, threshold: 500 }], now - RETENTION_MS - 1, {
        env,
        now: () => now - RETENTION_MS - 1,
    });
    persistExceededSamples([{ key: 'router.memory', value: 800, threshold: 500 }], now, { env, now: () => now });

    const database = openDatabase(env);
    try {
        const rows = database.prepare('SELECT sampled_at, value FROM resource_samples ORDER BY sampled_at')
            .all()
            .map((row) => ({ sampled_at: row.sampled_at, value: row.value }));
        assert.deepEqual(rows, [{ sampled_at: now, value: 800 }]);
    } finally {
        database.close();
    }
});

test('SQLite persists and queries per-runtime resource series', async (t) => {
    const env = await temporaryEnvironment(t);
    const start = Date.parse('2026-08-11T10:00:00Z');
    const cpuKey = 'runtime:AchillesIDE%2Fexplorer:cpu';
    const memoryKey = 'runtime:AchillesIDE%2Fexplorer:memory';
    persistExceededSamples([
        { key: cpuKey, value: 42, threshold: 80 },
        { key: memoryKey, value: 2_048, threshold: 4_096 },
    ], start, { env, now: () => start });

    const result = queryHistory({
        from: new Date(start - 1_000).toISOString(),
        to: new Date(start + 1_000).toISOString(),
        series: [cpuKey, memoryKey],
    }, { env });

    assert.deepEqual(result.series[cpuKey].values, [[start, 42]]);
    assert.deepEqual(result.series[memoryKey].values, [[start, 2_048]]);
});

function countingProvider(env) {
    const counts = { opened: 0, closed: 0 };
    const provider = createDatabaseHandleProvider({
        env,
        openDatabaseImpl: (target) => {
            counts.opened += 1;
            const database = openDatabase(target);
            const close = database.close.bind(database);
            database.close = () => { counts.closed += 1; close(); };
            return database;
        },
    });
    return { provider, counts };
}

function history(env, start, key) {
    return queryHistory({
        from: new Date(start - 1_000).toISOString(),
        to: new Date(start + 600_000).toISOString(),
        maxPoints: 600,
        series: [key],
    }, { env }).series[key].values;
}

test('a database handle provider opens the database once for repeated persists', async (t) => {
    const env = await temporaryEnvironment(t);
    const { provider, counts } = countingProvider(env);
    t.after(() => provider.close());
    const start = Date.parse('2026-08-11T10:00:00Z');
    for (let index = 0; index < 3; index += 1) {
        persistExceededSamples([{ key: 'workspace.cpu', value: 10 + index, threshold: 80 }], start + index * 10_000, {
            env, now: () => start, databaseProvider: provider,
        });
    }
    assert.equal(counts.opened, 1);
    assert.equal(counts.closed, 0);
    assert.deepEqual(history(env, start, 'workspace.cpu').map(([, value]) => value), [10, 11, 12]);
});

test('a persist error closes and drops the shared handle and the next persist reopens it', async (t) => {
    const env = await temporaryEnvironment(t);
    const { provider, counts } = countingProvider(env);
    t.after(() => provider.close());
    const start = Date.parse('2026-08-11T10:00:00Z');
    const options = { env, now: () => start, databaseProvider: provider };
    persistExceededSamples([{ key: 'workspace.cpu', value: 1, threshold: 80 }], start, options);
    assert.throws(() => persistExceededSamples([{ key: 'not-a-series', value: 1, threshold: 80 }], start + 10_000, options), /Invalid resource sample/);
    assert.equal(counts.closed, 1);
    persistExceededSamples([{ key: 'workspace.cpu', value: 2, threshold: 80 }], start + 20_000, options);
    assert.equal(counts.opened, 2);
    assert.deepEqual(history(env, start, 'workspace.cpu').map(([, value]) => value), [1, 2]);
});

test('a shared handle is reopened when the database file was replaced', async (t) => {
    const env = await temporaryEnvironment(t);
    const { provider, counts } = countingProvider(env);
    t.after(() => provider.close());
    const start = Date.parse('2026-08-11T10:00:00Z');
    const options = { env, now: () => start, databaseProvider: provider };
    persistExceededSamples([{ key: 'workspace.cpu', value: 1, threshold: 80 }], start, options);
    for (const suffix of ['', '-wal', '-shm']) await fs.rm(`${databasePath(env)}${suffix}`, { force: true });
    persistExceededSamples([{ key: 'workspace.cpu', value: 2, threshold: 80 }], start + 10_000, options);
    assert.equal(counts.opened, 2);
    assert.deepEqual(history(env, start, 'workspace.cpu').map(([, value]) => value), [2]);
});
