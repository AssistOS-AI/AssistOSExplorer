import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { validateExecutorManifest } from '../../runtime/executors/executor-interface.mjs';
import { ExecutorCatalog } from '../../runtime/executors/executor-catalog.mjs';
import { adaptProviderToExecutor } from '../../runtime/executors/provider-executor-adapter.mjs';

// ── Executor manifest validation ────────────────────────────────────

describe('validateExecutorManifest', () => {
  const validManifest = {
    key: 'test-executor',
    name: 'Test Executor',
    executorType: 'external_api',
    supportsStreaming: true,
    supportsTools: true,
  };

  it('accepts a valid manifest', () => {
    assert.doesNotThrow(() => validateExecutorManifest(validManifest));
  });

  it('accepts all valid executorType values', () => {
    for (const t of ['external_api', 'search', 'local_model', 'wrapper', 'custom']) {
      assert.doesNotThrow(
        () => validateExecutorManifest({ ...validManifest, executorType: t }),
      );
    }
  });

  it('rejects null manifest', () => {
    assert.throws(() => validateExecutorManifest(null), /non-null object/);
  });

  it('rejects non-object manifest', () => {
    assert.throws(() => validateExecutorManifest('string'), /non-null object/);
  });

  it('rejects missing key', () => {
    assert.throws(
      () => validateExecutorManifest({ ...validManifest, key: '' }),
      /manifest\.key/,
    );
  });

  it('rejects non-string key', () => {
    assert.throws(
      () => validateExecutorManifest({ ...validManifest, key: 42 }),
      /manifest\.key/,
    );
  });

  it('rejects missing name', () => {
    assert.throws(
      () => validateExecutorManifest({ ...validManifest, name: '' }),
      /manifest\.name/,
    );
  });

  it('rejects invalid executorType', () => {
    assert.throws(
      () => validateExecutorManifest({ ...validManifest, executorType: 'invalid' }),
      /executorType/,
    );
  });

  it('rejects non-boolean supportsStreaming', () => {
    assert.throws(
      () => validateExecutorManifest({ ...validManifest, supportsStreaming: 'yes' }),
      /supportsStreaming/,
    );
  });

  it('rejects non-boolean supportsTools', () => {
    assert.throws(
      () => validateExecutorManifest({ ...validManifest, supportsTools: 1 }),
      /supportsTools/,
    );
  });
});

// ── adaptProviderToExecutor ─────────────────────────────────────────

describe('adaptProviderToExecutor', () => {
  function makeProviderPlugin(overrides = {}) {
    return {
      manifest: {
        key: 'test-api',
        kind: 'external_api',
        authStrategy: 'api_key',
        supportsStreaming: true,
        supportsTools: true,
        supportedFormats: ['openai_chat'],
        displayName: 'Test API Provider',
        ...overrides.manifest,
      },
      async init() {},
      async shutdown() {},
      validateProviderRecord() {},
      validateModelRecord() {},
      async execute(ctx) { return { accountId: null, stream: null, abort: async () => {} }; },
      classifyError(err) { return { httpStatus: 500, errorType: 'internal_error', retryable: false, cooldown: false, cascade: false, retryAfterSeconds: null }; },
      async discoverModels() { return [{ modelId: 'm1', displayName: 'Model 1' }]; },
      async testConnection() { return { ok: true, detail: 'connected' }; },
      ...overrides,
    };
  }

  it('maps kind to executorType', () => {
    const adapted = adaptProviderToExecutor(makeProviderPlugin());
    assert.equal(adapted.manifest.executorType, 'external_api');
  });

  it('maps kind=search to executorType=search', () => {
    const adapted = adaptProviderToExecutor(makeProviderPlugin({
      manifest: { kind: 'search', key: 'search-builtin', displayName: 'Search' },
    }));
    assert.equal(adapted.manifest.executorType, 'search');
  });

  it('uses displayName as name', () => {
    const adapted = adaptProviderToExecutor(makeProviderPlugin());
    assert.equal(adapted.manifest.name, 'Test API Provider');
  });

  it('falls back to key when displayName is absent', () => {
    const plugin = makeProviderPlugin();
    delete plugin.manifest.displayName;
    const adapted = adaptProviderToExecutor(plugin);
    assert.equal(adapted.manifest.name, 'test-api');
  });

  it('preserves execute function', async () => {
    let called = false;
    const plugin = makeProviderPlugin({
      async execute(ctx) { called = true; return { accountId: null, stream: null, abort: async () => {} }; },
    });
    const adapted = adaptProviderToExecutor(plugin);
    await adapted.execute({});
    assert.ok(called);
  });

  it('preserves classifyError function', () => {
    let called = false;
    const plugin = makeProviderPlugin({
      classifyError(err) { called = true; return { httpStatus: 400 }; },
    });
    const adapted = adaptProviderToExecutor(plugin);
    adapted.classifyError(new Error('test'));
    assert.ok(called);
  });

  it('preserves discoverModels when present', async () => {
    const adapted = adaptProviderToExecutor(makeProviderPlugin());
    assert.equal(typeof adapted.discoverModels, 'function');
    const models = await adapted.discoverModels();
    assert.equal(models.length, 1);
    assert.equal(models[0].modelId, 'm1');
  });

  it('omits discoverModels when not on provider', () => {
    const plugin = makeProviderPlugin();
    delete plugin.discoverModels;
    const adapted = adaptProviderToExecutor(plugin);
    assert.equal(adapted.discoverModels, undefined);
  });

  it('preserves testConnection when present', async () => {
    const adapted = adaptProviderToExecutor(makeProviderPlugin());
    assert.equal(typeof adapted.testConnection, 'function');
    const result = await adapted.testConnection();
    assert.equal(result.ok, true);
  });

  it('preserves init and shutdown when present', async () => {
    let initCalled = false;
    let shutdownCalled = false;
    const plugin = makeProviderPlugin({
      async init() { initCalled = true; },
      async shutdown() { shutdownCalled = true; },
    });
    const adapted = adaptProviderToExecutor(plugin);
    await adapted.init();
    await adapted.shutdown();
    assert.ok(initCalled);
    assert.ok(shutdownCalled);
  });

  it('produces a manifest that passes validation', () => {
    const adapted = adaptProviderToExecutor(makeProviderPlugin());
    assert.doesNotThrow(() => validateExecutorManifest(adapted.manifest));
  });
});

// ── ExecutorCatalog ─────────────────────────────────────────────────

describe('ExecutorCatalog', () => {
  function makeExecutor(key, overrides = {}) {
    return {
      manifest: {
        key,
        name: overrides.name || key,
        executorType: overrides.executorType || 'external_api',
        supportsStreaming: true,
        supportsTools: true,
      },
      async execute() {},
      classifyError() {},
      ...overrides,
    };
  }

  it('register and getExecutor', () => {
    const cat = new ExecutorCatalog();
    const exec = makeExecutor('openai-api');
    cat.register('openai-api', exec);
    assert.strictEqual(cat.getExecutor('openai-api'), exec);
  });

  it('listKeys returns registered keys', () => {
    const cat = new ExecutorCatalog();
    cat.register('openai-api', makeExecutor('openai-api'));
    cat.register('anthropic-api', makeExecutor('anthropic-api'));
    assert.deepEqual(cat.listKeys().sort(), ['anthropic-api', 'openai-api']);
  });

  it('size reflects count', () => {
    const cat = new ExecutorCatalog();
    assert.equal(cat.size, 0);
    cat.register('a', makeExecutor('a'));
    assert.equal(cat.size, 1);
    cat.register('b', makeExecutor('b'));
    assert.equal(cat.size, 2);
  });

  it('getExecutor returns null for unknown key', () => {
    const cat = new ExecutorCatalog();
    assert.equal(cat.getExecutor('nonexistent'), null);
  });

  it('getExecutor returns the registered executor by exact key', () => {
    // The catalog is keyed by the plugin's manifest.key (e.g.
    // `openai-api`), and every caller is required to look up by the
    // same key — there is no longer a legacy short-name fallback
    // (`nvidia`/`mistral`/`anthropic` → `openai-api`/`anthropic-api`).
    // The schema declares providers.adapter_key as NOT NULL and the
    // create endpoint always populates it with a real plugin key, so
    // a fallback table would only be a brittle abstraction with no
    // remaining production caller. See providers-route + the
    // execution engine — both pass the resolved adapter_key directly.
    const cat = new ExecutorCatalog();
    const openaiExec = makeExecutor('openai-api');
    cat.register('openai-api', openaiExec);

    assert.strictEqual(cat.getExecutor('openai-api'), openaiExec);
    // Legacy short names no longer resolve — callers must pass the
    // canonical plugin key.
    assert.equal(cat.getExecutor('nvidia'), null);
    assert.equal(cat.getExecutor('mistral'), null);
    assert.equal(cat.getExecutor('openrouter'), null);
  });

  it('rejects invalid manifest on register', () => {
    const cat = new ExecutorCatalog();
    assert.throws(
      () => cat.register('bad', { manifest: { key: '' } }),
      /manifest\.key/,
    );
  });
});

// ── Adapted executor executorType mapping ───────────────────────────

describe('Adapted executor executorType mapping', () => {
  function makeProviderPlugin(kind) {
    return {
      manifest: {
        key: `test-${kind}`,
        kind,
        authStrategy: 'api_key',
        supportsStreaming: kind !== 'search',
        supportsTools: kind !== 'search',
        supportedFormats: ['openai_chat'],
        displayName: `Test ${kind}`,
      },
      async init() {},
      async shutdown() {},
      async execute() {},
      classifyError() {},
    };
  }

  for (const kind of ['external_api', 'search', 'local_model', 'wrapper']) {
    it(`maps provider kind '${kind}' to executorType '${kind}'`, () => {
      const adapted = adaptProviderToExecutor(makeProviderPlugin(kind));
      assert.equal(adapted.manifest.executorType, kind);
    });
  }
});
