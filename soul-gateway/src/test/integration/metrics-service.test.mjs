import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase, initializeSchema } from '../../db/sqlite-db.mjs';
import * as apiKeysDao from '../../db/dao/api-keys-dao.mjs';
import * as auditLogsDao from '../../db/dao/audit-logs-dao.mjs';
import { MetricsService } from '../../observability/metrics-service.mjs';

async function withDb(fn) {
    const dir = await mkdtemp(join(tmpdir(), 'soul-metrics-'));
    const db = await openDatabase({ SQLITE_PATH: join(dir, 'gateway.sqlite3') });
    try {
        await initializeSchema(db);
        return await fn(db);
    } finally {
        await db.end();
        await rm(dir, { recursive: true, force: true });
    }
}

async function seedMetricRows(db) {
    const primaryKey = await apiKeysDao.create(db, {
        label: 'Primary key',
        keyHint: 'sk-prim...0001',
        subjectId: 'user:daniel:primary',
        subjectType: 'user',
        dailyBudgetUsd: 10,
        metadata: { purpose: 'metrics-test' },
    });
    const agentKey = await apiKeysDao.create(db, {
        label: 'Agent key',
        keyHint: 'agent:...demo',
        subjectId: 'agent:repo/demo',
        subjectType: 'agent',
        monthlyBudgetUsd: 25,
        metadata: { purpose: 'metrics-test' },
    });

    await auditLogsDao.insertCompleted(db, {
        startedAt: '2026-06-26T10:00:00.000Z',
        completedAt: '2026-06-26T10:00:01.000Z',
        requestId: 'req-fast-1',
        requestFormat: 'openai_chat',
        status: 'succeeded',
        apiKeyId: primaryKey.id,
        requestedModel: 'fast',
        httpStatus: 200,
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        inputCostUsd: 0.01,
        outputCostUsd: 0.02,
        totalCostUsd: 0.03,
        cacheHit: false,
    });
    await auditLogsDao.insertCompleted(db, {
        startedAt: '2026-06-26T11:00:00.000Z',
        completedAt: '2026-06-26T11:00:01.000Z',
        requestId: 'req-fast-2',
        requestFormat: 'openai_chat',
        status: 'succeeded',
        apiKeyId: primaryKey.id,
        requestedModel: 'fast',
        httpStatus: 200,
        inputTokens: 2,
        outputTokens: 3,
        totalTokens: 5,
        inputCostUsd: 0.004,
        outputCostUsd: 0.006,
        totalCostUsd: 0.01,
        cacheHit: true,
    });
    await auditLogsDao.insertCompleted(db, {
        startedAt: '2026-06-26T12:00:00.000Z',
        completedAt: '2026-06-26T12:00:02.000Z',
        requestId: 'req-plan-1',
        requestFormat: 'openai_chat',
        status: 'failed',
        apiKeyId: agentKey.id,
        requestedModel: 'plan',
        httpStatus: 500,
        errorType: 'provider_error',
        errorMessage: 'upstream failed',
        totalCostUsd: 0,
        cacheHit: false,
    });

    return { primaryKey, agentKey };
}

describe('MetricsService dashboard aggregates', () => {
    it('builds the usage shape consumed by the dashboard usage page', async () => {
        await withDb(async (db) => {
            const { primaryKey, agentKey } = await seedMetricRows(db);
            const service = new MetricsService(db);

            const metrics = await service.getUsageDashboardMetrics({
                from: '2026-06-01T00:00:00.000Z',
                to: '2026-07-01T00:00:00.000Z',
                groupBy: 'day',
            });

            assert.equal(metrics.total.request_count, 3);
            assert.equal(metrics.total.total_tokens, 20);
            assert.equal(metrics.total.total_cost, 0.04);
            assert.deepEqual(metrics.models, ['fast', 'plan']);
            assert.deepEqual(
                metrics.daily_by_model.map((row) => ({
                    model: row.resolved_model,
                    requests: row.request_count,
                    cost: row.total_cost,
                })),
                [
                    { model: 'fast', requests: 2, cost: 0.04 },
                    { model: 'plan', requests: 1, cost: 0 },
                ]
            );
            assert.deepEqual(
                metrics.model_requests.map((row) => ({
                    model: row.resolved_model,
                    key: row.api_key_id,
                    total: row.total,
                    cached: row.cached,
                    nonCached: row.non_cached,
                })),
                [
                    {
                        model: 'fast',
                        key: primaryKey.id,
                        total: 2,
                        cached: 1,
                        nonCached: 1,
                    },
                    {
                        model: 'plan',
                        key: agentKey.id,
                        total: 1,
                        cached: 0,
                        nonCached: 1,
                    },
                ]
            );
        });
    });

    it('builds the key activity shape consumed by the dashboard activity page', async () => {
        await withDb(async (db) => {
            const { primaryKey, agentKey } = await seedMetricRows(db);
            const service = new MetricsService(db);

            const metrics = await service.getActivityDashboardMetrics({
                from: '2026-06-01T00:00:00.000Z',
                to: '2026-07-01T00:00:00.000Z',
                bucket: 'hour',
            });

            assert.equal(metrics.data.length, 3);
            assert.deepEqual(
                metrics.by_key.map((row) => ({
                    key: row.api_key_id,
                    requests: row.request_count,
                    errors: row.error_count,
                    tokens: row.total_tokens,
                    budget: row.key_budget,
                })),
                [
                    {
                        key: agentKey.id,
                        requests: 1,
                        errors: 1,
                        tokens: 0,
                        budget: 25,
                    },
                    {
                        key: primaryKey.id,
                        requests: 2,
                        errors: 0,
                        tokens: 20,
                        budget: 10,
                    },
                ]
            );
        });
    });
});
