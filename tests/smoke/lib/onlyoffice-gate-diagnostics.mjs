import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { findTraceCredentialResidue, redactTraceText, stopAndAttachRedactedTrace } from './redacted-trace.mjs';
import { findSecretLeaks } from './security.mjs';

function safeUrl(value) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return '';
  }
}

function safeJson(value) {
  const payload = redactTraceText(JSON.stringify(value, null, 2), {
    inputActionValues: [
      process.env.SMOKE_USERNAME,
      process.env.SMOKE_PASSWORD,
      process.env.SMOKE_SECONDARY_USERNAME,
      process.env.SMOKE_SECONDARY_PASSWORD,
    ].filter(Boolean),
  });
  assert.deepEqual(findSecretLeaks(payload), [], 'OnlyOffice evidence must not contain configured secrets.');
  assert.deepEqual(findTraceCredentialResidue(payload), [], 'OnlyOffice evidence must not contain credential-shaped values.');
  return payload;
}

async function attachJson(testInfo, name, value) {
  const outputPath = testInfo.outputPath(name);
  const payload = safeJson(value);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, payload);
  await testInfo.attach(name, { path: outputPath, contentType: 'application/json' });
}

export function createOnlyOfficeGateDiagnostics(context, { now = () => performance.now() } = {}) {
  const events = [];
  const phaseTimings = [];
  const startedAt = now();
  let phaseStartedAt = startedAt;
  let phase = 'initialization';
  let contextClosed = false;
  const record = (event) => events.push({ phase, elapsedMs: Math.round(now() - startedAt), ...event });
  // Context events cover the first navigation, every iframe, and any new page.
  // Lifecycle disruption is evidence, never a reason to filter browser errors.
  context.on('console', (message) => record({
    kind: 'console',
    type: message.type(),
    text: message.text(),
    location: { ...message.location(), url: safeUrl(message.location().url) },
  }));
  context.on('weberror', (webError) => record({
    kind: 'pageerror',
    type: 'error',
    text: webError.error().stack || webError.error().message,
    url: safeUrl(webError.page()?.url()),
  }));
  context.on('requestfailed', (request) => record({
    kind: 'requestfailed',
    url: safeUrl(request.url()),
    method: request.method(),
    failure: request.failure()?.errorText || '',
  }));
  context.on('response', (response) => {
    if (response.status() >= 400) record({
      kind: 'response',
      url: safeUrl(response.url()),
      method: response.request().method(),
      status: response.status(),
    });
  });
  context.on('close', () => {
    contextClosed = true;
    record({ kind: 'contextclosed' });
  });

  function snapshot() {
    return JSON.parse(safeJson({
      contextClosed,
      phaseTimings: [...phaseTimings, {
        phase,
        startedAfterMs: Math.round(phaseStartedAt - startedAt),
        elapsedMs: Math.round(now() - phaseStartedAt),
      }],
      ignoredBrowserErrors: 0,
      consoleErrors: events.filter((event) => event.kind === 'console' && event.type === 'error'),
      pageErrors: events.filter((event) => event.kind === 'pageerror'),
      events,
    }));
  }

  return Object.freeze({
    setPhase(value) {
      const changedAt = now();
      phaseTimings.push({
        phase,
        startedAfterMs: Math.round(phaseStartedAt - startedAt),
        elapsedMs: Math.round(changedAt - phaseStartedAt),
      });
      phase = String(value);
      phaseStartedAt = changedAt;
    },
    snapshot,
    assertNoErrors() {
      const evidence = snapshot();
      assert.deepEqual(
        [...evidence.consoleErrors, ...evidence.pageErrors],
        [],
        'OnlyOffice requires zero console or page errors, including targeted restart and cleanup.',
      );
    },
    async attach(testInfo) {
      await attachJson(testInfo, 'onlyoffice-browser-diagnostics.json', snapshot());
    },
  });
}

export async function attachOnlyOfficeDocumentScreenshot(editorFrame, testInfo, name) {
  // This viewport contains only the synthetic document, excluding account UI.
  const outputPath = testInfo.outputPath(`${name}.png`);
  await editorFrame.locator('#id_viewer_overlay').screenshot({ path: outputPath });
  await testInfo.attach(name, { path: outputPath, contentType: 'image/png' });
}

export async function finalizeOnlyOfficeGate({
  context,
  testInfo,
  diagnostics,
  failureCollector,
  cleanup,
  cleanupTarget = {},
  traceStarted,
}) {
  diagnostics.setPhase('cleanup');
  let cleanupEvidence = { ...cleanupTarget, attempted: true, deleted: false };
  await failureCollector.required('Confidential document cleanup', async () => {
    try {
      cleanupEvidence = { ...cleanupEvidence, ...await cleanup() };
      assert.equal(cleanupEvidence.deleted, true, 'The Confidential smoke document must be deleted.');
    } catch (error) {
      cleanupEvidence.error = String(error?.message || error);
      throw error;
    }
  });
  await failureCollector.required('OnlyOffice cleanup evidence', () => (
    attachJson(testInfo, 'onlyoffice-cleanup-evidence.json', cleanupEvidence)
  ));
  diagnostics.setPhase('evidence');
  if (traceStarted) {
    await failureCollector.required('OnlyOffice redacted trace', () => (
      stopAndAttachRedactedTrace(context, testInfo, 'onlyoffice')
    ));
  } else {
    failureCollector.add('OnlyOffice redacted trace', new Error('Tracing did not start.'));
  }
  diagnostics.setPhase('context-close');
  await failureCollector.required('OnlyOffice browser context close', () => context.close());
  await failureCollector.required('OnlyOffice browser diagnostics', () => diagnostics.attach(testInfo));
  await failureCollector.required('OnlyOffice zero browser errors', () => diagnostics.assertNoErrors());
}
