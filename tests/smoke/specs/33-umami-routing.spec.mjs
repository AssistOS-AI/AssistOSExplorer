import { signIn } from '../lib/auth.mjs';
import { smokeConfig } from '../lib/config.mjs';
import { acknowledgeExactPageDiagnostics, checkpointPageDiagnostics, expect, test } from '../lib/fixtures.mjs';
import { findSecretLeaks } from '../lib/security.mjs';
import { beginUmamiSignedOutProof, verifyUmamiBrowserAuthorization } from '../lib/umami-auth-diagnostics.mjs';
import { installUmamiRscDiagnostics } from '../lib/umami-rsc-diagnostics.mjs';

const DASHBOARD_PREFIX = '/base-agent-additional-server/umamiAgent/3000/';

function isPublishedPath(pathname) {
  return pathname === DASHBOARD_PREFIX.slice(0, -1) || pathname.startsWith(DASHBOARD_PREFIX);
}

function required(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name} is required when SMOKE_UMAMI=1.`);
  return value;
}

function urlEvidence(value) {
  const url = new URL(value);
  return {
    origin: url.origin,
    pathname: url.pathname,
    queryKeys: Array.from(url.searchParams.keys()).sort(),
  };
}

function privateOrigin(value, routerOrigin) {
  const url = new URL(value);
  if (url.origin === routerOrigin) return false;
  const hostname = url.hostname.toLowerCase();
  return hostname === 'localhost'
    || hostname === '127.0.0.1'
    || hostname === '0.0.0.0'
    || hostname === 'host.containers.internal'
    || ['3000', '3001', '5432', '7301'].includes(url.port);
}

async function attachEvidence(testInfo, name, value) {
  const payload = JSON.stringify(value, null, 2);
  expect(findSecretLeaks(payload), `secret values leaked into ${name}`).toEqual([]);
  await testInfo.attach(name, {
    body: Buffer.from(payload, 'utf8'),
    contentType: 'application/json',
  });
}

test.describe('Umami Router publication @external', () => {
  test('authenticated dashboard keeps HTML, assets, API, and navigation under its base path', async ({ page }, testInfo) => {
    test.skip(!smokeConfig.flags.umami, 'SMOKE_UMAMI is off.');
    const umamiUsername = required('SMOKE_UMAMI_USERNAME');
    const umamiPassword = required('SMOKE_UMAMI_PASSWORD');
    const routerOrigin = new URL(smokeConfig.baseURL).origin;
    // This Router GET is static HTML and does not revoke the session. Complete
    // provider sign-in and its principal check before observing service traffic.
    await signIn(page, smokeConfig.primaryUser, '/auth/logged-out', { requireConfiguredPrincipal: true });
    const loginUrl = new URL(`${DASHBOARD_PREFIX}api/auth/login`, routerOrigin).href;
    const verifyUrl = new URL(`${DASHBOARD_PREFIX}api/auth/verify`, routerOrigin).href;
    const rscDiagnostics = await installUmamiRscDiagnostics(page, {
      origin: routerOrigin,
      publicationPath: DASHBOARD_PREFIX.slice(0, -1),
    });

    const requests = [];
    const documentResponses = [];
    const postLoginDocuments = [];
    const dashboardDocuments = [];
    let loginSucceeded = false;
    let dashboardNavigationStarted = false;
    page.on('request', (request) => {
      const url = new URL(request.url());
      requests.push({
        url: request.url(),
        method: request.method(),
        resourceType: request.resourceType(),
      });
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
        if (loginSucceeded && url.pathname === `${DASHBOARD_PREFIX}login`) {
          postLoginDocuments.push(urlEvidence(request.url()));
        }
        if (dashboardNavigationStarted) dashboardDocuments.push(urlEvidence(request.url()));
      }
    });
    page.on('response', (response) => {
      if (response.url() === loginUrl && response.request().method() === 'POST' && response.status() === 200) {
        loginSucceeded = true;
      }
      if (response.request().isNavigationRequest() && response.frame() === page.mainFrame()
        && isPublishedPath(new URL(response.url()).pathname)) documentResponses.push(response);
    });

    const assertSignedOut = beginUmamiSignedOutProof(page, {
      verifyUrl,
      timeout: smokeConfig.timeouts.navigation,
    });
    await page.goto(`${DASHBOARD_PREFIX}login`, { waitUntil: 'load' });
    const response = documentResponses.at(-1);
    expect(response, 'Umami navigation must produce its document response').toBeTruthy();
    expect(response?.status(), 'Umami dashboard HTML response').toBeLessThan(400);
    expect(isPublishedPath(new URL(page.url()).pathname)).toBe(true);

    const usernameInput = page.locator('input[name="username"], input[autocomplete="username"]').first();
    const passwordInput = page.locator('input[name="password"], input[type="password"]').first();
    await expect(usernameInput, 'Umami must retain its defense-in-depth login').toBeVisible();
    await expect(passwordInput).toBeVisible();
    const signedOut = await assertSignedOut();
    await rscDiagnostics.beginAuthenticatedPhase();
    const authenticatedDiagnostics = checkpointPageDiagnostics(page, 'Umami authenticated response completion');
    const loginResponsePromise = page.waitForResponse(
      (candidate) => candidate.url() === loginUrl && candidate.request().method() === 'POST',
      { timeout: smokeConfig.timeouts.navigation },
    );
    await usernameInput.fill(umamiUsername);
    await passwordInput.fill(umamiPassword);
    await page.locator('form button[type="submit"], button[type="submit"]').first().click();
    const loginResponse = await loginResponsePromise;
    expect(loginResponse.status(), 'Umami credential login must succeed').toBe(200);
    expect(await loginResponse.finished() === null, 'Umami login response must complete').toBe(true);
    expect(loginResponse.request().failure() === null, 'Umami login request must not fail').toBe(true);
    await expect(passwordInput, 'Umami login must leave the credential form').toBeHidden({
      timeout: smokeConfig.timeouts.navigation,
    });
    await expect(page.locator('body')).not.toContainText(/invalid password|invalid credentials|login failed/i);

    const api = await page.evaluate(async (path) => {
      const apiResponse = await fetch(path, { cache: 'no-store', credentials: 'include' });
      return {
        status: apiResponse.status,
        contentType: apiResponse.headers.get('content-type') || '',
        bodyLength: (await apiResponse.text()).length,
      };
    }, `${DASHBOARD_PREFIX}api/heartbeat`);
    expect(api.status, 'Umami heartbeat API through Router').toBe(200);
    expect(api.bodyLength).toBeGreaterThan(0);

    let navigation;
    await expect.poll(async () => {
      const currentPath = new URL(page.url()).pathname;
      const anchors = page.locator('a[href]');
      for (let index = 0; index < await anchors.count(); index += 1) {
        const anchor = anchors.nth(index);
        if (!await anchor.isVisible()) continue;
        const href = await anchor.getAttribute('href');
        if (!href || href.startsWith('#') || href.startsWith('mailto:')) continue;
        const resolved = new URL(href, page.url());
        if (resolved.origin !== routerOrigin) continue;
        if (!isPublishedPath(resolved.pathname) || resolved.pathname === currentPath) continue;
        if (/\/(?:login|logout)\/?$/i.test(resolved.pathname)) continue;
        if (resolved.pathname !== `${DASHBOARD_PREFIX}dashboard`) continue;
        navigation = { href, pathname: resolved.pathname, fromPath: currentPath };
        return true;
      }
      return false;
    }, {
      message: 'Umami must render a visible in-app dashboard navigation link',
      timeout: smokeConfig.timeouts.navigation,
    }).toBe(true);
    dashboardNavigationStarted = true;
    await page.locator(`a[href=${JSON.stringify(navigation.href)}]:visible`).first().click();
    expect(navigation.pathname).not.toBe(navigation.fromPath);
    await expect.poll(() => {
      const url = new URL(page.url());
      return { origin: url.origin, pathname: url.pathname };
    }, {
      message: 'Umami in-app navigation reaches the exact selected destination',
      timeout: smokeConfig.timeouts.navigation,
    }).toEqual({ origin: routerOrigin, pathname: navigation.pathname });
    await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible({
      timeout: smokeConfig.timeouts.navigation,
    });
    const designLink = page.getByRole('link', { name: 'Design', exact: true });
    await expect(designLink).toHaveAttribute('href', `${DASHBOARD_PREFIX}dashboard/edit`);
    await expect(designLink).toBeVisible();

    const authorization = await verifyUmamiBrowserAuthorization(page, {
      path: `${DASHBOARD_PREFIX}api/auth/verify`,
      expectedUsername: umamiUsername,
    });
    expect(authorization, 'the application token must authorize a completed verification without changing app state')
      .toEqual({ hasToken: true, status: 200, validUser: true });
    expect(postLoginDocuments, 'successful Umami login must not reload its login document').toEqual([]);
    expect(dashboardDocuments, 'Umami Dashboard navigation must stay within the current document').toEqual([]);

    const sameOriginRequests = requests.filter((entry) => new URL(entry.url).origin === routerOrigin);
    expect(sameOriginRequests.length, 'Umami must issue same-origin Router requests').toBeGreaterThan(1);
    expect(
      sameOriginRequests.filter((entry) => ['script', 'stylesheet', 'font', 'image'].includes(entry.resourceType)).length,
      'Umami must load at least one browser asset through the base path',
    ).toBeGreaterThan(0);
    for (const entry of sameOriginRequests) {
      expect(isPublishedPath(new URL(entry.url).pathname), `root-relative Umami request leaked: ${entry.url}`).toBe(true);
    }
    expect(requests.some((entry) => privateOrigin(entry.url, routerOrigin)), 'Umami must not dial a browser-visible private origin').toBe(false);

    const domUrls = await page.locator('[src], [href], [action]').evaluateAll((elements) => (
      elements.flatMap((element) => ['src', 'href', 'action']
        .map((attribute) => element.getAttribute(attribute))
        .filter(Boolean)
        .map((value) => new URL(value, document.baseURI).href))
    ));
    expect(domUrls.some((url) => privateOrigin(url, routerOrigin)), 'Umami DOM must not expose private origins').toBe(false);
    for (const url of domUrls.filter((value) => new URL(value).origin === routerOrigin)) {
      const pathname = new URL(url).pathname;
      if (pathname === new URL(page.url()).pathname && new URL(url).hash) continue;
      expect(isPublishedPath(pathname), `root-relative Umami DOM URL leaked: ${url}`).toBe(true);
    }

    const completion = await rscDiagnostics.drainAndProve({ timeout: smokeConfig.timeouts.navigation });
    expect(postLoginDocuments, 'successful Umami login must not reload its login document during drain').toEqual([]);
    expect(dashboardDocuments, 'Umami Dashboard must remain in the same document during drain').toEqual([]);
    await attachEvidence(testInfo, 'umami-rsc-response-completion', completion.proof);
    acknowledgeExactPageDiagnostics(page, authenticatedDiagnostics, completion.expectedSignatures);

    await attachEvidence(testInfo, 'umami-dashboard-routing', {
      finalUrl: urlEvidence(page.url()),
      api,
      signedOut,
      authorization,
      requests: requests.map((entry) => ({ ...urlEvidence(entry.url), method: entry.method, resourceType: entry.resourceType })),
    });
  });

});
