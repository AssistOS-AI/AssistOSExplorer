/**
 * Gateway-dispatch cooldown-loop tests.
 *
 * The cascade middleware invokes `ctx.metadata.onCooldown(modelKey, err)`
 * whenever a child attempt fails with `err.cooldown === true`.  The route
 * layer installs that hook inside `gatewayDispatchMiddleware`, and the
 * hook must:
 *
 *   - insert a row into `soul_gateway.model_cooldowns` (write side)
 *   - trigger an async snapshot refresh so the next request bound to a
 *     fresh snapshot sees the cooldown in `snapshot.cooldowns`
 *   - never throw out of the callback and never block cascade flow
 *
 * These tests hit `persistCooldown` directly with a stub pool and a
 * stub refresh service, so no DB or runtime is required.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { persistCooldown } from '../../runtime/route/gateway-dispatch.mjs';

function makeLog() {
    const entries = [];
    return {
        entries,
        debug() {},
        info(msg, extra) {
            entries.push({ level: 'info', msg, extra });
        },
        warn(msg, extra) {
            entries.push({ level: 'warn', msg, extra });
        },
        error(msg, extra) {
            entries.push({ level: 'error', msg, extra });
        },
        fatal() {},
    };
}

function makeCtx({ modelKey = 'tier-x/child', model, requestId = 'req-1' } = {}) {
    return {
        requestId,
        metadata: { sourceAccountId: null },
        snapshot: {
            models: new Map([[modelKey, model]]),
        },
    };
}

function makePool({ onInsert, insertShouldFail = false } = {}) {
    const queries = [];
    return {
        queries,
        async query(sql, params) {
            queries.push({ sql, params });
            if (/INSERT INTO soul_gateway\.model_cooldowns/.test(sql)) {
                if (insertShouldFail) {
                    throw new Error('db write failed');
                }
                onInsert?.(sql, params);
                return {
                    rows: [
                        {
                            model_id: params[0],
                            expires_at: params[5],
                        },
                    ],
                };
            }
            return { rows: [] };
        },
    };
}

function makeAppCtx({ pool, env = {}, refreshCalls } = {}) {
    const log = makeLog();
    return {
        log,
        pool,
        config: { env },
        services: {
            refreshRuntimeAsync: (options) => {
                refreshCalls?.push(options);
                return Promise.resolve({
                    snapshotGeneration: 42,
                    reason: options?.reason,
                });
            },
        },
    };
}

describe('gateway-dispatch: persistCooldown', () => {
    it('writes the cooldown to the DAO with the resolved model id and computed expiresAt', async () => {
        const inserts = [];
        const pool = makePool({
            onInsert: (_sql, params) => inserts.push(params),
        });
        const refreshCalls = [];
        const appCtx = makeAppCtx({
            pool,
            env: { COOLDOWN_DURATION_MS: 5_000 },
            refreshCalls,
        });
        const model = {
            id: 'model-uuid-1',
            modelKey: 'tier-x/child',
            retryPolicy: {},
        };
        const ctx = makeCtx({ model });
        const error = {
            errorType: 'rate_limit',
            message: 'slow down',
            cooldown: true,
        };

        const before = Date.now();
        persistCooldown(appCtx, ctx, 'tier-x/child', error);
        // Let the fire-and-forget promise chain resolve.
        await new Promise((resolve) => setImmediate(resolve));

        assert.equal(inserts.length, 1);
        const params = inserts[0];
        assert.equal(params[0], 'model-uuid-1', 'modelId');
        assert.equal(params[1], null, 'sourceAccountId');
        assert.equal(params[2], 'req-1', 'requestId');
        assert.equal(params[3], 'rate_limit', 'reasonType');
        assert.equal(params[4], 'slow down', 'reasonMessage');

        const expiresAt = params[5];
        const delta = expiresAt.getTime() - before;
        assert.ok(
            delta >= 4_000 && delta <= 10_000,
            `expiresAt should be ~5s in the future, got ${delta}ms`
        );

        const metadata = JSON.parse(params[6]);
        assert.equal(metadata.cooldownMs, 5_000);
        assert.equal(metadata.modelKey, 'tier-x/child');

        assert.equal(refreshCalls.length, 1);
        assert.equal(refreshCalls[0].snapshot, true);
        assert.equal(refreshCalls[0].reason, 'cooldown.tier-x/child');
    });

    it('prefers err.cooldownMs over model.retryPolicy.cooldownMs over env default', async () => {
        const inserts = [];
        const pool = makePool({
            onInsert: (_sql, params) => inserts.push(params),
        });
        const appCtx = makeAppCtx({
            pool,
            env: { COOLDOWN_DURATION_MS: 1_000_000 },
        });
        const model = {
            id: 'model-uuid-2',
            modelKey: 'tier-x/child',
            retryPolicy: { cooldownMs: 2_000 },
        };
        const ctx = makeCtx({ model });

        // err.cooldownMs wins
        persistCooldown(appCtx, ctx, 'tier-x/child', {
            errorType: 'rate_limit',
            cooldownMs: 500,
        });
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(JSON.parse(inserts[0][6]).cooldownMs, 500);

        // No err.cooldownMs → retryPolicy wins
        persistCooldown(appCtx, ctx, 'tier-x/child', { errorType: 'x' });
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(JSON.parse(inserts[1][6]).cooldownMs, 2_000);

        // No retryPolicy, no err.cooldownMs → env wins
        const modelNoRetry = { ...model, retryPolicy: {} };
        const ctx2 = makeCtx({ model: modelNoRetry });
        persistCooldown(appCtx, ctx2, 'tier-x/child', { errorType: 'x' });
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(JSON.parse(inserts[2][6]).cooldownMs, 1_000_000);
    });

    it('falls back to a 1-hour default when no env value is set', async () => {
        const inserts = [];
        const pool = makePool({
            onInsert: (_sql, params) => inserts.push(params),
        });
        const appCtx = makeAppCtx({ pool, env: {} });
        const model = {
            id: 'model-uuid-3',
            modelKey: 'tier-x/child',
            retryPolicy: {},
        };
        const ctx = makeCtx({ model });

        persistCooldown(appCtx, ctx, 'tier-x/child', { errorType: 'x' });
        await new Promise((resolve) => setImmediate(resolve));

        assert.equal(JSON.parse(inserts[0][6]).cooldownMs, 3_600_000);
    });

    it('skips the write and logs warn when the modelKey is not in the snapshot', async () => {
        const pool = makePool();
        const appCtx = makeAppCtx({ pool, env: {} });
        const ctx = {
            requestId: 'req-1',
            metadata: {},
            snapshot: { models: new Map() },
        };

        persistCooldown(appCtx, ctx, 'unknown-model', { errorType: 'x' });
        await new Promise((resolve) => setImmediate(resolve));

        assert.equal(pool.queries.length, 0);
        const warn = appCtx.log.entries.find(
            (entry) => entry.level === 'warn'
        );
        assert.ok(warn, 'expected a warn log');
        assert.match(warn.msg, /cooldown write skipped/);
        assert.equal(warn.extra.modelKey, 'unknown-model');
    });

    it('is a no-op when no pool is available', () => {
        const appCtx = { log: makeLog(), config: { env: {} }, services: {} };
        const ctx = makeCtx({
            model: { id: 'm', modelKey: 'k', retryPolicy: {} },
        });
        assert.doesNotThrow(() =>
            persistCooldown(appCtx, ctx, 'k', { errorType: 'x' })
        );
    });

    it('logs at warn level and does not throw when the DB write fails', async () => {
        const pool = makePool({ insertShouldFail: true });
        const appCtx = makeAppCtx({ pool, env: {} });
        const model = {
            id: 'model-uuid-4',
            modelKey: 'k',
            retryPolicy: {},
        };
        const ctx = makeCtx({ model, modelKey: 'k' });

        persistCooldown(appCtx, ctx, 'k', { errorType: 'x' });
        // Let the promise chain's .catch run.
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));

        const warn = appCtx.log.entries.find(
            (entry) =>
                entry.level === 'warn' && /cooldown write failed/.test(entry.msg)
        );
        assert.ok(warn, 'expected a cooldown-write-failed warn log');
        assert.equal(warn.extra.modelKey, 'k');
    });

    it('does not trigger refreshRuntimeAsync when the DB write fails', async () => {
        const pool = makePool({ insertShouldFail: true });
        const refreshCalls = [];
        const appCtx = makeAppCtx({ pool, env: {}, refreshCalls });
        const model = {
            id: 'model-uuid-5',
            modelKey: 'k',
            retryPolicy: {},
        };
        const ctx = makeCtx({ model, modelKey: 'k' });

        persistCooldown(appCtx, ctx, 'k', { errorType: 'x' });
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));

        assert.equal(refreshCalls.length, 0);
    });
});
