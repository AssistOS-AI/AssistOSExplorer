import { test, expect } from '../lib/fixtures.mjs';
import { openExplorer } from '../lib/explorer.mjs';

test.skip(!['true', 'false'].includes(process.env.SMOKE_EXPECT_PROD), 'Set SMOKE_EXPECT_PROD to select the separate production gates profile.');

test('captured production policy controls Git and Marketplace', async ({ page }, testInfo) => {
  const expected = process.env.SMOKE_EXPECT_PROD;
  expect(['true', 'false']).toContain(expected);
  const production = expected === 'true';
  await openExplorer(page);
  const marketplace = await page.request.get('/api/marketplace/agents');
  expect(marketplace.ok()).toBe(true);
  const permissions = (await marketplace.json()).marketplace.permissions;
  expect(permissions.production).toBe(production);
  if (production) expect(permissions.canRestart).toBe(false);

  const origin = new URL(page.url()).origin;
  const proofResponse = await page.request.get('/auth/token?agent=gitAgent');
  expect(proofResponse.ok()).toBe(true);
  const proof = (await proofResponse.json()).browserMutation;
  expect(proof?.routeKey).toBe('gitAgent');
  expect(proof?.origin).toBe(origin);
  expect(typeof proof?.csrfToken).toBe('string');
  expect(proof.csrfToken.length).toBeGreaterThan(0);
  const headers = {
    origin,
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'x-ploinky-browser-csrf-token': proof.csrfToken,
  };
  const send = (method, params, extra = {}) => page.request.post('/gitAgent/mcp', {
    headers: { ...headers, ...extra },
    data: { jsonrpc: '2.0', id: 1, method, params },
  });
  const init = await send('initialize', {
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'prod-gates-smoke', version: '1.0.0' },
  });
  expect(init.status()).toBe(200);
  const initBody = await init.json();
  expect(initBody.error).toBeUndefined();
  const sessionId = init.headers()['mcp-session-id'];
  expect(sessionId).toBeTruthy();
  const session = { 'mcp-session-id': sessionId, 'mcp-protocol-version': initBody.result.protocolVersion };
  const list = await send('tools/list', {}, session);
  expect(list.status()).toBe(200);
  const tools = (await list.json()).result.tools.map((tool) => tool.name);
  expect(tools.includes('git_pull')).toBe(!production);
  const repoPath = process.env.SMOKE_GIT_STATUS_PATH || '.';
  const status = await send('tools/call', { name: 'git_status', arguments: { path: repoPath } }, session);
  expect(status.status()).toBe(200);
  const statusBody = await status.json();
  expect(statusBody.error).toBeUndefined();
  expect(statusBody.result).toBeTruthy();
  expect([undefined, false]).toContain(statusBody.result.isError);
  const toolContent = statusBody.result.content;
  expect(Array.isArray(toolContent) && toolContent.length === 1 && toolContent[0].type === 'text').toBe(true);
  const gitStatus = JSON.parse(toolContent[0].text);
  expect(gitStatus.ok, 'git_status must succeed in the SMOKE_GIT_STATUS_PATH repository').toBe(true);
  expect(Array.isArray(gitStatus.status?.staged)).toBe(true);
  if (production) {
    // The invalid path cannot operate on a Git checkout if the policy is broken.
    const pull = await send('tools/call', { name: 'git_pull', arguments: { path: null } }, session);
    expect(pull.status()).toBe(403);
    expect((await pull.json())?.error?.data?.code).toBe('PROD_DISABLED');
  }

  const launcher = page.locator('#fileExpToolbarPluginsDropdown [data-app-plugin-key="gitAgent/git"] #gitButton[data-local-action="openGitPanel"]');
  await expect(launcher).toBeAttached({ timeout: 30000 });
  await page.locator('#pluginsMenuButton').click();
  await expect(launcher).toBeVisible();
  await launcher.click();
  const panel = page.locator('git-panel:visible');
  await expect(panel).toBeVisible();
  await expect.poll(() => panel.evaluate((element) => Boolean(element.webSkelPresenter?.initialLoad))).toBe(true);
  await panel.evaluate(async (element) => { await element.webSkelPresenter.initialLoad; });
  const content = panel.locator('.git-panel-content');
  const credentials = panel.locator('.git-panel.git-credentials-open git-credentials-prompt');
  if (await credentials.isVisible()) {
    const close = credentials.getByRole('button', { name: /^(Cancel|Close)$/ });
    await expect(close).toHaveCount(1);
    await close.click();
  }
  await expect(content).toBeVisible();
  await expect(panel.locator('[data-role="git-panel-loader"]')).toBeHidden();
  await expect(panel.locator('git-commit-actions #gitCommitMessage')).toBeVisible();
  const sync = panel.locator('button.git-sync-button');
  await expect(sync).toHaveCount(1);
  await expect(sync).toBeAttached();
  if (production) {
    await expect(sync).toHaveAttribute('hidden', '');
    await expect(sync).toBeHidden();
  } else {
    await expect(sync).toBeVisible();
  }
  await page.screenshot({ path: testInfo.outputPath('prod-gates.png') });
});
