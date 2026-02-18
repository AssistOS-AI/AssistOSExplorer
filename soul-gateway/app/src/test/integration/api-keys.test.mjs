import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupDb, teardownDb, startTestServer, stopTestServer } from '../helpers/test-setup.mjs';
import { get, post, del, login, clearSessionCookie } from '../helpers/http-client.mjs';
import { TEST_DASHBOARD_PASSWORD, FAMILY } from '../helpers/fixtures.mjs';

describe('api-keys', () => {
  let familyId;
  let keyId;
  let rawKey;

  before(async () => {
    await setupDb();
    await startTestServer();
    await login(TEST_DASHBOARD_PASSWORD);

    // Create a family first
    const res = await post('/api/v1/soul-families', FAMILY);
    const body = await res.json();
    familyId = body.id;
  });

  after(async () => {
    clearSessionCookie();
    await stopTestServer();
    await teardownDb();
  });

  it('GET /api/v1/keys returns empty list initially', async () => {
    const res = await get('/api/v1/keys');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body));
    assert.equal(body.length, 0);
  });

  it('POST /api/v1/keys creates a key', async () => {
    const res = await post('/api/v1/keys', {
      family_id: familyId,
      label: 'test-key',
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.ok(body.id);
    assert.ok(body.key); // raw key returned on creation
    assert.ok(body.key.startsWith('sk-soul-'));
    assert.ok(body.key_hint);
    assert.equal(body.family_id, familyId);
    assert.equal(body.label, 'test-key');
    keyId = body.id;
    rawKey = body.key;
  });

  it('POST /api/v1/keys rejects missing family_id', async () => {
    const res = await post('/api/v1/keys', { label: 'no-family' });
    assert.equal(res.status, 400);
  });

  it('GET /api/v1/keys lists keys', async () => {
    const res = await get('/api/v1/keys');
    const body = await res.json();
    assert.equal(body.length, 1);
    assert.equal(body[0].id, keyId);
    assert.equal(body[0].label, 'test-key');
    // Raw key should NOT be in list response
    assert.equal(body[0].key, undefined);
  });

  it('GET /api/v1/keys?family_id filters by family', async () => {
    const res = await get(`/api/v1/keys?family_id=${familyId}`);
    const body = await res.json();
    assert.equal(body.length, 1);

    const res2 = await get('/api/v1/keys?family_id=00000000-0000-0000-0000-000000000000');
    const body2 = await res2.json();
    assert.equal(body2.length, 0);
  });

  it('DELETE /api/v1/keys/:id revokes the key', async () => {
    const res = await del(`/api/v1/keys/${keyId}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.revoked, true);
  });

  it('revoked key appears as revoked in list', async () => {
    const res = await get('/api/v1/keys');
    const body = await res.json();
    const key = body.find(k => k.id === keyId);
    assert.equal(key.is_revoked, true);
  });
});
