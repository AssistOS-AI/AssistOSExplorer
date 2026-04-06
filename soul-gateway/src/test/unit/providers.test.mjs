import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// ── Extension SDK ───────────────────────────────────────────────────

import { createExtensionContext } from '../../runtime/providers/extension-sdk.mjs';

describe('Extension SDK stubs', () => {
  it('createExtensionContext returns an object with services', () => {
    const ctx = createExtensionContext({});
    assert.ok(ctx.services, 'should have services');
    assert.ok(typeof ctx.services.invokeModel === 'function');
    assert.ok(typeof ctx.services.invokeSearch === 'function');
    assert.ok(typeof ctx.services.credentials.get === 'function');
    assert.ok(typeof ctx.services.credentials.signRequest === 'function');
    assert.ok(typeof ctx.services.browserPool.acquire === 'function');
    assert.ok(typeof ctx.services.browserPool.release === 'function');
    assert.ok(typeof ctx.services.tokenEstimator.estimate === 'function');
    assert.ok(typeof ctx.services.tokenEstimator.countTokens === 'function');
  });

  it('invokeModel rejects without snapshot', async () => {
    const ctx = createExtensionContext({});
    await assert.rejects(
      () => ctx.services.invokeModel('test', { messages: [] }),
      /snapshot/i,
    );
  });

  it('invokeSearch rejects without snapshot', async () => {
    const ctx = createExtensionContext({});
    await assert.rejects(
      () => ctx.services.invokeSearch('test', 'query'),
      /snapshot/i,
    );
  });

  it('credentials.get rejects without CredentialManager', async () => {
    const ctx = createExtensionContext({});
    await assert.rejects(
      () => ctx.services.credentials.get('provider-1'),
      /CredentialManager/i,
    );
  });

  it('credentials.signRequest uses leased secret material and releases the lease', async () => {
    let releasedLease = null;
    const ctx = createExtensionContext({
      services: {
        credentialManager: {
          async getCredentials() {
            return {
              leaseId: 'lease-1',
              accountId: 'acc-1',
              authType: 'oauth',
              secret: null,
              oauth: { accessToken: 'oauth-token', refreshToken: null, expiresAt: null },
              metadata: {},
            };
          },
          release(lease) {
            releasedLease = lease;
          },
        },
      },
    });

    const headers = await ctx.services.credentials.signRequest({
      providerId: 'provider-1',
      headers: { 'X-Test': '1' },
    });

    assert.equal(headers.Authorization, 'Bearer oauth-token');
    assert.equal(headers['X-Test'], '1');
    assert.equal(releasedLease.leaseId, 'lease-1');
  });

  it('browserPool.acquire rejects with helpful message', async () => {
    const ctx = createExtensionContext({});
    await assert.rejects(
      () => ctx.services.browserPool.acquire(),
      /browser runtime/i,
    );
  });

  it('tokenEstimator.estimate returns a number', () => {
    const ctx = createExtensionContext({});
    const result = ctx.services.tokenEstimator.estimate({ messages: [{ role: 'user', content: 'hello world' }] });
    assert.equal(typeof result, 'number');
    assert.ok(result > 0);
  });
});

// ── Provider Interface (manifest validation) ────────────────────────

import { validateManifest } from '../../runtime/providers/provider-interface.mjs';

describe('Provider manifest validation', () => {
  const validManifest = {
    key: 'test-provider',
    kind: 'external_api',
    authStrategy: 'api_key',
    supportsStreaming: true,
    supportsTools: true,
    supportedFormats: ['openai_chat'],
  };

  it('accepts a valid manifest', () => {
    assert.doesNotThrow(() => validateManifest(validManifest));
  });

  it('rejects null manifest', () => {
    assert.throws(() => validateManifest(null), /must be a non-null object/);
  });

  it('rejects missing key', () => {
    assert.throws(() => validateManifest({ ...validManifest, key: '' }), /non-empty string/);
  });

  it('rejects invalid kind', () => {
    assert.throws(() => validateManifest({ ...validManifest, kind: 'invalid' }), /kind must be one of/);
  });

  it('accepts all valid kinds', () => {
    for (const kind of ['external_api', 'search', 'local_model', 'wrapper']) {
      assert.doesNotThrow(() => validateManifest({ ...validManifest, kind }));
    }
  });

  it('rejects invalid authStrategy', () => {
    assert.throws(() => validateManifest({ ...validManifest, authStrategy: 'invalid' }), /authStrategy must be one of/);
  });

  it('accepts all valid authStrategies', () => {
    for (const authStrategy of ['none', 'api_key', 'oauth', 'hybrid', 'custom']) {
      assert.doesNotThrow(() => validateManifest({ ...validManifest, authStrategy }));
    }
  });

  it('rejects non-boolean supportsStreaming', () => {
    assert.throws(() => validateManifest({ ...validManifest, supportsStreaming: 'yes' }), /boolean/);
  });

  it('rejects non-boolean supportsTools', () => {
    assert.throws(() => validateManifest({ ...validManifest, supportsTools: 1 }), /boolean/);
  });

  it('rejects non-array supportedFormats', () => {
    assert.throws(() => validateManifest({ ...validManifest, supportedFormats: 'openai_chat' }), /array/);
  });
});

// ── Provider Context ────────────────────────────────────────────────

import { createProviderContext } from '../../runtime/providers/provider-context.mjs';

describe('Provider context', () => {
  it('creates a frozen context from exec context', () => {
    const ctx = createProviderContext({
      requestId: 'req-1',
      request: { messages: [] },
      resolvedModel: { id: 'm1' },
      providerRecord: { id: 'p1' },
      signal: AbortSignal.timeout(5000),
      logger: { info() {} },
    });

    assert.equal(ctx.requestId, 'req-1');
    assert.deepEqual(ctx.request, { messages: [] });
    assert.equal(ctx.credentialLease, null);
    assert.deepEqual(ctx.attempt, { index: 0, previousErrors: [] });
    assert.ok(Object.isFrozen(ctx));
    assert.ok(Object.isFrozen(ctx.attempt));
  });
});

// ── Error classification: OpenAI ────────────────────────────────────

import { providerPlugin as openaiPlugin } from '../../runtime/providers/builtin/openai-api.provider.mjs';

describe('OpenAI error classification', () => {
  it('classifies 401 as ProviderAuthError', () => {
    const err = openaiPlugin.classifyError({ status: 401, body: {} });
    assert.equal(err.errorType, 'provider_auth_error');
    assert.equal(err.httpStatus, 502);
  });

  it('classifies 429 as ProviderRateLimitError', () => {
    const err = openaiPlugin.classifyError({ status: 429, body: {} });
    assert.equal(err.errorType, 'provider_rate_limited');
    assert.equal(err.cooldown, true);
  });

  it('classifies 429 with insufficient_quota as ProviderQuotaError', () => {
    const err = openaiPlugin.classifyError({
      status: 429,
      body: { error: { type: 'insufficient_quota' } },
    });
    assert.equal(err.errorType, 'provider_quota_exhausted');
  });

  it('classifies 400 content_policy_violation as ProviderContentPolicyError', () => {
    const err = openaiPlugin.classifyError({
      status: 400,
      body: { error: { type: 'content_policy_violation' } },
    });
    assert.equal(err.errorType, 'provider_content_policy');
  });

  it('classifies 404 as ProviderModelNotFoundError', () => {
    const err = openaiPlugin.classifyError({ status: 404, body: {} });
    assert.equal(err.errorType, 'provider_model_not_found');
  });

  it('classifies 503 as ProviderUnavailableError', () => {
    const err = openaiPlugin.classifyError({ status: 503, body: {} });
    assert.equal(err.errorType, 'provider_unavailable');
  });

  it('classifies 500 as ProviderServerError', () => {
    const err = openaiPlugin.classifyError({ status: 500, body: {} });
    assert.equal(err.errorType, 'provider_server_error');
  });

  it('classifies ETIMEDOUT as ProviderTimeoutError', () => {
    const err = openaiPlugin.classifyError({ code: 'ETIMEDOUT' });
    assert.equal(err.errorType, 'provider_timeout');
  });

  it('classifies ECONNREFUSED as ProviderUnavailableError', () => {
    const err = openaiPlugin.classifyError({ code: 'ECONNREFUSED' });
    assert.equal(err.errorType, 'provider_unavailable');
  });

  it('manifest has correct shape', () => {
    assert.equal(openaiPlugin.manifest.key, 'openai-api');
    assert.equal(openaiPlugin.manifest.kind, 'external_api');
    assert.equal(openaiPlugin.manifest.authStrategy, 'api_key');
    assert.equal(openaiPlugin.manifest.supportsStreaming, true);
    assert.equal(openaiPlugin.manifest.supportsTools, true);
  });
});

// ── Error classification: Anthropic ─────────────────────────────────

import { providerPlugin as anthropicPlugin } from '../../runtime/providers/builtin/anthropic-api.provider.mjs';

describe('Anthropic error classification', () => {
  it('classifies authentication_error as ProviderAuthError', () => {
    const err = anthropicPlugin.classifyError({
      status: 401,
      body: { error: { type: 'authentication_error' } },
    });
    assert.equal(err.errorType, 'provider_auth_error');
  });

  it('classifies rate_limit_error as ProviderRateLimitError', () => {
    const err = anthropicPlugin.classifyError({
      status: 429,
      body: { error: { type: 'rate_limit_error' } },
    });
    assert.equal(err.errorType, 'provider_rate_limited');
  });

  it('classifies overloaded_error as ProviderUnavailableError', () => {
    const err = anthropicPlugin.classifyError({
      status: 529,
      body: { error: { type: 'overloaded_error' } },
    });
    assert.equal(err.errorType, 'provider_unavailable');
  });

  it('classifies not_found_error as ProviderModelNotFoundError', () => {
    const err = anthropicPlugin.classifyError({
      status: 404,
      body: { error: { type: 'not_found_error' } },
    });
    assert.equal(err.errorType, 'provider_model_not_found');
  });

  it('classifies content policy as ProviderContentPolicyError', () => {
    const err = anthropicPlugin.classifyError({
      status: 400,
      body: { error: { type: 'invalid_request_error', message: 'content policy violation' } },
    });
    assert.equal(err.errorType, 'provider_content_policy');
  });

  it('manifest has correct shape', () => {
    assert.equal(anthropicPlugin.manifest.key, 'anthropic-api');
    assert.equal(anthropicPlugin.manifest.kind, 'external_api');
    assert.ok(anthropicPlugin.manifest.supportedFormats.includes('anthropic_messages'));
  });
});

// ── Error classification: Copilot ───────────────────────────────────

import { providerPlugin as copilotPlugin } from '../../runtime/providers/builtin/copilot-api.provider.mjs';

describe('Copilot error classification', () => {
  it('classifies 401 as ProviderAuthError', () => {
    const err = copilotPlugin.classifyError({ status: 401, body: {} });
    assert.equal(err.errorType, 'provider_auth_error');
  });

  it('classifies 429 quota as ProviderQuotaError', () => {
    const err = copilotPlugin.classifyError({
      status: 429,
      body: { message: 'premium request limit exceeded' },
    });
    assert.equal(err.errorType, 'provider_quota_exhausted');
  });

  it('classifies 429 without quota as ProviderRateLimitError', () => {
    const err = copilotPlugin.classifyError({ status: 429, body: {} });
    assert.equal(err.errorType, 'provider_rate_limited');
  });

  it('manifest uses oauth auth strategy', () => {
    assert.equal(copilotPlugin.manifest.authStrategy, 'oauth');
  });
});

// ── Error classification: Kiro ──────────────────────────────────────

import { providerPlugin as kiroPlugin } from '../../runtime/providers/builtin/kiro-api.provider.mjs';

describe('Kiro error classification', () => {
  it('classifies AccessDeniedException as ProviderAuthError', () => {
    const err = kiroPlugin.classifyError({
      status: 403,
      body: { __type: 'AccessDeniedException', message: 'Denied' },
    });
    assert.equal(err.errorType, 'provider_auth_error');
  });

  it('classifies ThrottlingException as ProviderRateLimitError', () => {
    const err = kiroPlugin.classifyError({
      status: 429,
      body: { __type: 'ThrottlingException' },
    });
    assert.equal(err.errorType, 'provider_rate_limited');
  });

  it('classifies ResourceNotFoundException as ProviderModelNotFoundError', () => {
    const err = kiroPlugin.classifyError({
      status: 404,
      body: { __type: 'ResourceNotFoundException' },
    });
    assert.equal(err.errorType, 'provider_model_not_found');
  });

  it('classifies ServiceUnavailableException as ProviderUnavailableError', () => {
    const err = kiroPlugin.classifyError({
      status: 503,
      body: { __type: 'ServiceUnavailableException' },
    });
    assert.equal(err.errorType, 'provider_unavailable');
  });

  it('classifies guardrail content as ProviderContentPolicyError', () => {
    const err = kiroPlugin.classifyError({
      status: 400,
      body: { __type: 'ValidationException', message: 'guardrail violation' },
    });
    assert.equal(err.errorType, 'provider_content_policy');
  });

  it('manifest uses oauth auth strategy', () => {
    assert.equal(kiroPlugin.manifest.authStrategy, 'oauth');
  });
});

// ── Error classification: Search ────────────────────────────────────

import { providerPlugin as searchPlugin } from '../../runtime/providers/builtin/search-builtin.provider.mjs';

describe('Search error classification', () => {
  it('classifies 401 as ProviderAuthError', () => {
    const err = searchPlugin.classifyError({ status: 401 });
    assert.equal(err.errorType, 'provider_auth_error');
  });

  it('classifies 429 as ProviderRateLimitError', () => {
    const err = searchPlugin.classifyError({ status: 429 });
    assert.equal(err.errorType, 'provider_rate_limited');
  });

  it('manifest is search kind', () => {
    assert.equal(searchPlugin.manifest.kind, 'search');
    assert.equal(searchPlugin.manifest.supportsStreaming, false);
  });
});

// ── Anthropic converter ─────────────────────────────────────────────

import * as anthropicConverter from '../../runtime/providers/converters/anthropic-converter.mjs';

describe('Anthropic converter', () => {
  describe('toProviderRequest', () => {
    it('extracts system messages to top-level system field', () => {
      const req = {
        messages: [
          { role: 'system', content: 'You are helpful.' },
          { role: 'user', content: 'Hello' },
        ],
        max_tokens: 1024,
      };
      const result = anthropicConverter.toProviderRequest(
        req,
        { provider_model_id: 'claude-3-haiku-20240307' },
        {},
      );

      assert.equal(result.system, 'You are helpful.');
      assert.equal(result.messages.length, 1);
      assert.equal(result.messages[0].role, 'user');
      assert.equal(result.model, 'claude-3-haiku-20240307');
    });

    it('converts tool result messages to user role with tool_result content', () => {
      const req = {
        messages: [
          { role: 'tool', content: '42', tool_call_id: 'tc-1' },
        ],
        max_tokens: 1024,
      };
      const result = anthropicConverter.toProviderRequest(
        req,
        { provider_model_id: 'claude-3-haiku-20240307' },
        {},
      );

      assert.equal(result.messages[0].role, 'user');
      assert.equal(result.messages[0].content[0].type, 'tool_result');
      assert.equal(result.messages[0].content[0].tool_use_id, 'tc-1');
    });

    it('converts tool definitions to Anthropic format', () => {
      const req = {
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 1024,
        tools: [{
          function: {
            name: 'get_weather',
            description: 'Get weather',
            parameters: { type: 'object', properties: { city: { type: 'string' } } },
          },
        }],
      };
      const result = anthropicConverter.toProviderRequest(
        req,
        { provider_model_id: 'claude-3-haiku-20240307' },
        {},
      );

      assert.equal(result.tools[0].name, 'get_weather');
      assert.ok(result.tools[0].input_schema);
    });
  });

  describe('fromProviderChunk', () => {
    it('converts message_start event', () => {
      const state = {};
      const chunks = anthropicConverter.fromProviderChunk({
        type: 'message_start',
        message: { id: 'msg-1', model: 'claude-3-haiku', role: 'assistant', usage: { input_tokens: 10 } },
      }, state);

      assert.equal(chunks.length, 2);
      assert.equal(chunks[0].type, 'message_start');
      assert.equal(chunks[0].data.id, 'msg-1');
      assert.equal(chunks[1].type, 'usage');
      assert.equal(chunks[1].data.input_tokens, 10);
    });

    it('converts text_delta event', () => {
      const state = { _initialized: true, currentBlockIndex: 0, toolCallMap: new Map(), messageId: null, model: null };
      const chunks = anthropicConverter.fromProviderChunk({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Hello' },
      }, state);

      assert.equal(chunks.length, 1);
      assert.equal(chunks[0].type, 'text_delta');
      assert.equal(chunks[0].data.text, 'Hello');
    });

    it('converts tool_use content_block_start', () => {
      const state = { _initialized: true, currentBlockIndex: -1, toolCallMap: new Map(), messageId: null, model: null };
      const chunks = anthropicConverter.fromProviderChunk({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'tc-1', name: 'get_weather' },
      }, state);

      assert.equal(chunks.length, 1);
      assert.equal(chunks[0].type, 'tool_call_delta');
      assert.equal(chunks[0].data.id, 'tc-1');
      assert.equal(chunks[0].data.name, 'get_weather');
    });

    it('converts message_delta with stop_reason', () => {
      const state = { _initialized: true, currentBlockIndex: 0, toolCallMap: new Map(), messageId: null, model: 'claude-3' };
      const chunks = anthropicConverter.fromProviderChunk({
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 50 },
      }, state);

      // Should produce both done and usage
      const doneChunk = chunks.find((c) => c.type === 'done');
      const usageChunk = chunks.find((c) => c.type === 'usage');
      assert.ok(doneChunk);
      assert.equal(doneChunk.data.finish_reason, 'stop');
      assert.ok(usageChunk);
      assert.equal(usageChunk.data.output_tokens, 50);
    });

    it('maps tool_use stop_reason to tool_calls finish_reason', () => {
      const state = { _initialized: true, currentBlockIndex: 0, toolCallMap: new Map(), messageId: null, model: 'claude-3' };
      const chunks = anthropicConverter.fromProviderChunk({
        type: 'message_delta',
        delta: { stop_reason: 'tool_use' },
      }, state);

      const doneChunk = chunks.find((c) => c.type === 'done');
      assert.equal(doneChunk.data.finish_reason, 'tool_calls');
    });

    it('ignores ping events', () => {
      const state = {};
      const chunks = anthropicConverter.fromProviderChunk({ type: 'ping' }, state);
      assert.equal(chunks.length, 0);
    });
  });

  describe('toBufferedResponse', () => {
    it('converts a complete Anthropic response', () => {
      const raw = {
        id: 'msg-1',
        model: 'claude-3-haiku',
        role: 'assistant',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Hello world' }],
        usage: { input_tokens: 10, output_tokens: 5 },
      };
      const result = anthropicConverter.toBufferedResponse(raw);

      assert.equal(result.id, 'msg-1');
      assert.equal(result.content, 'Hello world');
      assert.equal(result.finish_reason, 'stop');
      assert.equal(result.usage.total_tokens, 15);
    });
  });
});

// ── Copilot converter ───────────────────────────────────────────────

import * as copilotConverter from '../../runtime/providers/converters/copilot-converter.mjs';

describe('Copilot converter', () => {
  describe('resolveEndpoint', () => {
    it('routes o1-preview to responses endpoint', () => {
      assert.equal(copilotConverter.resolveEndpoint('o1-preview'), 'responses');
    });

    it('routes gpt-4o to completions endpoint', () => {
      assert.equal(copilotConverter.resolveEndpoint('gpt-4o'), 'completions');
    });

    it('routes gpt-4.1 to responses endpoint', () => {
      assert.equal(copilotConverter.resolveEndpoint('gpt-4.1'), 'responses');
    });

    it('honors force_endpoint setting', () => {
      assert.equal(
        copilotConverter.resolveEndpoint('gpt-4o', { settings: { force_endpoint: 'responses' } }),
        'responses',
      );
      assert.equal(
        copilotConverter.resolveEndpoint('o1-preview', { settings: { force_endpoint: 'completions' } }),
        'completions',
      );
    });
  });

  describe('toProviderRequest', () => {
    it('returns completions endpoint for gpt-4o', () => {
      const result = copilotConverter.toProviderRequest(
        { messages: [{ role: 'user', content: 'hi' }], stream: true },
        { provider_model_id: 'gpt-4o' },
        {},
      );
      assert.equal(result.endpoint, 'completions');
      assert.equal(result.path, '/chat/completions');
    });

    it('returns responses endpoint for o1-preview', () => {
      const result = copilotConverter.toProviderRequest(
        { messages: [{ role: 'user', content: 'hi' }], stream: true },
        { provider_model_id: 'o1-preview' },
        {},
      );
      assert.equal(result.endpoint, 'responses');
      assert.match(result.path, /\/models\/o1-preview\/responses/);
    });
  });

  describe('fromCompletionsChunk', () => {
    it('emits message_start on first chunk', () => {
      const state = {};
      const chunks = copilotConverter.fromCompletionsChunk(
        { id: 'c-1', model: 'gpt-4o', choices: [{ delta: { content: 'Hi' } }] },
        state,
      );
      const msgStart = chunks.find((c) => c.type === 'message_start');
      assert.ok(msgStart);
      assert.equal(msgStart.data.model, 'gpt-4o');
    });

    it('emits text_delta for content', () => {
      const state = { _initialized: true, firstChunk: false, model: 'gpt-4o' };
      const chunks = copilotConverter.fromCompletionsChunk(
        { choices: [{ delta: { content: 'World' } }] },
        state,
      );
      const textDelta = chunks.find((c) => c.type === 'text_delta');
      assert.ok(textDelta);
      assert.equal(textDelta.data.text, 'World');
    });
  });
});

// ── Kiro converter ──────────────────────────────────────────────────

import * as kiroConverter from '../../runtime/providers/converters/kiro-converter.mjs';

describe('Kiro converter', () => {
  describe('toProviderRequest', () => {
    it('builds conversationState with turns', () => {
      const req = {
        messages: [
          { role: 'system', content: 'Be helpful' },
          { role: 'user', content: 'Hello' },
        ],
        max_tokens: 2048,
        temperature: 0.7,
      };
      const result = kiroConverter.toProviderRequest(
        req,
        { provider_model_id: 'claude-sonnet-4' },
        {},
      );

      assert.equal(result.modelId, 'claude-sonnet-4');
      assert.equal(result.conversationState.systemInstruction, 'Be helpful');
      assert.equal(result.conversationState.turns.length, 1);
      assert.equal(result.conversationState.turns[0].role, 'user');
      assert.equal(result.inferenceConfig.maxTokens, 2048);
      assert.equal(result.inferenceConfig.temperature, 0.7);
    });
  });

  describe('fromProviderChunk', () => {
    it('converts messageStart event', () => {
      const state = {};
      const chunks = kiroConverter.fromProviderChunk({
        headers: { ':event-type': 'messageStart' },
        payload: { model: 'claude-sonnet-4', role: 'assistant' },
      }, state);

      assert.equal(chunks.length, 1);
      assert.equal(chunks[0].type, 'message_start');
      assert.equal(chunks[0].data.model, 'claude-sonnet-4');
    });

    it('converts contentBlockDelta text', () => {
      const state = { _initialized: true, firstChunk: false, model: 'claude-sonnet-4', toolIndex: 0 };
      const chunks = kiroConverter.fromProviderChunk({
        headers: { ':event-type': 'contentBlockDelta' },
        payload: { delta: { type: 'text_delta', text: 'Hello' } },
      }, state);

      assert.equal(chunks.length, 1);
      assert.equal(chunks[0].type, 'text_delta');
      assert.equal(chunks[0].data.text, 'Hello');
    });

    it('converts messageStop event', () => {
      const state = { _initialized: true, firstChunk: false, model: 'test', toolIndex: 0 };
      const chunks = kiroConverter.fromProviderChunk({
        headers: { ':event-type': 'messageStop' },
        payload: { stopReason: 'end_turn' },
      }, state);

      assert.equal(chunks.length, 1);
      assert.equal(chunks[0].type, 'done');
      assert.equal(chunks[0].data.finish_reason, 'stop');
    });
  });

  describe('parseBinaryFrame', () => {
    it('returns null for buffers smaller than 16 bytes', () => {
      assert.equal(kiroConverter.parseBinaryFrame(Buffer.alloc(10)), null);
    });

    it('returns null for null input', () => {
      assert.equal(kiroConverter.parseBinaryFrame(null), null);
    });
  });
});

// ── Search converter ────────────────────────────────────────────────

import * as searchConverter from '../../runtime/providers/converters/search-converter.mjs';

describe('Search converter', () => {
  describe('formatSearchResults', () => {
    it('formats results as markdown with citations', () => {
      const results = [
        { title: 'Page 1', url: 'https://example.com/1', snippet: 'First result' },
        { title: 'Page 2', url: 'https://example.com/2', snippet: 'Second result' },
      ];
      const formatted = searchConverter.formatSearchResults(results, 'test query');

      assert.match(formatted, /Search results for/);
      assert.match(formatted, /Page 1/);
      assert.match(formatted, /Page 2/);
      assert.match(formatted, /Sources/);
      assert.match(formatted, /\[1\]/);
      assert.match(formatted, /\[2\]/);
    });

    it('handles empty results', () => {
      const formatted = searchConverter.formatSearchResults([], 'test');
      assert.match(formatted, /No search results found/);
    });

    it('respects maxResults option', () => {
      const results = Array.from({ length: 20 }, (_, i) => ({
        title: `Page ${i}`, url: `https://example.com/${i}`, snippet: `Result ${i}`,
      }));
      const formatted = searchConverter.formatSearchResults(results, 'test', { maxResults: 3 });
      // Should only contain [1], [2], [3] in sources
      assert.match(formatted, /\[3\]/);
      assert.doesNotMatch(formatted, /\[4\]/);
    });
  });

  describe('toNormalizedChunks', () => {
    it('produces message_start, text_delta, usage, done', () => {
      const results = [{ title: 'Page 1', url: 'https://x.com', snippet: 'Test' }];
      const chunks = searchConverter.toNormalizedChunks(results, 'query', {
        requestId: 'r1', model: 'search-tavily',
      });

      assert.equal(chunks.length, 4);
      assert.equal(chunks[0].type, 'message_start');
      assert.equal(chunks[1].type, 'text_delta');
      assert.equal(chunks[2].type, 'usage');
      assert.equal(chunks[3].type, 'done');
    });
  });

  describe('per-provider extractors', () => {
    it('extractTavilyResults handles tavily format', () => {
      const results = searchConverter.extractTavilyResults({
        results: [{ title: 'T', url: 'https://t.com', content: 'Snippet', score: 0.9 }],
      });
      assert.equal(results.length, 1);
      assert.equal(results[0].title, 'T');
      assert.equal(results[0].snippet, 'Snippet');
    });

    it('extractBraveResults handles brave format', () => {
      const results = searchConverter.extractBraveResults({
        web: { results: [{ title: 'B', url: 'https://b.com', description: 'Brave snippet' }] },
      });
      assert.equal(results.length, 1);
      assert.equal(results[0].snippet, 'Brave snippet');
    });

    it('extractSerperResults handles serper format', () => {
      const results = searchConverter.extractSerperResults({
        organic: [{ title: 'S', link: 'https://s.com', snippet: 'Serper snippet', position: 1 }],
      });
      assert.equal(results.length, 1);
      assert.equal(results[0].url, 'https://s.com');
    });

    it('extractDuckDuckGoResults handles DDG format', () => {
      const results = searchConverter.extractDuckDuckGoResults({
        AbstractText: 'DDG answer',
        AbstractURL: 'https://ddg.com',
        Heading: 'DDG',
        RelatedTopics: [],
      });
      assert.equal(results.length, 1);
      assert.equal(results[0].snippet, 'DDG answer');
    });

    it('extractSearxngResults handles searxng format', () => {
      const results = searchConverter.extractSearxngResults({
        results: [{ title: 'SX', url: 'https://sx.com', content: 'SearXNG' }],
      });
      assert.equal(results.length, 1);
    });

    it('extractResults routes to correct extractor', () => {
      const results = searchConverter.extractResults('tavily', {
        results: [{ title: 'T', url: 'https://t.com', content: 'X' }],
      });
      assert.equal(results.length, 1);
    });

    it('extractResults returns empty for unknown provider', () => {
      const results = searchConverter.extractResults('unknown', {});
      assert.equal(results.length, 0);
    });
  });
});

// ── Credential Manager ──────────────────────────────────────────────

import { CredentialManager } from '../../runtime/providers/credential-manager.mjs';

describe('CredentialManager', () => {
  let manager;
  let mockAccountPool;

  // Default oauth-manager stub for the main suite: never signals that a
  // refresh is needed, so these tests don't have to model the inline
  // refresh path. The dedicated suite below exercises it explicitly.
  const noopOAuthManager = {
    needsRefresh() { return false; },
    async refreshTokens() {},
  };
  const noopProvidersDao = {
    async findById() { return null; },
  };

  beforeEach(() => {
    mockAccountPool = {
      _nextAccount: null,
      async getNextAccount() { return this._nextAccount; },
    };
    manager = new CredentialManager({
      pool: {},
      accountsDao: {},
      providersDao: noopProvidersDao,
      accountPool: mockAccountPool,
      encryptionKey: Buffer.alloc(32, 'a'),
      oauthManager: noopOAuthManager,
      log: { info() {}, error() {}, warn() {} },
    });
  });

  it('returns null when no account available', async () => {
    mockAccountPool._nextAccount = null;
    const lease = await manager.getCredentials('provider-1');
    assert.equal(lease, null);
  });

  it('returns a lease with authType for api_key account (no encrypted secret)', async () => {
    mockAccountPool._nextAccount = {
      id: 'acc-1',
      auth_type: 'api_key',
      secret_ciphertext: null,
      metadata: {},
    };
    const lease = await manager.getCredentials('provider-1');
    assert.ok(lease);
    assert.equal(lease.accountId, 'acc-1');
    assert.equal(lease.authType, 'api_key');
    assert.equal(lease.secret, null); // no ciphertext to decrypt
  });

  it('returns oauth lease for oauth accounts', async () => {
    mockAccountPool._nextAccount = {
      id: 'acc-2',
      auth_type: 'oauth',
      metadata: { access_token: 'tok-123', refresh_token: 'ref-456' },
      access_token_expires_at: '2026-12-31T00:00:00Z',
    };
    const lease = await manager.getCredentials('provider-1');
    assert.ok(lease);
    assert.equal(lease.authType, 'oauth');
    assert.equal(lease.oauth.accessToken, 'tok-123');
    assert.equal(lease.oauth.refreshToken, 'ref-456');
  });

  it('release clears secret from memory', async () => {
    mockAccountPool._nextAccount = {
      id: 'acc-3',
      auth_type: 'oauth',
      metadata: { access_token: 'tok' },
    };
    const lease = await manager.getCredentials('provider-1');
    // Simulate a secret
    lease.secret = 'sensitive';
    manager.release(lease);
    assert.equal(lease.secret, null);
    assert.equal(manager.activeLeaseCount, 0);
  });

  it('tracks active lease count', async () => {
    mockAccountPool._nextAccount = { id: 'acc-4', auth_type: 'none', metadata: {} };
    const lease1 = await manager.getCredentials('p1');
    const lease2 = await manager.getCredentials('p1');
    assert.equal(manager.activeLeaseCount, 2);
    manager.release(lease1);
    assert.equal(manager.activeLeaseCount, 1);
    manager.release(lease2);
    assert.equal(manager.activeLeaseCount, 0);
  });

  describe('inline OAuth refresh', () => {
    const PROVIDER_ID = 'prov-1';

    function buildManager({ oauthManager, providersDao, accountsDao }) {
      return new CredentialManager({
        pool: {},
        accountsDao,
        providersDao,
        accountPool: mockAccountPool,
        encryptionKey: Buffer.alloc(32, 'a'),
        oauthManager,
        log: { info() {}, error() {}, warn() {}, debug() {} },
      });
    }

    it('refreshes an expiring oauth account synchronously before leasing', async () => {
      const staleAccount = {
        id: 'acc-expiring',
        provider_id: PROVIDER_ID,
        auth_type: 'oauth',
        metadata: { access_token: 'stale', refresh_token: 'rt' },
        access_token_expires_at: new Date(Date.now() + 60_000).toISOString(),
        refresh_margin_seconds: 300,
      };
      const freshAccount = {
        ...staleAccount,
        metadata: { access_token: 'fresh', refresh_token: 'rt2' },
        access_token_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      };

      mockAccountPool._nextAccount = staleAccount;
      const refreshCalls = [];
      const oauthManager = {
        needsRefresh(account) {
          const expiresAt = new Date(account.access_token_expires_at).getTime();
          const marginMs = (account.refresh_margin_seconds || 300) * 1000;
          return Date.now() >= expiresAt - marginMs;
        },
        async refreshTokens(accountId, adapterKey) {
          refreshCalls.push({ accountId, adapterKey });
        },
      };
      const providersDao = {
        async findById(_pool, id) {
          assert.equal(id, PROVIDER_ID);
          return { id: PROVIDER_ID, oauth_adapter_key: 'openai-codex' };
        },
      };
      const accountsDao = {
        async findById(_pool, id) {
          assert.equal(id, 'acc-expiring');
          return freshAccount;
        },
      };

      const m = buildManager({ oauthManager, providersDao, accountsDao });
      const lease = await m.getCredentials(PROVIDER_ID);

      assert.equal(refreshCalls.length, 1);
      assert.deepEqual(refreshCalls[0], { accountId: 'acc-expiring', adapterKey: 'openai-codex' });
      assert.equal(lease.oauth.accessToken, 'fresh');
      assert.equal(lease.oauth.refreshToken, 'rt2');
    });

    it('does not refresh when the token is comfortably fresh', async () => {
      mockAccountPool._nextAccount = {
        id: 'acc-fresh',
        provider_id: PROVIDER_ID,
        auth_type: 'oauth',
        metadata: { access_token: 'fresh', refresh_token: 'rt' },
        access_token_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        refresh_margin_seconds: 300,
      };
      const oauthManager = {
        needsRefresh() { return false; },
        async refreshTokens() {
          throw new Error('refreshTokens should not be called');
        },
      };
      const m = buildManager({
        oauthManager,
        providersDao: { async findById() { throw new Error('lookup should be skipped'); } },
        accountsDao: {},
      });

      const lease = await m.getCredentials(PROVIDER_ID);
      assert.equal(lease.oauth.accessToken, 'fresh');
    });

    it('falls through with the stale token when the refresh throws', async () => {
      const stale = {
        id: 'acc-err',
        provider_id: PROVIDER_ID,
        auth_type: 'oauth',
        metadata: { access_token: 'stale', refresh_token: 'rt' },
        access_token_expires_at: new Date(Date.now() + 30_000).toISOString(),
        refresh_margin_seconds: 300,
      };
      mockAccountPool._nextAccount = stale;
      const warnings = [];
      const oauthManager = {
        needsRefresh() { return true; },
        async refreshTokens() { throw new Error('network down'); },
      };
      const providersDao = {
        async findById() { return { oauth_adapter_key: 'openai-codex' }; },
      };
      const m = new CredentialManager({
        pool: {},
        accountsDao: {},
        providersDao,
        accountPool: mockAccountPool,
        encryptionKey: Buffer.alloc(32, 'a'),
        oauthManager,
        log: {
          info() {},
          error() {},
          warn(msg, meta) { warnings.push({ msg, meta }); },
          debug() {},
        },
      });

      const lease = await m.getCredentials(PROVIDER_ID);
      assert.equal(lease.oauth.accessToken, 'stale');
      assert.equal(warnings.length, 1);
      assert.equal(warnings[0].msg, 'inline_oauth_refresh_failed');
      assert.equal(warnings[0].meta.accountId, 'acc-err');
      assert.equal(warnings[0].meta.error, 'network down');
    });

    it('skips refresh for api_key accounts even when oauthManager is present', async () => {
      mockAccountPool._nextAccount = {
        id: 'acc-apikey',
        provider_id: PROVIDER_ID,
        auth_type: 'api_key',
        secret_ciphertext: null,
        metadata: {},
      };
      const oauthManager = {
        needsRefresh() { throw new Error('should not be consulted for api_key'); },
        async refreshTokens() { throw new Error('should not be called'); },
      };
      const m = buildManager({ oauthManager, providersDao: {}, accountsDao: {} });

      const lease = await m.getCredentials(PROVIDER_ID);
      assert.equal(lease.authType, 'api_key');
    });

    it('uses oauth_adapter_key already on the account row without a providers lookup', async () => {
      const stale = {
        id: 'acc-inline-key',
        provider_id: PROVIDER_ID,
        oauth_adapter_key: 'aws-kiro',
        auth_type: 'oauth',
        metadata: { access_token: 'stale', refresh_token: 'rt' },
        access_token_expires_at: new Date(Date.now() + 30_000).toISOString(),
        refresh_margin_seconds: 300,
      };
      const fresh = { ...stale, metadata: { access_token: 'fresh', refresh_token: 'rt' } };
      mockAccountPool._nextAccount = stale;
      const calls = [];
      const oauthManager = {
        needsRefresh() { return true; },
        async refreshTokens(accountId, adapterKey) {
          calls.push({ accountId, adapterKey });
        },
      };
      const providersDao = {
        async findById() { throw new Error('providersDao should not be called'); },
      };
      const accountsDao = {
        async findById() { return fresh; },
      };
      const m = buildManager({ oauthManager, providersDao, accountsDao });

      const lease = await m.getCredentials(PROVIDER_ID);
      assert.deepEqual(calls, [{ accountId: 'acc-inline-key', adapterKey: 'aws-kiro' }]);
      assert.equal(lease.oauth.accessToken, 'fresh');
    });
  });
});

// ── Account Pool ────────────────────────────────────────────────────

import { AccountPool } from '../../runtime/providers/account-pool.mjs';

describe('AccountPool', () => {
  let pool;
  let mockDao;
  let mockPgPool;

  beforeEach(() => {
    mockPgPool = { query: async () => ({}) };
    mockDao = {
      _accounts: [],
      async listByProvider() { return this._accounts; },
      async markExhausted() { return {}; },
      async markRefreshing() { return {}; },
      async updateTokenExpiry() { return {}; },
      async updateStatus() { return {}; },
    };
    pool = new AccountPool({
      pool: mockPgPool,
      accountsDao: mockDao,
      log: { info() {}, error() {}, warn() {} },
    });
  });

  it('returns null when no accounts exist', async () => {
    mockDao._accounts = [];
    const account = await pool.getNextAccount('provider-1');
    assert.equal(account, null);
  });

  it('returns active accounts', async () => {
    mockDao._accounts = [
      { id: 'a1', status: 'active', metadata: {} },
    ];
    const account = await pool.getNextAccount('provider-1');
    assert.equal(account.id, 'a1');
  });

  it('excludes exhausted accounts', async () => {
    mockDao._accounts = [
      { id: 'a1', status: 'active', metadata: {} },
      { id: 'a2', status: 'active', metadata: {} },
    ];
    await pool.markExhausted('p1', 'a1', new Date(Date.now() + 60000));
    const account = await pool.getNextAccount('provider-1');
    assert.equal(account.id, 'a2');
  });

  it('excludes accounts in excludeAccountIds set', async () => {
    mockDao._accounts = [
      { id: 'a1', status: 'active', metadata: {} },
      { id: 'a2', status: 'active', metadata: {} },
    ];
    const account = await pool.getNextAccount('provider-1', {
      excludeAccountIds: new Set(['a1']),
    });
    assert.equal(account.id, 'a2');
  });

  it('round-robins between accounts', async () => {
    mockDao._accounts = [
      { id: 'a1', status: 'active', metadata: {} },
      { id: 'a2', status: 'active', metadata: {} },
    ];
    const first = await pool.getNextAccount('provider-1');
    const second = await pool.getNextAccount('provider-1');
    assert.notEqual(first.id, second.id);
  });

  it('excludes non-active/non-refreshing statuses', async () => {
    mockDao._accounts = [
      { id: 'a1', status: 'deleted', metadata: {} },
      { id: 'a2', status: 'error', metadata: {} },
      { id: 'a3', status: 'quota_exhausted', metadata: {} },
    ];
    const account = await pool.getNextAccount('provider-1');
    assert.equal(account, null);
  });

  it('includes refreshing accounts', async () => {
    mockDao._accounts = [
      { id: 'a1', status: 'refreshing', metadata: {} },
    ];
    const account = await pool.getNextAccount('provider-1');
    assert.equal(account.id, 'a1');
  });

  it('purges expired exhaustions', async () => {
    mockDao._accounts = [{ id: 'a1', status: 'active', metadata: {} }];
    await pool.markExhausted('p1', 'a1', new Date(Date.now() - 1000)); // already expired
    const purged = pool.purgeExpiredExhaustions();
    assert.equal(purged, 1);
    assert.equal(pool.exhaustedCount, 0);
  });

  it('clears restored exhausted accounts explicitly', async () => {
    mockDao._accounts = [
      { id: 'a1', status: 'active', metadata: {} },
      { id: 'a2', status: 'active', metadata: {} },
    ];
    await pool.markExhausted('p1', 'a1', new Date(Date.now() + 60_000));
    await pool.markExhausted('p1', 'a2', new Date(Date.now() + 60_000));

    const cleared = pool.clearExhaustions(['a1']);

    assert.equal(cleared, 1);
    assert.equal(pool.exhaustedCount, 1);
  });

  it('tracks exhausted and refreshing counts', async () => {
    mockDao._accounts = [
      { id: 'a1', status: 'active', metadata: {} },
      { id: 'a2', status: 'active', metadata: {} },
    ];
    await pool.markExhausted('p1', 'a1', new Date(Date.now() + 60000));
    await pool.markRefreshing('a2');
    assert.equal(pool.exhaustedCount, 1);
    assert.equal(pool.refreshingCount, 1);
  });
});

// ── Provider Catalog ────────────────────────────────────────────────

import { ProviderCatalog } from '../../runtime/providers/provider-catalog.mjs';
import { providerPlugin as codexPlugin } from '../../runtime/providers/builtin/codex-api.provider.mjs';
import { providerPlugin as geminiOAuthPlugin } from '../../runtime/providers/builtin/gemini-openai.provider.mjs';
import { providerPlugin as claudeaiPlugin } from '../../runtime/providers/builtin/claudeai-api.provider.mjs';

describe('ProviderCatalog', () => {
  let catalog;

  beforeEach(() => {
    catalog = new ProviderCatalog({ log: { info() {}, error() {} } });
  });

  function makePlugin(key) {
    return {
      manifest: {
        key,
        kind: 'external_api',
        authStrategy: 'api_key',
        supportsStreaming: true,
        supportsTools: true,
        supportedFormats: ['openai_chat'],
      },
      async init() {},
      async shutdown() {},
      async execute() {},
      classifyError() {},
    };
  }

  it('starts empty', () => {
    assert.equal(catalog.size, 0);
    assert.equal(catalog.generation, 0);
  });

  it('loads plugins and increments generation', () => {
    catalog.load([makePlugin('test-1'), makePlugin('test-2')]);
    assert.equal(catalog.size, 2);
    assert.equal(catalog.generation, 1);
  });

  it('retrieves plugin by key', () => {
    catalog.load([makePlugin('test-1')]);
    const plugin = catalog.getPlugin('test-1');
    assert.ok(plugin);
    assert.equal(plugin.manifest.key, 'test-1');
  });

  it('returns null for unknown key', () => {
    catalog.load([makePlugin('test-1')]);
    assert.equal(catalog.getPlugin('nonexistent'), null);
  });

  it('rejects duplicate keys', () => {
    assert.throws(
      () => catalog.load([makePlugin('dup'), makePlugin('dup')]),
      /Duplicate provider key/,
    );
  });

  it('listKeys returns all keys', () => {
    catalog.load([makePlugin('a'), makePlugin('b')]);
    const keys = catalog.listKeys();
    assert.deepEqual(keys.sort(), ['a', 'b']);
  });

  it('shutdownAll clears all plugins', async () => {
    let shutdownCount = 0;
    const plugin = makePlugin('test');
    plugin.shutdown = async () => { shutdownCount++; };
    catalog.load([plugin]);
    await catalog.shutdownAll();
    assert.equal(catalog.size, 0);
    assert.equal(shutdownCount, 1);
  });

  it('testConnection leases credentials for plugins that need them', async () => {
    let releasedLease = null;
    const plugin = makePlugin('test-provider');
    plugin.testConnection = async (ctx) => {
      assert.equal(ctx.credentialLease.secret, 'sk-test');
      assert.equal(ctx.providerRecord.base_url, 'https://api.example.test');
      return { ok: true, detail: 'ok' };
    };
    catalog.load([plugin]);

    const result = await catalog.testConnection(
      { id: 'provider-1', adapter_key: 'test-provider', base_url: 'https://api.example.test' },
      {
        credentialManager: {
          async getCredentials(providerId) {
            assert.equal(providerId, 'provider-1');
            return { leaseId: 'lease-1', accountId: 'acc-1', authType: 'api_key', secret: 'sk-test', oauth: null, metadata: {} };
          },
          release(lease) {
            releasedLease = lease;
          },
        },
      },
    );

    assert.deepEqual(result, { ok: true, detail: 'ok' });
    assert.equal(releasedLease.leaseId, 'lease-1');
  });

  it('discoverModels leases credentials and releases them after discovery', async () => {
    let releasedLease = null;
    const plugin = makePlugin('discovery-provider');
    plugin.discoverModels = async (ctx) => {
      assert.equal(ctx.credentialLease.oauth.accessToken, 'oauth-token');
      return [{ modelId: 'm1' }];
    };
    catalog.load([plugin]);

    const result = await catalog.discoverModels(
      { id: 'provider-2', adapter_key: 'discovery-provider' },
      {
        credentialManager: {
          async getCredentials(providerId) {
            assert.equal(providerId, 'provider-2');
            return {
              leaseId: 'lease-2',
              accountId: 'acc-2',
              authType: 'oauth',
              secret: null,
              oauth: { accessToken: 'oauth-token', refreshToken: null, expiresAt: null },
              metadata: {},
            };
          },
          release(lease) {
            releasedLease = lease;
          },
        },
      },
    );

    assert.deepEqual(result, [{ modelId: 'm1' }]);
    assert.equal(releasedLease.leaseId, 'lease-2');
  });

  it('testConnection falls back to executorCatalog for custom providers', async () => {
    const result = await catalog.testConnection(
      {
        id: 'provider-custom',
        provider_key: 'custom-provider',
        adapter_key: 'custom-provider',
        provider_mode: 'custom',
        executor_key: 'custom-executor',
      },
      {
        executorCatalog: {
          getExecutor(key) {
            assert.equal(key, 'custom-executor');
            return {
              async testConnection(ctx) {
                assert.equal(ctx.providerRecord.executor_key, 'custom-executor');
                return { ok: true, detail: 'custom-ok' };
              },
            };
          },
        },
      },
    );

    assert.deepEqual(result, { ok: true, detail: 'custom-ok' });
  });

  it('discoverModels falls back to executorCatalog for custom providers', async () => {
    const result = await catalog.discoverModels(
      {
        id: 'provider-custom',
        provider_key: 'custom-provider',
        adapter_key: 'custom-provider',
        provider_mode: 'custom',
        executor_key: 'custom-executor',
      },
      {
        executorCatalog: {
          getExecutor(key) {
            assert.equal(key, 'custom-executor');
            return {
              async discoverModels() {
                return [{ modelId: 'custom-model' }];
              },
            };
          },
        },
      },
    );

    assert.deepEqual(result, [{ modelId: 'custom-model' }]);
  });

  it('getTemplates exposes dashboard metadata for OAuth-capable providers', () => {
    catalog.load([codexPlugin, geminiOAuthPlugin, claudeaiPlugin]);

    const templates = catalog.getTemplates();

    assert.equal(templates['codex-api'].adapter_key, 'codex-api');
    assert.equal(templates['codex-api'].auth_type, 'managed');
    assert.equal(templates['codex-api'].oauth_adapter_key, 'openai-codex');
    assert.equal(templates['codex-api'].base_url, 'https://chatgpt.com/backend-api/codex');

    assert.equal(templates['gemini-openai'].oauth_adapter_key, 'google-gemini');
    assert.equal(templates['claudeai-api'].oauth_adapter_key, 'anthropic-claudeai');
  });
});

// ── Codex provider plugin ───────────────────────────────────────────

describe('codex-api provider plugin', () => {
  it('testConnection fails when no oauth token is leased', async () => {
    const result = await codexPlugin.testConnection({ credentialLease: {} });
    assert.equal(result.ok, false);
    assert.match(result.detail, /No Codex OAuth token/);
  });

  it('testConnection reports expiry without hitting the network', async () => {
    const result = await codexPlugin.testConnection({
      credentialLease: {
        oauth: {
          accessToken: 'tok',
          expiresAt: new Date(Date.now() - 1000).toISOString(),
        },
      },
    });
    assert.equal(result.ok, false);
    assert.match(result.detail, /expired/);
  });

  it('testConnection succeeds when an unexpired oauth token is present', async () => {
    const result = await codexPlugin.testConnection({
      credentialLease: {
        oauth: {
          accessToken: 'tok',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      },
    });
    assert.equal(result.ok, true);
    assert.match(result.detail, /credentials present/);
  });

  it('testConnection does not perform any HTTP call (scope cannot list /v1/models)', async () => {
    // If testConnection were making a live request it would fail with a
    // connection error in this test environment. Reaching the success
    // branch proves no outbound fetch happened.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => { throw new Error('testConnection must not call fetch'); };
    try {
      const result = await codexPlugin.testConnection({
        credentialLease: { oauth: { accessToken: 'tok' } },
      });
      assert.equal(result.ok, true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
