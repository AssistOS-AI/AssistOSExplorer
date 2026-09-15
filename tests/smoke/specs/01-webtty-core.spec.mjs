import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  acknowledgeExactPageDiagnostics,
  assertPageDiagnosticsClean,
  attachPageDiagnostics,
  checkpointPageDiagnostics,
  expect,
  test,
} from '../lib/fixtures.mjs';
import { assertDistinctAuthenticatedPrincipals, readAuthenticatedPrincipal } from '../lib/auth.mjs';
import { smokeConfig } from '../lib/config.mjs';
import { diagnosticEventSignature } from '../lib/diagnostic-ledger.mjs';
import { assertExplorerDirectory, openExplorer } from '../lib/explorer.mjs';
import { resolvePloinkyExecutable } from '../lib/ploinky-executable.mjs';
import {
  captureNestedPodmanEventCursor,
  collectAgentProcessRows,
  collectExactAgentState,
  collectExactRoutingServerIdentity,
  collectNestedContainerEvents,
  collectWebttyRuntimeEvidence,
  collectWebttyRecoveryDirectoryState,
  crashExactRoutingServer,
  requireAgentEvidence,
  resolveWebttyBoxEndpoint,
} from '../lib/webtty-runtime-evidence.mjs';

const execFileAsync = promisify(execFile);

const explorerFiniteRequests = new WeakMap();

async function observeExplorerPluginReadiness(page) {
  const pending = new Set();
  const observation = { pending, started: 0 };
  explorerFiniteRequests.set(page, observation);
  page.on('request', (request) => {
    observation.started += 1;
    pending.add(request);
  });
  page.on('requestfinished', (request) => pending.delete(request));
  page.on('requestfailed', (request) => pending.delete(request));
  page.on('response', (response) => {
    // A confirmed SSE response intentionally has no finite body. Every other
    // request stays pending through its body, including auth and image loads
    // started by plugins outside the presenter's render promise.
    const contentType = response.headers()['content-type']?.split(';')[0].trim().toLowerCase();
    if (response.ok() && contentType === 'text/event-stream') pending.delete(response.request());
  });
  await page.addInitScript(() => {
    window.__e2eWebttyExplorerPluginsReady = false;
    window.addEventListener('assistos:runtime-plugins-updated', (event) => {
      if (event.detail?.phase === 'ready') window.__e2eWebttyExplorerPluginsReady = true;
    });
  });
}

async function waitForExplorerPluginRender(page, timeout = smokeConfig.timeouts.navigation) {
  // Shell readiness intentionally precedes plugin discovery. The ready event
  // starts mounting; its presenter promise covers component HTML/CSS/modules
  // and stays non-null until the current (possibly queued) render settles.
  const observation = explorerFiniteRequests.get(page);
  if (!observation) throw new Error('Explorer request observation must start before navigation.');
  await expect.poll(async () => {
    if (observation.pending.size) return false;
    const started = observation.started;
    const rendered = await page.evaluate(async () => {
      // Body completion may queue a follow-up fetch or an image render. Cross
      // the next render turn before sampling readiness, then reject this sample
      // if any request started in that interval. No fixed quiet sleep is used.
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      if (!window.__e2eWebttyExplorerPluginsReady) return false;
      const presenter = document.querySelector('file-exp')?.webSkelPresenter;
      return Boolean(presenter) && !presenter.__appPluginRenderPromise;
    });
    return rendered && observation.pending.size === 0 && observation.started === started;
  }, {
    timeout,
    message: 'Explorer plugin rendering and finite response bodies must settle before navigation',
  }).toBe(true);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function requireLocalWorkspaceFixture() {
  if (!smokeConfig.workspaceRoot) {
    throw new Error('SMOKE_WORKSPACE_ROOT is required for the WebTTY core release gate.');
  }
  const baseURL = new URL(smokeConfig.baseURL);
  if (baseURL.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(baseURL.hostname)) {
    throw new Error('The WebTTY core release gate requires a loopback HTTP SMOKE_BASE_URL.');
  }

  const workspaceRoot = fs.realpathSync(smokeConfig.workspaceRoot);
  const fixtureRunId = crypto.createHash('sha256')
    .update(smokeConfig.runId)
    .digest('hex')
    .slice(0, 16);
  const fixtureName = `webtty-smoke-${fixtureRunId}`;
  const fixtureRoot = path.resolve(workspaceRoot, fixtureName);
  const relativeFixture = path.relative(workspaceRoot, fixtureRoot);
  if (!relativeFixture || relativeFixture.startsWith(`..${path.sep}`) || path.isAbsolute(relativeFixture)) {
    throw new Error('The WebTTY smoke fixture did not resolve beneath SMOKE_WORKSPACE_ROOT.');
  }
  if (fs.existsSync(fixtureRoot)) {
    throw new Error(`The run-scoped WebTTY smoke fixture already exists: ${fixtureName}`);
  }

  const nestedRoot = path.join(fixtureRoot, 'nested-folder');
  fs.mkdirSync(nestedRoot, { recursive: true });
  const hostMarker = `host-${crypto.randomUUID()}`;
  const browserMarker = `browser-${crypto.randomUUID()}`;
  const agentBrowserMarker = `agent-${crypto.randomUUID()}`;
  const readOnlyRefusedMarker = `read-only-refused-${crypto.randomUUID()}`;
  const readOnlySucceededMarker = `read-only-succeeded-${crypto.randomUUID()}`;
  const readOnlyProbeName = `.webtty-read-only-probe-${crypto.randomUUID()}`;
  fs.writeFileSync(path.join(nestedRoot, 'host-marker.txt'), `${hostMarker}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(nestedRoot, 'read-only-refused-marker.txt'), `${readOnlyRefusedMarker}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(nestedRoot, 'read-only-succeeded-marker.txt'), `${readOnlySucceededMarker}\n`, { mode: 0o600 });
  return Object.freeze({
    workspaceRoot,
    fixtureRoot,
    parentDirectoryPath: `/${fixtureName}`,
    nestedDirectoryPath: `/${fixtureName}/nested-folder`,
    explorerHash: `file-exp/${encodeURIComponent(fixtureName)}`,
    relativeDirectory: `${fixtureName}/nested-folder`,
    nestedRoot,
    hostMarker,
    browserMarker,
    agentBrowserMarker,
    readOnlyRefusedMarker,
    readOnlySucceededMarker,
    readOnlyProbeName,
  });
}

function requirePinnedRuntimeBinding() {
  const boxEndpoint = resolveWebttyBoxEndpoint({
    baseURL: smokeConfig.baseURL,
    boxBaseURL: process.env.SMOKE_BOX_BASE_URL || smokeConfig.baseURL,
  });
  const expectedContainerName = String(process.env.SMOKE_PLOINKY_BOX_CONTAINER || '').trim();
  const expectedImageId = String(process.env.SMOKE_EXPECT_BOX_IMAGE_ID || '').trim();
  const expectedImageRef = String(process.env.SMOKE_EXPECT_BOX_IMAGE_REF || '').trim();
  if (!expectedContainerName || !expectedImageId || !expectedImageRef) {
    throw new Error(
      'The WebTTY core release gate requires SMOKE_PLOINKY_BOX_CONTAINER, '
      + 'SMOKE_EXPECT_BOX_IMAGE_ID, and SMOKE_EXPECT_BOX_IMAGE_REF.',
    );
  }
  const ploinkyExecutable = fs.realpathSync(resolvePloinkyExecutable());
  const expectedPloinkySource = fs.realpathSync(path.resolve(path.dirname(ploinkyExecutable), '..'));
  return Object.freeze({
    boxBaseURL: boxEndpoint.baseURL,
    expectedContainerName,
    expectedImageId,
    expectedImageRef,
    expectedPloinkySource,
    requireFreshImage: false,
  });
}

async function browserMutation(page, pathname, { method = 'POST', body } = {}) {
  return page.evaluate(async ({ requestPath, requestMethod, requestBody }) => {
    const csrf = document.cookie
      .split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith('ploinky_browser_csrf='))
      ?.slice('ploinky_browser_csrf='.length) || '';
    const response = await fetch(requestPath, {
      method: requestMethod,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: {
        'Content-Type': 'application/json',
        'X-Ploinky-Browser-CSRF-Token': csrf,
      },
      body: requestBody === undefined ? undefined : JSON.stringify(requestBody),
    });
    const text = await response.text();
    let payload = null;
    try { payload = JSON.parse(text); } catch {}
    return { status: response.status, payload, text };
  }, { requestPath: pathname, requestMethod: method, requestBody: body });
}

function expectedHttpFailureDiagnostics(pathname, { method = 'POST', status } = {}) {
  if (status !== 404) throw new Error('the WebTTY negative diagnostic proof only permits exact 404 responses');
  const url = new URL(pathname, smokeConfig.baseURL).toString();
  return [
    diagnosticEventSignature({ kind: 'response', type: 'error', status, url, method }),
    diagnosticEventSignature({
      kind: 'console',
      type: 'error',
      text: 'Failed to load resource: the server responded with a status of 404 (Not Found)',
      location: { url },
    }),
  ];
}

function expectedDiscoveryCancellationDiagnostics(discoveryId) {
  const pathname = `/webtty/target-discoveries/${encodeURIComponent(discoveryId)}`;
  return expectedHttpFailureDiagnostics(pathname, { method: 'DELETE', status: 404 });
}

function expectedRouterRecoveryDiagnostics(sessionId) {
  const pathname = `/webtty/sessions/${encodeURIComponent(sessionId)}/stream`;
  const url = new URL(pathname, smokeConfig.baseURL).toString();
  return [
    diagnosticEventSignature({
      kind: 'requestfailed',
      type: 'error',
      url,
      method: 'GET',
      failure: 'net::ERR_INCOMPLETE_CHUNKED_ENCODING',
    }),
    diagnosticEventSignature({
      kind: 'console',
      type: 'error',
      text: 'Failed to load resource: net::ERR_INCOMPLETE_CHUNKED_ENCODING',
      location: { url },
    }),
    diagnosticEventSignature({ kind: 'response', type: 'error', status: 404, url, method: 'GET' }),
    diagnosticEventSignature({
      kind: 'console',
      type: 'error',
      text: 'Failed to load resource: the server responded with a status of 404 (Not Found)',
      location: { url },
    }),
  ];
}

function waitForExact404Console(page, pathname) {
  const url = new URL(pathname, smokeConfig.baseURL).toString();
  return page.waitForEvent('console', {
    predicate: (message) => message.type() === 'error'
      && message.text() === 'Failed to load resource: the server responded with a status of 404 (Not Found)'
      && message.location().url === url,
    timeout: smokeConfig.timeouts.action,
  });
}

async function directAuthenticatedMutation(page, pathname, {
  origin,
  includeCsrfCookie = true,
  includeCsrfHeader = true,
  body,
} = {}) {
  const cookies = await page.context().cookies(smokeConfig.baseURL);
  const selectedCookies = cookies.filter((cookie) => (
    includeCsrfCookie || cookie.name !== 'ploinky_browser_csrf'
  ));
  const csrf = cookies.find((cookie) => cookie.name === 'ploinky_browser_csrf')?.value || '';
  const headers = {
    'Content-Type': 'application/json',
    Cookie: selectedCookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; '),
    Origin: origin,
  };
  if (includeCsrfHeader) headers['X-Ploinky-Browser-CSRF-Token'] = csrf;
  const response = await fetch(new URL(pathname, smokeConfig.baseURL), {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    redirect: 'manual',
  });
  return { status: response.status, payload: await response.json().catch(() => null) };
}

function isSessionCreation(response) {
  const target = new URL(response.url());
  return response.request().method() === 'POST' && target.pathname === '/webtty/sessions';
}

function isTargetDiscovery(response) {
  const target = new URL(response.url());
  return response.request().method() === 'POST' && target.pathname === '/webtty/target-discoveries';
}

function isWebttyNavigation(request) {
  const target = new URL(request.url());
  return request.isNavigationRequest()
    && request.method() === 'GET'
    && target.pathname === '/webtty/';
}

async function readTargetDiscovery(response, expectedDirectory) {
  expect(response.status()).toBe(201);
  const payload = await response.json();
  expect(Object.keys(payload).sort()).toEqual(['discovery', 'ok']);
  expect(payload.ok).toBe(true);
  expect(Object.keys(payload.discovery).sort()).toEqual([
    'agentTargetsAvailable',
    'directory',
    'expiresAt',
    'id',
    'targets',
  ]);
  expect(payload.discovery).toMatchObject({
    id: expect.stringMatching(/^[A-Za-z0-9_-]{32,128}$/),
    directory: expectedDirectory,
    expiresAt: expect.any(Number),
    agentTargetsAvailable: expect.any(Boolean),
  });
  expect(Number.isSafeInteger(payload.discovery.expiresAt)).toBe(true);
  expect(payload.discovery.targets.length).toBeGreaterThan(0);
  expect(payload.discovery.targets[0].kind).toBe('box');
  expect(payload.discovery.targets.filter((target) => target.kind === 'box')).toHaveLength(1);
  for (const target of payload.discovery.targets) {
    expect(Object.keys(target).sort()).toEqual([
      'access',
      'cwdDisplay',
      'detail',
      'kind',
      'label',
      'launch',
    ]);
    expect(target).toMatchObject({
      launch: expect.stringMatching(/^[A-Za-z0-9_-]{32,128}$/),
      kind: expect.stringMatching(/^(?:box|agent)$/),
      label: expect.any(String),
      detail: expect.any(String),
      access: expect.stringMatching(/^(?:rw|ro)$/),
      cwdDisplay: expect.any(String),
    });
  }
  return payload.discovery;
}

async function readSessionCreation(response) {
  expect(response.status()).toBe(201);
  const payload = await response.json();
  expect(Object.keys(payload).sort()).toEqual(['ok', 'session']);
  expect(Object.keys(payload.session).sort()).toEqual(['cols', 'cwd', 'id', 'rows', 'target']);
  expect(Object.keys(payload.session.target).sort()).toEqual([
    'access',
    'cwdDisplay',
    'detail',
    'kind',
    'label',
  ]);
  expect(payload).toMatchObject({
    ok: true,
    session: {
      id: expect.stringMatching(/^[A-Za-z0-9_-]{16,128}$/),
      target: {
        kind: expect.stringMatching(/^(?:box|agent)$/),
        label: expect.any(String),
        access: expect.stringMatching(/^(?:rw|ro)$/),
        cwdDisplay: expect.any(String),
      },
    },
  });
  return payload.session;
}

async function waitForConnectedTerminal(page) {
  await expect(page.locator('#status')).toHaveText('Connected', {
    timeout: smokeConfig.timeouts.navigation,
  });
  await expect(page.locator('#terminal .xterm-helper-textarea')).toBeAttached();
}

async function openTerminalChooser(page, directoryPath) {
  const row = page.locator(`tr[data-entry-path="${directoryPath}"]`);
  await expect(row).toHaveCount(1, { timeout: smokeConfig.timeouts.navigation });
  await row.locator('.action-menu-trigger').click();
  const launcher = row.getByRole('menuitem', { name: 'Open Terminal Here' });
  await expect(launcher).toBeVisible({ timeout: smokeConfig.timeouts.action });

  const context = page.context();
  const initialPageCount = context.pages().length;
  const discoveryPromise = page.waitForResponse(isTargetDiscovery, {
    timeout: smokeConfig.timeouts.navigation,
  });
  await launcher.click();
  const discovery = await readTargetDiscovery(
    await discoveryPromise,
    directoryPath.replace(/^\/+/, ''),
  );
  const chooser = page.getByRole('dialog', { name: 'Open terminal in' });
  await expect(chooser).toBeVisible({ timeout: smokeConfig.timeouts.navigation });
  await expect(chooser.locator('#terminalTargetDirectory')).toHaveText(directoryPath);
  await expect(chooser.locator('.terminal-target-button')).toHaveCount(discovery.targets.length);
  expect(context.pages().length, 'opening the chooser must not open or navigate a terminal tab').toBe(initialPageCount);

  for (const target of discovery.targets) {
    const targetButton = chooser.locator(`.terminal-target-button[data-launch="${target.launch}"]`);
    await expect(targetButton).toHaveCount(1);
    await expect(targetButton).toHaveAttribute('data-launch', target.launch);
    await expect(targetButton.locator('.terminal-target-label')).toHaveText(target.label);
    await expect(targetButton.locator('.terminal-target-detail')).toHaveText(target.detail);
    await expect(targetButton.locator('.terminal-target-cwd')).toHaveText(target.cwdDisplay);
    await expect(targetButton.locator('.terminal-target-access')).toHaveText(
      target.access === 'ro' ? 'Read only' : 'Read and write',
    );
  }

  return { page, chooser, discovery, context };
}

async function selectTerminalTarget(chooserState, predicate) {
  const selectedTarget = chooserState.discovery.targets.find(predicate);
  expect(selectedTarget, 'the requested terminal target must be present in the current discovery').toBeTruthy();
  const selectedButton = chooserState.chooser.locator(
    `.terminal-target-button[data-launch="${selectedTarget.launch}"]`,
  );
  await expect(selectedButton).toHaveCount(1);
  const { context } = chooserState;
  const popupPromise = context.waitForEvent('page', { timeout: smokeConfig.timeouts.navigation });
  const navigationPromise = context.waitForEvent('request', {
    predicate: isWebttyNavigation,
    timeout: smokeConfig.timeouts.navigation,
  });
  const createPromise = context.waitForEvent('response', {
    predicate: isSessionCreation,
    timeout: smokeConfig.timeouts.navigation,
  });
  await selectedButton.click();
  const terminalPage = await popupPromise;
  const navigationRequest = await navigationPromise;
  const createResponse = await createPromise;
  await terminalPage.waitForURL((url) => url.pathname === '/webtty/' && !url.hash, {
    timeout: smokeConfig.timeouts.navigation,
  });
  await terminalPage.waitForLoadState('load');
  await expect(chooserState.chooser).toBeHidden();
  return {
    terminalPage,
    session: await readSessionCreation(createResponse),
    discovery: chooserState.discovery,
    launch: selectedTarget.launch,
    selectedTarget,
    navigationRequest,
  };
}

async function openTerminalFromExplorer(page, directoryPath, predicate = (target) => target.kind === 'box') {
  return selectTerminalTarget(await openTerminalChooser(page, directoryPath), predicate);
}

async function refreshTerminalChooser(chooserState, expectedDirectory) {
  const responsePromise = chooserState.page.waitForResponse(isTargetDiscovery, {
    timeout: smokeConfig.timeouts.navigation,
  });
  await chooserState.chooser.getByRole('button', { name: 'Refresh' }).click();
  chooserState.discovery = await readTargetDiscovery(await responsePromise, expectedDirectory.replace(/^\/+/, ''));
  await expect(chooserState.chooser.locator('.terminal-target-button')).toHaveCount(
    chooserState.discovery.targets.length,
  );
  return chooserState.discovery;
}

function publicTarget(target) {
  return {
    kind: target.kind,
    label: target.label,
    detail: target.detail,
    access: target.access,
    cwdDisplay: target.cwdDisplay,
  };
}

function sortedTargets(targets) {
  return targets.map(publicTarget).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

async function closeTerminal(terminal, { closePage = true } = {}) {
  const result = await browserMutation(
    terminal.terminalPage,
    `/webtty/sessions/${encodeURIComponent(terminal.session.id)}`,
    { method: 'DELETE' },
  );
  expect(result).toMatchObject({ status: 200, payload: { ok: true } });
  if (closePage) await terminal.terminalPage.close();
}

async function restartPloinkyTarget(target, fixture) {
  const executable = resolvePloinkyExecutable();
  const result = await execFileAsync(executable, ['restart', target], {
    cwd: fixture.workspaceRoot,
    env: { ...process.env, PLOINKY_CWD: fixture.workspaceRoot },
    encoding: 'utf8',
    timeout: Math.max(smokeConfig.timeouts.relay, 420_000),
    maxBuffer: 16 * 1024 * 1024,
    killSignal: 'SIGKILL',
  });
  return { stdout: String(result.stdout || ''), stderr: String(result.stderr || '') };
}

async function waitForAgentExecDelta(evidence, agent, baseline, expectedDelta) {
  await expect.poll(() => {
    const state = collectExactAgentState(evidence, agent);
    if (!state.present) return -1;
    return state.execIds.filter((id) => !baseline.includes(id)).length;
  }, {
    message: `the exact ${agent.agentName} container must have ${expectedDelta} WebTTY exec delta`,
    timeout: smokeConfig.timeouts.navigation,
  }).toBe(expectedDelta);
}

async function waitForAgentProcess(evidence, agent, pattern, present) {
  await expect.poll(() => {
    const rows = collectAgentProcessRows(evidence, agent);
    return {
      querySucceeded: true,
      present: rows.some((row) => pattern.test(row)),
    };
  }, {
    message: `the exact ${agent.agentName} container process must ${present ? 'appear' : 'disappear'}`,
    timeout: smokeConfig.timeouts.navigation,
  }).toEqual({ querySucceeded: true, present });
}

function collectAgentMarkerTokens(evidence, agent) {
  const tokens = new Set();
  for (const row of collectAgentProcessRows(evidence, agent)) {
    for (const match of row.matchAll(/ploinky-webtty-marker:[A-Za-z0-9_-]{24,128}/g)) {
      tokens.add(match[0]);
    }
  }
  return [...tokens].sort();
}

async function waitForSingleNewAgentMarker(evidence, agent, baseline) {
  let selected = '';
  await expect.poll(() => {
    const added = collectAgentMarkerTokens(evidence, agent).filter((token) => !baseline.includes(token));
    selected = added.length === 1 ? added[0] : '';
    return added.length;
  }, {
    message: `the exact ${agent.agentName} container must expose one new marker-bearing terminal wrapper`,
    timeout: smokeConfig.timeouts.navigation,
  }).toBe(1);
  return selected;
}

async function waitForAgentMarker(evidence, agent, marker, present) {
  await expect.poll(() => ({
    querySucceeded: true,
    present: collectAgentMarkerTokens(evidence, agent).includes(marker),
  }), {
    message: `the exact ${agent.agentName} marker-bearing terminal wrapper must ${present ? 'appear' : 'disappear'}`,
    timeout: smokeConfig.timeouts.navigation,
  }).toEqual({ querySucceeded: true, present });
}

async function runWhileObservingNoAgentShell(evidence, agent, baselineExecIds, baselineMarkers, action) {
  const eventSince = captureNestedPodmanEventCursor(evidence);
  let actionSettled = false;
  let postActionSamples = 0;
  let samples = 0;
  let violation = '';
  let startObserver;
  const observerStarted = new Promise((resolve) => { startObserver = resolve; });
  const observer = (async () => {
    while (!actionSettled || postActionSamples < 2) {
      try {
        const state = collectExactAgentState(evidence, agent);
        const markers = collectAgentMarkerTokens(evidence, agent);
        if (!state.present || state.running !== true) {
          violation ||= 'the exact replacement target disappeared during stale launch rejection';
        } else if (JSON.stringify(state.execIds) !== JSON.stringify(baselineExecIds)) {
          violation ||= 'a transient exec appeared in the exact replacement target during stale launch rejection';
        } else if (JSON.stringify(markers) !== JSON.stringify(baselineMarkers)) {
          violation ||= 'a transient marker-bearing wrapper appeared during stale launch rejection';
        }
      } catch (error) {
        violation ||= `exact stale-launch observation failed closed: ${error?.message || String(error)}`;
      }
      samples += 1;
      if (samples === 1) startObserver();
      if (actionSettled) postActionSamples += 1;
      if (!actionSettled || postActionSamples < 2) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
  })();

  await observerStarted;
  let value;
  let actionError = null;
  try {
    value = await action();
  } catch (error) {
    actionError = error;
  } finally {
    actionSettled = true;
  }
  await observer;
  if (actionError) throw actionError;
  const eventUntil = captureNestedPodmanEventCursor(evidence);
  const exactEvents = collectNestedContainerEvents(evidence, agent, {
    since: eventSince,
    until: eventUntil,
  });
  const execEvents = exactEvents.filter((event) => event.status === 'exec' || event.status === 'exec_died');
  expect(execEvents, 'the exact nested engine event audit must contain no target exec lifecycle').toEqual([]);
  expect(violation, 'stale launch observation must see no transient shell lifecycle').toBe('');
  expect(samples, 'stale launch observation must span before, during, and after the request').toBeGreaterThanOrEqual(3);
  return { value, samples, exactEventCount: exactEvents.length };
}

test.describe('Ploinky core WebTTY release gate', () => {
  test.skip(!smokeConfig.flags.webttyCore, 'Run with npm run test:webtty.');

  test('local administrator controls the mounted workspace while an ordinary user is denied', async ({ page, browser }, testInfo) => {
    test.setTimeout(Math.max(smokeConfig.timeouts.test, 900_000));
    const runtimeBinding = requirePinnedRuntimeBinding();
    const fixture = requireLocalWorkspaceFixture();
    const terminals = [];
    let userContext = null;
    let foreignAdminContext = null;
    try {
      await observeExplorerPluginReadiness(page);
      await openExplorer(page, { hash: fixture.explorerHash });
      await assertExplorerDirectory(page, fixture.parentDirectoryPath);
      const admin = await readAuthenticatedPrincipal(page, smokeConfig.primaryUser);
      // The Router session is checked against the configured account independently
      // of the WebTTY responses; UserPersisto assigns opaque account IDs.
      expect(admin.roles).toContain('admin');

      let initialRuntime = null;
      let runtimeReadinessFailure = '';
      let priorRuntimeSignature = '';
      let stableRuntimeSamples = 0;
      await expect.poll(() => {
        try {
          const candidate = collectWebttyRuntimeEvidence({
            baseURL: smokeConfig.baseURL,
            workspaceRoot: fixture.workspaceRoot,
            selectedDirectory: fixture.nestedRoot,
            ...runtimeBinding,
          });
          requireAgentEvidence(candidate, 'gitAgent', { eligible: true });
          requireAgentEvidence(candidate, 'liveKitServerAgent', { eligible: false });
          const signature = JSON.stringify(candidate.agents.map((agent) => ({
            agentName: agent.agentName,
            containerId: agent.containerId,
            instanceId: agent.instanceId,
            enableGeneration: agent.enableGeneration,
            projectedTarget: agent.projectedTarget,
          })));
          stableRuntimeSamples = signature === priorRuntimeSignature ? stableRuntimeSamples + 1 : 1;
          priorRuntimeSignature = signature;
          initialRuntime = candidate;
          runtimeReadinessFailure = '';
          return stableRuntimeSamples >= 3;
        } catch (error) {
          runtimeReadinessFailure = error?.message || String(error);
          return false;
        }
      }, {
        message: 'the exact fresh gitAgent and isolated liveKitServerAgent runtimes must become ready',
        timeout: smokeConfig.timeouts.relay,
        intervals: [1_000, 2_000, 5_000],
      }).toBe(true);
      expect(runtimeReadinessFailure).toBe('');
      const initialGitAgent = requireAgentEvidence(initialRuntime, 'gitAgent', { eligible: true });
      const isolatedLiveKit = requireAgentEvidence(initialRuntime, 'liveKitServerAgent', { eligible: false });
      const readOnlyAgent = initialRuntime.agents.find((agent) => agent.projectedTarget?.access === 'ro') || null;
      let readOnlyTargetExercised = false;
      expect(initialRuntime.eligibleTargets.length, 'the fresh graph must expose at least one proven agent target').toBeGreaterThan(0);
      expect(isolatedLiveKit.runMode).toBe('isolated');

      const canonicalOrigin = new URL(smokeConfig.baseURL).origin;
      const missingCsrf = await directAuthenticatedMutation(page, '/webtty/sessions', {
        origin: canonicalOrigin,
        includeCsrfCookie: false,
        includeCsrfHeader: false,
        body: { launch: 'A'.repeat(32), cols: 80, rows: 24 },
      });
      expect(missingCsrf).toMatchObject({
        status: 403,
        payload: { ok: false, error: 'browser_csrf_invalid' },
      });
      const forgedOrigin = await directAuthenticatedMutation(page, '/webtty/sessions', {
        origin: 'http://webtty-cross-origin.invalid',
        body: { launch: 'A'.repeat(32), cols: 80, rows: 24 },
      });
      expect(forgedOrigin).toMatchObject({
        status: 403,
        payload: { ok: false, error: 'browser_origin_required' },
      });

      const firstChooser = await openTerminalChooser(page, fixture.nestedDirectoryPath);
      const expectedBoxTarget = {
        kind: 'box',
        label: 'Ploinky Box',
        detail: 'Workspace runtime',
        access: 'rw',
        cwdDisplay: `/workspace/${fixture.relativeDirectory}`,
      };
      expect(firstChooser.discovery.agentTargetsAvailable).toBe(true);
      expect(sortedTargets(firstChooser.discovery.targets.filter((target) => target.kind === 'agent')))
        .toEqual(sortedTargets(initialRuntime.eligibleTargets));
      expect(publicTarget(firstChooser.discovery.targets[0])).toEqual(expectedBoxTarget);
      expect(firstChooser.discovery.targets.some((target) => (
        target.label === isolatedLiveKit.agentName
        && target.detail === `${isolatedLiveKit.repoName}/${isolatedLiveKit.agentName}`
      ))).toBe(false);
      await expect(firstChooser.chooser).toHaveAttribute('aria-labelledby', 'terminalTargetTitle');
      await expect(firstChooser.chooser.getByRole('button', { name: 'Refresh' })).toBeVisible();

      const ownedAgentLaunch = firstChooser.discovery.targets.find((target) => (
        target.kind === 'agent'
        && target.label === initialGitAgent.agentName
        && target.detail === `${initialGitAgent.repoName}/${initialGitAgent.agentName}`
      ))?.launch;
      expect(ownedAgentLaunch).toMatch(/^[A-Za-z0-9_-]{32,128}$/);
      foreignAdminContext = await browser.newContext({
        baseURL: smokeConfig.baseURL,
        ignoreHTTPSErrors: true,
      });
      const foreignAdminPage = await foreignAdminContext.newPage();
      await openExplorer(foreignAdminPage, {
        account: smokeConfig.primaryUser,
        hash: fixture.explorerHash,
      });
      const foreignLaunchAttempt = await browserMutation(foreignAdminPage, '/webtty/sessions', {
        body: { launch: ownedAgentLaunch, cols: 80, rows: 24 },
      });
      expect(foreignLaunchAttempt).toMatchObject({
        status: 404,
        payload: { ok: false, error: 'terminal_launch_unavailable' },
      });
      await foreignAdminContext.close();
      foreignAdminContext = null;

      const first = await selectTerminalTarget(firstChooser, (target) => target.kind === 'box');
      terminals.push(first);
      const firstDiagnostics = attachPageDiagnostics(first.terminalPage, testInfo, 'webtty-first-terminal');
      const firstUrl = new URL(first.terminalPage.url());
      expect(firstUrl.origin).toBe(new URL(smokeConfig.baseURL).origin);
      expect(firstUrl.pathname).toBe('/webtty/');
      expect(firstUrl.search).toBe('');
      expect(firstUrl.hash, 'the opaque launch fragment must be stripped before terminal creation').toBe('');
      expect(
        first.navigationRequest.headers().referer,
        'the fragment-only terminal navigation must not disclose the Explorer URL as a referrer',
      ).toBeUndefined();
      expect(await first.terminalPage.evaluate(() => window.opener === null)).toBe(true);
      expect(first.session.cwd).toBe(fixture.relativeDirectory);
      expect(first.session.target).toEqual({
        kind: first.selectedTarget.kind,
        label: first.selectedTarget.label,
        detail: first.selectedTarget.detail,
        access: first.selectedTarget.access,
        cwdDisplay: first.selectedTarget.cwdDisplay,
      });
      expect(first.session.target.kind).toBe('box');
      expect(first.session.target).toEqual(expectedBoxTarget);
      await expect(first.terminalPage.locator('#target')).toHaveText('Ploinky Box — Workspace runtime');
      await expect(first.terminalPage.locator('#directory')).toHaveText(first.selectedTarget.cwdDisplay);
      await expect(first.terminalPage.locator('#access')).toHaveText('Read and write folder mapping');
      await waitForConnectedTerminal(first.terminalPage);

      const replayCheckpoint = checkpointPageDiagnostics(page, 'single-use launch replay rejection');
      const replayConsole = waitForExact404Console(page, '/webtty/sessions');
      const replay = await browserMutation(page, '/webtty/sessions', {
        body: { launch: first.launch, cols: 80, rows: 24 },
      });
      expect(replay).toMatchObject({
        status: 404,
        payload: { ok: false, error: 'terminal_launch_unavailable' },
      });
      await replayConsole;
      acknowledgeExactPageDiagnostics(
        page,
        replayCheckpoint,
        expectedHttpFailureDiagnostics('/webtty/sessions', { status: 404 }),
      );

      const expectedCwd = `/workspace/${fixture.relativeDirectory}`;
      const command = [
        'printf \'__WEBTTY_PWD__%s__\\n\' "$PWD"',
        'printf \'__WEBTTY_HOST__\'',
        'cat -- host-marker.txt',
        'printf \'__WEBTTY_HOST_END__\\n\'',
        `printf '%s\\n' '${fixture.browserMarker}' > browser-marker.txt`,
      ].join('; ') + '\r';
      const input = await browserMutation(
        first.terminalPage,
        `/webtty/sessions/${encodeURIComponent(first.session.id)}/input`,
        { body: { data: command } },
      );
      expect(input).toMatchObject({ status: 200, payload: { ok: true } });
      await expect.poll(() => first.terminalPage.locator('#terminal .xterm-rows').innerText(), {
        message: 'the terminal must report its selected /workspace cwd and read the host marker',
        timeout: smokeConfig.timeouts.navigation,
      }).toContain(`__WEBTTY_PWD__${expectedCwd}__`);
      await expect(first.terminalPage.locator('#terminal .xterm-rows')).toContainText(fixture.hostMarker);
      await expect.poll(() => {
        try {
          return fs.readFileSync(path.join(fixture.nestedRoot, 'browser-marker.txt'), 'utf8').trim();
        } catch {
          return '';
        }
      }, {
        message: 'the terminal-created marker must be visible on the host workspace',
        timeout: smokeConfig.timeouts.navigation,
      }).toBe(fixture.browserMarker);
      expect(firstDiagnostics.actionableEvents(), 'the connected terminal page must have no browser errors').toEqual([]);
      firstDiagnostics.pause();

      const firstClose = await browserMutation(
        first.terminalPage,
        `/webtty/sessions/${encodeURIComponent(first.session.id)}`,
        { method: 'DELETE' },
      );
      expect(firstClose).toMatchObject({ status: 200, payload: { ok: true } });
      await first.terminalPage.close();
      await firstDiagnostics.flush();

      const legacyUrl = new URL('/webtty/', smokeConfig.baseURL);
      legacyUrl.searchParams.set('dir', fixture.relativeDirectory);
      const legacyPage = await page.context().newPage();
      let legacyCreationRequests = 0;
      legacyPage.on('request', (request) => {
        const requestUrl = new URL(request.url());
        if (request.method() === 'POST' && requestUrl.pathname === '/webtty/sessions') {
          legacyCreationRequests += 1;
        }
      });
      const legacyNavigation = await legacyPage.goto(legacyUrl.toString(), { waitUntil: 'load' });
      expect(legacyNavigation?.status()).toBe(200);
      await expect(legacyPage.locator('#status')).toHaveText('Invalid launch');
      await expect(legacyPage.locator('#message')).toContainText('missing, invalid, expired, or already used');
      expect(legacyCreationRequests, 'a legacy ?dir= URL must never create a terminal session').toBe(0);
      await legacyPage.close();

      const second = await openTerminalFromExplorer(page, fixture.nestedDirectoryPath);
      terminals.push(second);
      const secondDiagnostics = attachPageDiagnostics(second.terminalPage, testInfo, 'webtty-second-terminal');
      await waitForConnectedTerminal(second.terminalPage);
      expect(second.session.cwd).toBe(fixture.relativeDirectory);
      expect(second.session.target.kind).toBe('box');
      expect(second.launch).not.toBe(first.launch);
      expect(secondDiagnostics.actionableEvents(), 'WebTTY must remain available after normal terminal cleanup').toEqual([]);
      secondDiagnostics.pause();
      const secondClose = await browserMutation(
        second.terminalPage,
        `/webtty/sessions/${encodeURIComponent(second.session.id)}`,
        { method: 'DELETE' },
      );
      expect(secondClose).toMatchObject({ status: 200, payload: { ok: true } });
      await second.terminalPage.close();
      await secondDiagnostics.flush();

      if (readOnlyAgent) {
        const readOnlyTerminal = await openTerminalFromExplorer(
          page,
          fixture.nestedDirectoryPath,
          (target) => target.kind === 'agent'
            && target.label === readOnlyAgent.agentName
            && target.detail === `${readOnlyAgent.repoName}/${readOnlyAgent.agentName}`
            && target.access === 'ro'
            && target.cwdDisplay === readOnlyAgent.mapping.translatedCwd,
        );
        terminals.push(readOnlyTerminal);
        const readOnlyDiagnostics = attachPageDiagnostics(
          readOnlyTerminal.terminalPage,
          testInfo,
          'webtty-read-only-agent-terminal',
        );
        await waitForConnectedTerminal(readOnlyTerminal.terminalPage);
        await waitForAgentExecDelta(initialRuntime, readOnlyAgent, readOnlyAgent.execIds, 1);
        const readOnlyCommand = [
          'printf \'__WEBTTY_RO_HOSTNAME__\'; hostname; printf \'__WEBTTY_RO_HOSTNAME_END__\\n\'',
          `if printf 'write-must-fail\\n' > '${fixture.readOnlyProbeName}'; then cat -- read-only-succeeded-marker.txt; else cat -- read-only-refused-marker.txt; fi`,
        ].join('; ') + '\r';
        const readOnlyInput = await browserMutation(
          readOnlyTerminal.terminalPage,
          `/webtty/sessions/${encodeURIComponent(readOnlyTerminal.session.id)}/input`,
          { body: { data: readOnlyCommand } },
        );
        expect(readOnlyInput).toMatchObject({ status: 200, payload: { ok: true } });
        await expect.poll(() => readOnlyTerminal.terminalPage.locator('#terminal .xterm-rows').innerText(), {
          message: 'the read-only terminal must prove its exact independently inspected container hostname',
          timeout: smokeConfig.timeouts.navigation,
        }).toMatch(new RegExp(
          `__WEBTTY_RO_HOSTNAME__\\s*${escapeRegExp(readOnlyAgent.hostname)}\\s*__WEBTTY_RO_HOSTNAME_END__`,
        ));
        await expect(readOnlyTerminal.terminalPage.locator('#terminal .xterm-rows')).toContainText(
          fixture.readOnlyRefusedMarker,
        );
        await expect(readOnlyTerminal.terminalPage.locator('#terminal .xterm-rows')).not.toContainText(
          fixture.readOnlySucceededMarker,
        );
        expect(
          fs.existsSync(path.join(fixture.nestedRoot, fixture.readOnlyProbeName)),
          'the read-only agent target must not create the probe in the host workspace',
        ).toBe(false);
        expect(readOnlyDiagnostics.actionableEvents(), 'the read-only terminal must remain browser-error-free').toEqual([]);
        readOnlyDiagnostics.pause();
        await closeTerminal(readOnlyTerminal);
        await readOnlyDiagnostics.flush();
        await waitForAgentExecDelta(initialRuntime, readOnlyAgent, readOnlyAgent.execIds, 0);
        readOnlyTargetExercised = true;
      } else {
        expect(initialRuntime.eligibleTargets.filter((target) => target.access === 'ro')).toHaveLength(0);
        expect(firstChooser.discovery.targets.filter((target) => (
          target.kind === 'agent' && target.access === 'ro'
        ))).toHaveLength(0);
      }

      const initialAgentMarkerBaseline = collectAgentMarkerTokens(initialRuntime, initialGitAgent);
      const agentTerminal = await openTerminalFromExplorer(
        page,
        fixture.nestedDirectoryPath,
        (target) => target.kind === 'agent'
          && target.label === initialGitAgent.agentName
          && target.detail === `${initialGitAgent.repoName}/${initialGitAgent.agentName}`,
      );
      terminals.push(agentTerminal);
      const agentDiagnostics = attachPageDiagnostics(agentTerminal.terminalPage, testInfo, 'webtty-agent-terminal');
      expect(agentTerminal.session.cwd).toBe(fixture.relativeDirectory);
      expect(agentTerminal.session.target).toEqual(publicTarget(agentTerminal.selectedTarget));
      expect(agentTerminal.session.target.kind).toBe('agent');
      expect(agentTerminal.session.target.cwdDisplay).toBe(initialGitAgent.mapping.translatedCwd);
      await expect(agentTerminal.terminalPage.locator('#target')).toContainText(initialGitAgent.agentName);
      await expect(agentTerminal.terminalPage.locator('#directory')).toHaveText(initialGitAgent.mapping.translatedCwd);
      await expect(agentTerminal.terminalPage.locator('#access')).toHaveText(
        initialGitAgent.mapping.access === 'ro' ? 'Read only folder mapping' : 'Read and write folder mapping',
      );
      await waitForConnectedTerminal(agentTerminal.terminalPage);
      await waitForAgentExecDelta(initialRuntime, initialGitAgent, initialGitAgent.execIds, 1);
      const initialAgentMarker = await waitForSingleNewAgentMarker(
        initialRuntime,
        initialGitAgent,
        initialAgentMarkerBaseline,
      );

      const agentCommand = [
        'printf \'__WEBTTY_AGENT_PWD__%s__\\n\' "$PWD"',
        'printf \'__WEBTTY_AGENT_HOSTNAME__\'; hostname; printf \'__WEBTTY_AGENT_HOSTNAME_END__\\n\'',
        'printf \'__WEBTTY_AGENT_HOST__\'',
        'cat -- host-marker.txt',
        'printf \'__WEBTTY_AGENT_HOST_END__\\n\'',
        `printf '%s\\n' '${fixture.agentBrowserMarker}' > agent-browser-marker.txt`,
      ].join('; ') + '\r';
      const agentInput = await browserMutation(
        agentTerminal.terminalPage,
        `/webtty/sessions/${encodeURIComponent(agentTerminal.session.id)}/input`,
        { body: { data: agentCommand } },
      );
      expect(agentInput).toMatchObject({ status: 200, payload: { ok: true } });
      await expect.poll(() => agentTerminal.terminalPage.locator('#terminal .xterm-rows').innerText(), {
        message: 'the agent terminal must report its independently translated cwd',
        timeout: smokeConfig.timeouts.navigation,
      }).toContain(`__WEBTTY_AGENT_PWD__${initialGitAgent.mapping.translatedCwd}__`);
      await expect.poll(() => agentTerminal.terminalPage.locator('#terminal .xterm-rows').innerText(), {
        message: 'the agent terminal must report the independently inspected exact container hostname',
        timeout: smokeConfig.timeouts.navigation,
      }).toMatch(new RegExp(
        `__WEBTTY_AGENT_HOSTNAME__\\s*${escapeRegExp(initialGitAgent.hostname)}\\s*__WEBTTY_AGENT_HOSTNAME_END__`,
      ));
      await expect(agentTerminal.terminalPage.locator('#terminal .xterm-rows')).toContainText(fixture.hostMarker);
      await expect.poll(() => {
        try {
          return fs.readFileSync(path.join(fixture.nestedRoot, 'agent-browser-marker.txt'), 'utf8').trim();
        } catch {
          return '';
        }
      }, {
        message: 'the agent terminal-created marker must be visible on the host workspace',
        timeout: smokeConfig.timeouts.navigation,
      }).toBe(fixture.agentBrowserMarker);

      const resize = await browserMutation(
        agentTerminal.terminalPage,
        `/webtty/sessions/${encodeURIComponent(agentTerminal.session.id)}/resize`,
        { body: { cols: 97, rows: 31 } },
      );
      expect(resize).toMatchObject({ status: 200, payload: { ok: true } });
      const sizeInput = await browserMutation(
        agentTerminal.terminalPage,
        `/webtty/sessions/${encodeURIComponent(agentTerminal.session.id)}/input`,
        { body: { data: "printf '__WEBTTY_SIZE__\\n'; stty size; printf '__WEBTTY_SIZE_END__\\n'\r" } },
      );
      expect(sizeInput).toMatchObject({ status: 200, payload: { ok: true } });
      await expect.poll(() => agentTerminal.terminalPage.locator('#terminal .xterm-rows').innerText(), {
        message: 'the agent PTY must report the exact requested terminal size',
        timeout: smokeConfig.timeouts.navigation,
      }).toMatch(/__WEBTTY_SIZE__\s+31 97\s+__WEBTTY_SIZE_END__/);

      const foregroundSeconds = 347;
      const foregroundInput = await browserMutation(
        agentTerminal.terminalPage,
        `/webtty/sessions/${encodeURIComponent(agentTerminal.session.id)}/input`,
        { body: { data: `sleep ${foregroundSeconds}\r` } },
      );
      expect(foregroundInput).toMatchObject({ status: 200, payload: { ok: true } });
      const foregroundPattern = new RegExp(`(?:^|\\s)sleep ${foregroundSeconds}(?:$|\\s)`);
      await waitForAgentProcess(initialRuntime, initialGitAgent, foregroundPattern, true);
      expect(agentDiagnostics.actionableEvents(), 'the live agent terminal must have no browser errors').toEqual([]);
      agentDiagnostics.pause();
      await agentTerminal.terminalPage.close();
      await agentDiagnostics.flush();
      await waitForAgentExecDelta(initialRuntime, initialGitAgent, initialGitAgent.execIds, 0);
      await waitForAgentProcess(initialRuntime, initialGitAgent, foregroundPattern, false);
      await waitForAgentMarker(initialRuntime, initialGitAgent, initialAgentMarker, false);

      const replacementVictimMarkerBaseline = collectAgentMarkerTokens(initialRuntime, initialGitAgent);
      const replacementVictim = await openTerminalFromExplorer(
        page,
        fixture.nestedDirectoryPath,
        (target) => target.kind === 'agent'
          && target.label === initialGitAgent.agentName
          && target.detail === `${initialGitAgent.repoName}/${initialGitAgent.agentName}`,
      );
      terminals.push(replacementVictim);
      const replacementVictimDiagnostics = attachPageDiagnostics(
        replacementVictim.terminalPage,
        testInfo,
        'webtty-agent-replacement-victim',
      );
      await waitForConnectedTerminal(replacementVictim.terminalPage);
      await waitForAgentExecDelta(initialRuntime, initialGitAgent, initialGitAgent.execIds, 1);
      const replacementVictimMarker = await waitForSingleNewAgentMarker(
        initialRuntime,
        initialGitAgent,
        replacementVictimMarkerBaseline,
      );
      expect(replacementVictimMarker).toMatch(/^ploinky-webtty-marker:[A-Za-z0-9_-]{24,128}$/);
      const replacementVictimSeconds = 367;
      const replacementVictimInput = await browserMutation(
        replacementVictim.terminalPage,
        `/webtty/sessions/${encodeURIComponent(replacementVictim.session.id)}/input`,
        { body: { data: `sleep ${replacementVictimSeconds}\r` } },
      );
      expect(replacementVictimInput).toMatchObject({ status: 200, payload: { ok: true } });
      const replacementVictimPattern = new RegExp(`(?:^|\\s)sleep ${replacementVictimSeconds}(?:$|\\s)`);
      await waitForAgentProcess(initialRuntime, initialGitAgent, replacementVictimPattern, true);
      expect(replacementVictimDiagnostics.actionableEvents(), 'the replacement victim must be healthy before target removal').toEqual([]);

      const replacementChooser = await openTerminalChooser(page, fixture.nestedDirectoryPath);
      const staleGitTarget = replacementChooser.discovery.targets.find((target) => (
        target.kind === 'agent'
        && target.label === initialGitAgent.agentName
        && target.detail === `${initialGitAgent.repoName}/${initialGitAgent.agentName}`
      ));
      expect(staleGitTarget).toBeTruthy();
      replacementVictimDiagnostics.setExpectedOffline(true);
      const restartAgentResult = await restartPloinkyTarget('gitAgent', fixture);
      expect(restartAgentResult.stderr).not.toMatch(/failed to (?:restart|start)|managed restart failed/i);
      expect(restartAgentResult.stdout).toMatch(/✓ Agent restarted(?: \([^)]+\))?\./);
      await expect.poll(() => collectExactAgentState(initialRuntime, initialGitAgent).present, {
        message: 'targeted restart must remove the exact predecessor agent container',
        timeout: smokeConfig.timeouts.relay,
      }).toBe(false);
      await expect(replacementVictim.terminalPage.locator('#status')).not.toHaveText('Connected');
      replacementVictimDiagnostics.setExpectedOffline(false);
      expect(
        replacementVictimDiagnostics.actionableEvents(),
        'active target replacement may interrupt transport but must not produce an unhandled browser failure',
      ).toEqual([]);
      await replacementVictim.terminalPage.close().catch(() => {});
      await replacementVictimDiagnostics.flush();

      const replacementRuntimeBeforeStale = collectWebttyRuntimeEvidence({
        baseURL: smokeConfig.baseURL,
        workspaceRoot: fixture.workspaceRoot,
        selectedDirectory: fixture.nestedRoot,
        ...runtimeBinding,
      });
      const replacementBeforeStale = requireAgentEvidence(
        replacementRuntimeBeforeStale,
        'gitAgent',
        { eligible: true },
      );
      expect(replacementBeforeStale.containerId).not.toBe(initialGitAgent.containerId);
      const replacementMarkersBeforeStale = collectAgentMarkerTokens(
        replacementRuntimeBeforeStale,
        replacementBeforeStale,
      );
      const staleCheckpoint = checkpointPageDiagnostics(page, 'stale predecessor launch rejection');
      const staleConsole = waitForExact404Console(page, '/webtty/sessions');
      const staleLaunchSubmittedAt = Date.now();
      const staleObservation = await runWhileObservingNoAgentShell(
        replacementRuntimeBeforeStale,
        replacementBeforeStale,
        replacementBeforeStale.execIds,
        replacementMarkersBeforeStale,
        () => browserMutation(page, '/webtty/sessions', {
          body: { launch: staleGitTarget.launch, cols: 80, rows: 24 },
        }),
      );
      const staleLaunchObservedAt = Date.now();
      expect(
        staleLaunchSubmittedAt,
        'the predecessor launch must still be live when replacement revalidation is submitted',
      ).toBeLessThan(replacementChooser.discovery.expiresAt);
      expect(
        staleLaunchObservedAt,
        'the predecessor rejection must complete before expiry can satisfy it ambiguously',
      ).toBeLessThan(replacementChooser.discovery.expiresAt);
      const staleLaunch = staleObservation.value;
      expect(staleLaunch).toMatchObject({
        status: 404,
        payload: { ok: false, error: 'terminal_launch_unavailable' },
      });
      await staleConsole;
      acknowledgeExactPageDiagnostics(
        page,
        staleCheckpoint,
        expectedHttpFailureDiagnostics('/webtty/sessions', { status: 404 }),
      );
      await waitForAgentExecDelta(
        replacementRuntimeBeforeStale,
        replacementBeforeStale,
        replacementBeforeStale.execIds,
        0,
      );
      await expect.poll(() => collectAgentMarkerTokens(
        replacementRuntimeBeforeStale,
        replacementBeforeStale,
      ), {
        message: 'a stale predecessor launch must not create a marker-bearing shell in the replacement',
        timeout: smokeConfig.timeouts.navigation,
      }).toEqual(replacementMarkersBeforeStale);

      const replacementRuntime = collectWebttyRuntimeEvidence({
        baseURL: smokeConfig.baseURL,
        workspaceRoot: fixture.workspaceRoot,
        selectedDirectory: fixture.nestedRoot,
        ...runtimeBinding,
      });
      const replacementGitAgent = requireAgentEvidence(replacementRuntime, 'gitAgent', { eligible: true });
      expect(replacementGitAgent.containerId).toBe(replacementBeforeStale.containerId);
      expect(replacementGitAgent.instanceId).toBe(initialGitAgent.instanceId);
      expect(replacementGitAgent.enableGeneration).toBe(initialGitAgent.enableGeneration);
      const consumedDiscoveryId = replacementChooser.discovery.id;
      const cancellationCheckpoint = checkpointPageDiagnostics(page, 'consumed discovery cancellation');
      const cancellationPath = `/webtty/target-discoveries/${encodeURIComponent(consumedDiscoveryId)}`;
      const cancellationUrl = new URL(cancellationPath, smokeConfig.baseURL).toString();
      const cancellationRequests = [];
      const cancellationSequence = [];
      const onCancellationRequest = (request) => {
        if (request.url() === cancellationUrl && request.method() === 'DELETE') {
          cancellationRequests.push(request);
          cancellationSequence.push('cancellation request');
        } else if (request.method() === 'POST'
          && new URL(request.url()).pathname === '/webtty/target-discoveries') {
          cancellationSequence.push('replacement discovery request');
        }
      };
      const onCancellationResponse = (response) => {
        if (response.url() === cancellationUrl && response.request().method() === 'DELETE') {
          cancellationSequence.push('cancellation response');
        }
      };
      page.on('request', onCancellationRequest);
      page.on('response', onCancellationResponse);
      try {
        const cancellationResponsePromise = page.waitForResponse((response) => (
          response.url() === cancellationUrl
          && response.request().method() === 'DELETE'
        ), { timeout: smokeConfig.timeouts.action });
        const cancellationFinishedPromise = page.waitForEvent('requestfinished', {
          predicate: (request) => request.url() === cancellationUrl
            && request.method() === 'DELETE',
          timeout: smokeConfig.timeouts.action,
        });
        const refreshedDiscoveryPromise = refreshTerminalChooser(
          replacementChooser,
          fixture.nestedDirectoryPath,
        );
        const [cancellationResponse, cancellationFinishedRequest, refreshedDiscovery] = await Promise.all([
          cancellationResponsePromise,
          cancellationFinishedPromise,
          refreshedDiscoveryPromise,
        ]);
        expect(cancellationResponse.url()).toBe(cancellationUrl);
        expect(cancellationResponse.request().method()).toBe('DELETE');
        expect(cancellationResponse.status()).toBe(404);
        expect(cancellationFinishedRequest).toBe(cancellationResponse.request());
        expect(cancellationFinishedRequest.failure()).toBeNull();
        expect(await cancellationResponse.json()).toEqual({ ok: false, error: 'not_found' });
        expect(refreshedDiscovery.id).not.toBe(consumedDiscoveryId);
        expect(cancellationRequests).toHaveLength(1);
        expect(cancellationRequests[0]).toBe(cancellationResponse.request());
        expect(cancellationSequence).toEqual([
          'cancellation request',
          'cancellation response',
          'replacement discovery request',
        ]);
        acknowledgeExactPageDiagnostics(
          page,
          cancellationCheckpoint,
          expectedDiscoveryCancellationDiagnostics(consumedDiscoveryId),
        );
        replacementChooser.discovery = refreshedDiscovery;
      } finally {
        page.off('request', onCancellationRequest);
        page.off('response', onCancellationResponse);
      }
      const refreshedDiscovery = replacementChooser.discovery;
      const refreshedTargets = refreshedDiscovery.targets;
      expect(sortedTargets(refreshedTargets.filter((target) => target.kind === 'agent')))
        .toEqual(sortedTargets(replacementRuntime.eligibleTargets));
      const refreshedGitTarget = refreshedTargets.find((target) => (
        target.kind === 'agent'
        && target.label === replacementGitAgent.agentName
        && target.detail === `${replacementGitAgent.repoName}/${replacementGitAgent.agentName}`
      ));
      expect(refreshedGitTarget?.launch).toMatch(/^[A-Za-z0-9_-]{32,128}$/);
      expect(refreshedGitTarget?.launch).not.toBe(staleGitTarget.launch);

      const replacementTerminalMarkerBaseline = collectAgentMarkerTokens(
        replacementRuntime,
        replacementGitAgent,
      );
      const replacementTerminal = await selectTerminalTarget(
        replacementChooser,
        (target) => target.launch === refreshedGitTarget.launch,
      );
      terminals.push(replacementTerminal);
      const replacementDiagnostics = attachPageDiagnostics(
        replacementTerminal.terminalPage,
        testInfo,
        'webtty-replacement-agent-terminal',
      );
      await waitForConnectedTerminal(replacementTerminal.terminalPage);
      await waitForAgentExecDelta(
        replacementRuntime,
        replacementGitAgent,
        replacementGitAgent.execIds,
        1,
      );
      const replacementTerminalMarker = await waitForSingleNewAgentMarker(
        replacementRuntime,
        replacementGitAgent,
        replacementTerminalMarkerBaseline,
      );
      const replacementInput = await browserMutation(
        replacementTerminal.terminalPage,
        `/webtty/sessions/${encodeURIComponent(replacementTerminal.session.id)}/input`,
        { body: { data: "printf '__WEBTTY_REPLACEMENT_HOSTNAME__'; hostname; printf '__WEBTTY_REPLACEMENT_HOSTNAME_END__\\n'; printf '__WEBTTY_REPLACEMENT_PWD__%s__\\n' \"$PWD\"\r" } },
      );
      expect(replacementInput).toMatchObject({ status: 200, payload: { ok: true } });
      await expect.poll(() => replacementTerminal.terminalPage.locator('#terminal .xterm-rows').innerText(), {
        message: 'the replacement terminal must bind output to the independently inspected replacement container',
        timeout: smokeConfig.timeouts.navigation,
      }).toMatch(new RegExp(
        `__WEBTTY_REPLACEMENT_HOSTNAME__\\s*${escapeRegExp(replacementGitAgent.hostname)}\\s*__WEBTTY_REPLACEMENT_HOSTNAME_END__`,
      ));
      await expect.poll(() => replacementTerminal.terminalPage.locator('#terminal .xterm-rows').innerText(), {
        message: 'the replacement terminal must use the independently translated cwd',
        timeout: smokeConfig.timeouts.navigation,
      }).toContain(`__WEBTTY_REPLACEMENT_PWD__${replacementGitAgent.mapping.translatedCwd}__`);

      const logoutSleepSeconds = 353;
      const logoutSleepInput = await browserMutation(
        replacementTerminal.terminalPage,
        `/webtty/sessions/${encodeURIComponent(replacementTerminal.session.id)}/input`,
        { body: { data: `sleep ${logoutSleepSeconds}\r` } },
      );
      expect(logoutSleepInput).toMatchObject({ status: 200, payload: { ok: true } });
      const logoutSleepPattern = new RegExp(`(?:^|\\s)sleep ${logoutSleepSeconds}(?:$|\\s)`);
      await waitForAgentProcess(replacementRuntime, replacementGitAgent, logoutSleepPattern, true);
      expect(replacementDiagnostics.actionableEvents(), 'the replacement agent terminal must remain error-free before revocation').toEqual([]);
      replacementDiagnostics.setExpectedOffline(true);
      await page.goto('/auth/logout?returnTo=/', { waitUntil: 'load' });
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'load' }),
        page.locator('form[action^="/auth/logout"] button[type="submit"]').click(),
      ]);
      await waitForAgentExecDelta(
        replacementRuntime,
        replacementGitAgent,
        replacementGitAgent.execIds,
        0,
      );
      await waitForAgentProcess(replacementRuntime, replacementGitAgent, logoutSleepPattern, false);
      await waitForAgentMarker(replacementRuntime, replacementGitAgent, replacementTerminalMarker, false);
      await expect(replacementTerminal.terminalPage.locator('#status')).not.toHaveText('Connected');
      replacementDiagnostics.setExpectedOffline(false);
      expect(
        replacementDiagnostics.actionableEvents(),
        'auth revocation may terminate transport but must not produce an unhandled browser failure',
      ).toEqual([]);
      await replacementTerminal.terminalPage.close().catch(() => {});
      await replacementDiagnostics.flush();

      await openExplorer(page, {
        account: smokeConfig.primaryUser,
        hash: fixture.explorerHash,
      });
      await assertExplorerDirectory(page, fixture.parentDirectoryPath);
      const recoveryTerminalMarkerBaseline = collectAgentMarkerTokens(
        replacementRuntime,
        replacementGitAgent,
      );
      const restartRecoveryTerminal = await openTerminalFromExplorer(
        page,
        fixture.nestedDirectoryPath,
        (target) => target.kind === 'agent'
          && target.label === replacementGitAgent.agentName
          && target.detail === `${replacementGitAgent.repoName}/${replacementGitAgent.agentName}`,
      );
      terminals.push(restartRecoveryTerminal);
      const recoveryDiagnostics = attachPageDiagnostics(
        restartRecoveryTerminal.terminalPage,
        testInfo,
        'webtty-router-recovery-terminal',
      );
      await waitForConnectedTerminal(restartRecoveryTerminal.terminalPage);
      await waitForAgentExecDelta(
        replacementRuntime,
        replacementGitAgent,
        replacementGitAgent.execIds,
        1,
      );
      const recoveryTerminalMarker = await waitForSingleNewAgentMarker(
        replacementRuntime,
        replacementGitAgent,
        recoveryTerminalMarkerBaseline,
      );
      const restartSleepSeconds = 359;
      const restartSleepInput = await browserMutation(
        restartRecoveryTerminal.terminalPage,
        `/webtty/sessions/${encodeURIComponent(restartRecoveryTerminal.session.id)}/input`,
        { body: { data: `sleep ${restartSleepSeconds}\r` } },
      );
      expect(restartSleepInput).toMatchObject({ status: 200, payload: { ok: true } });
      const restartSleepPattern = new RegExp(`(?:^|\\s)sleep ${restartSleepSeconds}(?:$|\\s)`);
      await waitForAgentProcess(replacementRuntime, replacementGitAgent, restartSleepPattern, true);
      await waitForExplorerPluginRender(page);
      assertPageDiagnosticsClean(page, 'Explorer must be error-free before Router fault injection');
      // Only the recovery terminal is the outage target. Stop unrelated Explorer
      // background traffic without muting either page's diagnostic ledger.
      await page.goto('about:blank', {waitUntil: 'load'});
      expect(page.url()).toBe('about:blank');
      assertPageDiagnosticsClean(page, 'quiescing Explorer must not hide browser failures');
      const primaryRecoveryCheckpoint = checkpointPageDiagnostics(page, 'quiescent Explorer during Router recovery');
      const explorerQuiescedAt = new Date().toISOString();
      expect(recoveryDiagnostics.actionableEvents(), 'the recovery terminal must remain error-free before Router crash').toEqual([]);
      const recoveryCheckpoint = recoveryDiagnostics.checkpoint('exact prior-epoch Router stream invalidation');
      const recovery404Console = waitForExact404Console(
        restartRecoveryTerminal.terminalPage,
        `/webtty/sessions/${encodeURIComponent(restartRecoveryTerminal.session.id)}/stream`,
      );
      const crashedRouter = crashExactRoutingServer(replacementRuntime, replacementGitAgent);
      let recoveredRouter = null;
      let routerRecoveryFailure = '';
      await expect.poll(async () => {
        try {
          const candidate = collectExactRoutingServerIdentity(replacementRuntime);
          if (candidate.watchdogPid !== crashedRouter.watchdogPid
            || candidate.watchdogStartTime !== crashedRouter.watchdogStartTime
            || (candidate.routerPid === crashedRouter.routerPid
              && candidate.routerStartTime === crashedRouter.routerStartTime)) {
            return false;
          }
          const response = await page.context().request.get(
            new URL('/auth/token', smokeConfig.baseURL).toString(),
            { failOnStatusCode: false, timeout: smokeConfig.timeouts.action },
          );
          if (response.status() !== 200) return false;
          recoveredRouter = candidate;
          routerRecoveryFailure = '';
          return true;
        } catch (error) {
          routerRecoveryFailure = error?.message || String(error);
          return false;
        }
      }, {
        message: 'the existing Watchdog must restart a new exact RoutingServer after SIGKILL',
        timeout: smokeConfig.timeouts.relay,
        intervals: [500, 1_000, 2_000],
      }).toBe(true);
      expect(routerRecoveryFailure).toBe('');
      expect(recoveredRouter).toBeTruthy();
      const routerRecoveredAt = new Date().toISOString();
      await waitForAgentExecDelta(
        replacementRuntime,
        replacementGitAgent,
        replacementGitAgent.execIds,
        0,
      );
      await waitForAgentProcess(replacementRuntime, replacementGitAgent, restartSleepPattern, false);
      await waitForAgentMarker(replacementRuntime, replacementGitAgent, recoveryTerminalMarker, false);
      expect(collectWebttyRecoveryDirectoryState(replacementRuntime)).toEqual({
        recordCount: 0,
        temporaryCount: 0,
        otherCount: 0,
      });
      await expect(restartRecoveryTerminal.terminalPage.locator('#status')).not.toHaveText('Connected');
      await recovery404Console;
      recoveryDiagnostics.acknowledgeExact(
        recoveryCheckpoint,
        expectedRouterRecoveryDiagnostics(restartRecoveryTerminal.session.id),
      );
      expect(recoveryDiagnostics.actionableEvents(), 'Router recovery diagnostics must match the exact prior-epoch stream').toEqual([]);
      await restartRecoveryTerminal.terminalPage.close().catch(() => {});
      await recoveryDiagnostics.flush();

      await openExplorer(page, {
        account: smokeConfig.primaryUser,
        hash: fixture.explorerHash,
      });
      await assertExplorerDirectory(page, fixture.parentDirectoryPath);
      acknowledgeExactPageDiagnostics(page, primaryRecoveryCheckpoint, []);
      assertPageDiagnosticsClean(page, 'Explorer must reopen cleanly after verified Router recovery');
      const explorerReopenedAt = new Date().toISOString();
      const isolationHostMarker = `box-isolation-host-${crypto.randomUUID()}`;
      const isolationBrowserMarker = `box-isolation-browser-${crypto.randomUUID()}`;
      fs.writeFileSync(
        path.join(fixture.nestedRoot, 'box-isolation-host-marker.txt'),
        `${isolationHostMarker}\n`,
        { mode: 0o600 },
      );
      const isolatedBox = await openTerminalFromExplorer(page, fixture.nestedDirectoryPath);
      terminals.push(isolatedBox);
      const isolatedBoxDiagnostics = attachPageDiagnostics(
        isolatedBox.terminalPage,
        testInfo,
        'webtty-box-after-agent-router-failures',
      );
      await waitForConnectedTerminal(isolatedBox.terminalPage);
      expect(isolatedBox.session.target.kind).toBe('box');
      const isolationInput = await browserMutation(
        isolatedBox.terminalPage,
        `/webtty/sessions/${encodeURIComponent(isolatedBox.session.id)}/input`,
        {
          body: {
            data: [
              "printf '__WEBTTY_BOX_ISOLATION_HOST__'",
              'cat -- box-isolation-host-marker.txt',
              "printf '__WEBTTY_BOX_ISOLATION_HOST_END__\\n'",
              `printf '%s\\n' '${isolationBrowserMarker}' > box-isolation-browser-marker.txt`,
            ].join('; ') + '\r',
          },
        },
      );
      expect(isolationInput).toMatchObject({ status: 200, payload: { ok: true } });
      await expect.poll(() => isolatedBox.terminalPage.locator('#terminal .xterm-rows').innerText(), {
        message: 'the Box terminal must read fresh application output after agent and Router failures',
        timeout: smokeConfig.timeouts.navigation,
      }).toContain(isolationHostMarker);
      await expect.poll(() => {
        try {
          return fs.readFileSync(
            path.join(fixture.nestedRoot, 'box-isolation-browser-marker.txt'),
            'utf8',
          ).trim();
        } catch {
          return '';
        }
      }, {
        message: 'the Box terminal must write through to the selected host folder after isolated failures',
        timeout: smokeConfig.timeouts.navigation,
      }).toBe(isolationBrowserMarker);
      expect(
        isolatedBoxDiagnostics.actionableEvents(),
        'the Box terminal must remain browser-error-free after isolated failures',
      ).toEqual([]);
      isolatedBoxDiagnostics.pause();
      await closeTerminal(isolatedBox);
      await isolatedBoxDiagnostics.flush();

      userContext = await browser.newContext({
        baseURL: smokeConfig.baseURL,
        ignoreHTTPSErrors: true,
      });
      const userPage = await userContext.newPage();
      await openExplorer(userPage, {
        account: smokeConfig.secondaryUser,
        hash: fixture.explorerHash,
      });
      await assertExplorerDirectory(userPage, fixture.parentDirectoryPath);
      const ordinaryUser = await readAuthenticatedPrincipal(userPage, smokeConfig.secondaryUser);
      assertDistinctAuthenticatedPrincipals(admin, ordinaryUser);
      expect(ordinaryUser.roles).not.toContain('admin');
      const userRow = userPage.locator(`tr[data-entry-path="${fixture.nestedDirectoryPath}"]`);
      await expect(userRow).toHaveCount(1, { timeout: smokeConfig.timeouts.navigation });
      await userRow.locator('.action-menu-trigger').click();
      await expect(userRow.getByRole('menuitem', { name: 'Open Terminal Here' })).toHaveCount(0);

      const deniedDiscovery = await browserMutation(userPage, '/webtty/target-discoveries', {
        body: { dir: fixture.relativeDirectory },
      });
      expect(deniedDiscovery).toMatchObject({
        status: 403,
        payload: { ok: false, error: 'administrator_required' },
      });
      const deniedCreation = await browserMutation(userPage, '/webtty/sessions', {
        body: { launch: 'A'.repeat(32), cols: 80, rows: 24 },
      });
      expect(deniedCreation).toMatchObject({
        status: 403,
        payload: { ok: false, error: 'administrator_required' },
      });
      const deniedPageUrl = new URL('/webtty/', smokeConfig.baseURL);
      const directResponse = await userPage.goto(deniedPageUrl.toString(), { waitUntil: 'load' });
      expect(directResponse?.status()).toBe(403);
      await expect(userPage.locator('body')).toContainText('administrator_required');

      await testInfo.attach('webtty-core-evidence.json', {
        body: Buffer.from(JSON.stringify({
          origin: firstUrl.origin,
          relativeDirectory: fixture.relativeDirectory,
          chooserAccessibleName: 'Open terminal in',
          routerFaultIsolation: {explorerQuiescedAt, routerRecoveredAt, explorerReopenedAt},
          discoveryTargetCount: first.discovery.targets.length,
          serverDerivedRowsMatched: true,
          boxWasFirst: true,
          independentlyProvedAgentTargetCount: initialRuntime.eligibleTargets.length,
          readOnlyAgentTargetCount: initialRuntime.eligibleTargets.filter((target) => target.access === 'ro').length,
          readOnlyBrowserDisposition: readOnlyAgent
            ? 'write-refusal-proved'
            : 'not-present-in-exact-live-graph',
          readOnlyTargetExercised,
          readOnlyWriteRefused: readOnlyAgent ? true : null,
          isolatedAgentExcluded: true,
          launchFragmentStripped: true,
          launchReplayStatus: replay.status,
          crossSessionLaunchStatus: foreignLaunchAttempt.status,
          missingCsrfStatus: missingCsrf.status,
          forgedOriginStatus: forgedOrigin.status,
          initialCwd: first.session.cwd,
          hostMarkerRead: true,
          hostMarkerWritten: true,
          agentCwdMatchedIndependentMountProof: true,
          agentBidirectionalIo: true,
          agentResize: true,
          agentDisconnectRemovedExecAndForegroundProcess: true,
          predecessorTargetRemoved: true,
          activeTargetReplacementRemovedExactMarkerContainer: true,
          staleLaunchStatus: staleLaunch.status,
          staleLaunchObservationSamples: staleObservation.samples,
          staleLaunchExactExecEventCount: staleObservation.exactEventCount,
          replacementTargetChangedImmutableContainer: true,
          replacementTargetPreservedCoordinatedIdentity: true,
          authRevocationRemovedExecAndForegroundProcess: true,
          defaultRouterCrashRecoveryRemovedAgentExecAndForegroundProcess: true,
          boxAvailableAfterAgentAndRouterFailures: true,
          legacyDirectoryQueryCreatedSession: false,
          normalCloseKeptWebttyAvailable: true,
          ordinaryUserMenuItemVisible: false,
          ordinaryUserPageStatus: directResponse.status(),
          ordinaryUserDiscoveryStatus: deniedDiscovery.status,
          ordinaryUserCreationStatus: deniedCreation.status,
        }, null, 2)),
        contentType: 'application/json',
      });
    } finally {
      await userContext?.close().catch(() => {});
      await foreignAdminContext?.close().catch(() => {});
      for (const terminal of terminals.reverse()) {
        if (!terminal.terminalPage.isClosed()) {
          await browserMutation(
            terminal.terminalPage,
            `/webtty/sessions/${encodeURIComponent(terminal.session.id)}`,
            { method: 'DELETE' },
          ).catch(() => {});
          await terminal.terminalPage.close().catch(() => {});
        }
      }
      fs.rmSync(fixture.fixtureRoot, { recursive: true, force: true });
    }
  });
});
