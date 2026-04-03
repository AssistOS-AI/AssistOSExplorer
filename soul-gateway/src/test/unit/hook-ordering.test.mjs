/**
 * Hook Ordering Integration Tests (Checkpoint 6)
 *
 * Proves the full runtime ordering is:
 *   1. gateway request hooks  (middleware pre-hooks)
 *   2. provider request hooks
 *   3. executor
 *   4. provider stream hooks
 *   5. provider response hooks
 *   6. gateway response hooks (middleware post-hooks)
 *
 * These tests wire both the middleware engine and the provider-hook engine
 * together through the same execution path used by the real pipeline,
 * without requiring a database or HTTP server.
 *
 * Limitation: the gateway middleware engine does not support wrapStream.
 * Gateway stream hooks are not part of the runtime ordering today.
 * See CAPABILITIES.md §17 / §18 for details.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { runMiddlewarePlan } from '../../runtime/middleware/middleware-engine.mjs';
import { executeProviderPipeline, runResponseHooks } from '../../runtime/hooks/provider-hook-engine.mjs';
import {
  createProviderHookContext,
  applyCollectedResultToHookContext,
  readCollectedResultFromHookContext,
} from '../../runtime/hooks/provider-hook-context.mjs';
import { collectNormalizedStream } from '../../runtime/execution/stream-collector.mjs';

// ── Shared helpers ─────────────────────────────────────────────────

const noopLog = { debug() {}, info() {}, warn() {}, error() {}, fatal() {} };

/** Ordered trace shared across all hooks in a single test. */
function createTrace() {
  const events = [];
  return {
    push(label) { events.push(label); },
    get events() { return [...events]; },
  };
}

/** Minimal async generator that yields text chunks then done. */
async function* makeStream(texts) {
  for (const text of texts) {
    yield { type: 'text_delta', data: { text } };
  }
  yield { type: 'usage', data: { input_tokens: 1, output_tokens: 1 } };
  yield { type: 'done', data: { finish_reason: 'stop' } };
}

/** Wraps an async generator, tagging each chunk. */
async function* wrapAsyncGen(stream, tag) {
  for await (const chunk of stream) {
    yield { ...chunk, _wrappedBy: [...(chunk._wrappedBy || []), tag] };
  }
}

// ── Gateway middleware helpers ──────────────────────────────────────

function makeGatewayHook(key, trace, { preOnly = false, postOnly = false } = {}) {
  const hooks = {};

  if (!postOnly) {
    hooks.pre = async (hookCtx) => {
      trace.push(`gw-request:${key}`);
    };
  }

  if (!preOnly) {
    hooks.post = async (hookCtx) => {
      trace.push(`gw-response:${key}`);
    };
  }

  return Object.freeze({
    middlewareKey: key,
    hookMode: preOnly ? 'pre' : postOnly ? 'post' : 'both',
    hooks,
    settings: {},
    sourceType: 'test',
  });
}

// ── Provider hook helpers ──────────────────────────────────────────

function makeProviderHook(key, phases, trace) {
  const hook = {
    meta: { key, name: key, scope: 'provider', phases },
  };

  if (phases.includes('request')) {
    hook.onRequest = async (ctx) => {
      trace.push(`prov-request:${key}`);
    };
  }

  if (phases.includes('stream')) {
    hook.wrapStream = (stream, ctx) => {
      trace.push(`prov-stream:${key}`);
      return wrapAsyncGen(stream, key);
    };
  }

  if (phases.includes('response')) {
    hook.onResponse = async (ctx) => {
      trace.push(`prov-response:${key}`);
    };
  }

  return hook;
}

function hookEntry(hook, settings = {}) {
  return { hook, settings, assignmentId: `assign-${hook.meta.key}`, phase: null, sortOrder: 0 };
}

// ── Dispatch builder ───────────────────────────────────────────────

/**
 * Builds a dispatch function that mirrors what pipeline.mjs does:
 * provider-hook pipeline -> collect stream -> run response hooks.
 *
 * The trace records the executor call inline so its position relative
 * to hook calls is captured.
 */
function buildProviderDispatch({ trace, providerRequestHooks, providerStreamHooks, providerResponseHooks }) {
  return async function dispatch() {
    const providerCtx = {
      requestId: 'test-req',
      request: { model: 'test/model', messages: [{ role: 'user', content: 'hi' }] },
      resolvedModel: { modelKey: 'test/model' },
      providerRecord: { providerKey: 'test-provider' },
      credentialLease: null,
      attempt: { index: 0 },
      signal: new AbortController().signal,
      logger: noopLog,
      services: Object.freeze({}),
    };
    const hookCtx = createProviderHookContext(providerCtx);

    const handle = await executeProviderPipeline({
      requestHooks: providerRequestHooks,
      streamHooks: providerStreamHooks,
      responseHooks: providerResponseHooks,
      executor: async (ctx) => {
        trace.push('executor');
        return { stream: makeStream(['hello', 'world']), accountId: null };
      },
      ctx: hookCtx,
      log: noopLog,
    });

    const collected = await collectNormalizedStream(handle.stream, { maxExcerptChars: 200 });

    applyCollectedResultToHookContext(hookCtx, collected);
    await runResponseHooks(handle, hookCtx, noopLog);
    const finalCollected = readCollectedResultFromHookContext(hookCtx, collected);

    return {
      response: {
        id: 'test-req',
        model: 'test/model',
        choices: [{ index: 0, message: { role: 'assistant', content: finalCollected.content }, finish_reason: 'stop' }],
        usage: finalCollected.usage,
      },
      usage: finalCollected.usage,
    };
  };
}

// ── Integration context for middleware engine ───────────────────────

function buildReqCtx() {
  return {
    request: { model: 'test/model', messages: [{ role: 'user', content: 'hi' }] },
    normalizedRequest: { model: 'test/model', messages: [{ role: 'user', content: 'hi' }] },
    log: noopLog,
    appCtx: { config: { env: {} }, log: noopLog, services: {}, pool: null },
    apiKey: { id: 'test-key', label: 'test', rpm_limit: 60, tpm_limit: 100000 },
    middlewareState: new Map(),
    metadata: {},
  };
}

// ── Tests ──────────────────────────────────────────────────────────

describe('hook ordering: gateway + provider pipeline integration', () => {

  it('basic ordering: gw-request -> prov-request -> executor -> prov-response -> gw-response', async () => {
    const trace = createTrace();

    const provReqHook = makeProviderHook('alpha', ['request'], trace);
    const provResHook = makeProviderHook('beta', ['response'], trace);

    const gwPlan = [
      makeGatewayHook('rate-limiter', trace),
      makeGatewayHook('budget', trace),
    ];

    const dispatch = buildProviderDispatch({
      trace,
      providerRequestHooks: [hookEntry(provReqHook)],
      providerStreamHooks: [],
      providerResponseHooks: [hookEntry(provResHook)],
    });

    const result = await runMiddlewarePlan({
      reqCtx: buildReqCtx(),
      plan: gwPlan,
      dispatch,
    });

    assert.deepEqual(trace.events, [
      'gw-request:rate-limiter',
      'gw-request:budget',
      'prov-request:alpha',
      'executor',
      'prov-response:beta',
      'gw-response:rate-limiter',
      'gw-response:budget',
    ]);

    assert.equal(result.synthetic, false);
    assert.ok(result.result);
  });

  it('full ordering with stream hooks: gw-request -> prov-request -> executor -> prov-stream -> prov-response -> gw-response', async () => {
    const trace = createTrace();

    const provReqHook = makeProviderHook('req-hook', ['request'], trace);
    const provStreamHook = makeProviderHook('stream-hook', ['stream'], trace);
    const provResHook = makeProviderHook('res-hook', ['response'], trace);

    const gwPlan = [
      makeGatewayHook('gw-pre', trace),
    ];

    const dispatch = buildProviderDispatch({
      trace,
      providerRequestHooks: [hookEntry(provReqHook)],
      providerStreamHooks: [hookEntry(provStreamHook)],
      providerResponseHooks: [hookEntry(provResHook)],
    });

    await runMiddlewarePlan({
      reqCtx: buildReqCtx(),
      plan: gwPlan,
      dispatch,
    });

    assert.deepEqual(trace.events, [
      'gw-request:gw-pre',
      'prov-request:req-hook',
      'executor',
      'prov-stream:stream-hook',
      'prov-response:res-hook',
      'gw-response:gw-pre',
    ]);
  });

  it('multiple hooks per phase preserve ordering within each layer', async () => {
    const trace = createTrace();

    const provReq1 = makeProviderHook('prov-req-1', ['request'], trace);
    const provReq2 = makeProviderHook('prov-req-2', ['request'], trace);
    const provRes1 = makeProviderHook('prov-res-1', ['response'], trace);
    const provRes2 = makeProviderHook('prov-res-2', ['response'], trace);

    const gwPlan = [
      makeGatewayHook('gw-a', trace),
      makeGatewayHook('gw-b', trace),
    ];

    const dispatch = buildProviderDispatch({
      trace,
      providerRequestHooks: [hookEntry(provReq1), hookEntry(provReq2)],
      providerStreamHooks: [],
      providerResponseHooks: [hookEntry(provRes1), hookEntry(provRes2)],
    });

    await runMiddlewarePlan({
      reqCtx: buildReqCtx(),
      plan: gwPlan,
      dispatch,
    });

    assert.deepEqual(trace.events, [
      // gateway request hooks in plan order
      'gw-request:gw-a',
      'gw-request:gw-b',
      // provider request hooks in ascending order
      'prov-request:prov-req-1',
      'prov-request:prov-req-2',
      // executor
      'executor',
      // provider response hooks in reverse order
      'prov-response:prov-res-2',
      'prov-response:prov-res-1',
      // gateway response hooks in plan order
      'gw-response:gw-a',
      'gw-response:gw-b',
    ]);
  });

  it('no provider hooks: gw-request -> executor -> gw-response', async () => {
    const trace = createTrace();

    const gwPlan = [
      makeGatewayHook('policy', trace),
    ];

    const dispatch = buildProviderDispatch({
      trace,
      providerRequestHooks: [],
      providerStreamHooks: [],
      providerResponseHooks: [],
    });

    await runMiddlewarePlan({
      reqCtx: buildReqCtx(),
      plan: gwPlan,
      dispatch,
    });

    assert.deepEqual(trace.events, [
      'gw-request:policy',
      'executor',
      'gw-response:policy',
    ]);
  });

  it('no gateway hooks: prov-request -> executor -> prov-response', async () => {
    const trace = createTrace();

    const provReq = makeProviderHook('p-req', ['request'], trace);
    const provRes = makeProviderHook('p-res', ['response'], trace);

    // Empty gateway plan — dispatch is called directly by the middleware engine
    const dispatch = buildProviderDispatch({
      trace,
      providerRequestHooks: [hookEntry(provReq)],
      providerStreamHooks: [],
      providerResponseHooks: [hookEntry(provRes)],
    });

    const result = await runMiddlewarePlan({
      reqCtx: buildReqCtx(),
      plan: [],
      dispatch,
    });

    assert.deepEqual(trace.events, [
      'prov-request:p-req',
      'executor',
      'prov-response:p-res',
    ]);
  });

  it('pre-only and post-only gateway hooks still interleave correctly', async () => {
    const trace = createTrace();

    const provReq = makeProviderHook('prov', ['request'], trace);

    const gwPlan = [
      makeGatewayHook('pre-only', trace, { preOnly: true }),
      makeGatewayHook('post-only', trace, { postOnly: true }),
      makeGatewayHook('both', trace),
    ];

    const dispatch = buildProviderDispatch({
      trace,
      providerRequestHooks: [hookEntry(provReq)],
      providerStreamHooks: [],
      providerResponseHooks: [],
    });

    await runMiddlewarePlan({
      reqCtx: buildReqCtx(),
      plan: gwPlan,
      dispatch,
    });

    assert.deepEqual(trace.events, [
      'gw-request:pre-only',
      // post-only has no pre hook, skipped
      'gw-request:both',
      'prov-request:prov',
      'executor',
      // pre-only has no post hook, skipped
      'gw-response:post-only',
      'gw-response:both',
    ]);
  });

  it('around-style provider hooks nest correctly with gateway hooks', async () => {
    const trace = createTrace();

    // Provider hooks that implement both request and response
    const aroundA = makeProviderHook('around-a', ['request', 'response'], trace);
    const aroundB = makeProviderHook('around-b', ['request', 'response'], trace);

    const gwPlan = [
      makeGatewayHook('gw', trace),
    ];

    const dispatch = buildProviderDispatch({
      trace,
      providerRequestHooks: [hookEntry(aroundA), hookEntry(aroundB)],
      providerStreamHooks: [],
      providerResponseHooks: [hookEntry(aroundA), hookEntry(aroundB)],
    });

    await runMiddlewarePlan({
      reqCtx: buildReqCtx(),
      plan: gwPlan,
      dispatch,
    });

    // Gateway wraps the entire provider pipeline.
    // Provider response hooks unwind in reverse.
    assert.deepEqual(trace.events, [
      'gw-request:gw',
      'prov-request:around-a',
      'prov-request:around-b',
      'executor',
      'prov-response:around-b',
      'prov-response:around-a',
      'gw-response:gw',
    ]);
  });

  it('multiple stream hooks compose within the correct ordering window', async () => {
    const trace = createTrace();

    const provReq = makeProviderHook('req', ['request'], trace);
    const streamA = makeProviderHook('stream-a', ['stream'], trace);
    const streamB = makeProviderHook('stream-b', ['stream'], trace);
    const provRes = makeProviderHook('res', ['response'], trace);

    const gwPlan = [
      makeGatewayHook('gw', trace),
    ];

    const dispatch = buildProviderDispatch({
      trace,
      providerRequestHooks: [hookEntry(provReq)],
      providerStreamHooks: [hookEntry(streamA), hookEntry(streamB)],
      providerResponseHooks: [hookEntry(provRes)],
    });

    await runMiddlewarePlan({
      reqCtx: buildReqCtx(),
      plan: gwPlan,
      dispatch,
    });

    assert.deepEqual(trace.events, [
      'gw-request:gw',
      'prov-request:req',
      'executor',
      'prov-stream:stream-a',
      'prov-stream:stream-b',
      'prov-response:res',
      'gw-response:gw',
    ]);
  });
});
