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

// The benchmark and helper modules are imported inside the tests, so the
// command-line regressions below still run against a source tree that lacks
// them.
const smokeRoot = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = path.resolve(smokeRoot, '..', '..');
const benchmarkScript = path.join(smokeRoot, 'scripts', 'run-ui-benchmark.mjs');
const helperModule = path.join(smokeRoot, 'lib', 'auth-wizard.mjs');
const runFile = promisify(execFile);

// Fabricated fixture values only; no real credential is involved. The
// sentinels must never appear in results, messages or process output.
const ACCOUNT_PASSWORD = 'sentinel-account-passphrase-4c1d';
const LOCAL_PASSWORD = 'sentinel-local-passphrase-9e27';
const WRONG_PASSWORD = 'sentinel-mistyped-passphrase-77b0';
const ACCOUNT_EMAIL = 'bench-member@example.test';
const NO_PASSWORD_EMAIL = 'code-only@example.test';
const UNKNOWN_EMAIL = 'unknown-member@example.test';
// The race tests drive a destination wizard with this separate account; it is
// never the benchmark's account.
const DESTINATION_EMAIL = 'destination-member@example.test';
const DESTINATION_PASSWORD = 'destination-passphrase';
const FOREIGN_SERVICE_PATH = '/other-service/auth/';
const LOCAL_USERNAME = 'bench-local';
const SENTINELS = [ACCOUNT_PASSWORD, LOCAL_PASSWORD, WRONG_PASSWORD];
const PROVIDER_PATH = '/base-agent-additional-server/userPersistoAgent/7000/service/auth/';
const ATTEMPT_DELAY_MS = 300;
const SIGNUP_ROUTES = ['signup/start', 'signup/create', 'signup/verify', 'signup/resend', 'signup/email'];
const WIZARD_ASSETS = ['index.html', 'main.js', 'wizard.js', 'password-rules.js', 'sso-adapter.js',
  'auth-api.js', 'google-gis.js', 'auth.css', 'google-button.css'];

function assertNoSentinel(text, where) {
  for (const sentinel of SENTINELS) {
    assert.equal(String(text).includes(sentinel), false, `${where} must not contain a fabricated credential`);
  }
}

// Router + UserPersisto fixture serving the real wizard assets. It records
// every request and keeps the registered accounts so a test can prove that
// nothing was created.
function createFixture() {
  const assets = new Map(WIZARD_ASSETS.map((name) => [
    name,
    fs.readFileSync(new URL(`../../../userPersistoAgent/public/auth/${name}`, import.meta.url)),
  ]));
  const fixture = {
    requests: [],
    registered: new Map(),
    sso: true,
    redirectDelay: 0,
    loginPath: PROVIDER_PATH,
    loginOrigin: '',
    setupComplete: true,
    signupEmail: true,
    initialPasswordSetup: false,
    returnTo: '/',
    baseURL: '',
    reset(overrides = {}) {
      this.requests.length = 0;
      this.registered.clear();
      this.registered.set(ACCOUNT_EMAIL, { password: ACCOUNT_PASSWORD });
      this.registered.set(NO_PASSWORD_EMAIL, { password: '' });
      this.registered.set(DESTINATION_EMAIL, { password: DESTINATION_PASSWORD });
      Object.assign(this, { sso: true, redirectDelay: 0, loginPath: PROVIDER_PATH, loginOrigin: '',
        setupComplete: true, signupEmail: true, initialPasswordSetup: false, returnTo: '/' }, overrides);
    },
    posts(route) {
      return this.requests.filter((entry) => entry.method === 'POST'
        && entry.pathname === `${this.loginPath}${route}`).length;
    },
    providerPosts() {
      return this.requests.filter((entry) => entry.method === 'POST' && entry.pathname.startsWith(this.loginPath))
        .map((entry) => entry.pathname.slice(this.loginPath.length));
    },
  };
  const json = (response, status, body) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  };
  const readBody = async (incoming) => {
    const chunks = [];
    for await (const chunk of incoming) chunks.push(chunk);
    return Buffer.concat(chunks).toString();
  };
  const authenticated = (incoming) => Boolean(incoming.headers.cookie?.includes('fixture-session=authenticated'));
  fixture.server = http.createServer(async (incoming, response) => {
    const url = new URL(incoming.url, 'http://fixture.invalid');
    const entry = { method: incoming.method, pathname: url.pathname };
    fixture.requests.push(entry);
    // The race tests also reach the real wizard at a foreign service path.
    const servicePath = [fixture.loginPath, FOREIGN_SERVICE_PATH].find((prefix) => url.pathname.startsWith(prefix));
    if (url.pathname === '/explorer/index.html') {
      if (!authenticated(incoming)) {
        response.writeHead(302, { location: `/auth/login?returnTo=${encodeURIComponent(url.pathname)}` });
        response.end();
        return;
      }
      // A fabricated Explorer shell: enough for shell readiness, never for
      // the full interactive check.
      response.setHeader('content-type', 'text/html');
      response.end('<div id="page_content"><div>Explorer fixture</div></div><script>window.webSkel = {};</script>');
      return;
    }
    if (url.pathname === '/auth/token') {
      return json(response, authenticated(incoming) ? 200 : 401, { error: 'fixture' });
    }
    if (url.pathname === '/auth/login' && incoming.method === 'GET' && fixture.sso) {
      fixture.returnTo = url.searchParams.get('returnTo') || '/';
      const destination = `${fixture.loginOrigin}${fixture.loginPath}?requestId=fixture-state&state=fixture-state`;
      if (fixture.redirectDelay) {
        response.setHeader('content-type', 'text/html');
        response.end(`<h1>Continue to sign in</h1><script>window.setTimeout(() => window.location.replace(${JSON.stringify(destination)}), ${fixture.redirectDelay});</script>`);
      } else {
        response.writeHead(302, { location: destination });
        response.end();
      }
      return;
    }
    if (servicePath && fixture.sso) {
      const relativePath = url.pathname.slice(servicePath.length);
      if (incoming.method === 'POST') {
        const payload = JSON.parse(await readBody(incoming) || '{}');
        entry.email = payload.email;
        if (payload.requestId !== 'fixture-state') return json(response, 400, { ok: false, error: 'login_request_invalid' });
        if (relativePath === 'attempt') {
          // A slow first state read proves the first step waits for the
          // rendered email screen rather than the page load.
          await new Promise((resolve) => setTimeout(resolve, ATTEMPT_DELAY_MS));
          return json(response, 200, { ok: true, expiresAt: Date.now() + 300_000, setupComplete: fixture.setupComplete,
            registration: true, signup: { email: fixture.signupEmail, google: false, verification: 'none' },
            methods: { password: true, emailCode: true, passkey: false, totp: false, google: false },
            passwordPolicy: { minLength: 1, maxLength: 128, maxRawLength: 1024, normalization: 'NFKC' },
            attempt: { status: 'active', challenge: null, locked: false } });
        }
        if (relativePath === 'attempt/cancel') return json(response, 200, { ok: true, status: 'cancelled' });
        const known = fixture.registered.get(payload.email);
        if (relativePath === 'discover') {
          return json(response, 200, { ok: true, exists: Boolean(known),
            initialPasswordSetup: !known && fixture.initialPasswordSetup,
            methods: { password: Boolean(known?.password), emailCode: Boolean(known), passkey: false, totp: false } });
        }
        if (relativePath === 'password/login') {
          if (!known?.password || payload.password !== known.password) {
            return json(response, 401, { ok: false, error: 'authentication_failed' });
          }
          return json(response, 200, { ok: true, code: 'fixture-code', state: payload.state, redirectUri: '/auth/callback' });
        }
        if (relativePath === 'signup/create' || relativePath === 'signup/start') {
          fixture.registered.set(payload.email, { password: payload.password });
          return json(response, 200, { ok: true, code: 'fixture-code', state: payload.state, redirectUri: '/auth/callback' });
        }
        return json(response, 404, { ok: false, error: 'not_found' });
      }
      const asset = assets.get(relativePath || 'index.html');
      if (asset) {
        response.setHeader('content-type', relativePath.endsWith('.js') ? 'text/javascript'
          : relativePath.endsWith('.css') ? 'text/css' : 'text/html');
        response.end(asset);
        return;
      }
    }
    if (url.pathname === '/auth/callback' && fixture.sso) {
      if (url.searchParams.get('state') !== 'fixture-state' || url.searchParams.get('code') !== 'fixture-code') {
        response.writeHead(401).end('Invalid callback');
        return;
      }
      response.writeHead(303, { location: fixture.returnTo, 'set-cookie': 'fixture-session=authenticated; Path=/; HttpOnly' });
      response.end();
      return;
    }
    if (url.pathname === '/auth/login' && incoming.method === 'POST') {
      const form = new URLSearchParams(await readBody(incoming));
      if (form.get('username') !== LOCAL_USERNAME || form.get('password') !== LOCAL_PASSWORD) {
        response.writeHead(401).end('Invalid username or password');
        return;
      }
      response.writeHead(303, { location: form.get('returnTo') || '/', 'set-cookie': 'fixture-session=authenticated; Path=/; HttpOnly' });
      response.end();
      return;
    }
    if (url.pathname === '/auth/login') {
      response.setHeader('content-type', 'text/html');
      const returnTo = String(url.searchParams.get('returnTo') || '/').replace(/[^A-Za-z0-9/._-]/g, '');
      response.end(`<form action="/auth/login" method="post"><input name="username"><input name="password" type="password"><input name="returnTo" type="hidden" value="${returnTo}"><button type="submit">Sign in</button></form>`);
      return;
    }
    response.writeHead(404).end('Unexpected surface');
  });
  return fixture;
}

let fixture;
let browser;

test.before(async () => {
  fixture = createFixture();
  await new Promise((resolve) => fixture.server.listen(0, '127.0.0.1', resolve));
  fixture.baseURL = `http://127.0.0.1:${fixture.server.address().port}`;
  browser = await chromium.launch();
});

test.after(async () => {
  await browser?.close();
  fixture?.server.closeAllConnections();
  await new Promise((resolve) => fixture?.server.close(resolve) ?? resolve());
});

function benchmarkConfig(overrides = {}) {
  return {
    baseURL: fixture.baseURL,
    timeoutMs: 15_000,
    directoryPath: '/.ploinky',
    filePath: '/README.md',
    username: LOCAL_USERNAME,
    password: LOCAL_PASSWORD,
    loginEmail: ACCOUNT_EMAIL,
    accountPassword: ACCOUNT_PASSWORD,
    ...overrides,
  };
}

// Drives the exported benchmark login sequence with the real step recorder.
// The recorder subclass logs step boundaries; the hook runs between the
// steps, outside both timers, and inspects the filled form.
async function runLogin(configOverrides = {}) {
  const { runAuthenticationSteps, NetworkRecorder } = await import('../scripts/run-ui-benchmark.mjs');
  assert.equal(typeof runAuthenticationSteps, 'function', 'the benchmark exports its login sequence');
  const events = [];
  class LoggingRecorder extends NetworkRecorder {
    beginStep(name) { events.push(`begin:${name}`); super.beginStep(name); }
    endStep() { events.push(`end:${this.currentStep}`); super.endStep(); }
  }
  const config = benchmarkConfig(configOverrides);
  const context = await browser.newContext();
  const page = await context.newPage();
  const session = await context.newCDPSession(page);
  await session.send('Performance.enable');
  const network = new LoggingRecorder(session, config.baseURL);
  await network.install();
  const state = { page, session, network, steps: [] };
  const filledBeforeLogin = {};
  let error = null;
  try {
    await runAuthenticationSteps(state, config, {
      beforeLoginStep: async ({ surface }) => {
        events.push('before-login-step');
        filledBeforeLogin.surface = surface;
        const passwordField = surface === 'userpersisto-login'
          ? page.locator('#auth_content input[name="password"]')
          : page.locator('input[name="password"]');
        filledBeforeLogin.password = (await passwordField.inputValue()) !== '';
        if (surface === 'legacy-login') {
          filledBeforeLogin.username = (await page.locator('input[name="username"]').inputValue()) === LOCAL_USERNAME;
        }
      },
      waitForInteractive: async () => { events.push('interactive'); },
    });
  } catch (caught) {
    error = caught;
  }
  const fields = [];
  if (!page.isClosed()) {
    for (const input of await page.locator('input[name="email"], input[name="password"], input[name="username"]').all()) {
      fields.push(await input.inputValue().catch(() => ''));
    }
  }
  const requests = network.export().requests;
  await context.close();
  return { error, events, steps: state.steps, requests, filledBeforeLogin, fields };
}

function stepOf(requests, method, pathname) {
  return requests.filter((entry) => entry.method === method && entry.pathname === pathname).map((entry) => entry.step);
}

function assertSafeOutcome(result) {
  assertNoSentinel(JSON.stringify(result.steps), 'recorded steps');
  assertNoSentinel(JSON.stringify(result.requests), 'recorded requests');
  assertNoSentinel(String(result.error?.message || ''), 'the error message');
  assert.doesNotMatch(String(result.error?.message || ''), /That password is not correct|Something went wrong/,
    'no wizard page text in benchmark errors');
}

function assertNothingCreated() {
  for (const route of SIGNUP_ROUTES) assert.equal(fixture.posts(route), 0, `no ${route} request`);
  assert.deepEqual([...fixture.registered.keys()].sort(), [ACCOUNT_EMAIL, NO_PASSWORD_EMAIL, DESTINATION_EMAIL].sort());
}

const LOGIN_STEPS = ['begin:router-login-page', 'end:router-login-page', 'before-login-step',
  'begin:login-to-explorer-interactive', 'interactive', 'end:login-to-explorer-interactive'];

test('the legacy local form fills outside both timers and submits inside the login timer', async () => {
  fixture.reset({ sso: false });
  const result = await runLogin();
  assert.equal(result.error, null);
  assert.deepEqual(result.events, LOGIN_STEPS);
  assert.deepEqual(result.steps.map((step) => [step.name, step.status]),
    [['router-login-page', 'passed'], ['login-to-explorer-interactive', 'passed']]);
  assert.deepEqual(result.filledBeforeLogin, { surface: 'legacy-login', password: true, username: true });
  assert.equal(result.steps[0].details.finalPathname, '/auth/login');
  assert.deepEqual(stepOf(result.requests, 'GET', '/auth/login'), ['router-login-page']);
  assert.deepEqual(stepOf(result.requests, 'POST', '/auth/login'), ['login-to-explorer-interactive']);
  assert.equal(fixture.requests.filter((entry) => entry.pathname === '/explorer/index.html').length, 2,
    'no extra Explorer navigation');
  assert.equal(fixture.requests.filter((entry) => entry.pathname === '/auth/token').length, 0, 'no session probe');
  assertSafeOutcome(result);
});

for (const delay of [0, 250]) {
  test(`an existing UserPersisto password account signs in after ${delay ? 'a delayed' : 'an immediate'} Router redirect`, async () => {
    fixture.reset({ redirectDelay: delay });
    const result = await runLogin();
    assert.equal(result.error, null);
    assert.deepEqual(result.events, LOGIN_STEPS);
    assert.deepEqual(result.steps.map((step) => [step.name, step.status]),
      [['router-login-page', 'passed'], ['login-to-explorer-interactive', 'passed']]);
    assert.deepEqual(result.filledBeforeLogin, { surface: 'userpersisto-login', password: true });
    assert.equal(result.steps[0].details.finalPathname, PROVIDER_PATH);
    assert.ok(result.steps[0].durationMs >= ATTEMPT_DELAY_MS,
      'the first step ends at the rendered email screen, after the wizard state read');
    // Each request is attributed to the step that was running when it started.
    assert.deepEqual(stepOf(result.requests, 'GET', '/auth/login'), ['router-login-page']);
    assert.deepEqual(stepOf(result.requests, 'GET', PROVIDER_PATH), ['router-login-page']);
    assert.deepEqual(stepOf(result.requests, 'POST', `${PROVIDER_PATH}attempt`), ['router-login-page']);
    assert.deepEqual(stepOf(result.requests, 'POST', `${PROVIDER_PATH}discover`), ['background'],
      'email discovery happens outside both measured steps');
    assert.deepEqual(stepOf(result.requests, 'POST', `${PROVIDER_PATH}password/login`), ['login-to-explorer-interactive'],
      'the final Log in happens inside the login timer');
    assert.deepEqual(stepOf(result.requests, 'GET', '/auth/callback'), ['login-to-explorer-interactive']);
    assert.deepEqual(fixture.providerPosts(), ['attempt', 'discover', 'password/login']);
    assert.equal(fixture.requests.filter((entry) => entry.pathname === '/explorer/index.html').length, 2,
      'no extra Explorer navigation');
    assert.equal(fixture.requests.filter((entry) => entry.pathname === '/auth/token').length, 0, 'no session probe');
    assertNothingCreated();
    assertSafeOutcome(result);
  });
}

test('an unknown account refuses before Sign up and creates nothing', async () => {
  fixture.reset();
  const result = await runLogin({ loginEmail: UNKNOWN_EMAIL });
  assert.equal(result.error?.message,
    'BLOCKED: UserPersisto has no account for the configured email, and sign-up is not allowed here.');
  assert.deepEqual(result.steps.map((step) => step.name), ['router-login-page']);
  assert.deepEqual(fixture.providerPosts(), ['attempt', 'discover']);
  assert.equal(fixture.posts('password/login'), 0);
  assertNothingCreated();
  assertSafeOutcome(result);
});

test('a wrong password refuses with fixed text inside the login step', async () => {
  fixture.reset();
  const result = await runLogin({ accountPassword: WRONG_PASSWORD });
  assert.equal(result.error?.message, 'UserPersisto refused the sign-in.');
  assert.deepEqual(result.steps.map((step) => [step.name, step.status]),
    [['router-login-page', 'passed'], ['login-to-explorer-interactive', 'failed']]);
  assert.deepEqual(result.steps[1].error, { name: 'Error', message: 'UserPersisto refused the sign-in.' });
  assert.equal(fixture.posts('password/login'), 1);
  assertNothingCreated();
  assertSafeOutcome(result);
});

for (const [name, overrides, message] of [
  ['a missing account password', { accountPassword: '' },
    'BLOCKED: UserPersisto benchmark login needs UI_BENCHMARK_ACCOUNT_PASSWORD or SMOKE_ACCOUNT_PASSWORD for an existing password account.'],
  ['a missing login email', { loginEmail: '' },
    'BLOCKED: UserPersisto benchmark login needs UI_BENCHMARK_LOGIN_EMAIL or SMOKE_LOGIN_EMAIL.'],
]) {
  test(`${name} refuses before account discovery`, async () => {
    fixture.reset();
    const result = await runLogin(overrides);
    assert.equal(result.error?.message, message);
    assert.deepEqual(fixture.providerPosts(), ['attempt']);
    assert.deepEqual(result.fields.filter(Boolean), [], 'no field was filled');
    assertNothingCreated();
    assertSafeOutcome(result);
  });
}

test('an account without password sign-in refuses before a password is entered', async () => {
  fixture.reset();
  const result = await runLogin({ loginEmail: NO_PASSWORD_EMAIL });
  assert.equal(result.error?.message, 'BLOCKED: password sign-in is not available for the configured benchmark account.');
  assert.deepEqual(fixture.providerPosts(), ['attempt', 'discover']);
  assertNothingCreated();
  assertSafeOutcome(result);
});

test('an unclaimed installation refuses before the email is entered', async () => {
  fixture.reset({ setupComplete: false });
  const result = await runLogin();
  assert.match(result.error?.message || '', /^UserPersisto setup is not complete\./);
  assert.deepEqual(fixture.providerPosts(), ['attempt']);
  assert.deepEqual(result.fields.filter(Boolean), []);
  assertNothingCreated();
  assertSafeOutcome(result);
});

test('an initial-setup password screen refuses before a password is entered', async () => {
  // Without email sign-up the first-administrator screen shows an enabled
  // password field and no Sign up button; a Log in there would claim the
  // installation.
  fixture.reset({ signupEmail: false, initialPasswordSetup: true });
  const result = await runLogin({ loginEmail: UNKNOWN_EMAIL });
  assert.match(result.error?.message || '', /^UserPersisto setup is not complete\./);
  assert.deepEqual(fixture.providerPosts(), ['attempt', 'discover']);
  assert.equal(fixture.posts('password/login'), 0);
  assertNothingCreated();
  assertSafeOutcome(result);
});

for (const scenario of ['different origin', 'different same-origin service path']) {
  for (const delay of [0, 250]) {
    test(`a ${scenario} after ${delay ? 'a delayed' : 'an immediate'} redirect refuses before any credential`, async () => {
      fixture.reset({
        redirectDelay: delay,
        loginOrigin: scenario === 'different origin' ? fixture.baseURL.replace('127.0.0.1', 'localhost') : '',
        loginPath: scenario === 'different origin' ? PROVIDER_PATH : '/other-service/auth/',
      });
      const result = await runLogin();
      assert.equal(result.error?.message, scenario === 'different origin'
        ? 'Authentication left the expected origin before a login surface rendered.'
        : 'Authentication reached an unsupported path before a login surface rendered.');
      assert.deepEqual(result.steps.map((step) => [step.name, step.status]), [['router-login-page', 'failed']]);
      // Only the wizard's own state read may be posted; no discovery or credential.
      assert.deepEqual(fixture.providerPosts().filter((route) => route !== 'attempt'), []);
      assert.deepEqual(result.fields.filter(Boolean), [], 'every field stays untouched');
      assertNothingCreated();
      assertSafeOutcome(result);
    });
  }
}

test('the shared helpers require explicit origins, timeouts and a sign-up choice', async () => {
  const helper = await import('./auth-wizard.mjs');
  const page = { url: () => `${fixture.baseURL}${PROVIDER_PATH}`, locator: () => assert.fail('no page access') };
  await assert.rejects(helper.waitForAuthenticationSurface(page, { baseURL: fixture.baseURL }), /positive integer/);
  await assert.rejects(helper.waitForAuthenticationSurface(page, { timeoutMs: 1_000 }), /absolute HTTP/);
  for (const allowSignup of [undefined, 'false', 0]) {
    await assert.rejects(helper.prepareUserPersistoAccount(page, { loginEmail: ACCOUNT_EMAIL },
      { expectedOrigin: fixture.baseURL, timeoutMs: 1_000, allowSignup }), /explicit allowSignup/);
  }
  await assert.rejects(helper.prepareUserPersistoAccount(page, { loginEmail: ACCOUNT_EMAIL },
    { expectedOrigin: fixture.baseURL.replace('127.0.0.1', 'localhost'), timeoutMs: 1_000, allowSignup: false }),
  /left the expected origin/);
  assert.throws(() => helper.assertAuthenticationLocation(page, { expectedOrigin: fixture.baseURL, pathname: '/auth/login' }),
    /not on the expected login path/);
});

test('benchmark credentials never fall back to another password', async () => {
  const { benchmarkCredentials } = await import('../scripts/run-ui-benchmark.mjs');
  assert.deepEqual(benchmarkCredentials({}), { username: 'admin', password: 'admin', loginEmail: '', accountPassword: '' });
  assert.deepEqual(benchmarkCredentials({
    SMOKE_USERNAME: 'member@example.test', SMOKE_PASSWORD: LOCAL_PASSWORD, SMOKE_RUN_ACCOUNT_PASSWORD: WRONG_PASSWORD,
  }), { username: 'member@example.test', password: LOCAL_PASSWORD, loginEmail: 'member@example.test', accountPassword: '' });
  assert.deepEqual(benchmarkCredentials({
    UI_BENCHMARK_USERNAME: 'local', UI_BENCHMARK_PASSWORD: LOCAL_PASSWORD, SMOKE_USERNAME: 'other@example.test',
    UI_BENCHMARK_LOGIN_EMAIL: ACCOUNT_EMAIL, SMOKE_LOGIN_EMAIL: 'fallback@example.test',
    UI_BENCHMARK_ACCOUNT_PASSWORD: ACCOUNT_PASSWORD, SMOKE_ACCOUNT_PASSWORD: WRONG_PASSWORD,
  }), { username: 'local', password: LOCAL_PASSWORD, loginEmail: ACCOUNT_EMAIL, accountPassword: ACCOUNT_PASSWORD });
  assert.deepEqual(benchmarkCredentials({ SMOKE_LOGIN_EMAIL: ACCOUNT_EMAIL, SMOKE_ACCOUNT_PASSWORD: ACCOUNT_PASSWORD }),
    { username: 'admin', password: 'admin', loginEmail: ACCOUNT_EMAIL, accountPassword: ACCOUNT_PASSWORD });
});

// A child environment built from an allowlist, so no operator SMOKE_* or
// UI_BENCHMARK_* value is inherited.
function childEnvironment(extra) {
  const environment = {};
  for (const name of ['PATH', 'HOME', 'TMPDIR', 'PLAYWRIGHT_BROWSERS_PATH']) {
    if (process.env[name]) environment[name] = process.env[name];
  }
  return { ...environment, ...extra };
}

function smokeArtifactPath(runId) {
  return path.join(repoRoot, '.ploinky', 'test-artifacts', 'headless-smoke', runId);
}

async function runChild(args, environment) {
  try {
    const { stdout, stderr } = await runFile(process.execPath, args,
      { cwd: smokeRoot, env: environment, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
    return { code: 0, stdout, stderr };
  } catch (error) {
    if (typeof error.code !== 'number') throw error;
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

test('importing the helper and benchmark and printing help create no smoke artifact or password', async () => {
  const runId = `ui-benchmark-auth-purity-${process.pid}-${Date.now()}`;
  const artifactDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ui-benchmark-auth-')), 'not-created');
  const environment = childEnvironment({ SMOKE_RUN_ID: runId, UI_BENCHMARK_ARTIFACT_DIR: artifactDir,
    UI_BENCHMARK_ACCOUNT_PASSWORD: ACCOUNT_PASSWORD, UI_BENCHMARK_PASSWORD: LOCAL_PASSWORD });
  try {
    const imported = await runChild(['--input-type=module', '-e', `
      await import(${JSON.stringify(new URL(`file://${helperModule}`).href)});
      await import(${JSON.stringify(new URL(`file://${benchmarkScript}`).href)});
      console.log(JSON.stringify({ runPassword: process.env.SMOKE_RUN_ACCOUNT_PASSWORD ?? null }));
    `], environment);
    assert.equal(imported.code, 0, imported.stderr);
    assert.deepEqual(JSON.parse(imported.stdout.trim().split('\n').at(-1)), { runPassword: null });
    const help = await runChild([benchmarkScript, '--help'], environment);
    assert.equal(help.code, 0, help.stderr);
    assert.match(help.stdout, /^Explorer UI benchmark\n\nUsage:/);
    assert.match(help.stdout, /--base-url http:\/\/localhost:8080/);
    assert.match(help.stdout, /UI_BENCHMARK_ACCOUNT_PASSWORD/);
    for (const output of [imported.stdout, imported.stderr, help.stdout, help.stderr]) assertNoSentinel(output, 'process output');
    assert.equal(fs.existsSync(artifactDir), false, 'help creates no benchmark artifact');
    assert.equal(fs.existsSync(smokeArtifactPath(runId)), false, 'no smoke configuration was loaded');
  } finally {
    fs.rmSync(path.dirname(artifactDir), { recursive: true, force: true });
  }
  const source = fs.readFileSync(helperModule, 'utf8');
  assert.deepEqual([...source.matchAll(/^\s*import\b[^;]*?from\s+['"]([^'"]+)['"]/gm)].map((match) => match[1]), [],
    'the shared helper imports nothing');
  assert.doesNotMatch(source, /process\.env|import\(/);
});

for (const [name, extra, expectation] of [
  ['an existing account', { UI_BENCHMARK_LOGIN_EMAIL: ACCOUNT_EMAIL }, 'existing'],
  ['an unknown account', { UI_BENCHMARK_LOGIN_EMAIL: UNKNOWN_EMAIL }, 'unknown'],
]) {
  test(`the benchmark command keeps credentials out of its output and result for ${name}`, async () => {
    fixture.reset();
    const runId = `ui-benchmark-auth-cli-${process.pid}-${Date.now()}`;
    const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-benchmark-auth-cli-'));
    try {
      const run = await runChild([benchmarkScript, '--base-url', fixture.baseURL, '--label', 'auth-fixture',
        '--iterations', '1', '--timeout-ms', '3000', '--artifact-dir', artifactDir, '--file-path', '/README.md'],
      childEnvironment({ SMOKE_RUN_ID: runId, UI_BENCHMARK_ACCOUNT_PASSWORD: ACCOUNT_PASSWORD,
        UI_BENCHMARK_USERNAME: LOCAL_USERNAME, UI_BENCHMARK_PASSWORD: LOCAL_PASSWORD, ...extra }));
      // The fabricated Explorer shell never becomes interactive, so the run fails after login.
      assert.equal(run.code, 1, run.stderr);
      const resultText = fs.readFileSync(path.join(artifactDir, 'result.json'), 'utf8');
      for (const output of [run.stdout, run.stderr, resultText]) assertNoSentinel(output, 'benchmark output');
      const report = JSON.parse(resultText);
      assert.equal(report.schemaVersion, 2);
      assert.deepEqual(report.scenario.steps.length, 10);
      const [iteration] = report.iterations;
      const requestSteps = (method, route) => iteration.waterfall.requests
        .filter((entry) => entry.method === method && entry.pathname === `${PROVIDER_PATH}${route}`)
        .map((entry) => entry.step);
      if (expectation === 'existing') {
        assert.deepEqual(iteration.steps.map((step) => [step.name, step.status]),
          [['router-login-page', 'passed'], ['login-to-explorer-interactive', 'failed']]);
        assert.equal(iteration.steps[0].details.finalPathname, PROVIDER_PATH);
        assert.deepEqual(requestSteps('POST', 'discover'), ['background']);
        assert.deepEqual(requestSteps('POST', 'password/login'), ['login-to-explorer-interactive']);
        assert.match(iteration.error.message, /Timeout 3000ms exceeded/, 'only Explorer readiness fails');
      } else {
        assert.deepEqual(iteration.steps.map((step) => [step.name, step.status]), [['router-login-page', 'passed']]);
        assert.equal(iteration.error.message,
          'BLOCKED: UserPersisto has no account for the configured email, and sign-up is not allowed here.');
        assert.deepEqual(requestSteps('POST', 'password/login'), []);
      }
      assertNothingCreated();
      assert.equal(fs.existsSync(smokeArtifactPath(runId)), false, 'no smoke configuration was loaded');
    } finally {
      fs.rmSync(artifactDir, { recursive: true, force: true });
    }
  });
}

// ---- navigation while a credential action is waiting ------------------------
// A field or button in the validated document is held unavailable, the page
// then moves while the benchmark's action waits, and the hold is released.
// The waiting action must never fill, click or send anything afterwards,
// even after its whole timeout has passed.
const RACE_TIMEOUT_MS = 2_000;
const ACCOUNT_VALUES = [ACCOUNT_EMAIL, ACCOUNT_PASSWORD, LOCAL_USERNAME, LOCAL_PASSWORD];

// Runs in every document: records input and click events (with whether the
// field now holds a benchmark value) and, only in the validated document,
// keeps the held element readonly or disabled until released.
function raceProbe({ origin, pathname, hold, values }) {
  const report = (event) => window.__authProbe?.({ ...event, href: location.href, driving: Boolean(window.__testDriving) });
  document.addEventListener('input', (event) => {
    if (event.target instanceof HTMLInputElement) {
      report({ type: 'input', name: event.target.name, account: values.includes(event.target.value) });
    }
  }, true);
  document.addEventListener('click', (event) => {
    const button = event.target instanceof Element ? event.target.closest('button') : null;
    if (button) report({ type: 'click', label: button.textContent.trim() });
  }, true);
  if (location.origin !== origin || location.pathname !== pathname) return;
  const selectors = {
    email: '#auth_content input[name="email"]',
    password: '#auth_content input[name="password"]',
    submit: '#auth_content button[type="submit"]',
    legacy: 'input[name="password"]',
  };
  const apply = () => {
    if (window.__holdReleased) return;
    for (const element of document.querySelectorAll(selectors[hold])) {
      if (hold === 'submit') {
        if (element.textContent.trim() === 'Log in' && !element.disabled) element.disabled = true;
      } else if (!element.readOnly) {
        element.readOnly = true;
      }
    }
  };
  window.__releaseHold = () => {
    window.__holdReleased = true;
    for (const element of document.querySelectorAll(selectors[hold])) {
      if (hold === 'submit') element.disabled = false;
      else element.readOnly = false;
    }
  };
  new MutationObserver(apply).observe(document, { childList: true, subtree: true });
}

async function waitFor(condition, what) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await condition().catch(() => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`timed out waiting for ${what}`);
}

async function runRace({ hold, move }) {
  const { runAuthenticationSteps, NetworkRecorder } = await import('../scripts/run-ui-benchmark.mjs');
  const legacy = hold === 'legacy';
  fixture.reset({ sso: !legacy });
  const config = benchmarkConfig({ timeoutMs: RACE_TIMEOUT_MS });
  const holdPath = legacy ? '/auth/login' : PROVIDER_PATH;
  const foreignOrigin = fixture.baseURL.replace('127.0.0.1', 'localhost');
  const events = [];
  const context = await browser.newContext();
  await context.exposeBinding('__authProbe', (_source, event) => { events.push(event); });
  await context.addInitScript(raceProbe, { origin: fixture.baseURL, pathname: holdPath, hold, values: ACCOUNT_VALUES });
  const page = await context.newPage();
  const session = await context.newCDPSession(page);
  await session.send('Performance.enable');
  const network = new NetworkRecorder(session, config.baseURL);
  await network.install();
  const state = { page, session, network, steps: [] };
  let error = null;
  const running = runAuthenticationSteps(state, config, { waitForInteractive: async () => {} })
    .then(() => {}, (caught) => { error = caught; });
  // Wait until the benchmark is blocked on the held action.
  if (hold === 'email') {
    await waitFor(async () => network.currentStep === 'background'
      && page.locator('#auth_content input[name="email"]').evaluate((input) => input.readOnly), 'the held email field');
  } else if (hold === 'password') {
    await waitFor(() => page.locator('#auth_content input[name="password"]').evaluate((input) => input.readOnly),
      'the held password field');
  } else if (hold === 'submit') {
    await waitFor(async () => network.currentStep === 'login-to-explorer-interactive', 'the login step');
  } else {
    await waitFor(async () => (await page.locator('input[name="username"]').inputValue()) !== ''
      && page.locator('input[name="password"]').evaluate((input) => input.readOnly), 'the held local password field');
  }
  await new Promise((resolve) => setTimeout(resolve, 300));
  const validatedHref = page.url();
  const requestMark = fixture.requests.length;
  const query = legacy ? '?returnTo=%2Fexplorer%2Findex.html' : '?requestId=fixture-state&state=fixture-state';
  if (move === 'cross-origin') {
    await page.goto(`${foreignOrigin}${holdPath}${query}`);
  } else if (move === 'foreign-path') {
    await page.goto(`${fixture.baseURL}${FOREIGN_SERVICE_PATH}${query}`);
  } else if (move === 'push-state') {
    await page.evaluate((target) => { history.pushState({}, '', target); window.__releaseHold(); }, `${FOREIGN_SERVICE_PATH}${query}`);
  } else {
    await page.evaluate(() => { location.hash = 'moved'; window.__releaseHold(); });
  }
  if (!legacy && ['cross-origin', 'foreign-path'].includes(move) && hold !== 'email') {
    // Give a stale action a real target: the destination's own password screen.
    await page.evaluate(() => { window.__testDriving = true; });
    await page.locator('#auth_content input[name="email"]').fill(DESTINATION_EMAIL);
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await page.getByRole('heading', { name: 'Enter your password', exact: true }).waitFor();
    await page.evaluate(() => { window.__testDriving = false; });
  }
  await running;
  // Outlast every bound wait before looking for a late effect.
  await new Promise((resolve) => setTimeout(resolve, RACE_TIMEOUT_MS + 500));
  const fieldsWithAccountValues = [];
  for (const input of await page.locator('input').all()) {
    if (ACCOUNT_VALUES.includes(await input.inputValue().catch(() => ''))) fieldsWithAccountValues.push(await input.getAttribute('name'));
  }
  await context.close();
  return {
    error,
    steps: state.steps.map((step) => [step.name, step.status]),
    movedAccountInputs: events.filter((event) => event.type === 'input' && event.account && event.href !== validatedHref)
      .map((event) => event.name),
    // The test itself only ever clicks Next in a destination; any other click
    // after the move, even while the test drives, came from the benchmark.
    movedClicks: events.filter((event) => event.type === 'click' && event.href !== validatedHref
      && !(event.driving && event.label === 'Next'))
      .map((event) => event.label),
    laterCredentialRequests: fixture.requests.slice(requestMark).filter((entry) => entry.method === 'POST'
      && (entry.email === ACCOUNT_EMAIL || entry.pathname.endsWith('/password/login') || entry.pathname === '/auth/login'))
      .map((entry) => entry.pathname),
    fieldsWithAccountValues,
  };
}

for (const [hold, moves] of [
  ['email', ['cross-origin', 'foreign-path', 'push-state', 'hash']],
  ['password', ['cross-origin', 'foreign-path', 'push-state']],
  ['submit', ['cross-origin', 'foreign-path', 'push-state']],
  ['legacy', ['cross-origin', 'push-state']],
]) {
  for (const move of moves) {
    test(`a ${move} move while the ${hold} action waits leaves no fill, click or request behind`, async () => {
      const result = await runRace({ hold, move });
      // Safety first, so a regression reports the leak rather than the message.
      assert.deepEqual(result.movedAccountInputs, [], 'no benchmark value was entered after the move');
      assert.deepEqual(result.movedClicks, [], 'nothing was clicked after the move');
      assert.deepEqual(result.laterCredentialRequests, [], 'no account request was sent after the move');
      // A same-document move keeps values entered before it in the validated
      // document; only the held field must stay empty there. A new document
      // must hold no benchmark value at all.
      const sameDocument = ['push-state', 'hash'].includes(move);
      const heldField = { email: 'email', password: 'password', submit: null, legacy: 'password' }[hold];
      assert.deepEqual(result.fieldsWithAccountValues.filter((name) => !sameDocument || name === heldField), [],
        'no field holds a benchmark value after the move');
      assert.equal(result.error?.message, 'Authentication left the validated login document.');
      assert.deepEqual(result.steps, hold === 'submit'
        ? [['router-login-page', 'passed'], ['login-to-explorer-interactive', 'failed']]
        : [['router-login-page', 'passed']]);
      assertSafeOutcome({ steps: [], requests: [], error: result.error });
    });
  }
}

// ---- navigation from the field's own focus listener -------------------------
// Focusing a field runs page listeners synchronously. A listener that moves
// the page to another service path must not receive the value that the bound
// action was about to write.
function focusMoveProbe({ field, target, values }) {
  document.addEventListener('input', (event) => {
    if (event.target instanceof HTMLInputElement) {
      window.__authProbe?.({ name: event.target.name, account: values.includes(event.target.value), pathname: location.pathname });
    }
  }, true);
  new MutationObserver(() => {
    const input = document.querySelector(`#auth_content input[name="${field}"]`);
    if (input && !input.dataset.focusMove) {
      input.dataset.focusMove = 'set';
      input.addEventListener('focus', () => { history.pushState({}, '', `${target}${location.search}`); }, { once: true });
    }
  }).observe(document, { childList: true, subtree: true });
}

for (const field of ['email', 'password']) {
  test(`a ${field} focus listener that moves to another service path receives no value`, async () => {
    const { runAuthenticationSteps, NetworkRecorder } = await import('../scripts/run-ui-benchmark.mjs');
    fixture.reset();
    const config = benchmarkConfig({ timeoutMs: RACE_TIMEOUT_MS });
    const events = [];
    const context = await browser.newContext();
    await context.exposeBinding('__authProbe', (_source, event) => { events.push(event); });
    await context.addInitScript(focusMoveProbe, { field, target: FOREIGN_SERVICE_PATH, values: ACCOUNT_VALUES });
    const page = await context.newPage();
    const session = await context.newCDPSession(page);
    await session.send('Performance.enable');
    const network = new NetworkRecorder(session, config.baseURL);
    await network.install();
    const state = { page, session, network, steps: [] };
    let error = null;
    try {
      await runAuthenticationSteps(state, config, { waitForInteractive: async () => {} }).catch((caught) => { error = caught; });
      // Outlast every bound wait before looking for a late effect.
      await new Promise((resolve) => setTimeout(resolve, RACE_TIMEOUT_MS + 500));
      assert.equal(new URL(page.url()).pathname, FOREIGN_SERVICE_PATH, 'the focus listener moved the page');
      assert.deepEqual(events.filter((event) => event.account && event.pathname !== PROVIDER_PATH), [],
        'no benchmark value was entered after the move');
      assert.equal(await page.locator(`#auth_content input[name="${field}"]`).inputValue(), '', 'the moved field stays empty');
      assert.deepEqual(fixture.requests.filter((entry) => entry.method === 'POST'
        && (entry.pathname.startsWith(FOREIGN_SERVICE_PATH) || entry.pathname.endsWith('/password/login'))), []);
      assert.deepEqual(fixture.providerPosts(), field === 'email' ? ['attempt'] : ['attempt', 'discover']);
      assert.equal(error?.message, 'Authentication left the validated login document.');
      assert.deepEqual(state.steps.map((step) => [step.name, step.status]), [['router-login-page', 'passed']]);
    } finally {
      await context.close();
    }
  });
}
