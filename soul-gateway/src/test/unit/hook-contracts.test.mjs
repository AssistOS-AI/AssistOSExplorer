import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { adaptMiddlewareToHook, adaptHookToMiddleware } from '../../runtime/hooks/hook-adapter.mjs';
import { validateHookModule } from '../../runtime/hooks/hook-interface.mjs';

// ── Test middleware stubs ────────────────────────────────────────────

function makePreOnlyMiddleware() {
  return {
    meta: {
      key: 'pre-only',
      name: 'Pre Only',
      description: 'Runs before dispatch only.',
      version: '1.0.0',
      defaultSettings: { threshold: 10 },
      hooks: 'pre',
    },
    pre: async (ctx, settings) => {
      ctx._preRan = true;
      ctx._settings = settings;
    },
  };
}

function makePostOnlyMiddleware() {
  return {
    meta: {
      key: 'post-only',
      name: 'Post Only',
      description: 'Runs after dispatch only.',
      version: '2.0.0',
      defaultSettings: { format: 'json' },
      hooks: 'post',
    },
    post: async (ctx, settings) => {
      ctx._postRan = true;
      ctx._settings = settings;
    },
  };
}

function makePrePostMiddleware() {
  return {
    meta: {
      key: 'pre-post',
      name: 'Pre and Post',
      description: 'Wraps the full dispatch cycle.',
      version: '3.0.0',
      defaultSettings: { verbose: true },
      hooks: 'both',
    },
    pre: async (ctx, settings) => {
      ctx._preRan = true;
    },
    post: async (ctx, settings) => {
      ctx._postRan = true;
    },
  };
}

// ── Hook stubs ──────────────────────────────────────────────────────

function makeRequestOnlyHook() {
  return {
    meta: {
      key: 'req-hook',
      name: 'Request Hook',
      scope: 'gateway',
      phases: ['request'],
      defaultSettings: {},
    },
    onRequest: async (ctx, settings) => {
      ctx._hookRequestRan = true;
    },
  };
}

function makeRequestResponseHook() {
  return {
    meta: {
      key: 'req-res-hook',
      name: 'Request Response Hook',
      scope: 'provider',
      phases: ['request', 'response'],
      defaultSettings: { depth: 3 },
    },
    onRequest: async (ctx, settings) => {
      ctx._hookRequestRan = true;
    },
    onResponse: async (ctx, settings) => {
      ctx._hookResponseRan = true;
    },
  };
}

function makeStreamHook() {
  return {
    meta: {
      key: 'stream-hook',
      name: 'Stream Hook',
      scope: 'provider',
      phases: ['stream'],
      defaultSettings: {},
    },
    async *wrapStream(stream, ctx, settings) {
      for await (const chunk of stream) {
        yield chunk;
      }
    },
  };
}

function makeFullHook() {
  return {
    meta: {
      key: 'full-hook',
      name: 'Full Hook',
      scope: 'gateway',
      phases: ['request', 'stream', 'response'],
      defaultSettings: {},
    },
    onRequest: async () => {},
    async *wrapStream(stream) { yield* stream; },
    onResponse: async () => {},
  };
}

// ── adaptMiddlewareToHook ───────────────────────────────────────────

describe('adaptMiddlewareToHook', () => {

  it('adapts a pre-only middleware', () => {
    const mw = makePreOnlyMiddleware();
    const hook = adaptMiddlewareToHook(mw);

    assert.equal(hook.meta.key, 'pre-only');
    assert.equal(hook.meta.name, 'Pre Only');
    assert.equal(hook.meta.scope, 'gateway');
    assert.deepEqual(hook.meta.phases, ['request']);
    assert.deepEqual(hook.meta.defaultSettings, { threshold: 10 });
    assert.equal(typeof hook.onRequest, 'function');
    assert.equal(hook.onResponse, undefined);
    assert.equal(hook.wrapStream, null);
  });

  it('adapts a post-only middleware', () => {
    const mw = makePostOnlyMiddleware();
    const hook = adaptMiddlewareToHook(mw);

    assert.equal(hook.meta.key, 'post-only');
    assert.equal(hook.meta.scope, 'gateway');
    assert.deepEqual(hook.meta.phases, ['response']);
    assert.equal(hook.onRequest, undefined);
    assert.equal(typeof hook.onResponse, 'function');
    assert.equal(hook.wrapStream, null);
  });

  it('adapts a pre+post middleware', () => {
    const mw = makePrePostMiddleware();
    const hook = adaptMiddlewareToHook(mw);

    assert.equal(hook.meta.key, 'pre-post');
    assert.equal(hook.meta.scope, 'gateway');
    assert.deepEqual(hook.meta.phases, ['request', 'response']);
    assert.equal(typeof hook.onRequest, 'function');
    assert.equal(typeof hook.onResponse, 'function');
    assert.equal(hook.wrapStream, null);
  });

  it('preserves function identity (onRequest === pre)', () => {
    const mw = makePreOnlyMiddleware();
    const hook = adaptMiddlewareToHook(mw);
    assert.equal(hook.onRequest, mw.pre);
  });

  it('preserves function identity (onResponse === post)', () => {
    const mw = makePostOnlyMiddleware();
    const hook = adaptMiddlewareToHook(mw);
    assert.equal(hook.onResponse, mw.post);
  });

  it('produces a valid HookModule', () => {
    const mw = makePrePostMiddleware();
    const hook = adaptMiddlewareToHook(mw);
    const result = validateHookModule(hook);
    assert.equal(result.valid, true, `Validation errors: ${result.errors.join(', ')}`);
  });

  it('throws when module has no meta', () => {
    assert.throws(() => adaptMiddlewareToHook({}), /must export meta/);
    assert.throws(() => adaptMiddlewareToHook(null), /must export meta/);
  });
});

// ── adaptHookToMiddleware ───────────────────────────────────────────

describe('adaptHookToMiddleware', () => {

  it('adapts a request-only hook', () => {
    const hook = makeRequestOnlyHook();
    const mw = adaptHookToMiddleware(hook);

    assert.equal(mw.meta.key, 'req-hook');
    assert.equal(mw.meta.hooks, 'pre');
    assert.equal(typeof mw.pre, 'function');
    assert.equal(mw.post, undefined);
  });

  it('adapts a request+response hook', () => {
    const hook = makeRequestResponseHook();
    const mw = adaptHookToMiddleware(hook);

    assert.equal(mw.meta.key, 'req-res-hook');
    assert.equal(mw.meta.hooks, 'both');
    assert.equal(typeof mw.pre, 'function');
    assert.equal(typeof mw.post, 'function');
  });

  it('adapts a stream-only hook (no pre/post)', () => {
    const hook = makeStreamHook();
    const mw = adaptHookToMiddleware(hook);

    // Stream-only hooks have no direct pre/post mapping.
    assert.equal(mw.meta.key, 'stream-hook');
    assert.equal(mw.pre, undefined);
    assert.equal(mw.post, undefined);
  });

  it('preserves function identity (pre === onRequest)', () => {
    const hook = makeRequestOnlyHook();
    const mw = adaptHookToMiddleware(hook);
    assert.equal(mw.pre, hook.onRequest);
  });

  it('throws when hook has no meta', () => {
    assert.throws(() => adaptHookToMiddleware({}), /must export meta/);
    assert.throws(() => adaptHookToMiddleware(null), /must export meta/);
  });
});

// ── Round-trip preservation ─────────────────────────────────────────

describe('round-trip: hook -> middleware -> hook', () => {

  it('preserves onRequest behavior through round-trip', async () => {
    const original = makeRequestOnlyHook();
    const mw = adaptHookToMiddleware(original);
    const roundTripped = adaptMiddlewareToHook(mw);

    assert.equal(roundTripped.meta.key, original.meta.key);
    assert.equal(roundTripped.meta.scope, 'gateway'); // adapter always sets gateway
    assert.deepEqual(roundTripped.meta.phases, ['request']);

    // Verify the function still works.
    const ctx = {};
    await roundTripped.onRequest(ctx, {});
    assert.equal(ctx._hookRequestRan, true);
  });

  it('preserves onRequest+onResponse behavior through round-trip', async () => {
    const original = makeRequestResponseHook();
    const mw = adaptHookToMiddleware(original);
    const roundTripped = adaptMiddlewareToHook(mw);

    assert.equal(roundTripped.meta.key, original.meta.key);
    assert.deepEqual(roundTripped.meta.phases, ['request', 'response']);

    const ctx = {};
    await roundTripped.onRequest(ctx, {});
    await roundTripped.onResponse(ctx, {});
    assert.equal(ctx._hookRequestRan, true);
    assert.equal(ctx._hookResponseRan, true);
  });
});

// ── Round-trip: middleware -> hook -> middleware ─────────────────────

describe('round-trip: middleware -> hook -> middleware', () => {

  it('preserves pre behavior through round-trip', async () => {
    const original = makePreOnlyMiddleware();
    const hook = adaptMiddlewareToHook(original);
    const roundTripped = adaptHookToMiddleware(hook);

    assert.equal(roundTripped.meta.key, original.meta.key);
    assert.equal(roundTripped.meta.hooks, 'pre');

    const ctx = {};
    await roundTripped.pre(ctx, { threshold: 5 });
    assert.equal(ctx._preRan, true);
    assert.deepEqual(ctx._settings, { threshold: 5 });
  });

  it('preserves pre+post behavior through round-trip', async () => {
    const original = makePrePostMiddleware();
    const hook = adaptMiddlewareToHook(original);
    const roundTripped = adaptHookToMiddleware(hook);

    assert.equal(roundTripped.meta.hooks, 'both');

    const ctx = {};
    await roundTripped.pre(ctx, {});
    await roundTripped.post(ctx, {});
    assert.equal(ctx._preRan, true);
    assert.equal(ctx._postRan, true);
  });
});

// ── Phase computation ───────────────────────────────────────────────

describe('phase computation', () => {

  it('onRequest only -> phases = [request]', () => {
    const hook = makeRequestOnlyHook();
    const result = validateHookModule(hook);
    assert.equal(result.valid, true);
    assert.deepEqual(hook.meta.phases, ['request']);
  });

  it('onRequest + onResponse -> phases = [request, response]', () => {
    const hook = makeRequestResponseHook();
    const result = validateHookModule(hook);
    assert.equal(result.valid, true);
    assert.deepEqual(hook.meta.phases, ['request', 'response']);
  });

  it('wrapStream only -> phases includes stream', () => {
    const hook = makeStreamHook();
    const result = validateHookModule(hook);
    assert.equal(result.valid, true);
    assert.ok(hook.meta.phases.includes('stream'));
  });

  it('full hook -> phases = [request, stream, response]', () => {
    const hook = makeFullHook();
    const result = validateHookModule(hook);
    assert.equal(result.valid, true);
    assert.deepEqual(hook.meta.phases, ['request', 'stream', 'response']);
  });

  it('adaptMiddlewareToHook computes phases from pre/post presence', () => {
    // pre only
    const preHook = adaptMiddlewareToHook(makePreOnlyMiddleware());
    assert.deepEqual(preHook.meta.phases, ['request']);

    // post only
    const postHook = adaptMiddlewareToHook(makePostOnlyMiddleware());
    assert.deepEqual(postHook.meta.phases, ['response']);

    // both
    const bothHook = adaptMiddlewareToHook(makePrePostMiddleware());
    assert.deepEqual(bothHook.meta.phases, ['request', 'response']);
  });
});

// ── validateHookModule ──────────────────────────────────────────────

describe('validateHookModule', () => {

  it('accepts a valid hook with onRequest', () => {
    const result = validateHookModule(makeRequestOnlyHook());
    assert.equal(result.valid, true);
    assert.equal(result.errors.length, 0);
  });

  it('accepts a valid hook with wrapStream', () => {
    const result = validateHookModule(makeStreamHook());
    assert.equal(result.valid, true);
  });

  it('accepts a valid full hook', () => {
    const result = validateHookModule(makeFullHook());
    assert.equal(result.valid, true);
  });

  it('rejects null', () => {
    const result = validateHookModule(null);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('non-null object')));
  });

  it('rejects missing meta', () => {
    const result = validateHookModule({ onRequest: async () => {} });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('meta')));
  });

  it('rejects missing meta.key', () => {
    const result = validateHookModule({
      meta: { name: 'X', scope: 'gateway', phases: ['request'] },
      onRequest: async () => {},
    });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('meta.key')));
  });

  it('rejects invalid scope', () => {
    const result = validateHookModule({
      meta: { key: 'x', name: 'X', scope: 'invalid', phases: ['request'] },
      onRequest: async () => {},
    });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('scope')));
  });

  it('rejects empty phases', () => {
    const result = validateHookModule({
      meta: { key: 'x', name: 'X', scope: 'gateway', phases: [] },
      onRequest: async () => {},
    });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('phases')));
  });

  it('rejects invalid phase values', () => {
    const result = validateHookModule({
      meta: { key: 'x', name: 'X', scope: 'gateway', phases: ['pre'] },
      onRequest: async () => {},
    });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes("invalid phase 'pre'")));
  });

  it('rejects hook with no phase functions', () => {
    const result = validateHookModule({
      meta: { key: 'x', name: 'X', scope: 'gateway', phases: ['request'] },
    });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('at least one')));
  });
});
