import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../../config.mjs';
import { setupDb, teardownDb, startTestServer, stopTestServer } from '../helpers/test-setup.mjs';
import { get, post, login, clearSessionCookie, chatCompletions } from '../helpers/http-client.mjs';
import {
  createMockUpstream, startMockUpstream, stopMockUpstream, resetMock,
} from '../helpers/mock-upstream.mjs';
import { TEST_DASHBOARD_PASSWORD, FAMILY, MODEL, CHAT_REQUEST } from '../helpers/fixtures.mjs';

describe('api-logs', () => {
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
    const keyRes = await post('/api/v1/keys', { family_id: family.id, label: 'logs-test' });
    apiKey = (await keyRes.json()).key;

    // Make a few requests to generate logs
    await chatCompletions(CHAT_REQUEST, apiKey);
    await chatCompletions(CHAT_REQUEST, apiKey);
    // Small delay for DB writes
    await new Promise(r => setTimeout(r, 100));
  });

  after(async () => {
    clearSessionCookie();
    await stopTestServer();
    await teardownDb();
    await stopMockUpstream(mockServer);
  });

  it('GET /api/v1/logs returns paginated logs', async () => {
    const res = await get('/api/v1/logs');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.total >= 2);
    assert.ok(body.rows.length >= 2);
    assert.ok(body.limit);
    assert.equal(body.offset, 0);
  });

  it('GET /api/v1/logs?limit=1 respects pagination', async () => {
    const res = await get('/api/v1/logs?limit=1');
    const body = await res.json();
    assert.equal(body.rows.length, 1);
    assert.equal(body.limit, 1);
  });

  it('GET /api/v1/logs?status=success filters by status', async () => {
    const res = await get('/api/v1/logs?status=success');
    const body = await res.json();
    assert.ok(body.rows.every(r => r.error_type === null));
  });

  it('GET /api/v1/logs/:id returns individual log', async () => {
    // Get a log ID first
    const listRes = await get('/api/v1/logs?limit=1');
    const listBody = await listRes.json();
    const logId = listBody.rows[0].id;

    const res = await get(`/api/v1/logs/${logId}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.id, logId);
    assert.ok(body.started_at);
    assert.ok(body.requested_model);
  });

  it('GET /api/v1/logs/:id returns 404 for missing', async () => {
    const res = await get('/api/v1/logs/00000000-0000-0000-0000-000000000000');
    assert.equal(res.status, 404);
  });

  it('logs contain expected fields', async () => {
    const res = await get('/api/v1/logs?limit=1');
    const body = await res.json();
    const log = body.rows[0];
    assert.ok(log.family_name);
    assert.ok(log.requested_model);
    assert.ok(log.resolved_model);
    assert.equal(log.status_code, 200);
    assert.ok(typeof log.latency_ms === 'number');
  });
});
