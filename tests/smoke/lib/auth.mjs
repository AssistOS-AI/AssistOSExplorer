import { expect, recordPageNavigationFailure } from './fixtures.mjs';
import { beginAuthNavigationDiagnostics } from './auth-navigation-diagnostics.mjs';
import { smokeConfig } from './config.mjs';
import { getWithoutKeepAlive } from './api-probe.mjs';

const USERPERSISTO_LOGIN_PATH = '/base-agent-additional-server/userPersistoAgent/7000/service/auth/';

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
  return validateAuthenticatedPrincipal(result.user, {
    expectedUsername: account?.username,
    expectedEmail: account?.loginEmail,
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
  { requireConfiguredPrincipal = false } = {},
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
      await page.locator('#auth_content form.password-panel, #auth_content form.registration-panel')
        .first().waitFor({ state: 'visible', timeout: smokeConfig.timeouts.navigation });
      const passwordForm = page.locator('#auth_content form.password-panel');
      if (!await passwordForm.isVisible()) {
        throw new Error('UserPersisto password sign-in is unavailable. Complete installation setup before running smoke tests.');
      }
      await passwordForm.locator('input[name="email"]').fill(account.loginEmail || account.username);
      await passwordForm.locator('input[name="password"]').fill(account.password);
      stage = 'login-submit-navigation';
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'load' }),
        passwordForm.getByRole('button', { name: 'Sign in', exact: true }).click(),
      ]);
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
