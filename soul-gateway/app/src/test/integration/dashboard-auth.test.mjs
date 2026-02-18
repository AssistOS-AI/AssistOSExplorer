import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupDb, teardownDb, startTestServer, stopTestServer, baseUrl } from '../helpers/test-setup.mjs';
import { get, login, clearSessionCookie, setSessionCookie } from '../helpers/http-client.mjs';
import { TEST_DASHBOARD_PASSWORD } from '../helpers/fixtures.mjs';

describe('dashboard-auth', () => {
  before(async () => {
    await setupDb();
    await startTestServer();
  });

  after(async () => {
    clearSessionCookie();
    await stopTestServer();
    await teardownDb();
  });

  it('unauthenticated request to / redirects to /login', async () => {
    clearSessionCookie();
    const res = await get('/');
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/login');
  });

  it('unauthenticated API request returns 401', async () => {
    clearSessionCookie();
    const res = await get('/api/v1/soul-families');
    assert.equal(res.status, 401);
  });

  it('POST /login with wrong password shows error', async () => {
    const res = await fetch(`${baseUrl()}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'password=wrong',
      redirect: 'manual',
    });
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('Invalid password'));
  });

  it('POST /login with correct password sets cookie and redirects', async () => {
    const res = await login(TEST_DASHBOARD_PASSWORD);
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/');
    const setCookie = res.headers.get('set-cookie');
    assert.ok(setCookie.includes('soul_session='));
    assert.ok(setCookie.includes('HttpOnly'));
  });

  it('authenticated request to / returns 200', async () => {
    // Already logged in from previous test
    const res = await get('/');
    assert.equal(res.status, 200);
  });

  it('authenticated API request returns 200', async () => {
    const res = await get('/api/v1/soul-families');
    assert.equal(res.status, 200);
  });

  it('GET /logout clears cookie and redirects', async () => {
    const res = await get('/logout');
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/login');
    const setCookie = res.headers.get('set-cookie');
    assert.ok(setCookie.includes('Max-Age=0'));
  });

  it('expired/tampered cookie is rejected', async () => {
    setSessionCookie('soul_session=12345.fakehash');
    const res = await get('/');
    assert.equal(res.status, 302); // redirects to login
    clearSessionCookie();
  });

  it('health endpoint is always accessible without auth', async () => {
    clearSessionCookie();
    const res = await get('/health');
    assert.equal(res.status, 200);
  });
});
