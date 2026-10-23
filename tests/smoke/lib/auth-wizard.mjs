// Side-effect-free UserPersisto wizard steps shared by the smoke sign-in and
// the UI benchmark. This module reads no environment or configuration,
// creates no artifacts or passwords, starts no diagnostics, checks no
// session and navigates nowhere itself. Callers pass explicit origins and
// timeouts; no helper returns, logs or serializes a credential.
//
// Credential entry and submission are bound to one validated document. A
// Playwright locator action re-resolves its selector after a navigation, so a
// fill that was waiting could land in the next document. Bound actions instead
// wait on an element handle, which fails once its document is gone, and then
// fill or click in a single in-page step that first rechecks the document
// mark and the exact address. Nothing is left pending after a refusal.

export const USERPERSISTO_LOGIN_PATH = '/base-agent-additional-server/userPersistoAgent/7000/service/auth/';
export const LEGACY_LOGIN_PATH = '/auth/login';
export const AUTHENTICATION_SURFACES = Object.freeze({
  legacy: 'legacy-login',
  userPersisto: 'userpersisto-login',
});

const SURFACE_POLL_MS = 50;
const LEFT_DOCUMENT = 'Authentication left the validated login document.';
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

// Marks the current main-frame document as the validated authentication
// document and records its exact address. The location check and the mark
// happen in one in-page step, so a navigation cannot slip between them.
export async function bindAuthenticationDocument(page, { expectedOrigin, pathname, timeoutMs } = {}) {
  const origin = requireOrigin(expectedOrigin);
  const timeout = requireTimeout(timeoutMs);
  assertAuthenticationLocation(page, { expectedOrigin: origin, pathname });
  const mark = `__authenticationDocument${globalThis.crypto.randomUUID().replace(/-/g, '')}`;
  const href = await page.evaluate(({ mark: name, origin: allowedOrigin, pathname: allowedPath }) => {
    if (location.origin !== allowedOrigin || location.pathname !== allowedPath) return '';
    Object.defineProperty(window, name, { value: true });
    return location.href;
  }, { mark, origin, pathname }).catch(() => '');
  if (!href) throw new Error(LEFT_DOCUMENT);
  return Object.freeze({ page, mark, href, origin, pathname, timeoutMs: timeout });
}

function requireBinding(binding) {
  if (!binding || typeof binding.mark !== 'string' || typeof binding.href !== 'string' || !binding.page) {
    throw new Error('Authentication actions require a validated login document.');
  }
  return binding;
}

// True while the page still shows the bound document at its exact address.
export async function documentStillBound(binding) {
  const { page, mark, href } = requireBinding(binding);
  if (page.url() !== href) return false;
  return page.evaluate(({ mark: name, href: address }) => window[name] === true && location.href === address,
    { mark, href }).catch(() => false);
}

export async function assertDocumentBound(binding) {
  if (!(await documentStillBound(binding))) throw new Error(LEFT_DOCUMENT);
}

// Waits for the element in the bound document, then fills or clicks it in one
// in-page step. A replaced element in a still-bound document (the wizard
// rebuilds its screens) is resolved again within the same deadline; any other
// change refuses with fixed text.
async function boundAction(binding, locator, kind, value = '') {
  const { mark, href, timeoutMs } = requireBinding(binding);
  const deadline = Date.now() + timeoutMs;
  while (true) {
    await assertDocumentBound(binding);
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw new Error('Timed out waiting for an authentication field.');
    let handle = null;
    let outcome;
    try {
      handle = await locator.elementHandle({ timeout: remainingMs });
      await handle.waitForElementState('visible', { timeout: Math.max(1, deadline - Date.now()) });
      await handle.waitForElementState(kind === 'fill' ? 'editable' : 'enabled', { timeout: Math.max(1, deadline - Date.now()) });
      outcome = await handle.evaluate((element, args) => {
        const moved = () => !element.isConnected || window[args.mark] !== true || location.href !== args.href;
        if (moved()) return 'moved';
        if (element.disabled || (args.kind === 'fill' && element.readOnly)) return 'unavailable';
        if (args.kind === 'fill') {
          element.focus();
          // Focus runs page listeners synchronously; check again before writing.
          if (moved()) return 'moved';
          if (element.disabled || element.readOnly) return 'unavailable';
          element.value = args.value;
          element.dispatchEvent(new Event('input', { bubbles: true }));
          element.dispatchEvent(new Event('change', { bubbles: true }));
        } else {
          element.click();
        }
        return 'done';
      }, { mark, href, kind, value: kind === 'fill' ? String(value) : '' });
    } catch (error) {
      if (!(await documentStillBound(binding))) throw new Error(LEFT_DOCUMENT);
      if (Date.now() >= deadline || error?.name === 'TimeoutError') throw error;
      outcome = 'retry';
    } finally {
      await handle?.dispose().catch(() => {});
    }
    if (outcome === 'done') return;
    if (outcome === 'moved') throw new Error(LEFT_DOCUMENT);
    // The element was replaced or became unavailable inside the bound document.
    await new Promise((resolve) => setTimeout(resolve, Math.min(SURFACE_POLL_MS, Math.max(0, deadline - Date.now()))));
  }
}

export function fillInBoundDocument(binding, locator, value) {
  return boundAction(binding, locator, 'fill', value);
}

export function clickInBoundDocument(binding, locator) {
  return boundAction(binding, locator, 'click');
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
// account refuses before any Sign up click, so nothing is created. The
// returned binding confines every later credential action to this document.
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
  const binding = await bindAuthenticationDocument(page, {
    expectedOrigin: origin,
    pathname: USERPERSISTO_LOGIN_PATH,
    timeoutMs: timeout,
  });
  await fillInBoundDocument(binding, emailInput, email);
  await clickInBoundDocument(binding, content.getByRole('button', { name: 'Next', exact: true }));
  const passwordScreen = content.getByRole('heading', { name: 'Enter your password', exact: true });
  const signUp = content.getByRole('button', { name: 'Sign up', exact: true });
  const noEmailSignUp = content.getByRole('heading', { name: /^(No account found|Create an account with Google)$/ });
  await passwordScreen.or(signUp).or(noEmailSignUp).first().waitFor({ state: 'visible', timeout });
  // Classification reads only count while the bound document is still shown.
  await assertDocumentBound(binding);
  if (await content.getByText(INITIAL_SETUP_TEXT, { exact: false }).isVisible()) {
    throw new Error('UserPersisto setup is not complete. Claim the installation as its administrator before running account tests.');
  }
  if (await signUp.isVisible()) {
    if (!allowSignup) {
      throw new Error('BLOCKED: UserPersisto has no account for the configured email, and sign-up is not allowed here.');
    }
    await assertDocumentBound(binding);
    return Object.freeze({ state: 'signup', content, binding });
  }
  if (await noEmailSignUp.isVisible()) {
    throw new Error('BLOCKED: UserPersisto has no account for the configured email and offers no email sign-up.');
  }
  await assertDocumentBound(binding);
  return Object.freeze({ state: 'existing', content, binding });
}

// Clicks a wizard action that completes sign-in, in the bound document, and
// waits for the Router callback navigation, reporting the wizard's own
// refusal instead of waiting for the navigation timeout. Refusal copy never
// contains a submitted secret; `safeRefusal` replaces it with fixed text for
// callers that must not record page content.
export async function completeThroughWizard(page, content, button, timeoutMs, {
  binding,
  safeRefusal = false,
} = {}) {
  const bound = requireBinding(binding);
  if (bound.page !== page || bound.pathname !== USERPERSISTO_LOGIN_PATH) {
    throw new Error('Authentication actions require a validated login document.');
  }
  const origin = bound.origin;
  const timeout = requireTimeout(timeoutMs);
  const refusal = content.locator('[role="alert"]').filter({ hasText: /\S/ }).first();
  const navigated = page.waitForNavigation({ waitUntil: 'load', timeout }).then(() => false);
  const refused = refusal.waitFor({ state: 'visible', timeout }).then(() => true);
  // Only the first outcome matters; the other one is abandoned.
  navigated.catch(() => {});
  refused.catch(() => {});
  await clickInBoundDocument(bound, button);
  if (await Promise.race([navigated, refused])) {
    if (safeRefusal) throw new Error('UserPersisto refused the sign-in.');
    const message = String(await refusal.textContent().catch(() => '') || '').trim();
    throw new Error(`UserPersisto refused the sign-in${message ? `: ${message}` : '.'}`);
  }
  if (currentLocation(page)?.origin !== origin) {
    throw new Error('Authentication left the expected origin.');
  }
}
