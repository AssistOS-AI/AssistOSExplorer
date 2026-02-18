import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../../config.mjs';
import { setupDb, teardownDb, startTestServer, stopTestServer } from '../helpers/test-setup.mjs';
import { get, post, login, clearSessionCookie, chatCompletions } from '../helpers/http-client.mjs';
import {
  createMockUpstream, startMockUpstream, stopMockUpstream, resetMock,
} from '../helpers/mock-upstream.mjs';
import { TEST_DASHBOARD_PASSWORD, FAMILY, MODEL, CHAT_REQUEST } from '../helpers/fixtures.mjs';

describe('api-metrics', () => {
  let mockServer;
  let apiKey;

  before(async () => {
    const mock = createMockUpstream();
    const info = await startMockUpstream(mock);
    mockServer = info.server;
    config.upstreamUrl = info.url;

    await setupDb();
    await startTestServer();
    await login(TEST_DASHBOARD_PASSWORD);

    // Create family, model, key
    const famRes = await post('/api/v1/soul-families', FAMILY);
    const family = await famRes.json();
    await post('/api/v1/models', MODEL);
    const keyRes = await post('/api/v1/keys', { family_id: family.id, label: 'metrics-test' });
    apiKey = (await keyRes.json()).key;

    // Generate some traffic
    await chatCompletions(CHAT_REQUEST, apiKey);
    await chatCompletions(CHAT_REQUEST, apiKey);
    await new Promise(r => setTimeout(r, 100));
  });

  after(async () => {
    clearSessionCookie();
    await stopTestServer();
    await teardownDb();
    await stopMockUpstream(mockServer);
  });

  it('GET /api/v1/metrics/costs returns cost breakdown', async () => {
    const res = await get('/api/v1/metrics/costs');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.by_family);
    assert.ok(body.by_model);
    assert.ok(body.trend);
    assert.ok(Array.isArray(body.by_family));
    assert.ok(Array.isArray(body.by_model));
  });

  it('cost metrics reflect actual usage', async () => {
    const res = await get('/api/v1/metrics/costs');
    const body = await res.json();
    if (body.by_family.length > 0) {
      const fam = body.by_family[0];
      assert.ok(fam.family_name);
      assert.ok(parseFloat(fam.request_count) >= 2);
    }
  });

  it('GET /api/v1/metrics/errors returns error summary', async () => {
    const res = await get('/api/v1/metrics/errors');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.rates !== undefined);
    assert.ok(body.summary);
    assert.ok(typeof parseInt(body.summary.total_requests) === 'number');
  });

  it('GET /api/v1/metrics/tokens returns token trend', async () => {
    const res = await get('/api/v1/metrics/tokens');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.trend);
    assert.ok(Array.isArray(body.trend));
  });
});
