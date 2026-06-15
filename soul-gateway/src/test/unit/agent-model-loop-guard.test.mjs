/**
 * Agent self-recursion loop-guard tests.
 *
 * Task 12 ("Add Agent Model Loop Guard"): a discovered Ploinky agent that
 * calls the Soul Gateway model representing *itself* would self-recurse. The
 * guard blocks that single-hop case before dispatch.
 *
 * Contract:
 *   - Caller subject id is read from the REAL auth shape the pipeline builds:
 *     `ctx.auth.apiKeyRecord.subjectId` (see authenticate.mjs / api-key-auth.mjs).
 *   - Target subject id + discovery marker are read from the resolved-model
 *     wrapper: `ctx.metadata.resolvedModel.model.metadata`.
 *   - It throws ONLY when caller == target AND the target is a discovered agent
 *     model (`metadata.discoverySource === 'ploinky-agent-discovery'`).
 *   - The error is a 400 with `errorType === 'invalid_request_error'`.
 *   - It is otherwise transparent (calls next), including for missing auth,
 *     missing resolved model, missing metadata, and string-encoded metadata.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { agentModelLoopGuardMiddleware } from '../../runtime/route/agent-model-loop-guard.mjs';
import { GatewayError } from '../../core/errors.mjs';

const DISCOVERY_MARKER = 'ploinky-agent-discovery';

// ── helpers ─────────────────────────────────────────────────────────────

/**
 * Build the real kernel-ctx subset the guard reads:
 *   - ctx.auth.apiKeyRecord.subjectId (caller identity)
 *   - ctx.metadata.resolvedModel.model.metadata (target marker)
 */
function makeCtx({ callerSubjectId, modelMetadata, resolvedModel } = {}) {
    const ctx = {
        auth:
            callerSubjectId === undefined
                ? null
                : { apiKeyRecord: { subjectId: callerSubjectId } },
        metadata: {},
    };
    if (resolvedModel !== undefined) {
        ctx.metadata.resolvedModel = resolvedModel;
    } else if (modelMetadata !== undefined) {
        ctx.metadata.resolvedModel = { model: { metadata: modelMetadata } };
    }
    return ctx;
}

/** A `next` spy that records whether it was awaited. */
function makeNext() {
    const state = { called: 0 };
    const next = async () => {
        state.called += 1;
    };
    return { next, state };
}

async function run(ctx) {
    const { next, state } = makeNext();
    await agentModelLoopGuardMiddleware()(ctx, next);
    return state;
}

// ── rejection: agent calling its own discovered model ───────────────────

describe('agentModelLoopGuardMiddleware rejects self-recursion', () => {
    it('throws a 400 invalid_request_error when caller == target discovered agent', async () => {
        const ctx = makeCtx({
            callerSubjectId: 'agent:repo/a',
            modelMetadata: {
                subjectId: 'agent:repo/a',
                discoverySource: DISCOVERY_MARKER,
            },
        });

        const { next, state } = makeNext();
        await assert.rejects(
            agentModelLoopGuardMiddleware()(ctx, next),
            (err) => {
                assert.ok(
                    err instanceof GatewayError,
                    'expected a GatewayError'
                );
                assert.equal(err.httpStatus, 400);
                assert.equal(err.errorType, 'invalid_request_error');
                assert.match(err.message, /own discovered Soul Gateway model/);
                return true;
            }
        );
        // The guard short-circuits — dispatch (next) must NOT run.
        assert.equal(state.called, 0);
    });
});

// ── allowed cases ───────────────────────────────────────────────────────

describe('agentModelLoopGuardMiddleware allows non-recursive calls', () => {
    it('allows agent:repo/a calling a different discovered agent (agent:repo/b)', async () => {
        const ctx = makeCtx({
            callerSubjectId: 'agent:repo/a',
            modelMetadata: {
                subjectId: 'agent:repo/b',
                discoverySource: DISCOVERY_MARKER,
            },
        });
        const state = await run(ctx);
        assert.equal(state.called, 1);
    });

    it('allows a user subject calling any discovered agent model', async () => {
        const ctx = makeCtx({
            callerSubjectId: 'user:123',
            modelMetadata: {
                subjectId: 'agent:repo/a',
                discoverySource: DISCOVERY_MARKER,
            },
        });
        const state = await run(ctx);
        assert.equal(state.called, 1);
    });

    it('allows a non-discovered external model even when subject ids match', async () => {
        // No discoverySource marker → not an agent model the guard owns.
        const ctx = makeCtx({
            callerSubjectId: 'agent:repo/a',
            modelMetadata: { subjectId: 'agent:repo/a' },
        });
        const state = await run(ctx);
        assert.equal(state.called, 1);
    });

    it('allows a model whose discoverySource is some other value', async () => {
        const ctx = makeCtx({
            callerSubjectId: 'agent:repo/a',
            modelMetadata: {
                subjectId: 'agent:repo/a',
                discoverySource: 'synced',
            },
        });
        const state = await run(ctx);
        assert.equal(state.called, 1);
    });
});

// ── defensive / absent-data cases ───────────────────────────────────────

describe('agentModelLoopGuardMiddleware is transparent when data is absent', () => {
    it('does not throw when ctx.auth is absent', async () => {
        const ctx = makeCtx({
            modelMetadata: {
                subjectId: 'agent:repo/a',
                discoverySource: DISCOVERY_MARKER,
            },
        });
        // callerSubjectId left undefined → ctx.auth === null
        assert.equal(ctx.auth, null);
        const state = await run(ctx);
        assert.equal(state.called, 1);
    });

    it('does not throw when resolvedModel is absent', async () => {
        const ctx = makeCtx({ callerSubjectId: 'agent:repo/a' });
        assert.equal(ctx.metadata.resolvedModel, undefined);
        const state = await run(ctx);
        assert.equal(state.called, 1);
    });

    it('does not throw when resolvedModel.model is null (no-snapshot path)', async () => {
        const ctx = makeCtx({
            callerSubjectId: 'agent:repo/a',
            resolvedModel: { model: null, kind: 'unknown' },
        });
        const state = await run(ctx);
        assert.equal(state.called, 1);
    });

    it('does not throw when model.metadata is absent', async () => {
        const ctx = makeCtx({
            callerSubjectId: 'agent:repo/a',
            resolvedModel: { model: { id: 'm1' } },
        });
        const state = await run(ctx);
        assert.equal(state.called, 1);
    });

    it('parses a JSON-string metadata and still fires on self-recursion', async () => {
        const ctx = makeCtx({
            callerSubjectId: 'agent:repo/a',
            modelMetadata: JSON.stringify({
                subjectId: 'agent:repo/a',
                discoverySource: DISCOVERY_MARKER,
            }),
        });
        const { next, state } = makeNext();
        await assert.rejects(
            agentModelLoopGuardMiddleware()(ctx, next),
            GatewayError
        );
        assert.equal(state.called, 0);
    });

    it('parses a JSON-string metadata and allows when subjects differ', async () => {
        const ctx = makeCtx({
            callerSubjectId: 'agent:repo/a',
            modelMetadata: JSON.stringify({
                subjectId: 'agent:repo/b',
                discoverySource: DISCOVERY_MARKER,
            }),
        });
        const state = await run(ctx);
        assert.equal(state.called, 1);
    });

    it('does not throw on a malformed metadata string (treated as empty)', async () => {
        const ctx = makeCtx({
            callerSubjectId: 'agent:repo/a',
            modelMetadata: 'not-json{',
        });
        const state = await run(ctx);
        assert.equal(state.called, 1);
    });
});
