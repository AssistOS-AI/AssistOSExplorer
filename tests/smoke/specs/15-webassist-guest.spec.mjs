import { test, expect } from '../lib/fixtures.mjs';
import { smokeConfig } from '../lib/config.mjs';

test.describe('webAssist guest access', () => {
  test('embedded chat and MCP initialize without prior authentication', async ({ page, context }) => {
    await context.clearCookies();
    const visitorStorageKey = `webassist-chat:visitorId:${smokeConfig.webAssistSiteId}`;
    await page.addInitScript(({ key, runId }) => {
      window.localStorage.setItem(key, `visitor-smoke-${runId}`);
    }, { key: visitorStorageKey, runId: smokeConfig.runId });

    const pendingMcpRequests = new Set();
    const isWebAssistMcpPost = (request) => {
      try {
        return request.method() === 'POST' && new URL(request.url()).pathname === '/webAssist/mcp';
      } catch {
        return false;
      }
    };
    page.on('request', (request) => {
      if (isWebAssistMcpPost(request)) pendingMcpRequests.add(request);
    });
    page.on('requestfinished', (request) => {
      if (isWebAssistMcpPost(request)) pendingMcpRequests.delete(request);
    });
    page.on('requestfailed', (request) => {
      if (isWebAssistMcpPost(request)) pendingMcpRequests.delete(request);
    });
    const waitForMcpIdle = async () => {
      await expect.poll(() => pendingMcpRequests.size, { timeout: 15_000 }).toBe(0);
    };

    const response = await page.goto(
      `/webAssist/IDE-plugins/web-assist-chat/web-assist-chat.html?siteId=${encodeURIComponent(smokeConfig.webAssistSiteId)}`,
      { waitUntil: 'domcontentloaded' }
    );
    expect(response?.status()).toBeLessThan(400);

    await expect(page.locator('form[action="/auth/login"], input[name="username"]')).toHaveCount(0);
    await expect(page.locator('#chatLauncher')).toBeVisible();
    await page.locator('#chatLauncher').click();
    await expect(page.locator('#chatInput')).toBeEditable();
    await waitForMcpIdle();

    const initResult = await page.evaluate(async () => {
      const mcpResponse = await fetch('/webAssist/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'webassist-guest-init',
          method: 'initialize',
          params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'webassist-smoke', version: '1.0.0' },
          },
        }),
      });
      return {
        status: mcpResponse.status,
        sessionId: mcpResponse.headers.get('mcp-session-id') || '',
        body: await mcpResponse.json(),
      };
    });

    expect(initResult.status).toBe(200);
    expect(initResult.sessionId).toMatch(/\S/);
    expect(initResult.body.error).toBeUndefined();
    expect(initResult.body.result?.serverInfo?.name || '').toContain('webAssist');

    const cookies = await context.cookies();
    // Guest cookies are per guest route; this is the webAssist route's cookie.
    expect(cookies.some((cookie) => cookie.name === 'ploinky_guest_ncGyyzpdIxmPjORN_wQfqv' && cookie.value)).toBe(true);
    await waitForMcpIdle();
  });
});
