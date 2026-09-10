import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { chromium } from '@playwright/test';

test('authentication preserves the final surface and records its first navigation failure safely', { timeout: 30_000 }, async (t) => {
  const requests = [];
  const account = { username: 'fixture-user', password: 'fixture-password' };
  let mode = 'normal';
  const server = http.createServer(async (incoming, response) => {
    const url = new URL(incoming.url, 'http://fixture.invalid');
    requests.push({ method: incoming.method, pathname: url.pathname });
    if (url.pathname === '/auth/token') {
      const authenticated = incoming.headers.cookie?.includes('fixture-session=authenticated');
      response.writeHead(authenticated ? 200 : 401, { 'content-type': 'application/json' });
      response.end(JSON.stringify(authenticated
        ? { user: { id: 'local:fixture-user', username: account.username, roles: ['user'] } }
        : { error: 'unauthenticated' }));
      return;
    }
    if (url.pathname === '/auth/login' && incoming.method === 'POST') {
      const chunks = [];
      for await (const chunk of incoming) chunks.push(chunk);
      const form = new URLSearchParams(Buffer.concat(chunks).toString());
      if (form.get('username') !== account.username || form.get('password') !== account.password) {
        response.writeHead(401).end('Invalid username or password');
        return;
      }
      response.writeHead(303, { location: form.get('returnTo'), 'set-cookie': 'fixture-session=authenticated; Path=/; HttpOnly' });
      response.end();
      return;
    }
    response.setHeader('content-type', 'text/html');
    if (url.pathname === '/auth/login') {
      response.end(`<form action="/auth/login" method="post"><input name="username"><input name="password" type="password"><input name="returnTo" type="hidden" value="${url.searchParams.get('returnTo')}"><button type="submit">Sign in</button></form>`);
      return;
    }
    if (url.pathname === '/service/') {
      if (mode === 'failed-navigation') {
        response.destroy();
        return;
      }
      if (mode === 'hanging-resource') {
        response.end('<h1>Service</h1><img src="/pending.png?opaque=private-url-sentinel"><script src="/completed.js"></script>');
        return;
      }
      response.end('<h1>Service</h1><form action="/service/login" method="post"><input name="username"><input name="password" type="password"><button type="submit">Service login</button></form>');
      return;
    }
    if (url.pathname === '/pending.png') {
      response.writeHead(200, { 'content-type': 'image/png', 'x-private-fixture': 'private-header-sentinel' });
      response.flushHeaders();
      return;
    }
    if (url.pathname === '/completed.js') {
      response.writeHead(200, { 'content-type': 'application/javascript' });
      response.end('fetch("/initiated.json?opaque=private-initiator-sentinel")');
      return;
    }
    if (url.pathname === '/initiated.json') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
      return;
    }
    response.writeHead(404).end('Unexpected intermediate surface');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseURL = `http://127.0.0.1:${server.address().port}`;
  process.env.SMOKE_BASE_URL = baseURL;
  const { signIn } = await import('./auth.mjs');
  const { attachPageDiagnostics } = await import('./fixtures.mjs');
  let browser;
  try {
    browser = await chromium.launch();
    const context = await browser.newContext({ baseURL });
    const page = await context.newPage();
    const principal = await signIn(page, account, '/service/', { requireConfiguredPrincipal: true });
    assert.equal(principal.canonicalUsername, account.username);
    assert.equal(new URL(page.url()).pathname, '/service/');
    assert.equal(requests.filter((entry) => entry.pathname === '/service/').length, 1,
      'the target must not boot before login or be reloaded after login');
    assert.deepEqual(requests.filter((entry) => entry.pathname === '/auth/login').map((entry) => entry.method), ['GET', 'POST']);
    assert.equal(requests.filter((entry) => entry.pathname === '/' || entry.pathname.startsWith('/explorer')).length, 0);
    assert.equal(await page.locator('input[name="username"]').inputValue(), '');
    assert.equal(await page.locator('input[name="password"]').inputValue(), '');

    await signIn(page, account, '/service/', { requireConfiguredPrincipal: true });
    assert.equal(requests.filter((entry) => entry.pathname === '/service/').length, 2);
    assert.equal(requests.filter((entry) => entry.pathname === '/auth/login').length, 2,
      'an existing Router session must not revisit its login form');
    assert.equal(requests.filter((entry) => entry.pathname === '/service/login').length, 0,
      'Ploinky credentials must never be submitted to the service login');
    assert.equal(await page.locator('input[name="username"]').inputValue(), '');
    assert.equal(await page.locator('input[name="password"]').inputValue(), '');
    await assert.rejects(signIn(page, { ...account, username: 'another-user' }, '/service/', {
      requireConfiguredPrincipal: true,
    }), /does not match the configured account/);
    await context.close();

    for (const scenario of ['hanging-resource', 'failed-navigation']) {
      await t.test(scenario, async () => {
        mode = scenario;
        const failureContext = await browser.newContext({ baseURL });
        const failurePage = await failureContext.newPage();
        failurePage.setDefaultNavigationTimeout(800);
        const artifactRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'auth-navigation-'));
        const diagnostics = attachPageDiagnostics(failurePage, {
          outputPath: (name) => path.join(artifactRoot, name),
        }, scenario);
        let firstNavigationError;
        let finalLoadWaits = 0;
        const waitForNavigation = failurePage.waitForNavigation.bind(failurePage);
        failurePage.waitForNavigation = async (...args) => {
          try { return await waitForNavigation(...args); } catch (error) {
            firstNavigationError = error;
            throw error;
          }
        };
        const waitForLoadState = failurePage.waitForLoadState.bind(failurePage);
        failurePage.waitForLoadState = (...args) => { finalLoadWaits += 1; return waitForLoadState(...args); };
        try {
          let snapshot;
          await assert.rejects(signIn(failurePage, account, '/service/', { requireConfiguredPrincipal: true }), (error) => {
            assert.equal(error, firstNavigationError, 'the first navigation exception must be propagated');
            snapshot = error.navigationDiagnostics;
            assert.equal(snapshot.stage, 'login-submit-navigation');
            assert.equal(snapshot.protocolAvailable, true);
            assert.equal(finalLoadWaits, 0, 'a failed navigation must not be followed by another load wait');
            return true;
          });
          assert.ok(snapshot.lifecycle.some(({ event }) => event === 'framenavigated'));
          assert.ok(snapshot.requests.some(({ url, method, state }) => url.endsWith('/auth/login') && method === 'POST' && state === 'finished'),
            'a completed redirected POST must not remain pending');
          assert.ok(snapshot.protocolRequests.some(({ state }) => state === 'redirected'));
          if (scenario === 'hanging-resource') {
            assert.ok(snapshot.pending.some(({ url, resourceType, status }) => url.endsWith('/pending.png') && resourceType === 'image' && status === 200));
            assert.ok(snapshot.requests.some(({ url, state }) => url.endsWith('/completed.js') && state === 'finished'));
            assert.ok(snapshot.protocolRequests.some(({ url, initiator, state }) => url.endsWith('/initiated.json') && state === 'finished'
              && initiator.type === 'script' && initiator.stack.some(({ url: source }) => source.endsWith('/completed.js'))));
          } else {
            assert.match(snapshot.failure.message, /net::ERR_/);
            assert.ok(snapshot.requests.some(({ resourceType, state }) => resourceType === 'document'
              && ['failed', 'pending'].includes(state)), 'retain a document whose terminal request event may follow the navigation rejection');
          }
          const captured = JSON.stringify(snapshot);
          await failureContext.close();
          assert.equal(JSON.stringify(snapshot), captured, 'cleanup cannot rewrite the failure-time snapshot');
          await diagnostics.flush();
          const artifact = await fs.readFile(path.join(artifactRoot, 'diagnostics', `${scenario}.browser-events.json`), 'utf8');
          const persisted = JSON.parse(artifact).find(({ kind }) => kind === 'navigationfailure');
          assert.deepEqual(persisted.pending, snapshot.pending);
          for (const privateValue of [account.username, account.password, 'private-url-sentinel', 'private-header-sentinel',
            'private-response-body-sentinel', 'private-initiator-sentinel', 'fixture-session=authenticated']) {
            assert.equal(JSON.stringify(persisted).includes(privateValue), false, privateValue);
          }
          assert.equal(/"(?:headers|cookies|postData|body|storage)"/.test(JSON.stringify(persisted)), false);
        } finally {
          await failureContext.close();
          await fs.rm(artifactRoot, { recursive: true, force: true });
        }
      });
    }
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
