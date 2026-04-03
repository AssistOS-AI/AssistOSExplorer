import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ConcurrencyController } from '../../runtime/execution/concurrency-controller.mjs';
import { executeWithHttpRetry } from '../../runtime/execution/http-retry.mjs';
import { collectNormalizedStream } from '../../runtime/execution/stream-collector.mjs';
import { executeResolvedRequest } from '../../runtime/execution/execution-engine.mjs';
import { withExecutionTimeout } from '../../runtime/execution/timeout-controller.mjs';
import { ModelQueueTimeoutError, ProviderTimeoutError } from '../../core/errors.mjs';

describe('ConcurrencyController', () => {
  it('allows requests up to max concurrency', async () => {
    const cc = new ConcurrencyController();
    cc.configure('model-a', 2);

    const r1 = await cc.acquire('model-a', 1000);
    const r2 = await cc.acquire('model-a', 1000);

    assert.equal(cc.activeCount('model-a'), 2);
    assert.equal(cc.queueDepth('model-a'), 0);

    r1();
    r2();
    assert.equal(cc.activeCount('model-a'), 0);
  });

  it('queues excess requests', async () => {
    const cc = new ConcurrencyController();
    cc.configure('model-a', 1);

    const r1 = await cc.acquire('model-a', 5000);
    assert.equal(cc.activeCount('model-a'), 1);

    // This should queue
    const p2 = cc.acquire('model-a', 5000);
    assert.equal(cc.queueDepth('model-a'), 1);

    r1(); // Release first — second should now acquire

    const r2 = await p2;
    assert.equal(cc.activeCount('model-a'), 1);
    r2();
  });

  it('rejects on timeout', async () => {
    const cc = new ConcurrencyController();
    cc.configure('model-a', 1);

    const r1 = await cc.acquire('model-a', 5000);

    await assert.rejects(
      cc.acquire('model-a', 50), // very short timeout
      (err) => err instanceof ModelQueueTimeoutError
    );

    r1();
  });

  it('provides snapshot', () => {
    const cc = new ConcurrencyController();
    cc.configure('m1', 5);
    const snap = cc.snapshot();
    assert.deepEqual(snap.m1, { max: 5, active: 0, queued: 0 });
  });

  it('supports live resize', async () => {
    const cc = new ConcurrencyController();
    cc.configure('m1', 1);
    const r1 = await cc.acquire('m1', 1000);
    assert.equal(cc.activeCount('m1'), 1);

    // Resize to 2
    cc.configure('m1', 2);

    // Now second request should succeed immediately
    const r2 = await cc.acquire('m1', 100);
    assert.equal(cc.activeCount('m1'), 2);
    r1();
    r2();
  });
});

describe('executeWithHttpRetry', () => {
  it('returns result on first success', async () => {
    const { result, trace } = await executeWithHttpRetry(
      { maxAttempts: 3, baseDelayMs: 10 },
      async () => 'ok'
    );
    assert.equal(result, 'ok');
    assert.equal(trace.length, 0);
  });

  it('retries on retryable error', async () => {
    let attempts = 0;
    const { result, trace } = await executeWithHttpRetry(
      { maxAttempts: 3, baseDelayMs: 10, jitterPct: 0 },
      async () => {
        attempts++;
        if (attempts < 3) {
          const err = new Error('retry me');
          err.retryable = true;
          err.errorType = 'provider_timeout';
          throw err;
        }
        return 'success';
      }
    );
    assert.equal(result, 'success');
    assert.equal(trace.length, 2);
    assert.equal(attempts, 3);
  });

  it('does not retry non-retryable error', async () => {
    let attempts = 0;
    const { error, trace } = await executeWithHttpRetry(
      { maxAttempts: 3, baseDelayMs: 10 },
      async () => {
        attempts++;
        const err = new Error('fatal');
        err.retryable = false;
        throw err;
      }
    );
    assert.equal(attempts, 1);
    assert.equal(error.message, 'fatal');
    assert.equal(trace.length, 1);
  });

  it('fails after max attempts', async () => {
    let attempts = 0;
    const { error, trace } = await executeWithHttpRetry(
      { maxAttempts: 2, baseDelayMs: 10, jitterPct: 0 },
      async () => {
        attempts++;
        const err = new Error('retry me');
        err.retryable = true;
        throw err;
      }
    );
    assert.equal(attempts, 2);
    assert.equal(trace.length, 2);
    assert.ok(error);
  });
});

describe('collectNormalizedStream', () => {
  it('collects text deltas', async () => {
    async function* gen() {
      yield { type: 'message_start' };
      yield { type: 'text_delta', text: 'Hello' };
      yield { type: 'text_delta', text: ' world' };
      yield { type: 'usage', input_tokens: 10, output_tokens: 5 };
      yield { type: 'done', finish_reason: 'stop' };
    }

    const result = await collectNormalizedStream(gen());
    assert.equal(result.content, 'Hello world');
    assert.equal(result.finishReason, 'stop');
    assert.equal(result.usage.input_tokens, 10);
    assert.equal(result.usage.output_tokens, 5);
    assert.equal(result.usage.total_tokens, 15);
  });

  it('collects tool call deltas', async () => {
    async function* gen() {
      yield { type: 'tool_call_delta', index: 0, id: 'call_1', name: 'search', arguments: '{"q":' };
      yield { type: 'tool_call_delta', index: 0, arguments: '"hello"}' };
      yield { type: 'done', finish_reason: 'tool_calls' };
    }

    const result = await collectNormalizedStream(gen());
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0].function.name, 'search');
    assert.equal(result.toolCalls[0].function.arguments, '{"q":"hello"}');
  });

  it('truncates excerpt at maxExcerptChars', async () => {
    async function* gen() {
      yield { type: 'text_delta', text: 'x'.repeat(5000) };
      yield { type: 'done', finish_reason: 'length' };
    }

    const result = await collectNormalizedStream(gen(), { maxExcerptChars: 100 });
    assert.equal(result.excerpt.length, 103); // 100 + '...'
    assert.equal(result.content.length, 5000);
  });

  it('throws on error chunk', async () => {
    async function* gen() {
      yield { type: 'error', error: new Error('stream failed') };
    }

    await assert.rejects(
      collectNormalizedStream(gen()),
      (err) => err.message === 'stream failed'
    );
  });

  it('collects provider chunks that wrap payloads in data objects', async () => {
    async function* gen() {
      yield { type: 'message_start', data: { role: 'assistant' } };
      yield { type: 'text_delta', data: { text: 'wrapped' } };
      yield { type: 'tool_call_delta', data: { index: 0, id: 'call_1', name: 'search', arguments: '{"q":"x"}' } };
      yield { type: 'usage', data: { input_tokens: 2, output_tokens: 3, total_tokens: 5 } };
      yield { type: 'done', data: { finish_reason: 'stop' } };
    }

    const result = await collectNormalizedStream(gen());
    assert.equal(result.content, 'wrapped');
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0].function.name, 'search');
    assert.equal(result.usage.total_tokens, 5);
    assert.equal(result.finishReason, 'stop');
  });
});

describe('executeResolvedRequest', () => {
  it('passes aliased model/provider records to the provider and releases credential leases', async () => {
    let releasedLease = null;
    let seenSecret = null;
    let seenProviderBaseUrl = null;
    let seenProviderModelId = null;

    async function* gen() {
      yield { type: 'message_start', data: { role: 'assistant' } };
      yield { type: 'text_delta', data: { text: 'hello' } };
      yield { type: 'usage', data: { input_tokens: 1, output_tokens: 2 } };
      yield { type: 'done', data: { finish_reason: 'stop' } };
    }

    const plugin = {
      async execute(ctx) {
        seenSecret = ctx.credentialLease?.secret || null;
        seenProviderBaseUrl = ctx.providerRecord?.base_url || null;
        seenProviderModelId = ctx.resolvedModel?.provider_model_id || null;
        return { accountId: ctx.credentialLease?.accountId || null, stream: gen(), abort: async () => {} };
      },
      classifyError(error) {
        return error;
      },
    };

    const providerCatalog = {
      getPlugin(key) {
        assert.equal(key, 'openai-api');
        return plugin;
      },
    };

    const credentialManager = {
      async getCredentials(providerId) {
        assert.equal(providerId, 'provider-1');
        return {
          leaseId: 'lease-1',
          accountId: 'account-1',
          authType: 'api_key',
          secret: 'sk-test',
          oauth: null,
          metadata: {},
        };
      },
      release(lease) {
        releasedLease = lease;
        lease.secret = null;
      },
    };

    const appCtx = {
      config: {
        env: {
          DEFAULT_REQUEST_TIMEOUT_MS: 1000,
          DEFAULT_QUEUE_TIMEOUT_MS: 1000,
          DEFAULT_MODEL_CONCURRENCY: 1,
          HTTP_RETRY_MAX_ATTEMPTS: 1,
          HTTP_RETRY_BASE_DELAY_MS: 1,
          HTTP_RETRY_MULTIPLIER: 1,
          HTTP_RETRY_MAX_DELAY_MS: 1,
          HTTP_RETRY_JITTER_PCT: 0,
        },
        defaults: {
          responseExcerptChars: 2000,
        },
      },
      services: {
        extensionServices: {},
      },
      log: { info() {}, warn() {}, error() {} },
    };

    const snapshot = {
      providers: new Map([[
        'openai-api',
        { id: 'provider-1', providerKey: 'openai-api', baseUrl: 'https://api.example.test/v1', settings: {} },
      ]]),
    };

    const result = await executeResolvedRequest({
      requestId: 'req-1',
      resolvedModel: {
        id: 'model-1',
        modelKey: 'openai/gpt-4o',
        providerId: 'provider-1',
        providerKey: 'openai-api',
        providerModelId: 'gpt-4o',
        requestTimeoutMs: 1000,
        queueTimeoutMs: 1000,
        concurrencyLimit: 1,
        retryPolicy: {},
      },
      resolvedTier: null,
      normalizedRequest: { model: 'openai/gpt-4o', messages: [] },
      snapshot,
      appCtx,
      concurrencyController: null,
      providerCatalog,
      credentialManager,
      onCooldown() {},
      log: appCtx.log,
    });

    assert.equal(result.collected.content, 'hello');
    assert.equal(seenSecret, 'sk-test');
    assert.equal(seenProviderBaseUrl, 'https://api.example.test/v1');
    assert.equal(seenProviderModelId, 'gpt-4o');
    assert.equal(releasedLease.accountId, 'account-1');
    assert.equal(releasedLease.secret, null);
  });

  it('lets response hooks inspect and mutate the buffered collected response', async () => {
    async function* gen() {
      yield { type: 'message_start', data: { role: 'assistant' } };
      yield { type: 'text_delta', data: { text: 'hello' } };
      yield { type: 'usage', data: { input_tokens: 1, output_tokens: 2 } };
      yield { type: 'done', data: { finish_reason: 'stop' } };
    }

    const responseHook = {
      hook: {
        meta: { key: 'answer-polisher', name: 'Answer Polisher', scope: 'provider', phases: ['response'] },
        async onResponse(ctx) {
          ctx.response.content += ' world';
          ctx.response.message.content = ctx.response.content;
          ctx.response.excerpt = ctx.response.content;
          ctx.usage = { input_tokens: 1, output_tokens: 3, total_tokens: 4 };
        },
      },
      settings: {},
      assignmentId: 'hook-1',
      phase: 'response',
      sortOrder: 1,
    };

    const executor = {
      async execute() {
        return { accountId: null, stream: gen(), abort: async () => {} };
      },
      classifyError(error) {
        return error;
      },
    };

    const result = await executeResolvedRequest({
      requestId: 'req-hooked',
      resolvedModel: {
        id: 'model-1',
        modelKey: 'custom/browser-search',
        providerId: 'provider-1',
        providerKey: 'custom-provider',
        providerModelId: 'browser-search',
        requestTimeoutMs: 1000,
        queueTimeoutMs: 1000,
        concurrencyLimit: 1,
        retryPolicy: {},
      },
      resolvedTier: null,
      normalizedRequest: { model: 'custom/browser-search', messages: [] },
      snapshot: {
        providers: new Map([[
          'custom-provider',
          {
            id: 'provider-1',
            providerKey: 'custom-provider',
            providerMode: 'custom',
            executorKey: 'custom-executor',
            settings: {},
          },
        ]]),
      },
      appCtx: {
        config: {
          env: {
            DEFAULT_REQUEST_TIMEOUT_MS: 1000,
            DEFAULT_QUEUE_TIMEOUT_MS: 1000,
            DEFAULT_MODEL_CONCURRENCY: 1,
            HTTP_RETRY_MAX_ATTEMPTS: 1,
            HTTP_RETRY_BASE_DELAY_MS: 1,
            HTTP_RETRY_MULTIPLIER: 1,
            HTTP_RETRY_MAX_DELAY_MS: 1,
            HTTP_RETRY_JITTER_PCT: 0,
          },
          defaults: {
            responseExcerptChars: 2000,
          },
        },
        services: {
          extensionServices: {},
          executorCatalog: {
            getExecutor(key) {
              assert.equal(key, 'custom-executor');
              return executor;
            },
          },
          providerHookCatalog: {
            getProviderPipeline(providerId) {
              assert.equal(providerId, 'provider-1');
              return { request: [], stream: [], response: [responseHook] };
            },
          },
        },
        log: { info() {}, warn() {}, error() {} },
      },
      concurrencyController: null,
      providerCatalog: null,
      credentialManager: null,
      onCooldown() {},
      log: { info() {}, warn() {}, error() {} },
    });

    assert.equal(result.collected.content, 'hello world');
    assert.equal(result.collected.message.content, 'hello world');
    assert.deepEqual(result.collected.usage, { input_tokens: 1, output_tokens: 3, total_tokens: 4 });
  });

  it('uses executorCatalog for custom providers when provider plugins are not present', async () => {
    let executed = false;

    async function* gen() {
      yield { type: 'text_delta', data: { text: 'custom' } };
      yield { type: 'done', data: { finish_reason: 'stop' } };
    }

    const result = await executeResolvedRequest({
      requestId: 'req-custom',
      resolvedModel: {
        id: 'model-1',
        modelKey: 'custom/local',
        providerId: 'provider-1',
        providerKey: 'custom-provider',
        providerModelId: 'local',
        requestTimeoutMs: 1000,
        queueTimeoutMs: 1000,
        concurrencyLimit: 1,
        retryPolicy: {},
      },
      resolvedTier: null,
      normalizedRequest: { model: 'custom/local', messages: [] },
      snapshot: {
        providers: new Map([[
          'custom-provider',
          {
            id: 'provider-1',
            providerKey: 'custom-provider',
            providerMode: 'custom',
            executorKey: 'custom-executor',
            settings: {},
          },
        ]]),
      },
      appCtx: {
        config: {
          env: {
            DEFAULT_REQUEST_TIMEOUT_MS: 1000,
            DEFAULT_QUEUE_TIMEOUT_MS: 1000,
            DEFAULT_MODEL_CONCURRENCY: 1,
            HTTP_RETRY_MAX_ATTEMPTS: 1,
            HTTP_RETRY_BASE_DELAY_MS: 1,
            HTTP_RETRY_MULTIPLIER: 1,
            HTTP_RETRY_MAX_DELAY_MS: 1,
            HTTP_RETRY_JITTER_PCT: 0,
          },
          defaults: {
            responseExcerptChars: 2000,
          },
        },
        services: {
          extensionServices: {},
          executorCatalog: {
            getExecutor(key) {
              assert.equal(key, 'custom-executor');
              return {
                async execute() {
                  executed = true;
                  return { accountId: null, stream: gen(), abort: async () => {} };
                },
                classifyError(error) {
                  return error;
                },
              };
            },
          },
          providerHookCatalog: { getProviderPipeline() { return null; } },
        },
        log: { info() {}, warn() {}, error() {} },
      },
      concurrencyController: null,
      providerCatalog: { getPlugin() { return null; } },
      credentialManager: null,
      onCooldown() {},
      log: { info() {}, warn() {}, error() {} },
    });

    assert.ok(executed);
    assert.equal(result.collected.content, 'custom');
  });
});

describe('withExecutionTimeout', () => {
  it('creates a signal that aborts after timeout', async () => {
    const { signal, clear } = withExecutionTimeout(50, 'test-provider');

    await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok(signal.aborted);

    clear();
  });

  it('can be cleared before timeout', async () => {
    const { signal, clear } = withExecutionTimeout(5000, 'test-provider');
    clear();

    await new Promise(resolve => setTimeout(resolve, 50));
    assert.ok(!signal.aborted);
  });
});
