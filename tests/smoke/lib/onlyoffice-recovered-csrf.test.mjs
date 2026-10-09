import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { chromium } from '@playwright/test';

import { createOnlyOfficeGateDiagnostics } from './onlyoffice-gate-diagnostics.mjs';
import {
  CONSOLE_LEAD_TOLERANCE_MS,
  RECOVERED_CSRF_CONSOLE_TEXT,
  evaluateRecoveredCsrfRefreshes,
} from './onlyoffice-recovered-csrf.mjs';

const ORIGIN = 'http://localhost:8080';
const URL_DPU = `${ORIGIN}/dpuAgent/mcp`;
const URL_EXPLORER = `${ORIGIN}/explorer/mcp`;
// Generations are public sha256 identifiers copied from the live reopen trace.
const OLD_GENERATION = 'sha256:01f7f44753c00d4397ba7fce7d628c7cb8d3944e79011aee691cf478d3c53e05';
const NEW_GENERATION = 'sha256:3392a4649dccc6176a2fa0cb336d125c55c6d0d3794ddc08fe697aee5c9d2d99';
const CLEANUP_GENERATION = 'sha256:ac26067b771e248f4f0c3c88ba8bd889d87bc72407932e77b6721d62383f0f6f';

let sequence = 0;
const mutation = (fields) => ({
  kind: 'mutation-response', seq: ++sequence, pageId: 1, phase: 'reopen', elapsedMs: 0, method: 'POST', status: 200,
  url: URL_DPU, bodyHash: 'a1b2c3d4e5f6', rpcMethod: 'tools/call', rpcId: '15', proofRef: 'ref-old', csrfInvalidBody: null,
  ...fields,
});
const proof = (fields) => ({
  kind: 'proof-response', seq: ++sequence, pageId: 1, phase: 'reopen', elapsedMs: 0, method: 'GET', status: 200,
  url: `${ORIGIN}/auth/token`, mutationRoute: 'dpuAgent', routeKey: 'dpuAgent', origin: ORIGIN,
  generation: OLD_GENERATION, proofRef: 'ref-old', ...fields,
});
const consoleError = (fields) => ({
  phase: 'reopen', elapsedMs: 0, kind: 'console', type: 'error', text: RECOVERED_CSRF_CONSOLE_TEXT,
  location: { url: URL_DPU, line: 0, column: 0, lineNumber: 0, columnNumber: 0 }, ...fields,
});

// The observed live sequence: the page held a proof for the old generation,
// the restart changed it, then 403 -> refresh -> identical retry 200.
function observed({ at = 1000, phase = 'reopen', oldGeneration = OLD_GENERATION, newGeneration = NEW_GENERATION } = {}) {
  const traffic = [
    proof({ phase: 'continued', elapsedMs: at - 500, generation: oldGeneration, proofRef: 'ref-old' }),
    mutation({ phase, elapsedMs: at, status: 403, csrfInvalidBody: true, proofRef: 'ref-old' }),
    proof({ phase, elapsedMs: at + 29, generation: newGeneration, proofRef: 'ref-new' }),
    mutation({ phase, elapsedMs: at + 103, status: 200, proofRef: 'ref-new' }),
  ];
  return { traffic, consoleErrors: [consoleError({ phase, elapsedMs: at })] };
}

// Sequence numbers follow array order, as the recorder assigns them.
const renumber = (traffic) => traffic.forEach((entry, index) => { entry.seq = index + 1; });

function assertFails(evidence, reason) {
  const result = evaluateRecoveredCsrfRefreshes(evidence);
  assert.deepEqual(result.acknowledged, [], `expected no acknowledgement for ${reason}`);
  assert.equal(result.rejected.length, 1);
  assert.equal(result.rejected[0].reason, reason);
  assert.equal(result.unacknowledgedConsoleErrors.length, evidence.consoleErrors.length);
  return result;
}

test('the observed 403 -> refresh with a new generation -> 200 retry sequence is acknowledged exactly once', () => {
  const evidence = observed();
  const result = evaluateRecoveredCsrfRefreshes(evidence);
  assert.deepEqual(result.rejected, []);
  assert.deepEqual(result.unacknowledgedConsoleErrors, []);
  assert.deepEqual(result.acknowledged, [{
    phase: 'reopen',
    url: URL_DPU,
    method: 'POST',
    rpcMethod: 'tools/call',
    rpcId: '15',
    bodyHash: 'a1b2c3d4e5f6',
    forbiddenStatus: 403,
    forbiddenBody: 'browser_csrf_invalid',
    rejectedGeneration: OLD_GENERATION,
    refreshedGeneration: NEW_GENERATION,
    refreshStatus: 200,
    retryStatus: 200,
    forbiddenAtMs: 1000,
    refreshAtMs: 1029,
    retryAtMs: 1103,
    refreshLatencyMs: 29,
    retryLatencyMs: 103,
    consoleText: RECOVERED_CSRF_CONSOLE_TEXT,
    consoleAtMs: 1000,
  }]);
});

test('two 403s for the same operation are never acknowledged, even when the last attempt recovers', () => {
  const evidence = observed();
  evidence.traffic.splice(2, 0, mutation({
    phase: 'reopen', elapsedMs: 1010, status: 403, csrfInvalidBody: true, proofRef: 'ref-old',
  }));
  renumber(evidence.traffic);
  const result = evaluateRecoveredCsrfRefreshes(evidence);
  assert.deepEqual(result.acknowledged, []);
  assert.deepEqual(result.rejected.map((entry) => entry.reason), ['repeated-403', 'repeated-403']);
  assert.equal(result.unacknowledgedConsoleErrors.length, 1);
});

test('a 403 with any body other than the exact browser_csrf_invalid object is not acknowledged', () => {
  const other = observed();
  other.traffic[1].csrfInvalidBody = false;
  assertFails(other, 'forbidden-body-not-browser-csrf-invalid');
  const unreadable = observed();
  unreadable.traffic[1].csrfInvalidBody = null;
  assertFails(unreadable, 'forbidden-body-unreadable');
  const failedCapture = observed();
  failedCapture.traffic[1].captureError = true;
  assertFails(failedCapture, 'capture-failed');
});

test('an unchanged generation is not a generation flip', () => {
  const evidence = observed({ newGeneration: OLD_GENERATION });
  assertFails(evidence, 'generation-unchanged');
});

test('the rejected proof generation must have been observed for the same route', () => {
  const unobserved = observed();
  unobserved.traffic.shift();
  assertFails(unobserved, 'rejected-proof-generation-unobserved');
  const otherRoute = observed();
  otherRoute.traffic[0].routeKey = 'explorer';
  assertFails(otherRoute, 'rejected-proof-generation-unobserved');
  const failedProof = observed();
  failedProof.traffic[0].status = 401;
  assertFails(failedProof, 'rejected-proof-generation-unobserved');
  const wrongProof = observed();
  wrongProof.traffic[0].proofRef = 'someone-else';
  assertFails(wrongProof, 'rejected-proof-generation-unobserved');
});

test('the refresh must exist, succeed, be route-bound, and precede the retry', () => {
  const missing = observed();
  missing.traffic.splice(2, 1);
  assertFails(missing, 'refresh-missing');
  const otherRouteOnly = observed();
  otherRouteOnly.traffic[2].mutationRoute = 'explorer';
  otherRouteOnly.traffic[2].routeKey = 'explorer';
  assertFails(otherRouteOnly, 'refresh-missing');
  const afterRetry = observed();
  [afterRetry.traffic[2].seq, afterRetry.traffic[3].seq] = [afterRetry.traffic[3].seq, afterRetry.traffic[2].seq];
  assertFails(afterRetry, 'refresh-missing');
  for (const status of [401, 403, 500, 503]) {
    const failed = observed();
    failed.traffic[2].status = status;
    assertFails(failed, 'refresh-failed');
  }
  const unreadable = observed();
  unreadable.traffic[2].captureError = true;
  assertFails(unreadable, 'refresh-unreadable-or-mismatched');
  const noGeneration = observed();
  noGeneration.traffic[2].generation = '';
  assertFails(noGeneration, 'refresh-unreadable-or-mismatched');
  const wrongRouteKey = observed();
  wrongRouteKey.traffic[2].routeKey = 'explorer';
  assertFails(wrongRouteKey, 'refresh-unreadable-or-mismatched');
  const wrongOrigin = observed();
  wrongOrigin.traffic[2].origin = 'http://evil.test';
  assertFails(wrongOrigin, 'refresh-unreadable-or-mismatched');
});

test('the retry must exist, be the same operation, succeed with 2xx, and use the refreshed proof', () => {
  const missing = observed();
  missing.traffic.pop();
  assertFails(missing, 'retry-missing');
  const differentBody = observed();
  differentBody.traffic[3].bodyHash = 'ffffffffffff';
  assertFails(differentBody, 'retry-missing');
  const differentUrl = observed();
  differentUrl.traffic[3].url = URL_EXPLORER;
  assertFails(differentUrl, 'retry-missing');
  const differentPage = observed();
  differentPage.traffic[3].pageId = 2;
  assertFails(differentPage, 'retry-missing');
  const getRequest = observed();
  getRequest.traffic[3].method = 'GET';
  assertFails(getRequest, 'retry-missing');
  for (const status of [302, 401, 404, 500, 503]) {
    const failed = observed();
    failed.traffic[3].status = status;
    assertFails(failed, 'retry-not-2xx');
  }
  const stillForbidden = observed();
  stillForbidden.traffic[3].status = 403;
  stillForbidden.traffic[3].csrfInvalidBody = true;
  const result = evaluateRecoveredCsrfRefreshes(stillForbidden);
  assert.deepEqual(result.acknowledged, []);
  assert.deepEqual(result.rejected.map((entry) => entry.reason), ['repeated-403', 'repeated-403']);
  const staleProof = observed();
  staleProof.traffic[3].proofRef = 'ref-old';
  assertFails(staleProof, 'retry-did-not-use-refreshed-proof');
  const unidentified = observed();
  unidentified.traffic[3].proofRef = '';
  assertFails(unidentified, 'capture-failed');
  const emptyBody = observed();
  emptyBody.traffic[1].bodyHash = '';
  assertFails(emptyBody, 'operation-not-identifiable');
});

test('the console error is the single exact 403 console event for that URL in the window', () => {
  // The exception covers only the matching console message; every other
  // console error remains unacknowledged and keeps failing the gate.
  const extra = observed();
  const unrelated = consoleError({ elapsedMs: 1050, text: 'TypeError: x is not a function', location: { url: `${ORIGIN}/app.js` } });
  extra.consoleErrors.push(unrelated);
  const withExtra = evaluateRecoveredCsrfRefreshes(extra);
  assert.equal(withExtra.acknowledged.length, 1);
  assert.deepEqual(withExtra.unacknowledgedConsoleErrors, [unrelated]);

  const otherStatusText = observed();
  const other500 = consoleError({ elapsedMs: 1040, text: 'Failed to load resource: the server responded with a status of 500 (Internal Server Error)' });
  otherStatusText.consoleErrors.push(other500);
  assert.deepEqual(evaluateRecoveredCsrfRefreshes(otherStatusText).unacknowledgedConsoleErrors, [other500]);

  const twice = observed();
  twice.consoleErrors.push(consoleError({ elapsedMs: 1040 }));
  assertFails(twice, 'console-error-count-2');

  const none = observed();
  none.consoleErrors = [];
  assertFails(none, 'console-error-count-0');

  const differentUrl = observed();
  differentUrl.consoleErrors = [consoleError({ location: { url: URL_EXPLORER } })];
  assertFails(differentUrl, 'console-error-count-0');

  const warning = observed();
  warning.consoleErrors = [consoleError({ type: 'warning' })];
  const warned = evaluateRecoveredCsrfRefreshes(warning);
  assert.deepEqual(warned.acknowledged, []);

  const afterRetry = observed();
  afterRetry.consoleErrors = [consoleError({ elapsedMs: 1104 })];
  assertFails(afterRetry, 'console-error-count-0');
  const earlyEdge = observed();
  earlyEdge.consoleErrors = [consoleError({ elapsedMs: 1000 - CONSOLE_LEAD_TOLERANCE_MS })];
  assert.equal(evaluateRecoveredCsrfRefreshes(earlyEdge).acknowledged.length, 1);
  const tooEarly = observed();
  tooEarly.consoleErrors = [consoleError({ elapsedMs: 1000 - CONSOLE_LEAD_TOLERANCE_MS - 1 })];
  assertFails(tooEarly, 'console-error-count-0');
});

test('a 403 on a different URL is not covered by an acknowledgement for another route', () => {
  const evidence = observed();
  const explorer403 = mutation({
    url: URL_EXPLORER, status: 403, csrfInvalidBody: true, elapsedMs: 1020, proofRef: 'ref-explorer', bodyHash: 'eeeeeeeeeeee', rpcId: '9',
  });
  evidence.traffic.splice(2, 0, explorer403);
  renumber(evidence.traffic);
  const explorerConsole = consoleError({ elapsedMs: 1020, location: { url: URL_EXPLORER } });
  evidence.consoleErrors.push(explorerConsole);
  const result = evaluateRecoveredCsrfRefreshes(evidence);
  assert.equal(result.acknowledged.length, 1);
  assert.equal(result.acknowledged[0].url, URL_DPU);
  assert.deepEqual(result.rejected.map((entry) => [entry.url, entry.reason]), [[URL_EXPLORER, 'retry-missing']]);
  assert.deepEqual(result.unacknowledgedConsoleErrors, [explorerConsole]);
});

test('independent recoveries, including a repeated identical body, are each acknowledged against their own console error', () => {
  const first = observed({ at: 1000, phase: 'reopen' });
  const second = observed({ at: 9000, phase: 'cleanup-document-deletion', oldGeneration: NEW_GENERATION, newGeneration: CLEANUP_GENERATION });
  // Same URL, same body and a proof the page still holds from before: the
  // identical operation is retried later and recovers again independently.
  const evidence = {
    traffic: [...first.traffic, ...second.traffic].map((entry, index) => ({ ...entry, seq: index + 1 })),
    consoleErrors: [...first.consoleErrors, ...second.consoleErrors],
  };
  const result = evaluateRecoveredCsrfRefreshes(evidence);
  assert.deepEqual(result.rejected, []);
  assert.deepEqual(result.unacknowledgedConsoleErrors, []);
  assert.deepEqual(result.acknowledged.map((entry) => [entry.phase, entry.rejectedGeneration, entry.refreshedGeneration]), [
    ['reopen', OLD_GENERATION, NEW_GENERATION],
    ['cleanup-document-deletion', NEW_GENERATION, CLEANUP_GENERATION],
  ]);
});

test('one console error can never account for two operations', () => {
  const evidence = observed();
  const secondTraffic = [
    mutation({ elapsedMs: 1005, status: 403, csrfInvalidBody: true, proofRef: 'ref-old', bodyHash: 'bbbbbbbbbbbb', rpcId: '16' }),
    proof({ elapsedMs: 1050, generation: NEW_GENERATION, proofRef: 'ref-new' }),
    mutation({ elapsedMs: 1100, status: 200, proofRef: 'ref-new', bodyHash: 'bbbbbbbbbbbb', rpcId: '16' }),
  ];
  evidence.traffic.splice(3, 0, ...secondTraffic);
  renumber(evidence.traffic);
  const result = evaluateRecoveredCsrfRefreshes(evidence);
  assert.deepEqual(result.acknowledged, []);
  assert.deepEqual(result.rejected.map((entry) => entry.reason), [
    'console-error-claimed-by-multiple-operations', 'console-error-claimed-by-multiple-operations',
  ]);
  assert.equal(result.unacknowledgedConsoleErrors.length, 1);
});

// ---------------------------------------------------------------------------
// Replay of the live gate diagnostics through the real recorder and assertions.
// ---------------------------------------------------------------------------

function fakeResponse({ method = 'GET', url, status = 200, postData = null, requestHeaders = {}, body = '' }) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    url: () => url,
    status: () => status,
    text: async () => text,
    json: async () => JSON.parse(text),
    request: () => ({
      method: () => method,
      postData: () => postData,
      headerValue: async (name) => requestHeaders[name] ?? null,
      frame: () => null,
    }),
  };
}

const RPC_BODY = '{"jsonrpc":"2.0","id":"15","method":"tools/call","params":{"name":"dpu_confidential_list","arguments":{"scope":"my-space"}}}';
const CSRF = 'x-ploinky-browser-csrf-token';

function proofBody(generation, routeKey = 'dpuAgent') {
  return { ok: true, browserMutation: { origin: ORIGIN, csrfToken: `synthetic-proof-${generation.slice(-6)}`, generation, hostRouteKey: 'control', routeKey } };
}

// Event shapes copied from the live diagnostics JSON (phases reopen and
// cleanup-document-deletion, elapsedMs 166690 and 326639). Proof, body and
// generation values are the trace-derived public identifiers.
function replayLiveGate({ extraConsoleError = false } = {}) {
  const context = new EventEmitter();
  let elapsed = 0;
  const diagnostics = createOnlyOfficeGateDiagnostics(context, { now: () => elapsed });
  const liveConsole = {
    type: () => 'error',
    text: () => RECOVERED_CSRF_CONSOLE_TEXT,
    location: () => ({ url: URL_DPU, lineNumber: 0, columnNumber: 0 }),
  };
  const cycle = (phase, forbiddenAt, oldGeneration, newGeneration) => {
    diagnostics.setPhase(phase);
    elapsed = forbiddenAt;
    context.emit('response', fakeResponse({
      method: 'POST', url: URL_DPU, status: 403, postData: RPC_BODY, requestHeaders: { [CSRF]: `synthetic-proof-${oldGeneration.slice(-6)}` }, body: { error: 'browser_csrf_invalid' },
    }));
    context.emit('console', liveConsole);
    elapsed = forbiddenAt + 29;
    context.emit('response', fakeResponse({ url: `${ORIGIN}/auth/token?mutationRoute=dpuAgent`, body: proofBody(newGeneration) }));
    elapsed = forbiddenAt + 103;
    context.emit('response', fakeResponse({
      method: 'POST', url: URL_DPU, status: 200, postData: RPC_BODY, requestHeaders: { [CSRF]: `synthetic-proof-${newGeneration.slice(-6)}` }, body: { jsonrpc: '2.0', id: '15', result: {} },
    }));
  };
  // The page fetched its dpuAgent proofs earlier in the run.
  elapsed = 20_000;
  context.emit('response', fakeResponse({ url: `${ORIGIN}/auth/token?mutationRoute=dpuAgent`, body: proofBody(OLD_GENERATION) }));
  cycle('reopen', 166_690, OLD_GENERATION, NEW_GENERATION);
  elapsed = 170_000;
  cycle('cleanup-document-deletion', 326_639, NEW_GENERATION, CLEANUP_GENERATION);
  if (extraConsoleError) {
    elapsed = 326_700;
    context.emit('console', {
      type: () => 'error',
      text: () => 'WebSocket connection to wss://localhost failed',
      location: () => ({ url: `${ORIGIN}/ws`, lineNumber: 0, columnNumber: 0 }),
    });
  }
  return diagnostics;
}

test('the live OnlyOffice diagnostics shapes pass the zero-error assertion with both recoveries recorded', async () => {
  const diagnostics = replayLiveGate();
  await diagnostics.settle();
  const evidence = diagnostics.snapshot();
  assert.equal(evidence.consoleErrors.length, 2, 'raw console errors stay listed');
  assert.deepEqual(evidence.unacknowledgedConsoleErrors, []);
  assert.equal(evidence.ignoredBrowserErrors, 2);
  assert.deepEqual(evidence.rejectedForbiddenMutations, []);
  assert.deepEqual(evidence.acknowledgedRecoveredCsrf.map((entry) => [
    entry.phase, entry.url, entry.rejectedGeneration, entry.refreshedGeneration, entry.forbiddenStatus, entry.refreshStatus, entry.retryStatus, entry.refreshLatencyMs, entry.retryLatencyMs,
  ]), [
    ['reopen', URL_DPU, OLD_GENERATION, NEW_GENERATION, 403, 200, 200, 29, 103],
    ['cleanup-document-deletion', URL_DPU, NEW_GENERATION, CLEANUP_GENERATION, 403, 200, 200, 29, 103],
  ]);
  assert.doesNotThrow(() => diagnostics.assertNoErrors());
  const serialized = JSON.stringify(evidence);
  assert.equal(serialized.includes('synthetic-proof'), false, 'no proof value may reach the evidence');
  assert.equal(serialized.includes('dpu_confidential_list'), false, 'no request body may reach the evidence');
  assert.equal(serialized.includes('proofRef'), false, 'not even a proof digest is saved');
  assert(evidence.mutationProofTraffic.length >= 5);
});

test('the same live diagnostics shapes still fail with one extra console error', async () => {
  const diagnostics = replayLiveGate({ extraConsoleError: true });
  await diagnostics.settle();
  const evidence = diagnostics.snapshot();
  assert.equal(evidence.acknowledgedRecoveredCsrf.length, 2);
  assert.equal(evidence.unacknowledgedConsoleErrors.length, 1);
  assert.match(evidence.unacknowledgedConsoleErrors[0].text, /WebSocket connection/);
  assert.throws(() => diagnostics.assertNoErrors(), /zero console or page errors/);
});

test('the replayed live shapes fail when the refreshed generation is unchanged', async () => {
  const context = new EventEmitter();
  let elapsed = 0;
  const diagnostics = createOnlyOfficeGateDiagnostics(context, { now: () => elapsed });
  const send = (response) => context.emit('response', response);
  const proofHeader = { [CSRF]: `synthetic-proof-${OLD_GENERATION.slice(-6)}` };
  send(fakeResponse({ url: `${ORIGIN}/auth/token?mutationRoute=dpuAgent`, body: proofBody(OLD_GENERATION) }));
  elapsed = 100;
  send(fakeResponse({ method: 'POST', url: URL_DPU, status: 403, postData: RPC_BODY, requestHeaders: proofHeader, body: { error: 'browser_csrf_invalid' } }));
  context.emit('console', { type: () => 'error', text: () => RECOVERED_CSRF_CONSOLE_TEXT, location: () => ({ url: URL_DPU }) });
  send(fakeResponse({ url: `${ORIGIN}/auth/token?mutationRoute=dpuAgent`, body: proofBody(OLD_GENERATION) }));
  send(fakeResponse({ method: 'POST', url: URL_DPU, status: 200, postData: RPC_BODY, requestHeaders: proofHeader, body: {} }));
  await diagnostics.settle();
  const evidence = diagnostics.snapshot();
  assert.deepEqual(evidence.rejectedForbiddenMutations.map((entry) => entry.reason), ['generation-unchanged']);
  assert.throws(() => diagnostics.assertNoErrors(), /zero console or page errors/);
});

// ---------------------------------------------------------------------------
// Real Chromium: proves the capture points (console text/location, request
// header, post data, query string, response bodies) behave as assumed.
// ---------------------------------------------------------------------------

async function runBrowserRecovery({ refreshGeneration, retryStatus = 200, forbiddenBody = { error: 'browser_csrf_invalid' } }) {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    const diagnostics = createOnlyOfficeGateDiagnostics(context);
    let generation = 'sha256:' + '1'.repeat(64);
    let served = 0;
    let posts = 0;
    await context.route('http://onlyoffice-diagnostic.test/**', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const json = (status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
      if (url.pathname === '/auth/token') {
        served += 1;
        const current = served === 1 ? generation : refreshGeneration || generation;
        return json(200, {
          ok: true,
          browserMutation: { origin: 'http://onlyoffice-diagnostic.test', csrfToken: `proof-${current.slice(7, 15)}`, generation: current, routeKey: url.searchParams.get('mutationRoute') },
        });
      }
      if (url.pathname === '/dpuAgent/mcp') {
        posts += 1;
        return posts === 1 ? json(403, forbiddenBody) : json(retryStatus, { jsonrpc: '2.0', id: '1', result: {} });
      }
      return route.fulfill({ contentType: 'text/html', body: '<html></html>' });
    });
    const page = await context.newPage();
    await page.goto('http://onlyoffice-diagnostic.test/', { waitUntil: 'load' });
    diagnostics.setPhase('reopen');
    await page.evaluate(async () => {
      const proofFor = async () => (await (await fetch('/auth/token?mutationRoute=dpuAgent', { credentials: 'include' })).json()).browserMutation.csrfToken;
      const send = (csrf) => fetch('/dpuAgent/mcp', {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-ploinky-browser-csrf-token': csrf }, body: '{"jsonrpc":"2.0","id":"1","method":"tools/call"}',
      });
      let csrf = await proofFor();
      if ((await send(csrf)).status === 403) {
        csrf = await proofFor();
        await send(csrf);
      }
    });
    await diagnostics.settle();
    const snapshot = diagnostics.snapshot();
    return { diagnostics, snapshot };
  } finally {
    await browser.close();
  }
}

test('real Chromium: a 403 csrf rejection recovered through a new generation is acknowledged and nothing else', { timeout: 30_000 }, async () => {
  // The first proof served is generation 1111... (presented, then rejected);
  // the refresh is served a new generation.
  const { diagnostics, snapshot } = await runBrowserRecovery({ refreshGeneration: 'sha256:' + '2'.repeat(64) });
  assert.equal(snapshot.consoleErrors.length, 1);
  assert.equal(snapshot.consoleErrors[0].text, RECOVERED_CSRF_CONSOLE_TEXT);
  assert.equal(snapshot.consoleErrors[0].location.url, 'http://onlyoffice-diagnostic.test/dpuAgent/mcp');
  assert.deepEqual(snapshot.rejectedForbiddenMutations, []);
  assert.equal(snapshot.acknowledgedRecoveredCsrf.length, 1);
  assert.equal(snapshot.acknowledgedRecoveredCsrf[0].rejectedGeneration, 'sha256:' + '1'.repeat(64));
  assert.equal(snapshot.acknowledgedRecoveredCsrf[0].refreshedGeneration, 'sha256:' + '2'.repeat(64));
  assert.equal(snapshot.acknowledgedRecoveredCsrf[0].rpcMethod, 'tools/call');
  assert.doesNotThrow(() => diagnostics.assertNoErrors());
  assert.equal(JSON.stringify(snapshot).includes('proof-11111111'), false);
});

test('real Chromium: the same recovery with an unchanged generation, a failed retry, or another body still fails', { timeout: 60_000 }, async () => {
  const unchanged = await runBrowserRecovery({ refreshGeneration: 'sha256:' + '1'.repeat(64) });
  assert.equal(unchanged.snapshot.acknowledgedRecoveredCsrf.length, 0);
  assert.deepEqual(unchanged.snapshot.rejectedForbiddenMutations.map((entry) => entry.reason), ['generation-unchanged']);
  assert.throws(() => unchanged.diagnostics.assertNoErrors(), /zero console or page errors/);
  const failedRetry = await runBrowserRecovery({ refreshGeneration: 'sha256:' + '2'.repeat(64), retryStatus: 500 });
  assert.equal(failedRetry.snapshot.acknowledgedRecoveredCsrf.length, 0);
  assert.deepEqual(failedRetry.snapshot.rejectedForbiddenMutations.map((entry) => entry.reason), ['retry-not-2xx']);
  assert.throws(() => failedRetry.diagnostics.assertNoErrors(), /zero console or page errors/);
  const otherBody = await runBrowserRecovery({ refreshGeneration: 'sha256:' + '2'.repeat(64), forbiddenBody: { error: 'forbidden' } });
  assert.equal(otherBody.snapshot.acknowledgedRecoveredCsrf.length, 0);
  assert.deepEqual(otherBody.snapshot.rejectedForbiddenMutations.map((entry) => entry.reason), ['forbidden-body-not-browser-csrf-invalid']);
  assert.throws(() => otherBody.diagnostics.assertNoErrors(), /zero console or page errors/);
});
