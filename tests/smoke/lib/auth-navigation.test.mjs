import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { chromium } from '@playwright/test';

test('authentication visits only its final surface and preserves a separate service login', { timeout: 90_000 }, async (t) => {
  const requests = [];
  const localAccount = { username: 'fixture-user', password: 'fixture-password' };
  const providerAccount = { username: 'fixture-user', loginEmail: 'fixture-user@example.test', signInMethod: 'emailCode' };
  // A password-created administrator has no sign-in email.
  const administratorAccount = { username: 'administrator', signInMethod: 'adminPassword' };
  const administratorPassword = `fixture-admin-${process.pid}-${Date.now()}`;
  const providerPath = '/base-agent-additional-server/userPersistoAgent/7000/service/auth/';
  const providerAssets = new Map(['index.html', 'main.js', 'wizard.js', 'sso-adapter.js', 'auth-api.js', 'auth.css', 'google-button.css'].map((name) => [
    name,
    fs.readFileSync(new URL(`../../../userPersistoAgent/public/auth/${name}`, import.meta.url)),
  ]));
  // The operator's code command reads the fixture mailbox; the address arrives as $SMOKE_EMAIL.
  const mailbox = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-auth-mailbox-'));
  const codeFile = path.join(mailbox, 'code.txt');
  fs.writeFileSync(codeFile, '');
  let account = localAccount;
  let sso = false;
  let redirectDelay = 0;
  let loginPath = providerPath;
  let loginOrigin = '';
  let setupComplete = true;
  let returnTo = '';
  let principalUsername = '';
  let issuedCode = '';
  const json = (response, status, body) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  };
  const readJson = async (incoming) => {
    const chunks = [];
    for await (const chunk of incoming) chunks.push(chunk);
    return JSON.parse(Buffer.concat(chunks).toString() || '{}');
  };
  const server = http.createServer(async (incoming, response) => {
    const url = new URL(incoming.url, 'http://fixture.invalid');
    requests.push({ method: incoming.method, pathname: url.pathname });
    if (url.pathname === '/auth/token') {
      const authenticated = incoming.headers.cookie?.includes('fixture-session=authenticated');
      return json(response, authenticated ? 200 : 401, authenticated
        ? { user: { id: 'USER.2', username: principalUsername || (String(account.username).includes('@') ? '' : account.username),
          email: account.loginEmail || (String(account.username).includes('@') ? account.username : ''), roles: ['user'] } }
        : { error: 'unauthenticated' });
    }
    if (url.pathname === '/auth/login' && incoming.method === 'GET' && sso) {
      returnTo = url.searchParams.get('returnTo');
      const destination = `${loginOrigin}${loginPath}?requestId=fixture-state&state=fixture-state`;
      if (redirectDelay) {
        response.setHeader('content-type', 'text/html');
        response.end(`<h1>Continue to sign in</h1><script>window.setTimeout(() => window.location.replace(${JSON.stringify(destination)}), ${redirectDelay});</script>`);
      } else {
        response.writeHead(302, { location: destination });
        response.end();
      }
      return;
    }
    if (url.pathname.startsWith(loginPath) && sso) {
      const relativePath = url.pathname.slice(loginPath.length);
      if (incoming.method === 'POST') {
        const payload = await readJson(incoming);
        if (payload.requestId !== 'fixture-state') return json(response, 400, { ok: false, error: 'login_request_invalid' });
        if (relativePath === 'attempt') {
          return json(response, 200, { ok: true, expiresAt: Date.now() + 300_000, setupComplete, registration: true,
            methods: { emailCode: true, passkey: false, totp: false, google: false }, adminPassword: true,
            attempt: { status: 'active', challenge: null, locked: false } });
        }
        if (relativePath === 'attempt/cancel') return json(response, 200, { ok: true, status: 'cancelled' });
        if (relativePath === 'discover') {
          const exists = payload.email === providerAccount.loginEmail;
          return json(response, 200, { ok: true, exists, methods: { emailCode: exists, passkey: false, totp: false } });
        }
        if (relativePath === 'email-code/start') {
          issuedCode = String(100000 + Math.floor(Math.random() * 900000));
          fs.writeFileSync(codeFile, `code for ${payload.email}: ${issuedCode}\n`);
          return json(response, 200, { ok: true, challenge: { email: payload.email, purpose: payload.purpose, expiresAt: Date.now() + 300_000,
            resendAt: Date.now() + 60_000, attemptsRemaining: 5, delivery: 'accepted', expired: false } });
        }
        if (relativePath === 'email-code/verify' || relativePath === 'admin/login') {
          const valid = relativePath === 'admin/login' ? payload.password === administratorPassword : payload.code === issuedCode;
          if (!valid) return json(response, 401, { ok: false, error: 'authentication_failed' });
          return json(response, 200, { ok: true, code: 'fixture-code', state: payload.state, redirectUri: '/auth/callback' });
        }
        return json(response, 404, { ok: false, error: 'not_found' });
      }
      const asset = providerAssets.get(relativePath || 'index.html');
      if (asset) {
        response.setHeader('content-type', relativePath.endsWith('.js') ? 'text/javascript'
          : relativePath.endsWith('.css') ? 'text/css' : 'text/html');
        response.end(asset);
        return;
      }
    }
    if (url.pathname === '/auth/callback' && sso) {
      if (url.searchParams.get('state') !== 'fixture-state' || url.searchParams.get('code') !== 'fixture-code') {
        response.writeHead(401).end('Invalid callback');
        return;
      }
      response.writeHead(303, { location: returnTo, 'set-cookie': 'fixture-session=authenticated; Path=/; HttpOnly' });
      response.end();
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
      response.end('<h1>Service</h1><form class="password-panel" action="/service/login" method="post"><input name="username"><input name="email"><input name="password" type="password"><button type="submit">Service login</button></form>');
      return;
    }
    response.writeHead(404).end('Unexpected intermediate surface');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseURL = `http://127.0.0.1:${server.address().port}`;
  process.env.SMOKE_BASE_URL = baseURL;
  process.env.SMOKE_ADMIN_PASSWORD = administratorPassword;
  process.env.SMOKE_EMAIL_CODE_COMMAND = `grep -F "for $SMOKE_EMAIL:" ${JSON.stringify(codeFile)} || true`;
  const { signIn } = await import('./auth.mjs');
  const providerPost = (name) => requests.filter((entry) => entry.method === 'POST' && entry.pathname === `${providerPath}${name}`).length;
  let browser;
  try {
    browser = await chromium.launch();
    for (const mode of ['local', 'immediate SSO', 'delayed frontend SSO', 'email-only SSO', 'SSO profile username differs', 'administrator SSO']) {
      const useSso = mode !== 'local';
      await t.test(`${mode} sign-in`, async () => {
        sso = useSso;
        setupComplete = true;
        redirectDelay = mode === 'delayed frontend SSO' ? 250 : 0;
        principalUsername = mode === 'SSO profile username differs' ? 'persisted-profile' : '';
        account = mode === 'email-only SSO'
          ? { username: providerAccount.loginEmail, signInMethod: 'emailCode' }
          : mode === 'SSO profile username differs'
            ? { ...providerAccount, username: 'configured-account-label' }
            : mode === 'administrator SSO' ? administratorAccount
              : useSso ? providerAccount : localAccount;
        requests.length = 0;
        fs.writeFileSync(codeFile, '');
        const context = await browser.newContext({ baseURL });
        const page = await context.newPage();
        try {
          const target = '/service/?source=smoke#requested-tab';
          const principal = await signIn(page, account, target, { requireConfiguredPrincipal: true });
          assert.equal(principal.canonicalUsername, principalUsername || account.username);
          assert.equal(page.url(), `${baseURL}${target}`);
          assert.equal(requests.filter((entry) => entry.pathname === '/service/').length, 1,
            'the target must not boot before login or be reloaded after login');
          assert.deepEqual(requests.filter((entry) => entry.pathname === '/auth/login').map((entry) => entry.method), useSso ? ['GET'] : ['GET', 'POST']);
          if (mode === 'administrator SSO') {
            assert.equal(providerPost('admin/login'), 1);
            assert.equal(providerPost('email-code/start'), 0, 'administrator sign-in never sends an email code');
          } else if (useSso) {
            assert.deepEqual([providerPost('email-code/start'), providerPost('email-code/verify'), providerPost('admin/login')], [1, 1, 0],
              'passwordless sign-in sends one code, verifies it once and never uses the administrator path');
          }
          assert.equal(requests.filter((entry) => entry.pathname === '/' || entry.pathname.startsWith('/explorer')).length, 0);
          assert.equal(await page.locator('input[name="username"]').inputValue(), '');
          assert.equal(await page.locator('input[name="password"]').inputValue(), '');

          await signIn(page, account, '/service/?source=second#requested-tab', { requireConfiguredPrincipal: true });
          assert.equal(requests.filter((entry) => entry.pathname === '/service/').length, 2);
          assert.equal(requests.filter((entry) => entry.pathname === '/auth/login').length, useSso ? 1 : 2,
            'an existing Router session must not revisit its login form');
          assert.equal(requests.filter((entry) => entry.pathname === '/service/login').length, 0,
            'Ploinky credentials must never be submitted to the service login');
          assert.equal(await page.locator('input[name="username"]').inputValue(), '');
          assert.equal(await page.locator('input[name="email"]').inputValue(), '');
          assert.equal(await page.locator('input[name="password"]').inputValue(), '');
          await assert.rejects(signIn(page, {
            ...account,
            username: 'another-user',
            ...(useSso ? { loginEmail: 'another-user@example.test' } : {}),
          }, '/service/', {
            requireConfiguredPrincipal: true,
          }), /does not match the configured account/);
        } finally {
          await context.close();
        }
      });
    }
    for (const scenario of ['initial setup', 'different same-origin path', 'different origin']) {
      for (const delay of [0, 250]) {
        await t.test(`does not submit credentials to ${scenario} after ${delay ? 'delayed frontend' : 'immediate'} SSO`, async () => {
          sso = true;
          redirectDelay = delay;
          account = providerAccount;
          principalUsername = '';
          setupComplete = scenario !== 'initial setup';
          loginPath = scenario === 'different same-origin path' ? '/other-service/auth/' : providerPath;
          loginOrigin = scenario === 'different origin' ? baseURL.replace('127.0.0.1', 'localhost') : '';
          requests.length = 0;
          const context = await browser.newContext({ baseURL });
          const page = await context.newPage();
          try {
            const expectedError = scenario === 'initial setup'
              ? /UserPersisto setup is not complete/
              : scenario === 'different origin'
                ? /Authentication left the configured smoke origin/
                : /Authenticated identity verification failed with HTTP 401/;
            await assert.rejects(signIn(page, account, '/service/', { requireConfiguredPrincipal: true }), expectedError);
            await page.locator('#auth_content h1').first().waitFor({ state: 'visible' });
            // Only the wizard's own state read may be posted; no code, discovery or credential.
            assert.deepEqual(requests.filter((entry) => entry.method === 'POST' && !entry.pathname.endsWith('/attempt')), []);
            for (const input of await page.locator('input[name="email"], input[name="password"], input[name="code"]').all()) {
              assert.equal(await input.inputValue(), '');
            }
          } finally {
            await context.close();
          }
        });
      }
    }
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(mailbox, { recursive: true, force: true });
    delete process.env.SMOKE_ADMIN_PASSWORD;
    delete process.env.SMOKE_EMAIL_CODE_COMMAND;
  }
});
