import { signIn } from '../lib/auth.mjs';
import { smokeConfig } from '../lib/config.mjs';
import { expect, test } from '../lib/fixtures.mjs';
import { findSecretLeaks } from '../lib/security.mjs';

const SERVICE_PREFIX = '/base-agent-additional-server/GPTResearcher/8000/';

function privateOrigin(value, routerOrigin) {
  const url = new URL(value);
  if (url.origin === routerOrigin) return false;
  const hostname = url.hostname.toLowerCase();
  return hostname === 'localhost'
    || hostname === '127.0.0.1'
    || hostname === '0.0.0.0'
    || hostname === 'host.containers.internal'
    || url.port === '8000';
}

function urlEvidence(value) {
  const url = new URL(value);
  return {
    protocol: url.protocol,
    origin: url.origin,
    pathname: url.pathname,
    queryKeys: Array.from(url.searchParams.keys()).sort(),
  };
}

async function attachEvidence(testInfo, name, value) {
  const payload = JSON.stringify(value, null, 2);
  expect(findSecretLeaks(payload), `secret values leaked into ${name}`).toEqual([]);
  await testInfo.attach(name, {
    body: Buffer.from(payload, 'utf8'),
    contentType: 'application/json',
  });
}

test.describe('GPTResearcher Router publication @external', () => {
  test('real HTML, assets, API, redirect, and WebSocket stay under the configured base path', async ({ page }, testInfo) => {
    test.skip(!smokeConfig.flags.gptResearcher, 'SMOKE_GPT_RESEARCHER is off.');
    const routerOrigin = new URL(smokeConfig.baseURL).origin;
    // This Router GET is static HTML and does not revoke the session. Complete
    // provider sign-in and its principal check before observing service traffic.
    await signIn(page, smokeConfig.primaryUser, '/auth/logged-out', { requireConfiguredPrincipal: true });
    const requests = [];
    const websocketEvents = [];
    const documentResponses = [];
    page.on('request', (request) => {
      requests.push({
        url: request.url(),
        method: request.method(),
        resourceType: request.resourceType(),
      });
    });
    page.on('response', (response) => {
      if (response.request().isNavigationRequest() && response.frame() === page.mainFrame()
        && new URL(response.url()).pathname.startsWith(SERVICE_PREFIX)) documentResponses.push(response);
    });
    page.on('websocket', (websocket) => {
      const event = { url: websocket.url(), sent: 0, received: 0 };
      websocketEvents.push(event);
      websocket.on('framesent', () => { event.sent += 1; });
      websocket.on('framereceived', () => { event.received += 1; });
    });

    await page.goto(SERVICE_PREFIX, { waitUntil: 'load' });
    const htmlResponse = documentResponses.at(-1);
    expect(htmlResponse, 'GPTResearcher navigation must produce its document response').toBeTruthy();
    expect(htmlResponse?.status(), 'GPTResearcher HTML through Router').toBe(200);
    expect(new URL(page.url()).pathname).toBe(SERVICE_PREFIX);
    await expect(page.locator('h1')).toContainText(/Research/i);
    await expect(page.locator('#researchForm')).toBeVisible();
    await expect(page.locator('#task')).toBeEditable();

    const html = await page.content();
    expect(html).not.toMatch(/(?:src|href|action)=["']\/(?:static|site|api|ws)(?:\/|["'])/i);
    expect(html).not.toMatch(/https?:\/\/(?:127\.0\.0\.1|localhost|0\.0\.0\.0)(?::8000)?/i);

    const api = await page.evaluate(async (path) => {
      const response = await fetch(path, { cache: 'no-store', credentials: 'include' });
      let payload = null;
      try {
        payload = await response.json();
      } catch (_) {
        payload = null;
      }
      return {
        status: response.status,
        contentType: response.headers.get('content-type') || '',
        reportsIsArray: Array.isArray(payload?.reports),
      };
    }, `${SERVICE_PREFIX}api/reports`);
    expect(api).toMatchObject({ status: 200, reportsIsArray: true });
    expect(api.contentType).toMatch(/json/i);

    const redirectResponse = await page.request.get(`${routerOrigin}${SERVICE_PREFIX}site`, {
      maxRedirects: 0,
      failOnStatusCode: false,
    });
    expect([301, 302, 307, 308]).toContain(redirectResponse.status());
    const location = redirectResponse.headers().location || '';
    expect(location, 'GPTResearcher static redirect must include a Location header').toBeTruthy();
    const resolvedLocation = new URL(location, `${routerOrigin}${SERVICE_PREFIX}site`);
    expect(resolvedLocation.origin).toBe(routerOrigin);
    expect(resolvedLocation.pathname).toBe(`${SERVICE_PREFIX}site/`);

    const websocket = await page.evaluate(async (path) => {
      const target = new URL(path, window.location.href);
      target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:';
      return new Promise((resolve, reject) => {
        const socket = new WebSocket(target.href);
        const timer = setTimeout(() => {
          socket.close();
          reject(new Error('GPTResearcher WebSocket ping timed out.'));
        }, 15_000);
        socket.addEventListener('open', () => socket.send('ping'), { once: true });
        socket.addEventListener('message', (event) => {
          if (event.data !== 'pong') return;
          clearTimeout(timer);
          const result = {
            protocol: target.protocol,
            origin: target.origin,
            pathname: target.pathname,
            message: event.data,
          };
          socket.close(1000, 'release gate complete');
          resolve(result);
        });
        socket.addEventListener('error', () => {
          clearTimeout(timer);
          reject(new Error('GPTResearcher WebSocket failed before pong.'));
        }, { once: true });
      });
    }, `${SERVICE_PREFIX}ws`);
    expect(websocket).toMatchObject({
      pathname: `${SERVICE_PREFIX}ws`,
      message: 'pong',
    });
    expect(['ws:', 'wss:']).toContain(websocket.protocol);

    const sameOriginRequests = requests.filter((entry) => new URL(entry.url).origin === routerOrigin);
    const assets = sameOriginRequests.filter((entry) => (
      ['script', 'stylesheet', 'font', 'image'].includes(entry.resourceType)
    ));
    expect(assets.length, 'GPTResearcher must load real browser assets through Router').toBeGreaterThan(0);
    for (const entry of sameOriginRequests) {
      expect(
        new URL(entry.url).pathname.startsWith(SERVICE_PREFIX),
        `root-relative GPTResearcher request leaked: ${entry.url}`,
      ).toBe(true);
    }
    expect(requests.some((entry) => privateOrigin(entry.url, routerOrigin)), 'GPTResearcher must not expose a private browser origin').toBe(false);

    const domUrls = await page.locator('[src], [href], [action]').evaluateAll((elements) => (
      elements.flatMap((element) => ['src', 'href', 'action']
        .map((attribute) => element.getAttribute(attribute))
        .filter(Boolean)
        .map((value) => new URL(value, document.baseURI).href))
    ));
    expect(domUrls.some((url) => privateOrigin(url, routerOrigin)), 'GPTResearcher DOM must not expose a private origin').toBe(false);
    for (const url of domUrls.filter((value) => new URL(value).origin === routerOrigin)) {
      const parsed = new URL(url);
      if (parsed.pathname === SERVICE_PREFIX && parsed.hash) continue;
      expect(
        parsed.pathname.startsWith(SERVICE_PREFIX),
        `root-relative GPTResearcher DOM URL leaked: ${url}`,
      ).toBe(true);
    }

    expect(websocketEvents.some((event) => new URL(event.url).pathname === `${SERVICE_PREFIX}ws`)).toBe(true);
    expect(websocketEvents.some((event) => new URL(event.url).pathname === '/ws')).toBe(false);
    await attachEvidence(testInfo, 'gpt-researcher-browser-routing', {
      html: urlEvidence(htmlResponse.url()),
      api,
      redirect: {
        status: redirectResponse.status(),
        location: urlEvidence(resolvedLocation.href),
      },
      websocket,
      websocketEvents: websocketEvents.map((event) => ({ ...urlEvidence(event.url), sent: event.sent, received: event.received })),
      requests: requests.map((entry) => ({ ...urlEvidence(entry.url), method: entry.method, resourceType: entry.resourceType })),
    });
  });
});
