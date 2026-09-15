import assert from 'node:assert/strict';
import test from 'node:test';

import { editorUrl as buildEditorUrl, probeUpgrade } from '../helpers/public-editor-probe.mjs';

const e2eEnabled = process.env.ONLYOFFICE_E2E === '1';
const skipMessage = 'Requires ONLYOFFICE_E2E=1 with a live Ploinky runtime profile (router + explorer + onlyOffice + dpuAgent + OnlyOffice Document Server).';

function runtimeTest(name, fn) {
  if (!e2eEnabled) {
    test.skip(name, skipMessage);
    return;
  }
  test(name, fn);
}

function requiredEnv(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) {
    throw new Error(`${name} is required when ONLYOFFICE_E2E=1.`);
  }
  return value;
}

function editorUrl(path) {
  return buildEditorUrl(requiredEnv('ONLYOFFICE_E2E_EDITOR_BASE_URL'), path);
}

function routerServiceUrl(path) {
  const routerBaseUrl = requiredEnv('ONLYOFFICE_E2E_ROUTER_BASE_URL');
  const servicePrefix = String(process.env.ONLYOFFICE_E2E_SERVICE_PREFIX || '/base-agent-additional-server/onlyOffice/7000/control').replace(/\/+$/, '');
  return new URL(`${servicePrefix}${path}`, routerBaseUrl).toString();
}

async function fetchText(url, options = {}) {
  const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10000), ...options });
  const text = await response.text();
  return { response, text };
}

function authHeaders() {
  const cookie = String(process.env.ONLYOFFICE_E2E_AUTH_COOKIE || '').trim();
  const bearer = String(process.env.ONLYOFFICE_E2E_AUTH_BEARER || '').trim();
  if (!cookie && !bearer) throw new Error('Authenticated control-route probe requires a cookie or bearer.');
  return {
    ...(cookie ? { cookie } : {}),
    ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
  };
}

runtimeTest('internet cannot reach internal document route through office host', async () => {
  const { response, text } = await fetchText(editorUrl('/internal/document/not-a-real-token'));

  assert.ok([403, 404].includes(response.status), `expected internal route to be blocked, got ${response.status}: ${text}`);
});

runtimeTest('router service prefix does not re-expose internal document route', async () => {
  const { response, text } = await fetchText(routerServiceUrl('/internal/document/not-a-real-token'), { headers: authHeaders() });

  assert.ok([401, 403, 404].includes(response.status), `expected internal route to be blocked, got ${response.status}: ${text}`);
});

runtimeTest('public editor host serves api js and websocket path while blocking admin endpoints', async () => {
  const api = await fetchText(editorUrl('/web-apps/apps/api/documents/api.js'));
  assert.equal(api.response.status, 200, api.text);
  assert.match(api.text, /DocsAPI|Asc/i);

  for (const path of ['/coauthoring/CommandService.ashx', '/ConvertService.ashx', '/converter', '/internal/document/not-a-real-token']) {
    const blocked = await fetchText(editorUrl(path));
    assert.ok([403, 404].includes(blocked.response.status), `${path} returned ${blocked.response.status}: ${blocked.text}`);
  }

  const websocketPath = String(process.env.ONLYOFFICE_E2E_WEBSOCKET_PATH || '/doc/e2e/c/?shardkey=e2e&EIO=4&transport=websocket');
  const upgradeStatus = await probeUpgrade(requiredEnv('ONLYOFFICE_E2E_EDITOR_BASE_URL'), websocketPath);
  assert.equal(upgradeStatus, 101, `websocket path did not complete a real upgrade: ${upgradeStatus}`);
});

runtimeTest('localhost Router authority serves the OnlyOffice API asset', async () => {
  const editorBaseUrl = new URL(requiredEnv('ONLYOFFICE_E2E_EDITOR_BASE_URL'));
  assert.equal(
    editorBaseUrl.hostname,
    'localhost',
    `localhost regression gate requires a localhost editor URL, got ${editorBaseUrl.origin}`,
  );

  const api = await fetchText(editorUrl('/web-apps/apps/api/documents/api.js'), {
    headers: { origin: editorBaseUrl.origin },
  });
  assert.equal(api.response.status, 200, api.text);
  assert.match(api.text, /DocsAPI|Asc/i);
});
