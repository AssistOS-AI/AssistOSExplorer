import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../../config.mjs';
import { setupDb, teardownDb, startTestServer, stopTestServer } from '../helpers/test-setup.mjs';
import { post, login, clearSessionCookie, chatCompletions } from '../helpers/http-client.mjs';
import {
  createMockUpstream, startMockUpstream, stopMockUpstream,
  resetMock, setNextResponse, getRequestLog,
} from '../helpers/mock-upstream.mjs';
import {
  TEST_DASHBOARD_PASSWORD, FAMILY, MODEL,
  CHAT_REQUEST, CHAT_REQUEST_STREAMING,
  NON_STREAM_RESPONSE,
} from '../helpers/fixtures.mjs';

describe('pipeline', () => {
  let mockServer;
  let apiKey;

  before(async () => {
    // Start mock upstream
    const mock = createMockUpstream();
    const info = await startMockUpstream(mock);
    mockServer = info.server;
    config.upstreamUrl = info.url;

    await setupDb();
    await startTestServer();
    await login(TEST_DASHBOARD_PASSWORD);

    // Create family, model, and API key
    const famRes = await post('/api/v1/soul-families', FAMILY);
    const family = await famRes.json();

    await post('/api/v1/models', MODEL);

    const keyRes = await post('/api/v1/keys', {
      family_id: family.id,
      label: 'pipeline-test-key',
    });
    const keyBody = await keyRes.json();
    apiKey = keyBody.key;
  });

  beforeEach(() => {
    resetMock();
  });

  after(async () => {
    clearSessionCookie();
    await stopTestServer();
    await teardownDb();
    await stopMockUpstream(mockServer);
  });

  describe('non-streaming', () => {
    it('returns a valid chat completion', async () => {
      const res = await chatCompletions(CHAT_REQUEST, apiKey);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.ok(body.choices);
      assert.equal(body.choices[0].message.content, NON_STREAM_RESPONSE.choices[0].message.content);
      assert.ok(body.usage);
    });

    it('forwards the correct model to upstream', async () => {
      await chatCompletions(CHAT_REQUEST, apiKey);
      const log = getRequestLog();
      assert.ok(log.length >= 1);
      const upstreamReq = log.find(r => r.url === '/v1/chat/completions');
      assert.ok(upstreamReq);
      // test-model should be resolved to upstream_model from MODEL fixture
      assert.equal(upstreamReq.body.model, MODEL.upstream_model);
    });

    it('rejects missing Authorization header', async () => {
      const res = await chatCompletions(CHAT_REQUEST, '');
      assert.equal(res.status, 401);
    });

    it('rejects invalid API key', async () => {
      const res = await chatCompletions(CHAT_REQUEST, 'sk-soul-invalid-key-12345');
      assert.equal(res.status, 401);
    });

    it('rejects missing model/messages', async () => {
      const res = await chatCompletions({ model: 'test-model' }, apiKey);
      assert.equal(res.status, 400);
    });

    it('returns 404 for unknown model', async () => {
      const res = await chatCompletions({
        ...CHAT_REQUEST,
        model: 'nonexistent-model',
      }, apiKey);
      assert.equal(res.status, 404);
    });

    it('handles upstream error', async () => {
      setNextResponse({ status: 500 });
      const res = await chatCompletions(CHAT_REQUEST, apiKey);
      assert.equal(res.status, 500);
    });
  });

  describe('streaming', () => {
    it('returns SSE stream', async () => {
      const res = await chatCompletions(CHAT_REQUEST_STREAMING, apiKey);
      assert.equal(res.status, 200);
      assert.ok(res.headers.get('content-type').includes('text/event-stream'));

      const text = await res.text();
      assert.ok(text.includes('data:'));
      assert.ok(text.includes('[DONE]'));
    });

    it('stream contains content chunks', async () => {
      const res = await chatCompletions(CHAT_REQUEST_STREAMING, apiKey);
      const text = await res.text();
      const lines = text.split('\n').filter(l => l.startsWith('data: '));
      assert.ok(lines.length >= 2); // at least content + DONE
    });
  });

  describe('blacklist blocking', () => {
    it('blocks request matching blacklist rule', async () => {
      // Create a blacklist rule
      await post('/api/v1/blacklist', {
        pattern: 'forbidden-content',
        match_type: 'substring',
        description: 'test block',
      });

      const res = await chatCompletions({
        model: 'test-model',
        messages: [{ role: 'user', content: 'This has forbidden-content in it' }],
      }, apiKey);
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body.error.type, 'content_blocked');
    });
  });

  describe('model mapping', () => {
    it('applies family model mapping', async () => {
      // Family has model_mapping: { 'gpt-4': 'axiologic-deep' }
      // We need an 'axiologic-deep' model config that maps to a real upstream
      await post('/api/v1/models', {
        name: 'axiologic-deep',
        upstream_model: 'claude-opus-4.6',
        mode: 'deep',
        input_price: 5,
        output_price: 25,
      });

      const res = await chatCompletions({
        model: 'gpt-4', // should be mapped to axiologic-deep
        messages: [{ role: 'user', content: 'test mapping' }],
      }, apiKey);
      assert.equal(res.status, 200);

      const log = getRequestLog();
      const upstreamReq = log.find(r => r.url === '/v1/chat/completions');
      assert.equal(upstreamReq.body.model, 'claude-opus-4.6');
    });
  });

  describe('response cache', () => {
    it('returns cached response on duplicate non-streaming request', async () => {
      const cacheReq = {
        model: 'test-model',
        messages: [{ role: 'user', content: 'cache-test-unique-' + Date.now() }],
        stream: false,
      };

      // First request — goes to upstream
      const res1 = await chatCompletions(cacheReq, apiKey);
      assert.equal(res1.status, 200);
      const body1 = await res1.json();
      const log1 = getRequestLog();
      assert.ok(log1.some(r => r.url === '/v1/chat/completions'), 'First request should hit upstream');

      // Second request — same prompt, should be served from cache
      const res2 = await chatCompletions(cacheReq, apiKey);
      assert.equal(res2.status, 200);
      const body2 = await res2.json();
      const log2 = getRequestLog();

      // No new upstream request — cache served
      assert.equal(log2.filter(r => r.url === '/v1/chat/completions').length, 0,
        'Second request should NOT hit upstream (cache hit)');

      // Response content should match
      assert.equal(body2.choices[0].message.content, body1.choices[0].message.content);
      assert.ok(body2.usage);
    });

    it('does not cache streaming requests', async () => {
      const streamReq = {
        model: 'test-model',
        messages: [{ role: 'user', content: 'stream-no-cache-' + Date.now() }],
        stream: true,
      };

      // First streaming request
      const res1 = await chatCompletions(streamReq, apiKey);
      assert.equal(res1.status, 200);
      await res1.text(); // consume the stream
      getRequestLog(); // clear

      // Second streaming request with same content — should still hit upstream
      const res2 = await chatCompletions(streamReq, apiKey);
      assert.equal(res2.status, 200);
      await res2.text();
      const log2 = getRequestLog();
      assert.ok(log2.some(r => r.url === '/v1/chat/completions'),
        'Streaming request should always hit upstream');
    });

    it('different models produce different cache entries', async () => {
      // Create a second model
      await post('/api/v1/models', {
        name: 'test-model-2',
        upstream_model: 'claude-sonnet-4.5',
        mode: 'fast',
        input_price: 1,
        output_price: 5,
      });

      const msgs = [{ role: 'user', content: 'multi-model-cache-' + Date.now() }];

      // Request to model 1
      const res1 = await chatCompletions({ model: 'test-model', messages: msgs, stream: false }, apiKey);
      assert.equal(res1.status, 200);
      await res1.json();
      getRequestLog(); // clear

      // Request to model 2 with same messages — should NOT be a cache hit
      const res2 = await chatCompletions({ model: 'test-model-2', messages: msgs, stream: false }, apiKey);
      assert.equal(res2.status, 200);
      const log2 = getRequestLog();
      assert.ok(log2.some(r => r.url === '/v1/chat/completions'),
        'Different model should miss cache and hit upstream');
    });
  });

  describe('cost budget throttling', () => {
    it('blocks request when family budget is exceeded', async () => {
      // Create a family with a very low budget ($0.0001 — less than one request costs)
      const famRes = await post('/api/v1/soul-families', {
        name: 'budget-family-' + Date.now(),
        description: 'Low budget family',
        rpm_limit: 100,
        tpm_limit: 200000,
        monthly_budget: 0.0001,
      });
      const family = await famRes.json();

      // Create a key for this family
      const keyRes = await post('/api/v1/keys', {
        family_id: family.id,
        label: 'budget-test-key',
      });
      const budgetKey = (await keyRes.json()).key;

      // First request — should succeed (no spend accumulated yet)
      const res1 = await chatCompletions({
        model: 'test-model',
        messages: [{ role: 'user', content: 'budget-test-1-' + Date.now() }],
        stream: false,
      }, budgetKey);
      assert.equal(res1.status, 200);
      await res1.json();

      // Wait briefly for the log to be written and cache to update
      await new Promise(r => setTimeout(r, 100));

      // Second request — family budget should be exceeded now
      const res2 = await chatCompletions({
        model: 'test-model',
        messages: [{ role: 'user', content: 'budget-test-2-' + Date.now() }],
        stream: false,
      }, budgetKey);
      assert.equal(res2.status, 429);
      const body2 = await res2.json();
      assert.equal(body2.error.type, 'budget_exceeded');
      assert.ok(body2.error.message.includes('family'));
    });

    it('blocks request when key budget is exceeded', async () => {
      // Create a family with no budget limit
      const famRes = await post('/api/v1/soul-families', {
        name: 'key-budget-family-' + Date.now(),
        description: 'Unlimited family',
        rpm_limit: 100,
        tpm_limit: 200000,
      });
      const family = await famRes.json();

      // Create a key with a very low budget
      const keyRes = await post('/api/v1/keys', {
        family_id: family.id,
        label: 'low-budget-key',
        monthly_budget: 0.0001,
      });
      const budgetKey = (await keyRes.json()).key;

      // First request — should succeed
      const res1 = await chatCompletions({
        model: 'test-model',
        messages: [{ role: 'user', content: 'key-budget-1-' + Date.now() }],
        stream: false,
      }, budgetKey);
      assert.equal(res1.status, 200);
      await res1.json();

      await new Promise(r => setTimeout(r, 100));

      // Second request — key budget should be exceeded
      const res2 = await chatCompletions({
        model: 'test-model',
        messages: [{ role: 'user', content: 'key-budget-2-' + Date.now() }],
        stream: false,
      }, budgetKey);
      assert.equal(res2.status, 429);
      const body2 = await res2.json();
      assert.equal(body2.error.type, 'budget_exceeded');
      assert.ok(body2.error.message.includes('key'));
    });

    it('allows requests when budget is null (unlimited)', async () => {
      // The main test family has no budget — requests should always work
      const res = await chatCompletions({
        model: 'test-model',
        messages: [{ role: 'user', content: 'no-budget-' + Date.now() }],
        stream: false,
      }, apiKey);
      assert.equal(res.status, 200);
    });

    it('returns Retry-After header on budget exceeded', async () => {
      // Create a family with zero budget (immediately exceeded)
      const famRes = await post('/api/v1/soul-families', {
        name: 'zero-budget-family-' + Date.now(),
        rpm_limit: 100,
        tpm_limit: 200000,
        monthly_budget: 0,
      });
      const family = await famRes.json();

      const keyRes = await post('/api/v1/keys', {
        family_id: family.id,
        label: 'zero-budget-key',
      });
      const budgetKey = (await keyRes.json()).key;

      // Any request should be blocked since budget is 0
      // But we need at least one logged request first so SUM > 0
      // Actually with budget=0, even SUM=0 means 0 >= 0 → blocked
      const res = await chatCompletions({
        model: 'test-model',
        messages: [{ role: 'user', content: 'zero-budget-' + Date.now() }],
        stream: false,
      }, budgetKey);
      assert.equal(res.status, 429);
      const retryAfter = res.headers.get('retry-after');
      assert.ok(retryAfter, 'Should include Retry-After header');
      assert.ok(Number(retryAfter) > 0, 'Retry-After should be positive');
    });
  });

  describe('model queue serialization', () => {
    it('serializes concurrent requests to the same model', async () => {
      // Add latency so requests overlap
      setNextResponse({ latencyMs: 100 });

      const req = {
        model: 'test-model',
        messages: [{ role: 'user', content: 'queue-test-1-' + Date.now() }],
        stream: false,
      };
      const req2 = {
        model: 'test-model',
        messages: [{ role: 'user', content: 'queue-test-2-' + Date.now() }],
        stream: false,
      };

      const start = Date.now();
      // Fire both requests concurrently
      const [res1, res2] = await Promise.all([
        chatCompletions(req, apiKey),
        chatCompletions(req2, apiKey),
      ]);

      const elapsed = Date.now() - start;

      assert.equal(res1.status, 200);
      assert.equal(res2.status, 200);
      await res1.json();
      await res2.json();

      // With serialization, total time should be >= 2 * latency (sequential)
      // Without serialization, it would be ~latency (parallel)
      assert.ok(elapsed >= 180,
        `Expected >= 180ms for serialized requests, got ${elapsed}ms`);
    });
  });
});
