import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { chromium } from '@playwright/test';

test('authentication visits only its final surface and preserves a separate service login', { timeout: 90_000 }, async (t) => {
  const requests = [];
  const localAccount = { username: 'fixture-user', password: 'fixture-password' };
  // Fixture values for a local mock provider; no real credential is involved.
  const providerAccount = { username: 'fixture-user', loginEmail: 'fixture-user@example.test', signInMethod: 'password',
    accountPassword: 'fixture account passphrase' };
  const administratorAccount = { username: 'administrator', loginEmail: 'owner@example.test', signInMethod: 'emailCode' };
  const totpSecret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  const providerPath = '/base-agent-additional-server/userPersistoAgent/7000/service/auth/';
  const providerAssets = new Map(['index.html', 'main.js', 'wizard.js', 'password-rules.js', 'sso-adapter.js', 'auth-api.js', 'auth.css', 'google-button.css'].map((name) => [
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
  let pendingSignup = null;
  let signupVerification = 'required';
  // A controlled authenticator clock shared by the helper and this provider.
  let totpTime = 1_700_000_000_000;
  const totpClock = { now: () => totpTime, wait: async (durationMs) => { totpTime += durationMs; } };
  const registered = new Map();
  const resetAccounts = () => {
    registered.clear();
    registered.set(providerAccount.loginEmail, { password: providerAccount.accountPassword, totp: true });
    registered.set(administratorAccount.loginEmail, { password: '', totp: false });
  };
  const handoff = (payload) => ({ ok: true, code: 'fixture-code', state: payload.state, redirectUri: '/auth/callback' });
  const issueCode = (email, purpose) => {
    issuedCode = String(100000 + Math.floor(Math.random() * 900000));
    fs.writeFileSync(codeFile, `code for ${email}: ${issuedCode}\n`);
    return { ok: true, challenge: { email, purpose, expiresAt: Date.now() + 300_000, resendAt: Date.now() + 60_000,
      attemptsRemaining: 5, delivery: 'accepted', expired: false } };
  };
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
          email: account.loginEmail || (String(account.username).includes('@') ? account.username : ''), roles: [account === administratorAccount ? 'admin' : 'user'] } }
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
            signup: { email: true, google: false, verification: signupVerification },
            methods: { password: true, emailCode: true, passkey: false, totp: true, google: false },
            passwordPolicy: { minLength: 15, maxLength: 128, maxRawLength: 1024, normalization: 'NFKC' },
            attempt: { status: 'active', challenge: null, locked: false } });
        }
        if (relativePath === 'attempt/cancel') return json(response, 200, { ok: true, status: 'cancelled' });
        const known = registered.get(payload.email);
        if (relativePath === 'discover') {
          return json(response, 200, { ok: true, exists: Boolean(known),
            methods: { password: Boolean(known?.password), emailCode: Boolean(known), passkey: false, totp: Boolean(known?.totp) } });
        }
        if (relativePath === 'password/login') {
          if (!known?.password || payload.password !== known.password) return json(response, 401, { ok: false, error: 'authentication_failed' });
          return json(response, 200, handoff(payload));
        }
        if (relativePath === 'email-code/start') {
          if (payload.purpose !== 'login' || !known) return json(response, 400, { ok: false, error: 'invalid_request' });
          return json(response, 200, issueCode(payload.email, 'login'));
        }
        if (relativePath === 'email-code/verify') {
          if (payload.code !== issuedCode) return json(response, 400, { ok: false, error: 'code_invalid', attemptsRemaining: 4 });
          return json(response, 200, handoff(payload));
        }
        if (relativePath === 'totp/verify') {
          if (!known?.totp || payload.token !== totpToken(totpSecret, totpTime)) return json(response, 401, { ok: false, error: 'authentication_failed' });
          return json(response, 200, handoff(payload));
        }
        if (relativePath === 'signup/start') {
          if (known) return json(response, 409, { ok: false, error: 'account_exists' });
          pendingSignup = { email: payload.email, password: payload.password, confirmed: payload.password === payload.passwordConfirmation };
          return json(response, 200, issueCode(payload.email, 'register'));
        }
        if (relativePath === 'signup/create') {
          if (signupVerification === 'required') return json(response, 409, { ok: false, error: 'signup_verification_required' });
          if (known) return json(response, 409, { ok: false, error: 'account_exists' });
          registered.set(payload.email, { password: payload.password, totp: false });
          return json(response, 200, handoff(payload));
        }
        if (relativePath === 'signup/verify') {
          if (!pendingSignup || payload.code !== issuedCode) return json(response, 400, { ok: false, error: 'code_invalid', attemptsRemaining: 4 });
          registered.set(pendingSignup.email, { password: pendingSignup.password, totp: false });
          pendingSignup = null;
          return json(response, 200, handoff(payload));
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
  process.env.SMOKE_EMAIL_CODE_COMMAND = `grep -F "for $SMOKE_EMAIL:" ${JSON.stringify(codeFile)} || true`;
  const { signIn, totpToken } = await import('./auth.mjs');
  const providerPost = (name) => requests.filter((entry) => entry.method === 'POST' && entry.pathname === `${providerPath}${name}`).length;
  const completionRoutes = ['password/login', 'email-code/start', 'email-code/verify', 'totp/verify', 'signup/start', 'signup/create', 'signup/verify', 'admin/login'];
  const signedUpAccount = { username: 'new-member', loginEmail: 'new-member@example.test', signInMethod: 'password' };
  const modes = [
    { name: 'local', account: localAccount },
    { name: 'immediate SSO password', account: providerAccount, posts: ['password/login'] },
    { name: 'delayed frontend SSO email code through Try another way', delay: 250,
      account: { ...providerAccount, signInMethod: 'emailCode' }, posts: ['email-code/start', 'email-code/verify'] },
    { name: 'email-only SSO password', account: { username: providerAccount.loginEmail, signInMethod: 'password', accountPassword: providerAccount.accountPassword },
      posts: ['password/login'] },
    { name: 'SSO profile username differs with an authenticator through Try another way', principal: 'persisted-profile',
      account: { ...providerAccount, username: 'configured-account-label', signInMethod: 'totp', totpSecret }, posts: ['totp/verify'] },
    { name: 'administrator SSO email code', account: administratorAccount, posts: ['email-code/start', 'email-code/verify'] },
    { name: 'SSO sign-up with the run password', account: signedUpAccount, posts: ['signup/start', 'signup/verify'] },
  ];
  let browser;
  try {
    browser = await chromium.launch();
    for (const mode of modes) {
      const useSso = mode.name !== 'local';
      await t.test(`${mode.name} sign-in`, async () => {
        sso = useSso;
        setupComplete = true;
        signupVerification = 'required';
        redirectDelay = mode.delay || 0;
        principalUsername = mode.principal || '';
        account = mode.account;
        resetAccounts();
        requests.length = 0;
        fs.writeFileSync(codeFile, '');
        const context = await browser.newContext({ baseURL });
        const page = await context.newPage();
        try {
          const target = '/service/?source=smoke#requested-tab';
          const principal = await signIn(page, account, target, { requireConfiguredPrincipal: true, totpClock });
          assert.equal(principal.canonicalUsername, principalUsername || account.username);
          assert.equal(page.url(), `${baseURL}${target}`);
          assert.equal(requests.filter((entry) => entry.pathname === '/service/').length, 1,
            'the target must not boot before login or be reloaded after login');
          assert.deepEqual(requests.filter((entry) => entry.pathname === '/auth/login').map((entry) => entry.method), useSso ? ['GET'] : ['GET', 'POST']);
          if (useSso) {
            assert.deepEqual(completionRoutes.map(providerPost), completionRoutes.map((route) => (mode.posts.includes(route) ? 1 : 0)),
              'each method completes through exactly its own wizard route and never a retired administrator path');
          }
          if (account === signedUpAccount) {
            assert.equal(registered.get(signedUpAccount.loginEmail)?.password === process.env.SMOKE_RUN_ACCOUNT_PASSWORD, true,
              'an account signed up without a configured password uses the run password');
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
    // The smoke configuration reads SMOKE_EMAIL_CODE_COMMAND once at import, so
    // a sign-up without it runs in a child process against this provider.
    const signUpWithoutCodeCommand = async () => {
      const environment = { ...process.env };
      delete environment.SMOKE_EMAIL_CODE_COMMAND;
      const script = `
        import { chromium } from '@playwright/test';
        const { signIn } = await import(${JSON.stringify(new URL('./auth.mjs', import.meta.url).href)});
        const browser = await chromium.launch();
        try {
          const page = await (await browser.newContext({ baseURL: ${JSON.stringify(baseURL)} })).newPage();
          const principal = await signIn(page, ${JSON.stringify(signedUpAccount)}, '/service/', { requireConfiguredPrincipal: true });
          console.log(JSON.stringify({ ok: true, username: principal.canonicalUsername, url: page.url() }));
        } catch (error) {
          console.log(JSON.stringify({ ok: false, message: error.message }));
        } finally {
          await browser.close();
        }`;
      const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script],
        { cwd: fileURLToPath(new URL('..', import.meta.url)), env: environment, timeout: 60_000 });
      return JSON.parse(stdout.trim().split('\n').at(-1));
    };
    await t.test('direct sign-up completes after Create account without SMOKE_EMAIL_CODE_COMMAND', async () => {
      sso = true;
      setupComplete = true;
      signupVerification = 'none';
      redirectDelay = 0;
      principalUsername = '';
      account = signedUpAccount;
      resetAccounts();
      requests.length = 0;
      fs.writeFileSync(codeFile, '');
      const result = await signUpWithoutCodeCommand();
      assert.deepEqual(result, { ok: true, username: signedUpAccount.username, url: `${baseURL}/service/` });
      assert.deepEqual(completionRoutes.map(providerPost), completionRoutes.map((route) => (route === 'signup/create' ? 1 : 0)));
      assert.equal(registered.get(signedUpAccount.loginEmail)?.password, process.env.SMOKE_RUN_ACCOUNT_PASSWORD);
      assert.equal(fs.readFileSync(codeFile, 'utf8'), '', 'no code was issued');
    });
    await t.test('the sign-up code screen still requires SMOKE_EMAIL_CODE_COMMAND', async () => {
      sso = true;
      setupComplete = true;
      signupVerification = 'required';
      redirectDelay = 0;
      principalUsername = '';
      account = signedUpAccount;
      resetAccounts();
      requests.length = 0;
      const result = await signUpWithoutCodeCommand();
      assert.equal(result.ok, false);
      assert.match(result.message, /BLOCKED: SMOKE_EMAIL_CODE_COMMAND is not configured, so the sign-up verification code cannot be automated\./);
      assert.deepEqual(completionRoutes.map(providerPost), completionRoutes.map((route) => (route === 'signup/start' ? 1 : 0)));
      assert.equal(registered.has(signedUpAccount.loginEmail), false);
    });
    await t.test('a refused password and unavailable methods are reported without waiting for navigation', async () => {
      sso = true;
      setupComplete = true;
      redirectDelay = 0;
      principalUsername = '';
      resetAccounts();
      requests.length = 0;
      const context = await browser.newContext({ baseURL });
      const page = await context.newPage();
      try {
        const started = Date.now();
        account = { ...providerAccount, accountPassword: 'fixture mistyped passphrase' };
        await assert.rejects(signIn(page, account, '/service/', { requireConfiguredPrincipal: true }),
          /UserPersisto refused the sign-in: That password is not correct/);
        assert.ok(Date.now() - started < 15_000, 'a refusal must not wait for the navigation timeout');
        account = { ...administratorAccount, signInMethod: 'password' };
        await assert.rejects(signIn(page, account, '/service/', { requireConfiguredPrincipal: true }),
          /BLOCKED: password sign-in is not available/);
        account = { ...administratorAccount, signInMethod: 'totp', totpSecret };
        await assert.rejects(signIn(page, account, '/service/', { requireConfiguredPrincipal: true, totpClock }),
          /BLOCKED: authenticator sign-in is not available/);
        assert.deepEqual(completionRoutes.map(providerPost), completionRoutes.map((route) => (route === 'password/login' ? 1 : 0)));
      } finally {
        await context.close();
      }
    });
    for (const scenario of ['initial setup', 'different same-origin path', 'different origin']) {
      for (const delay of [0, 250]) {
        await t.test(`does not submit credentials to ${scenario} after ${delay ? 'delayed frontend' : 'immediate'} SSO`, async () => {
          sso = true;
          redirectDelay = delay;
          account = providerAccount;
          principalUsername = '';
          resetAccounts();
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
    delete process.env.SMOKE_EMAIL_CODE_COMMAND;
  }
});
