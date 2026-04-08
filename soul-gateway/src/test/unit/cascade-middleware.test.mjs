/**
 * Cascade middleware tests.
 *
 * Validates Phase 7 (runtime side): the cascade is now a kernel
 * middleware that loops over candidate models and dispatches each one
 * via `ctx.invokeModel`.  The legacy `executeModelCascade` helper has
 * been retired.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { compose, createKernelContext } from '../../runtime/kernel/index.mjs';
import { cascadeMiddleware } from '../../runtime/execution/cascade-middleware.mjs';
import {
    TierExhaustedError,
    ProviderRateLimitError,
    ProviderQuotaError,
    ConfigurationError,
} from '../../core/errors.mjs';

// ── helpers ────────────────────────────────────────────────────────────

function noopLog() {
    return { debug() {}, info() {}, warn() {}, error() {}, fatal() {} };
}

function makeCtx(overrides = {}) {
    return createKernelContext({
        requestId: 'req-cascade-1',
        request: {
            model: 'tier-x',
            messages: [{ role: 'user', content: 'hi' }],
        },
        log: overrides.log ?? noopLog(),
        appCtx: { config: { env: {} }, services: {} },
    });
}

function makeCascadeModel(key = 'tier-x') {
    return Object.freeze({ modelKey: key, displayName: key, children: [] });
}

function makeCandidate(modelKey) {
    return { model: { modelKey, providerKey: 'p' } };
}

// ── input validation ──────────────────────────────────────────────────

describe('cascadeMiddleware: validation', () => {
    it('requires a model', () => {
        assert.throws(
            () => cascadeMiddleware({}),
            /options\.model is required/
        );
    });

    it('requires resolveCandidates', () => {
        assert.throws(
            () => cascadeMiddleware({ model: makeCascadeModel() }),
            /options\.resolveCandidates is required/
        );
    });

    it('throws InternalServerError when ctx.invokeModel is missing', async () => {
        const cascade = cascadeMiddleware({
            model: makeCascadeModel(),
            resolveCandidates: () => [makeCandidate('m1')],
        });
        await assert.rejects(
            compose([cascade])(makeCtx()),
            (err) =>
                err instanceof Error &&
                /ctx\.invokeModel is not installed/.test(err.message)
        );
    });
});

// ── single-success cases ───────────────────────────────────────────────

describe('cascadeMiddleware: single-success cases', () => {
    it('returns the result from the first candidate when it succeeds', async () => {
        const calls = [];
        const ctx = makeCtx();
        ctx.invokeModel = async (model) => {
            calls.push(model.modelKey);
            return {
                response: {
                    message: { role: 'assistant', content: 'ok' },
                    usage: { total_tokens: 1 },
                },
                metadata: {
                    backendAccountId: 'acct-1',
                    retryTrace: [],
                    queueWaitMs: 5,
                },
                target: { model },
            };
        };

        const cascade = cascadeMiddleware({
            model: makeCascadeModel(),
            resolveCandidates: () => [makeCandidate('m1'), makeCandidate('m2')],
        });
        await compose([cascade])(ctx);

        assert.deepEqual(calls, ['m1']);
        assert.equal(ctx.response.message.content, 'ok');
        assert.equal(ctx.metadata.cascadeAttempt, 1);
        assert.equal(ctx.metadata.cascadeAccountId, 'acct-1');
        assert.equal(ctx.metadata.cascadeQueueWaitMs, 5);
        assert.equal(ctx.metadata.cascadeModel.modelKey, 'm1');
        assert.deepEqual(ctx.metadata.cascadeTrace, []);
    });
});

// ── fallback / cascade behavior ────────────────────────────────────────

describe('cascadeMiddleware: fallback', () => {
    it('falls back to the next candidate on a cascade-classified error', async () => {
        const calls = [];
        const ctx = makeCtx();
        ctx.invokeModel = async (model) => {
            calls.push(model.modelKey);
            if (model.modelKey === 'm1') throw new ProviderRateLimitError('p');
            return {
                response: {
                    message: { role: 'assistant', content: 'recovered' },
                    usage: {},
                },
                metadata: {
                    backendAccountId: 'acct-2',
                },
                target: { model },
            };
        };

        const cascade = cascadeMiddleware({
            model: makeCascadeModel(),
            resolveCandidates: (excluded) => {
                const all = [makeCandidate('m1'), makeCandidate('m2')];
                return all.filter(({ model }) => !excluded.has(model.modelKey));
            },
        });
        await compose([cascade])(ctx);

        assert.deepEqual(calls, ['m1', 'm2']);
        assert.equal(ctx.response.message.content, 'recovered');
        assert.equal(ctx.metadata.cascadeAttempt, 2);
        assert.equal(ctx.metadata.cascadeTrace.length, 1);
        assert.equal(ctx.metadata.cascadeTrace[0].model, 'm1');
        assert.equal(ctx.metadata.cascadeTrace[0].cooldown, true);
        assert.equal(ctx.metadata.cascadeTrace[0].cascade, true);
    });

    it('triggers onCooldown when a candidate fails with a cooldown error', async () => {
        const cooldowns = [];
        const ctx = makeCtx();
        ctx.invokeModel = async (model) => {
            if (model.modelKey === 'm1') throw new ProviderQuotaError('p');
            return {
                response: { message: {}, usage: {} },
                metadata: {},
                target: { model },
            };
        };

        const cascade = cascadeMiddleware({
            model: makeCascadeModel(),
            resolveCandidates: (excluded) =>
                [makeCandidate('m1'), makeCandidate('m2')].filter(
                    ({ model }) => !excluded.has(model.modelKey)
                ),
            onCooldown: (key, err) =>
                cooldowns.push({ key, type: err.errorType }),
        });
        await compose([cascade])(ctx);

        assert.equal(cooldowns.length, 1);
        assert.equal(cooldowns[0].key, 'm1');
        assert.equal(cooldowns[0].type, 'provider_quota_exhausted');
    });

    it('does not cascade on a non-cascade error and re-throws', async () => {
        const ctx = makeCtx();
        ctx.invokeModel = async () => {
            const err = new ConfigurationError('bad config');
            // ConfigurationError has cascade=false (default)
            throw err;
        };

        const cascade = cascadeMiddleware({
            model: makeCascadeModel(),
            resolveCandidates: () => [makeCandidate('m1'), makeCandidate('m2')],
        });

        await assert.rejects(compose([cascade])(ctx), ConfigurationError);
    });

    it('throws TierExhaustedError when all candidates fail with cascade errors', async () => {
        const ctx = makeCtx();
        ctx.invokeModel = async () => {
            throw new ProviderRateLimitError('p');
        };

        const cascade = cascadeMiddleware({
            model: makeCascadeModel('exhausted'),
            resolveCandidates: (excluded) =>
                [makeCandidate('m1'), makeCandidate('m2')].filter(
                    ({ model }) => !excluded.has(model.modelKey)
                ),
        });

        await assert.rejects(
            compose([cascade])(ctx),
            (err) =>
                err instanceof TierExhaustedError &&
                /exhausted/.test(err.message)
        );
    });

    it('respects maxAttempts even if more candidates remain', async () => {
        const calls = [];
        const ctx = makeCtx();
        ctx.invokeModel = async (model) => {
            calls.push(model.modelKey);
            throw new ProviderRateLimitError('p');
        };

        const cascade = cascadeMiddleware({
            model: makeCascadeModel(),
            resolveCandidates: (excluded) => {
                const all = [
                    makeCandidate('m1'),
                    makeCandidate('m2'),
                    makeCandidate('m3'),
                    makeCandidate('m4'),
                ];
                return all.filter(({ model }) => !excluded.has(model.modelKey));
            },
            maxAttempts: 2,
        });

        await assert.rejects(compose([cascade])(ctx), TierExhaustedError);
        assert.deepEqual(calls, ['m1', 'm2']);
    });

    it('throws TierExhaustedError immediately when no candidates are returned', async () => {
        const ctx = makeCtx();
        ctx.invokeModel = async () => {
            throw new Error('should not be called');
        };

        const cascade = cascadeMiddleware({
            model: makeCascadeModel(),
            resolveCandidates: () => [],
        });
        await assert.rejects(compose([cascade])(ctx), TierExhaustedError);
    });
});
