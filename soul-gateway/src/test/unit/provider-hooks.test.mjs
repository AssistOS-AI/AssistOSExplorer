import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ProviderHookCatalog } from '../../runtime/hooks/provider-hook-catalog.mjs';
import { executeProviderPipeline, runResponseHooks } from '../../runtime/hooks/provider-hook-engine.mjs';

// ── Test helpers ────────────────────────────────────────────────────

function makeHook(key, phases, { scope = 'provider', defaultSettings = {} } = {}) {
  const hook = {
    meta: { key, name: key, scope, phases, defaultSettings },
  };

  if (phases.includes('request')) {
    hook.onRequest = async (ctx, settings) => {
      ctx._callOrder = ctx._callOrder || [];
      ctx._callOrder.push(`${key}:request`);
      ctx._settings = ctx._settings || {};
      ctx._settings[key] = settings;
    };
  }

  if (phases.includes('stream')) {
    hook.wrapStream = function (stream, ctx, settings) {
      ctx._callOrder = ctx._callOrder || [];
      ctx._callOrder.push(`${key}:stream`);
      return wrapAsyncGen(stream, key);
    };
  }

  if (phases.includes('response')) {
    hook.onResponse = async (ctx, settings) => {
      ctx._callOrder = ctx._callOrder || [];
      ctx._callOrder.push(`${key}:response`);
    };
  }

  return hook;
}

/**
 * Wraps an async generator to prepend a tag to each yielded chunk.
 */
async function* wrapAsyncGen(stream, tag) {
  for await (const chunk of stream) {
    yield { ...chunk, _wrappedBy: [...(chunk._wrappedBy || []), tag] };
  }
}

/**
 * Creates a minimal async generator that yields text_delta chunks.
 */
async function* makeStream(texts) {
  for (const text of texts) {
    yield { type: 'text_delta', data: { text } };
  }
  yield { type: 'done', data: { finish_reason: 'stop' } };
}

/**
 * Collect all chunks from an async generator into an array.
 */
async function collectChunks(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return chunks;
}

function hookEntry(hook, settings = {}, extras = {}) {
  return { hook, settings, ...extras };
}

// ── DAO export tests ────────────────────────────────────────────────

describe('provider-hook-assignments-dao exports', () => {
  it('exports create, listByProvider, listByProviderAndPhase, update, del, reorder', async () => {
    const dao = await import('../../db/dao/provider-hook-assignments-dao.mjs');
    for (const fn of ['create', 'listByProvider', 'listByProviderAndPhase', 'update', 'del', 'reorder']) {
      assert.equal(typeof dao[fn], 'function', `missing export: ${fn}`);
    }
  });
});

// ── ProviderHookCatalog tests ───────────────────────────────────────

describe('ProviderHookCatalog', () => {

  it('registerHook stores a hook module', () => {
    const catalog = new ProviderHookCatalog();
    const hook = makeHook('test-hook', ['request']);
    catalog.registerHook('test-hook', hook);

    assert.equal(catalog.hookCount, 1);
    assert.strictEqual(catalog.getHook('test-hook'), hook);
  });

  it('listHookKeys returns all registered keys', () => {
    const catalog = new ProviderHookCatalog();
    catalog.registerHook('a', makeHook('a', ['request']));
    catalog.registerHook('b', makeHook('b', ['response']));

    assert.deepEqual(catalog.listHookKeys().sort(), ['a', 'b']);
  });

  it('getHook returns null for unknown key', () => {
    const catalog = new ProviderHookCatalog();
    assert.equal(catalog.getHook('nonexistent'), null);
  });

  it('setAssignments and getProviderPipeline returns correct phases', () => {
    const catalog = new ProviderHookCatalog();
    const reqHook = makeHook('req-hook', ['request']);
    const resHook = makeHook('res-hook', ['response']);
    const streamHook = makeHook('stream-hook', ['stream']);

    catalog.registerHook('req-hook', reqHook);
    catalog.registerHook('res-hook', resHook);
    catalog.registerHook('stream-hook', streamHook);

    catalog.setAssignments('provider-1', {
      request: [{ hookKey: 'req-hook', sortOrder: 1, enabled: true, settings: {} }],
      stream: [{ hookKey: 'stream-hook', sortOrder: 1, enabled: true, settings: {} }],
      response: [{ hookKey: 'res-hook', sortOrder: 1, enabled: true, settings: {} }],
    });

    const pipeline = catalog.getProviderPipeline('provider-1');
    assert.ok(pipeline);
    assert.equal(pipeline.request.length, 1);
    assert.equal(pipeline.stream.length, 1);
    assert.equal(pipeline.response.length, 1);
    assert.strictEqual(pipeline.request[0].hook, reqHook);
    assert.strictEqual(pipeline.stream[0].hook, streamHook);
    assert.strictEqual(pipeline.response[0].hook, resHook);
  });

  it('getProviderPipeline returns null for unknown provider', () => {
    const catalog = new ProviderHookCatalog();
    assert.equal(catalog.getProviderPipeline('nonexistent'), null);
  });

  it('getProviderPipeline returns null when all assignments resolve to no hooks', () => {
    const catalog = new ProviderHookCatalog();
    // Assignment references a hook that is NOT registered
    catalog.setAssignments('provider-1', {
      request: [{ hookKey: 'missing-hook', sortOrder: 1, enabled: true, settings: {} }],
    });

    assert.equal(catalog.getProviderPipeline('provider-1'), null);
  });

  it('getProviderPipeline merges default settings with assignment settings', () => {
    const catalog = new ProviderHookCatalog();
    const hook = makeHook('ctx-comp', ['request'], {
      defaultSettings: { threshold: 100, mode: 'fast' },
    });
    catalog.registerHook('ctx-comp', hook);

    catalog.setAssignments('provider-1', {
      request: [{ hookKey: 'ctx-comp', sortOrder: 1, enabled: true, settings: { threshold: 50 } }],
    });

    const pipeline = catalog.getProviderPipeline('provider-1');
    assert.ok(pipeline);
    assert.deepEqual(pipeline.request[0].settings, { threshold: 50, mode: 'fast' });
  });

  it('preserves per-assignment settings when the same hook is reused across phases', () => {
    const catalog = new ProviderHookCatalog();
    const hook = makeHook('shared', ['request', 'response'], {
      defaultSettings: { mode: 'default', limit: 10 },
    });
    catalog.registerHook('shared', hook);

    catalog.setAssignments('provider-1', {
      request: [{ id: 'a1', hookKey: 'shared', sortOrder: 1, enabled: true, settings: { mode: 'request' } }],
      response: [{ id: 'a2', hookKey: 'shared', sortOrder: 1, enabled: true, settings: { mode: 'response', limit: 20 } }],
    });

    const pipeline = catalog.getProviderPipeline('provider-1');
    assert.ok(pipeline);
    assert.deepEqual(pipeline.request[0].settings, { mode: 'request', limit: 10 });
    assert.deepEqual(pipeline.response[0].settings, { mode: 'response', limit: 20 });
    assert.equal(pipeline.request[0].assignmentId, 'a1');
    assert.equal(pipeline.response[0].assignmentId, 'a2');
  });

  it('assignedProviderCount reflects provider count', () => {
    const catalog = new ProviderHookCatalog();
    const hook = makeHook('h', ['request']);
    catalog.registerHook('h', hook);

    assert.equal(catalog.assignedProviderCount, 0);

    catalog.setAssignments('p1', { request: [{ hookKey: 'h', sortOrder: 1, enabled: true, settings: {} }] });
    assert.equal(catalog.assignedProviderCount, 1);

    catalog.setAssignments('p2', { request: [{ hookKey: 'h', sortOrder: 1, enabled: true, settings: {} }] });
    assert.equal(catalog.assignedProviderCount, 2);
  });
});

// ── Provider Hook Engine tests ──────────────────────────────────────

describe('executeProviderPipeline', () => {

  it('request-only hook runs before executor', async () => {
    const hook = makeHook('req-only', ['request']);
    const ctx = {};
    let executorCalled = false;

    await executeProviderPipeline({
      requestHooks: [hookEntry(hook)],
      streamHooks: [],
      responseHooks: [],
      executor: async (c) => {
        executorCalled = true;
        assert.deepEqual(c._callOrder, ['req-only:request']);
        return { stream: makeStream(['hello']), accountId: null };
      },
      ctx,
    });

    assert.ok(executorCalled, 'executor must be called');
  });

  it('response-only hook runs after executor (reverse order)', async () => {
    const hookA = makeHook('res-A', ['response']);
    const hookB = makeHook('res-B', ['response']);
    const ctx = {};

    const handle = await executeProviderPipeline({
      requestHooks: [],
      streamHooks: [],
      responseHooks: [hookEntry(hookA), hookEntry(hookB)],
      executor: async () => ({ stream: makeStream(['x']), accountId: null }),
      ctx,
    });

    // Consume stream so it completes
    await collectChunks(handle.stream);

    // Run response hooks
    await runResponseHooks(handle, ctx);

    // Response hooks run in reverse: B first, then A
    assert.deepEqual(ctx._callOrder, ['res-B:response', 'res-A:response']);
  });

  it('request+response hook pair unwinds correctly', async () => {
    const hookA = makeHook('around-A', ['request', 'response']);
    const hookB = makeHook('around-B', ['request', 'response']);
    const ctx = {};

    const handle = await executeProviderPipeline({
      requestHooks: [hookEntry(hookA), hookEntry(hookB)],
      streamHooks: [],
      responseHooks: [hookEntry(hookA), hookEntry(hookB)],
      executor: async (c) => {
        c._callOrder.push('executor');
        return { stream: makeStream(['data']), accountId: null };
      },
      ctx,
    });

    await collectChunks(handle.stream);
    await runResponseHooks(handle, ctx);

    // Request: A, B -> executor -> Response: B, A
    assert.deepEqual(ctx._callOrder, [
      'around-A:request',
      'around-B:request',
      'executor',
      'around-B:response',
      'around-A:response',
    ]);
  });

  it('stream hook wraps the async generator', async () => {
    const streamHook = makeHook('s1', ['stream']);
    const ctx = {};

    const handle = await executeProviderPipeline({
      requestHooks: [],
      streamHooks: [hookEntry(streamHook)],
      responseHooks: [],
      executor: async () => ({ stream: makeStream(['hello', 'world']), accountId: null }),
      ctx,
    });

    const chunks = await collectChunks(handle.stream);
    // Text delta chunks should have _wrappedBy from the stream hook
    const textChunks = chunks.filter(c => c.type === 'text_delta');
    assert.equal(textChunks.length, 2);
    for (const chunk of textChunks) {
      assert.deepEqual(chunk._wrappedBy, ['s1']);
    }
  });

  it('multiple stream hooks compose (last wraps outermost)', async () => {
    const hookA = makeHook('sA', ['stream']);
    const hookB = makeHook('sB', ['stream']);
    const ctx = {};

    const handle = await executeProviderPipeline({
      requestHooks: [],
      streamHooks: [hookEntry(hookA), hookEntry(hookB)],
      responseHooks: [],
      executor: async () => ({ stream: makeStream(['chunk']), accountId: null }),
      ctx,
    });

    const chunks = await collectChunks(handle.stream);
    const textChunks = chunks.filter(c => c.type === 'text_delta');
    // hookA wraps first, then hookB wraps the result of hookA
    // So _wrappedBy should be [sA, sB] — sA added first, sB added second
    assert.deepEqual(textChunks[0]._wrappedBy, ['sA', 'sB']);
  });

  it('multiple hooks in same phase respect sort_order', async () => {
    const hookA = makeHook('first', ['request']);
    const hookB = makeHook('second', ['request']);
    const hookC = makeHook('third', ['request']);
    const ctx = {};

    await executeProviderPipeline({
      requestHooks: [hookEntry(hookA), hookEntry(hookB), hookEntry(hookC)],
      streamHooks: [],
      responseHooks: [],
      executor: async () => ({ stream: makeStream([]), accountId: null }),
      ctx,
    });

    assert.deepEqual(ctx._callOrder, [
      'first:request',
      'second:request',
      'third:request',
    ]);
  });

  it('empty pipeline (no hooks) passes through to executor directly', async () => {
    const ctx = {};
    let executorCalled = false;

    const handle = await executeProviderPipeline({
      requestHooks: [],
      streamHooks: [],
      responseHooks: [],
      executor: async () => {
        executorCalled = true;
        return { stream: makeStream(['passthrough']), accountId: 'acct-1' };
      },
      ctx,
    });

    assert.ok(executorCalled);
    assert.equal(handle.accountId, 'acct-1');

    const chunks = await collectChunks(handle.stream);
    const textChunks = chunks.filter(c => c.type === 'text_delta');
    assert.equal(textChunks.length, 1);
    // No _wrappedBy since no stream hooks
    assert.equal(textChunks[0]._wrappedBy, undefined);
  });

  it('hook error is caught and logged (non-fatal)', async () => {
    const warnings = [];
    const fakeLog = {
      warn: (msg, meta) => warnings.push({ msg, meta }),
    };

    const badHook = {
      meta: { key: 'bad-hook', name: 'Bad Hook', scope: 'provider', phases: ['request'] },
      onRequest: async () => { throw new Error('hook exploded'); },
    };

    const ctx = {};
    let executorCalled = false;

    await executeProviderPipeline({
      requestHooks: [hookEntry(badHook)],
      streamHooks: [],
      responseHooks: [],
      executor: async () => {
        executorCalled = true;
        return { stream: makeStream(['ok']), accountId: null };
      },
      ctx,
      log: fakeLog,
    });

    assert.ok(executorCalled, 'executor must still be called after hook error');
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].meta.hook, 'bad-hook');
    assert.match(warnings[0].meta.error, /hook exploded/);
  });

  it('response hook error is caught and non-fatal', async () => {
    const warnings = [];
    const fakeLog = {
      warn: (msg, meta) => warnings.push({ msg, meta }),
    };

    const badResHook = {
      meta: { key: 'bad-res', name: 'Bad Response Hook', scope: 'provider', phases: ['response'] },
      onResponse: async () => { throw new Error('response exploded'); },
    };

    const ctx = {};

    const handle = await executeProviderPipeline({
      requestHooks: [],
      streamHooks: [],
      responseHooks: [hookEntry(badResHook)],
      executor: async () => ({ stream: makeStream(['data']), accountId: null }),
      ctx,
    });

    await collectChunks(handle.stream);
    await runResponseHooks(handle, ctx, fakeLog);

    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].meta.hook, 'bad-res');
  });

  it('stream hook error is caught and non-fatal', async () => {
    const warnings = [];
    const fakeLog = {
      warn: (msg, meta) => warnings.push({ msg, meta }),
    };

    const badStreamHook = {
      meta: { key: 'bad-stream', name: 'Bad Stream', scope: 'provider', phases: ['stream'] },
      wrapStream: () => { throw new Error('stream wrap exploded'); },
    };

    const ctx = {};

    const handle = await executeProviderPipeline({
      requestHooks: [],
      streamHooks: [hookEntry(badStreamHook)],
      responseHooks: [],
      executor: async () => ({ stream: makeStream(['ok']), accountId: null }),
      ctx,
      log: fakeLog,
    });

    // Stream should still be usable (the original, since the wrapper threw)
    const chunks = await collectChunks(handle.stream);
    assert.ok(chunks.length > 0);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].meta.hook, 'bad-stream');
  });

  it('settings are passed to hooks correctly', async () => {
    const hook = makeHook('cfg-hook', ['request']);
    const ctx = {};

    await executeProviderPipeline({
      requestHooks: [hookEntry(hook, { maxTokens: 500, format: 'json' })],
      streamHooks: [],
      responseHooks: [],
      executor: async () => ({ stream: makeStream([]), accountId: null }),
      ctx,
    });

    assert.deepEqual(ctx._settings['cfg-hook'], { maxTokens: 500, format: 'json' });
  });

  it('full pipeline with request + stream + response hooks', async () => {
    const fullHook = makeHook('full', ['request', 'stream', 'response']);
    const ctx = {};

    const handle = await executeProviderPipeline({
      requestHooks: [hookEntry(fullHook)],
      streamHooks: [hookEntry(fullHook)],
      responseHooks: [hookEntry(fullHook)],
      executor: async (c) => {
        c._callOrder.push('executor');
        return { stream: makeStream(['test']), accountId: null };
      },
      ctx,
    });

    const chunks = await collectChunks(handle.stream);
    await runResponseHooks(handle, ctx);

    // Full lifecycle: request -> executor -> stream wrap -> response
    assert.ok(ctx._callOrder.includes('full:request'));
    assert.ok(ctx._callOrder.includes('executor'));
    assert.ok(ctx._callOrder.includes('full:stream'));
    assert.ok(ctx._callOrder.includes('full:response'));

    // Request must come before executor
    const reqIdx = ctx._callOrder.indexOf('full:request');
    const execIdx = ctx._callOrder.indexOf('executor');
    assert.ok(reqIdx < execIdx);

    // Stream chunks should have been wrapped
    const textChunks = chunks.filter(c => c.type === 'text_delta');
    assert.deepEqual(textChunks[0]._wrappedBy, ['full']);
  });

  it('executor return value is preserved in handle', async () => {
    const handle = await executeProviderPipeline({
      requestHooks: [],
      streamHooks: [],
      responseHooks: [],
      executor: async () => ({
        stream: makeStream([]),
        accountId: 'acct-42',
        customField: 'preserved',
      }),
      ctx: {},
    });

    assert.equal(handle.accountId, 'acct-42');
    assert.equal(handle.customField, 'preserved');
  });

  it('handle without stream skips stream hook wrapping', async () => {
    const streamHook = makeHook('skip-stream', ['stream']);
    const ctx = {};

    const handle = await executeProviderPipeline({
      requestHooks: [],
      streamHooks: [hookEntry(streamHook)],
      responseHooks: [],
      executor: async () => ({ stream: null, accountId: null }),
      ctx,
    });

    // stream is null, so stream hooks should not have been called
    assert.equal(handle.stream, null);
    assert.equal(ctx._callOrder, undefined);
  });
});

// ── runResponseHooks tests ──────────────────────────────────────────

describe('runResponseHooks', () => {

  it('does nothing when no _responseHooks on handle', async () => {
    const handle = {};
    const ctx = {};
    // Should not throw
    await runResponseHooks(handle, ctx);
    assert.equal(ctx._callOrder, undefined);
  });

  it('does nothing when _responseHooks is empty', async () => {
    const handle = { _responseHooks: [] };
    const ctx = {};
    await runResponseHooks(handle, ctx);
    assert.equal(ctx._callOrder, undefined);
  });

  it('runs hooks in reverse order', async () => {
    const hookA = makeHook('rA', ['response']);
    const hookB = makeHook('rB', ['response']);
    const hookC = makeHook('rC', ['response']);

    const handle = {
      _responseHooks: [hookEntry(hookA), hookEntry(hookB), hookEntry(hookC)],
    };
    const ctx = {};

    await runResponseHooks(handle, ctx);

    assert.deepEqual(ctx._callOrder, ['rC:response', 'rB:response', 'rA:response']);
  });
});
