import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupDb, teardownDb, startTestServer, stopTestServer } from '../helpers/test-setup.mjs';
import { get, options, login, setSessionCookie, clearSessionCookie } from '../helpers/http-client.mjs';
import { TEST_DASHBOARD_PASSWORD } from '../helpers/fixtures.mjs';

describe('server-routing', () => {
  before(async () => {
    await setupDb();
    await startTestServer();
    // Login so dashboard-protected routes are accessible
    await login(TEST_DASHBOARD_PASSWORD);
  });

  after(async () => {
    clearSessionCookie();
    await stopTestServer();
    await teardownDb();
  });

  it('GET /health returns ok', async () => {
    const res = await get('/health');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'ok');
    assert.ok(typeof body.uptime === 'number');
  });

  it('OPTIONS request returns CORS headers', async () => {
    const res = await options('/api/v1/soul-families');
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
  });

  it('GET unknown path returns 404', async () => {
    const res = await get('/nonexistent-path');
    assert.equal(res.status, 404);
  });

  it('GET /api/v1/nonexistent returns 404 from API router', async () => {
    const res = await get('/api/v1/nonexistent');
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.ok(body.error);
  });

  it('GET / serves dashboard HTML', async () => {
    const res = await get('/');
    assert.equal(res.status, 200);
    assert.ok(res.headers.get('content-type').includes('text/html'));
  });

  it('GET /login serves login page', async () => {
    // Login page is accessible without auth
    clearSessionCookie();
    const res = await get('/login');
    assert.equal(res.status, 200);
    assert.ok(res.headers.get('content-type').includes('text/html'));
    // Re-login for subsequent tests
    await login(TEST_DASHBOARD_PASSWORD);
  });
});
