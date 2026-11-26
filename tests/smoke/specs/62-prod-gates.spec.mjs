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

  const result = await page.evaluate(async (production) => {
    const agent = 'gitAgent';
    const proof = (await (await fetch(`/auth/token?agent=${agent}`, { credentials: 'include', cache: 'no-store' })).json()).browserMutation;
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-ploinky-browser-csrf-token': proof.csrfToken };
    const send = (method, params, extra = {}) => fetch('/gitAgent/mcp', { method: 'POST', credentials: 'include', headers: { ...headers, ...extra }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    const init = await send('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'prod-gates-smoke', version: '1.0.0' } });
    const initBody = await init.json();
    const session = { 'mcp-session-id': init.headers.get('mcp-session-id'), 'mcp-protocol-version': initBody.result.protocolVersion };
    const list = await send('tools/list', {}, session);
    const tools = (await list.json()).result.tools.map((tool) => tool.name);
    const status = await send('tools/call', { name: 'git_status', arguments: { path: '.' } }, session);
    const pull = production ? await send('tools/call', { name: 'git_pull', arguments: { path: '.' } }, session) : null;
    return { tools, status: status.status, pull: pull?.status };
  }, production);
  expect(result.status).toBe(200);
  expect(result.tools.includes('git_pull')).toBe(!production);
  if (production) expect(result.pull).toBe(403);
  await page.getByRole('button', { name: 'Git', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Git', exact: true });
  await expect(dialog).toBeVisible();
  if (production) await expect(dialog.getByRole('button', { name: 'Sync', exact: true })).toBeHidden();
  else await expect(dialog.getByRole('button', { name: 'Sync', exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('prod-gates.png') });
});
