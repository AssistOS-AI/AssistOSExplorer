// Side-effect-free UserPersisto wizard steps shared by the smoke sign-in and
// the UI benchmark. This module reads no environment or configuration,
// creates no artifacts or passwords, starts no diagnostics, checks no
// session and navigates nowhere itself. Callers pass explicit origins and
// timeouts; no helper returns, logs or serializes a credential.

export const USERPERSISTO_LOGIN_PATH = '/base-agent-additional-server/userPersistoAgent/7000/service/auth/';
export const LEGACY_LOGIN_PATH = '/auth/login';
export const AUTHENTICATION_SURFACES = Object.freeze({
  legacy: 'legacy-login',
  userPersisto: 'userpersisto-login',
});

const SURFACE_POLL_MS = 50;
const UNCLAIMED_TEXT = 'The first completed sign-in becomes its administrator';
const INITIAL_SETUP_TEXT = 'First-time setup:';

function requireTimeout(timeoutMs) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error('The authentication timeout must be a positive integer.');
  }
  return timeoutMs;
}

function requireOrigin(value) {
  let parsed;
  try {
    parsed = new URL(String(value || ''));
  } catch {
    throw new Error('The expected authentication origin must be an absolute HTTP or HTTPS URL.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('The expected authentication origin must be an absolute HTTP or HTTPS URL.');
  }
  return parsed.origin;
}

function currentLocation(page) {
  try {
    return new URL(page.url());
  } catch {
    return null;
  }
}

// Refuses unless the page is exactly at `pathname` on `expectedOrigin`.
// Callers run it immediately before entering any credential or submitting.
export function assertAuthenticationLocation(page, { expectedOrigin, pathname }) {
  const origin = requireOrigin(expectedOrigin);
  const location = currentLocation(page);
  if (!location || location.origin !== origin) {
    throw new Error('Authentication left the expected origin.');
  }
  if (location.pathname !== pathname) {
    throw new Error('Authentication is not on the expected login path.');
  }
}

function legacyLoginForm(page) {
  return page.locator('form[action="/auth/login"], input#username, input[name="username"]').first();
}

// Waits for the rendered legacy form at /auth/login or the rendered email
// screen at the exact UserPersisto path, following a delayed Router
// redirect. Any other origin or path refuses before a credential is typed.
// Returns only a non-secret surface identifier.
export async function waitForAuthenticationSurface(page, { baseURL, timeoutMs } = {}) {
  const origin = requireOrigin(baseURL);
  const timeout = requireTimeout(timeoutMs);
  const deadline = Date.now() + timeout;
  const emailInput = page.locator('#auth_content input[name="email"]');
  while (true) {
    const location = currentLocation(page);
    if (!location || location.origin !== origin) {
      throw new Error('Authentication left the expected origin before a login surface rendered.');
    }
    if (location.pathname === LEGACY_LOGIN_PATH) {
      // The Router SSO landing page renders at this path and redirects later.
      if (await legacyLoginForm(page).isVisible().catch(() => false)) {
        assertAuthenticationLocation(page, { expectedOrigin: origin, pathname: LEGACY_LOGIN_PATH });
        return AUTHENTICATION_SURFACES.legacy;
      }
    } else if (location.pathname === USERPERSISTO_LOGIN_PATH) {
      if (await emailInput.isVisible().catch(() => false)) {
        assertAuthenticationLocation(page, { expectedOrigin: origin, pathname: USERPERSISTO_LOGIN_PATH });
        return AUTHENTICATION_SURFACES.userPersisto;
      }
    } else {
      throw new Error('Authentication reached an unsupported path before a login surface rendered.');
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw new Error('Timed out waiting for a login surface.');
    await new Promise((resolve) => setTimeout(resolve, Math.min(SURFACE_POLL_MS, remainingMs)));
  }
}

// Enters the account email on the UserPersisto start screen, selects Next and
// classifies the result as an existing account (`existing`) or an unknown
// one that the wizard offers to sign up (`signup`). An unclaimed installation
// refuses before the email is entered. With `allowSignup: false` an unknown
// account refuses before any Sign up click, so nothing is created.
export async function prepareUserPersistoAccount(page, { loginEmail, username } = {}, {
  expectedOrigin,
  timeoutMs,
  allowSignup,
} = {}) {
  const origin = requireOrigin(expectedOrigin);
  const timeout = requireTimeout(timeoutMs);
  if (typeof allowSignup !== 'boolean') {
    throw new Error('UserPersisto account preparation requires an explicit allowSignup choice.');
  }
  assertAuthenticationLocation(page, { expectedOrigin: origin, pathname: USERPERSISTO_LOGIN_PATH });
  const content = page.locator('#auth_content');
  // Wait for the rendered start screen, not the loading placeholder.
  const emailInput = content.locator('input[name="email"]');
  await emailInput.waitFor({ state: 'visible', timeout });
  // The first completed sign-in claims an unclaimed installation; a test
  // account must never become its administrator by accident.
  if (await content.getByText(UNCLAIMED_TEXT, { exact: false }).isVisible()) {
    throw new Error('UserPersisto setup is not complete. Claim the installation as its administrator before running account tests.');
  }
  const email = String(loginEmail || username || '').trim();
  if (!email.includes('@')) throw new Error('A UserPersisto account needs a configured sign-in email.');
  assertAuthenticationLocation(page, { expectedOrigin: origin, pathname: USERPERSISTO_LOGIN_PATH });
  await emailInput.fill(email);
  await content.getByRole('button', { name: 'Next', exact: true }).click();
  const passwordScreen = content.getByRole('heading', { name: 'Enter your password', exact: true });
  const signUp = content.getByRole('button', { name: 'Sign up', exact: true });
  const noEmailSignUp = content.getByRole('heading', { name: /^(No account found|Create an account with Google)$/ });
  await passwordScreen.or(signUp).or(noEmailSignUp).first().waitFor({ state: 'visible', timeout });
  assertAuthenticationLocation(page, { expectedOrigin: origin, pathname: USERPERSISTO_LOGIN_PATH });
  if (await content.getByText(INITIAL_SETUP_TEXT, { exact: false }).isVisible()) {
    throw new Error('UserPersisto setup is not complete. Claim the installation as its administrator before running account tests.');
  }
  if (await signUp.isVisible()) {
    if (!allowSignup) {
      throw new Error('BLOCKED: UserPersisto has no account for the configured email, and sign-up is not allowed here.');
    }
    return Object.freeze({ state: 'signup', content });
  }
  if (await noEmailSignUp.isVisible()) {
    throw new Error('BLOCKED: UserPersisto has no account for the configured email and offers no email sign-up.');
  }
  return Object.freeze({ state: 'existing', content });
}

// Clicks a wizard action that completes sign-in and waits for the Router
// callback navigation, reporting the wizard's own refusal instead of waiting
// for the navigation timeout. Refusal copy never contains a submitted secret;
// `safeRefusal` replaces it with fixed text for callers that must not record
// page content.
export async function completeThroughWizard(page, content, button, timeoutMs, {
  expectedOrigin,
  safeRefusal = false,
} = {}) {
  const origin = requireOrigin(expectedOrigin);
  const timeout = requireTimeout(timeoutMs);
  assertAuthenticationLocation(page, { expectedOrigin: origin, pathname: USERPERSISTO_LOGIN_PATH });
  const refusal = content.locator('[role="alert"]').filter({ hasText: /\S/ }).first();
  const navigated = page.waitForNavigation({ waitUntil: 'load', timeout }).then(() => false);
  const refused = refusal.waitFor({ state: 'visible', timeout }).then(() => true);
  // Only the first outcome matters; the other one is abandoned.
  navigated.catch(() => {});
  refused.catch(() => {});
  await button.click();
  if (await Promise.race([navigated, refused])) {
    if (safeRefusal) throw new Error('UserPersisto refused the sign-in.');
    const message = String(await refusal.textContent().catch(() => '') || '').trim();
    throw new Error(`UserPersisto refused the sign-in${message ? `: ${message}` : '.'}`);
  }
  if (currentLocation(page)?.origin !== origin) {
    throw new Error('Authentication left the expected origin.');
  }
}
