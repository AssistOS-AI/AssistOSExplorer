import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupDb, teardownDb, startTestServer, stopTestServer } from '../helpers/test-setup.mjs';
import { get, post, put, del, login, clearSessionCookie } from '../helpers/http-client.mjs';
import { TEST_DASHBOARD_PASSWORD, FAMILY } from '../helpers/fixtures.mjs';

describe('api-blacklist', () => {
  let familyId;
  let ruleId;

  before(async () => {
    await setupDb();
    await startTestServer();
    await login(TEST_DASHBOARD_PASSWORD);

    const res = await post('/api/v1/soul-families', FAMILY);
    familyId = (await res.json()).id;
  });

  after(async () => {
    clearSessionCookie();
    await stopTestServer();
    await teardownDb();
  });

  it('GET /api/v1/blacklist returns empty list initially', async () => {
    const res = await get('/api/v1/blacklist');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body));
    assert.equal(body.length, 0);
  });

  it('POST /api/v1/blacklist creates a rule', async () => {
    const res = await post('/api/v1/blacklist', {
      family_id: familyId,
      pattern: 'bad-content',
      match_type: 'substring',
      description: 'test rule',
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.ok(body.id);
    assert.equal(body.pattern, 'bad-content');
    assert.equal(body.match_type, 'substring');
    assert.equal(body.is_enabled, true);
    ruleId = body.id;
  });

  it('POST /api/v1/blacklist rejects missing fields', async () => {
    const res = await post('/api/v1/blacklist', { pattern: 'test' });
    assert.equal(res.status, 400);
  });

  it('POST /api/v1/blacklist rejects invalid match_type', async () => {
    const res = await post('/api/v1/blacklist', {
      pattern: 'test',
      match_type: 'invalid',
    });
    assert.equal(res.status, 400);
  });

  it('POST /api/v1/blacklist creates global rule (no family_id)', async () => {
    const res = await post('/api/v1/blacklist', {
      pattern: 'global-banned',
      match_type: 'exact',
      description: 'global rule',
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.family_id, null);
  });

  it('GET /api/v1/blacklist lists rules', async () => {
    const res = await get('/api/v1/blacklist');
    const body = await res.json();
    assert.ok(body.length >= 2);
  });

  it('PUT /api/v1/blacklist/:id updates a rule', async () => {
    const res = await put(`/api/v1/blacklist/${ruleId}`, {
      pattern: 'updated-pattern',
      is_enabled: false,
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.pattern, 'updated-pattern');
    assert.equal(body.is_enabled, false);
  });

  it('DELETE /api/v1/blacklist/:id removes a rule', async () => {
    const res = await del(`/api/v1/blacklist/${ruleId}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.deleted, true);
  });

  it('DELETE /api/v1/blacklist/:id returns 404 for missing', async () => {
    const res = await del(`/api/v1/blacklist/${ruleId}`);
    assert.equal(res.status, 404);
  });
});
