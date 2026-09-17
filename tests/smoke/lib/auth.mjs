import { createHmac } from 'node:crypto';
import { execFile } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

import { expect, recordPageNavigationFailure } from './fixtures.mjs';
import { beginAuthNavigationDiagnostics } from './auth-navigation-diagnostics.mjs';
import { smokeConfig } from './config.mjs';
import { getWithoutKeepAlive } from './api-probe.mjs';

const USERPERSISTO_LOGIN_PATH = '/base-agent-additional-server/userPersistoAgent/7000/service/auth/';
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const TOTP_PERIOD_MS = 30_000;
const TOTP_BOUNDARY_MARGIN_MS = 250;
const SIGN_IN_METHODS = new Set(['password', 'emailCode', 'totp']);

// RFC 6238 code for an enrolled authenticator secret (base32, SHA-1, 30 s, 6 digits).
export function totpToken(secret, time = Date.now()) {
  const clean = String(secret || '').replace(/=+$/g, '').replace(/\s+/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index < 0) throw new Error('The configured authenticator secret is not base32.');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  if (!bytes.length) throw new Error('The configured authenticator secret is empty.');
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(time / 1000 / 30)));
  const hmac = createHmac('sha1', Buffer.from(bytes)).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const code = ((hmac[offset] & 0x7f) << 24 | hmac[offset + 1] << 16 | hmac[offset + 2] << 8 | hmac[offset + 3]) % 1_000_000;
  return String(code).padStart(6, '0');
}

// Every accepted counter is single-use, including the enrollment counter.
// Always cross a boundary rather than remembering a worker-local last code:
// a new worker or a later suite can otherwise replay the preceding login.
export async function freshTotpToken(secret, {
    now = Date.now,
    wait = (durationMs, signal) => delay(durationMs, undefined, { signal }),
    signal,
    timeoutMs = smokeConfig.timeouts.navigation,
} = {}) {
    signal?.throwIfAborted();
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
        throw new Error('The authenticator wait timeout must be a positive integer.');
    }
    const startedAt = now();
    totpToken(secret, startedAt);
    const nextBoundary = (Math.floor(startedAt / TOTP_PERIOD_MS) + 1) * TOTP_PERIOD_MS + TOTP_BOUNDARY_MARGIN_MS;
    const deadline = startedAt + timeoutMs;
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const waitSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    const timeoutError = () => new Error('Timed out waiting for a fresh authenticator code.');
    try {
        while (true) {
            waitSignal.throwIfAborted();
            const time = now();
            const remainingMs = deadline - time;
            if (remainingMs <= 0) throw timeoutError();
            const waitMs = nextBoundary - time;
            if (waitMs <= 0) return totpToken(secret, time);
            if (waitMs >= remainingMs) throw timeoutError();
            await wait(waitMs, waitSignal);
        }
    } catch (error) {
        if (timeoutSignal.aborted && !signal?.aborted) throw timeoutError();
        throw error;
    }
}

async function fillFreshTotpToken(page, input, secret, timeout, clock = {}) {
    const controller = new AbortController();
    const abort = () => controller.abort(new Error('Authenticator sign-in stopped because its page closed or crashed.'));
    page.on('close', abort);
    page.on('crash', abort);
    try {
        if (page.isClosed()) abort();
        await input.waitFor({ state: 'visible', timeout });
        const token = await freshTotpToken(secret, { ...clock, signal: controller.signal, timeoutMs: timeout });
        await input.fill(token);
    } finally {
        page.off('close', abort);
        page.off('crash', abort);
    }
}

function runCodeCommand(command, email) {
  return new Promise((resolve, reject) => {
    // The address travels as data in the environment, never as shell text.
    execFile('/bin/sh', ['-c', command], { env: { ...process.env, SMOKE_EMAIL: email }, timeout: 15_000, maxBuffer: 1024 * 1024 },
      (error, stdout) => (error ? reject(error) : resolve(String(stdout || ''))));
  });
}

function latestCode(output) {
  return [...String(output || '').matchAll(/\b(\d{6})\b/g)].at(-1)?.[1] || '';
}

// Reads the newest UserPersisto email code for `email` through the operator's
// configured command (for example a test mailbox reader or the development
// log). A code equal to `after` is an earlier one and is not accepted.
export async function readEmailCode(email, {
  command = smokeConfig.emailCodeCommand,
  after = '',
  timeoutMs = smokeConfig.timeouts.navigation,
  intervalMs = 1_000,
  run = runCodeCommand,
} = {}) {
  if (!command) {
    throw new Error('BLOCKED: SMOKE_EMAIL_CODE_COMMAND is not configured, so email-code sign-in cannot be automated.');
  }
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  do {
    try {
      const code = latestCode(await run(command, email));
      if (code && code !== after) return code;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  } while (Date.now() < deadline);
  throw new Error(`No new UserPersisto email code arrived for the configured account${lastError ? ` (last command error: ${lastError.message})` : ''}.`);
}

async function currentEmailCode(email, run) {
  if (!smokeConfig.emailCodeCommand) return '';
  try {
    return latestCode(await (run || runCodeCommand)(smokeConfig.emailCodeCommand, email));
  } catch (_) {
    return '';
  }
}

// Clicks a wizard action that completes sign-in and waits for the Router
// callback navigation, reporting the wizard's own refusal instead of waiting
// for the navigation timeout. Refusal copy never contains a submitted secret.
async function completeThroughWizard(page, content, button, timeout) {
  const refusal = content.locator('[role="alert"]').filter({ hasText: /\S/ }).first();
  const navigated = page.waitForNavigation({ waitUntil: 'load', timeout }).then(() => false);
  const refused = refusal.waitFor({ state: 'visible', timeout }).then(() => true);
  // Only the first outcome matters; the other one is abandoned.
  navigated.catch(() => {});
  refused.catch(() => {});
  await button.click();
  if (await Promise.race([navigated, refused])) {
    const message = String(await refusal.textContent().catch(() => '') || '').trim();
    throw new Error(`UserPersisto refused the sign-in${message ? `: ${message}` : '.'}`);
  }
}

function requireEmailCodeCommand(purpose) {
  if (!smokeConfig.emailCodeCommand) {
    throw new Error(`BLOCKED: SMOKE_EMAIL_CODE_COMMAND is not configured, so ${purpose} cannot be automated.`);
  }
}

// Signs up an unknown email through Sign up, Create your password and the
// emailed verification code, then follows the automatic sign-in.
async function signUpThroughUserPersisto(page, content, { email, password, timeout, codeCommandRunner }) {
  requireEmailCodeCommand('the sign-up verification code');
  const baseline = await currentEmailCode(email, codeCommandRunner);
  await content.getByRole('button', { name: 'Sign up', exact: true }).click();
  const passwordInput = content.locator('input[name="password"]');
  await passwordInput.waitFor({ state: 'visible', timeout });
  await passwordInput.fill(password);
  await content.locator('input[name="passwordConfirmation"]').fill(password);
  await content.getByRole('button', { name: 'Create account', exact: true }).click();
  const codeInput = content.locator('input[name="code"]');
  const refusal = content.locator('[role="alert"]').filter({ hasText: /\S/ }).first();
  const collision = content.getByRole('heading', { name: 'Log in instead?', exact: true });
  await codeInput.or(refusal).or(collision).first().waitFor({ state: 'visible', timeout });
  if (await collision.isVisible()) throw new Error('An account already uses the configured sign-up email.');
  if (await refusal.isVisible()) {
    throw new Error(`UserPersisto refused the sign-up: ${String(await refusal.textContent() || '').trim()}`);
  }
  if (await content.getByRole('button', { name: 'Send again', exact: true }).isVisible()) {
    throw new Error('BLOCKED: UserPersisto could not send the sign-up verification code.');
  }
  const code = await readEmailCode(email, { after: baseline, ...(codeCommandRunner ? { run: codeCommandRunner } : {}) });
  await codeInput.fill(code);
  await completeThroughWizard(page, content, content.getByRole('button', { name: 'Verify', exact: true }), timeout);
}

// Drives the email-first wizard for administrators and other accounts: Email
// and Next, then the account password, or Try another way to an email code or
// an enrolled authenticator. An unknown email signs up instead. The account
// password is the configured one, or the run password for accounts this run
// signs up.
export async function signInThroughUserPersisto(page, account, { codeCommandRunner, totpClock } = {}) {
  const content = page.locator('#auth_content');
  const timeout = smokeConfig.timeouts.navigation;
  await content.locator('h1').first().waitFor({ state: 'visible', timeout });
  if (!SIGN_IN_METHODS.has(account.signInMethod)) {
    throw new Error('BLOCKED: automated UserPersisto sign-in requires password, emailCode or totp.');
  }
  // Wait for the rendered start screen, not the loading placeholder.
  const emailInput = content.locator('input[name="email"]');
  await emailInput.waitFor({ state: 'visible', timeout });
  // The first completed sign-in claims an unclaimed installation; a test
  // account must never become its administrator by accident.
  if (await content.getByText('The first completed sign-in becomes its administrator', { exact: false }).isVisible()) {
    throw new Error('UserPersisto setup is not complete. Claim the installation as its administrator before running account tests.');
  }
  const email = String(account.loginEmail || account.username || '').trim();
  if (!email.includes('@')) throw new Error('A UserPersisto account needs a configured sign-in email.');
  if (account.signInMethod === 'totp' && !account.totpSecret) {
    throw new Error('BLOCKED: the configured account uses an authenticator app but no TOTP secret is configured.');
  }
  const password = String(account.accountPassword || smokeConfig.runAccountPassword || '');
  await emailInput.fill(email);
  await content.getByRole('button', { name: 'Next', exact: true }).click();
  const passwordScreen = content.getByRole('heading', { name: 'Enter your password', exact: true });
  const signUp = content.getByRole('button', { name: 'Sign up', exact: true });
  const noEmailSignUp = content.getByRole('heading', { name: /^(No account found|Create an account with Google)$/ });
  await passwordScreen.or(signUp).or(noEmailSignUp).first().waitFor({ state: 'visible', timeout });
  if (await signUp.isVisible()) {
    await signUpThroughUserPersisto(page, content, { email, password, timeout, codeCommandRunner });
    return;
  }
  if (await noEmailSignUp.isVisible()) {
    throw new Error('BLOCKED: UserPersisto has no account for the configured email and offers no email sign-up.');
  }
  if (account.signInMethod === 'password') {
    const passwordInput = content.locator('input[name="password"]');
    if (await passwordInput.isDisabled()) {
      throw new Error('BLOCKED: password sign-in is not available for the configured account.');
    }
    await passwordInput.fill(password);
    await completeThroughWizard(page, content, content.getByRole('button', { name: 'Log in', exact: true }), timeout);
    return;
  }
  const totp = account.signInMethod === 'totp';
  if (!totp) requireEmailCodeCommand('email-code sign-in');
  await content.getByRole('button', { name: 'Try another way', exact: true }).click();
  const choice = content.getByRole('button', { name: totp ? 'Use an authenticator app' : 'Email me a code', exact: true });
  await choice.waitFor({ state: 'visible', timeout });
  if (await choice.isDisabled()) {
    throw new Error(`BLOCKED: ${totp ? 'authenticator' : 'email-code'} sign-in is not available for the configured account.`);
  }
  if (totp) {
    await choice.click();
    await fillFreshTotpToken(page, content.locator('input[name="token"]'), account.totpSecret, timeout, totpClock);
  } else {
    const baseline = await currentEmailCode(email, codeCommandRunner);
    await choice.click();
    const codeInput = content.locator('input[name="code"]');
    await codeInput.waitFor({ state: 'visible', timeout });
    const code = await readEmailCode(email, { after: baseline, ...(codeCommandRunner ? { run: codeCommandRunner } : {}) });
    await codeInput.fill(code);
  }
  await completeThroughWizard(page, content, content.getByRole('button', { name: 'Verify', exact: true }), timeout);
}

function loginForm(page) {
  return page.locator('form[action="/auth/login"], input#username, input[name="username"]').first();
}

export function normalizePrincipalComponent(value, name = 'authenticated principal component') {
  const normalized = String(value || '').normalize('NFKC').trim().toLowerCase();
  if (!normalized) throw new Error(`${name} is unavailable.`);
  return normalized;
}

export function validateAuthenticatedPrincipal(user, { expectedUsername, expectedEmail } = {}) {
  if (!user || typeof user !== 'object' || Array.isArray(user)) {
    throw new Error('The authenticated identity endpoint returned no user principal.');
  }
  const canonicalId = normalizePrincipalComponent(user.id, 'authenticated principal id');
  const returnedUsername = String(user.username || '').trim()
    ? normalizePrincipalComponent(user.username, 'authenticated principal username')
    : '';
  const returnedEmail = String(user.email || '').trim()
    ? normalizePrincipalComponent(user.email, 'authenticated principal email')
    : '';
  const canonicalUsername = returnedUsername
    || normalizePrincipalComponent(returnedEmail, 'authenticated principal username or email');
  const roles = Array.isArray(user.roles)
    ? user.roles.map((role) => normalizePrincipalComponent(role, 'authenticated principal role'))
    : [];
  if (roles.includes('guest') || canonicalId === 'guest' || canonicalId.startsWith('guest:')) {
    throw new Error('The authenticated identity endpoint returned a guest principal.');
  }
  const configuredUsername = expectedUsername === undefined
    ? ''
    : normalizePrincipalComponent(expectedUsername, 'configured account username');
  const configuredEmail = expectedEmail === undefined
    ? ''
    : normalizePrincipalComponent(expectedEmail, 'configured account login email');
  const usernameMatches = configuredUsername && (
    returnedUsername
      ? returnedUsername === configuredUsername
      : returnedEmail === configuredUsername
  );
  const emailMatches = configuredEmail && returnedEmail === configuredEmail;
  if ((configuredUsername || configuredEmail) && !usernameMatches && !emailMatches) {
    throw new Error('The authenticated principal does not match the configured account identity.');
  }
  return Object.freeze({ canonicalId, canonicalUsername, roles: Object.freeze(roles) });
}

export function assertDistinctAuthenticatedPrincipals(left, right) {
  const first = validateAuthenticatedPrincipal({
    id: left?.canonicalId,
    username: left?.canonicalUsername,
    roles: left?.roles,
  });
  const second = validateAuthenticatedPrincipal({
    id: right?.canonicalId,
    username: right?.canonicalUsername,
    roles: right?.roles,
  });
  if (first.canonicalId === second.canonicalId || first.canonicalUsername === second.canonicalUsername) {
    throw new Error('WebMeet release gates require two distinct authenticated principals.');
  }
  return Object.freeze([first, second]);
}

export async function readAuthenticatedPrincipal(page, account) {
  const result = await page.evaluate(async () => {
    const response = await fetch('/auth/token', {
      method: 'GET',
      credentials: 'include',
      cache: 'no-store',
      headers: { accept: 'application/json' },
    });
    if (!response.ok) return { ok: false, status: response.status, user: null };
    const payload = await response.json().catch(() => null);
    return {
      ok: true,
      status: response.status,
      user: payload?.user && typeof payload.user === 'object'
        ? {
            id: payload.user.id,
            username: payload.user.username,
            email: payload.user.email,
            roles: payload.user.roles,
          }
        : null,
    };
  });
  if (!result?.ok) {
    throw new Error(`Authenticated identity verification failed with HTTP ${Number(result?.status || 0) || 'unknown'}.`);
  }
  const principal = validateAuthenticatedPrincipal(result.user, {
    expectedUsername: account?.username,
    expectedEmail: account?.loginEmail,
  });
  return Object.freeze({
    ...principal,
    id: String(result.user.id),
    email: String(result.user.email || '').trim()
      ? normalizePrincipalComponent(result.user.email, 'authenticated principal email')
      : '',
  });
}

export async function hasAuthenticatedSession(request) {
  const response = await getWithoutKeepAlive(request, '/auth/token').catch(() => null);
  return Boolean(response?.ok());
}

export async function signIn(
  page,
  account = smokeConfig.primaryUser,
  returnTo = '/',
  { requireConfiguredPrincipal = false, totpClock } = {},
) {
  const navigation = await beginAuthNavigationDiagnostics(page, account);
  let stage = 'session-check';
  try {
    const sessionOk = await hasAuthenticatedSession(page.request);
    stage = sessionOk ? 'authenticated-navigation' : 'login-navigation';
    if (sessionOk) {
      await page.goto(returnTo, { waitUntil: 'load' });
    } else {
      const params = new URLSearchParams({
        agent: smokeConfig.authAgent,
        returnTo,
      });
      await page.goto(`/auth/login?${params.toString()}`, { waitUntil: 'load' });
    }

    const smokeOrigin = new URL(smokeConfig.baseURL).origin;
    // The Router SSO landing page redirects after load; wait before choosing a form.
    await expect.poll(async () => {
      const currentUrl = new URL(page.url());
      return currentUrl.origin !== smokeOrigin
        || currentUrl.pathname !== '/auth/login'
        || await loginForm(page).isVisible().catch(() => false);
    }, {
      timeout: smokeConfig.timeouts.navigation,
      message: 'Authentication did not reach a login form or redirect destination.',
    }).toBe(true);
    const loginUrl = new URL(page.url());
    if (loginUrl.origin !== smokeOrigin) {
      throw new Error('Authentication left the configured smoke origin.');
    }
    if (loginUrl.pathname === '/auth/login'
      && await loginForm(page).isVisible().catch(() => false)) {
      await page.locator('input#username, input[name="username"]').first().fill(account.username);
      await page.locator('input#password, input[name="password"]').first().fill(account.password);
      stage = 'login-submit-navigation';
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'load' }),
        page.locator('form[action="/auth/login"] button[type="submit"], button[type="submit"], .auth-btn').first().click(),
      ]);
    } else if (loginUrl.pathname === USERPERSISTO_LOGIN_PATH) {
      stage = 'login-submit-navigation';
      await signInThroughUserPersisto(page, account, { totpClock });
    }

    stage = 'final-load';
    await page.waitForLoadState('load');
    if (new URL(page.url()).origin !== smokeOrigin) {
      throw new Error('Authentication left the configured smoke origin.');
    }
    stage = 'principal-verification';
    await expect(page.locator('body')).not.toContainText(/Invalid username or password|Local auth is not configured/i);
    if (new URL(page.url()).pathname === '/auth/login') {
      throw new Error(`Login did not leave /auth/login for ${account.username}.`);
    }
    if (new URL(page.url()).pathname === USERPERSISTO_LOGIN_PATH) {
      throw new Error(`Login did not leave UserPersisto for ${account.username}.`);
    }
    return await readAuthenticatedPrincipal(page, requireConfiguredPrincipal ? account : undefined);
  } catch (error) {
    recordPageNavigationFailure(page, navigation.failure(error, stage));
    throw error;
  } finally {
    await navigation.dispose();
  }
}

export async function trySignIn(page, account = smokeConfig.primaryUser, returnTo = '/') {
  try {
    await signIn(page, account, returnTo);
    return true;
  } catch (_) {
    return false;
  }
}
