import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupDb, teardownDb, startTestServer, stopTestServer } from '../helpers/test-setup.mjs';
import { get, post, put, del, login, clearSessionCookie } from '../helpers/http-client.mjs';
import { TEST_DASHBOARD_PASSWORD, FAMILY } from '../helpers/fixtures.mjs';

describe('api-families', () => {
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

  it('GET /api/v1/soul-families returns empty list initially', async () => {
    const res = await get('/api/v1/soul-families');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body));
    assert.equal(body.length, 0);
  });

  it('POST /api/v1/soul-families creates a family', async () => {
    const res = await post('/api/v1/soul-families', FAMILY);
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.name, FAMILY.name);
    assert.equal(body.description, FAMILY.description);
    assert.equal(body.rpm_limit, FAMILY.rpm_limit);
    assert.equal(body.tpm_limit, FAMILY.tpm_limit);
    assert.ok(body.id);
    createdId = body.id;
  });

  it('POST /api/v1/soul-families rejects missing name', async () => {
    const res = await post('/api/v1/soul-families', { description: 'no name' });
    assert.equal(res.status, 400);
  });

  it('POST /api/v1/soul-families rejects duplicate name', async () => {
    const res = await post('/api/v1/soul-families', FAMILY);
    assert.equal(res.status, 409);
  });

  it('GET /api/v1/soul-families lists the created family', async () => {
    const res = await get('/api/v1/soul-families');
    const body = await res.json();
    assert.equal(body.length, 1);
    assert.equal(body[0].name, FAMILY.name);
  });

  it('GET /api/v1/soul-families/:id returns the family', async () => {
    const res = await get(`/api/v1/soul-families/${createdId}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.id, createdId);
    assert.equal(body.name, FAMILY.name);
  });

  it('GET /api/v1/soul-families/:id returns 404 for missing', async () => {
    const res = await get('/api/v1/soul-families/00000000-0000-0000-0000-000000000000');
    assert.equal(res.status, 404);
  });

  it('PUT /api/v1/soul-families/:id updates the family', async () => {
    const res = await put(`/api/v1/soul-families/${createdId}`, {
      description: 'updated description',
      rpm_limit: 200,
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.description, 'updated description');
    assert.equal(body.rpm_limit, 200);
    assert.equal(body.name, FAMILY.name); // unchanged
  });

  it('DELETE /api/v1/soul-families/:id removes the family', async () => {
    const res = await del(`/api/v1/soul-families/${createdId}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.deleted, true);
  });

  it('DELETE /api/v1/soul-families/:id returns 404 for missing', async () => {
    const res = await del(`/api/v1/soul-families/${createdId}`);
    assert.equal(res.status, 404);
  });
});
