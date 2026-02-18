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
});
