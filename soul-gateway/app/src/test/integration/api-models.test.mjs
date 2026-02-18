import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupDb, teardownDb, startTestServer, stopTestServer } from '../helpers/test-setup.mjs';
import { get, post, put, del, login, clearSessionCookie } from '../helpers/http-client.mjs';
import { TEST_DASHBOARD_PASSWORD, MODEL } from '../helpers/fixtures.mjs';

describe('api-models', () => {
  let createdId;

  before(async () => {
    await setupDb();
    await startTestServer();
    await login(TEST_DASHBOARD_PASSWORD);
  });

  after(async () => {
    clearSessionCookie();
    await stopTestServer();
    await teardownDb();
  });

  it('GET /api/v1/models returns empty list initially', async () => {
    const res = await get('/api/v1/models');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body));
    assert.equal(body.length, 0);
  });

  it('POST /api/v1/models creates a model', async () => {
    const res = await post('/api/v1/models', MODEL);
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.name, MODEL.name);
    assert.equal(body.upstream_model, MODEL.upstream_model);
    assert.equal(body.mode, MODEL.mode);
    assert.ok(body.id);
    createdId = body.id;
  });

  it('POST /api/v1/models rejects missing required fields', async () => {
    const res = await post('/api/v1/models', { name: 'no-upstream' });
    assert.equal(res.status, 400);
  });

  it('POST /api/v1/models rejects duplicate name', async () => {
    const res = await post('/api/v1/models', MODEL);
    assert.equal(res.status, 409);
  });

  it('GET /api/v1/models lists created model', async () => {
    const res = await get('/api/v1/models');
    const body = await res.json();
    assert.equal(body.length, 1);
    assert.equal(body[0].name, MODEL.name);
  });

  it('PUT /api/v1/models/:id updates model', async () => {
    const res = await put(`/api/v1/models/${createdId}`, {
      display_name: 'Updated Display',
      input_price: 10,
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.display_name, 'Updated Display');
  });

  it('PUT /api/v1/models/:id/toggle toggles enabled', async () => {
    const res = await put(`/api/v1/models/${createdId}/toggle`, {});
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.is_enabled, false);

    // Toggle back
    const res2 = await put(`/api/v1/models/${createdId}/toggle`, {});
    const body2 = await res2.json();
    assert.equal(body2.is_enabled, true);
  });

  it('DELETE /api/v1/models/:id removes model', async () => {
    const res = await del(`/api/v1/models/${createdId}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
  });

  it('DELETE /api/v1/models/:id returns 404 for missing', async () => {
    const res = await del(`/api/v1/models/${createdId}`);
    assert.equal(res.status, 404);
  });
});
