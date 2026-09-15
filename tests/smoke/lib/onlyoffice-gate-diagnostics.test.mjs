import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { chromium } from '@playwright/test';

import {
  attachOnlyOfficeDocumentScreenshot,
  createOnlyOfficeGateDiagnostics,
  finalizeOnlyOfficeGate,
} from './onlyoffice-gate-diagnostics.mjs';
import { createReleaseGateFailureCollector } from './release-gate-failures.mjs';

const execFileAsync = promisify(execFile);

test('OnlyOffice timing evidence distinguishes both restarts from deletion and final evidence', () => {
  const context = new EventEmitter();
  let elapsed = 0;
  const diagnostics = createOnlyOfficeGateDiagnostics(context, { now: () => elapsed });
  elapsed = 17_737;
  diagnostics.setPhase('targeted-restart');
  elapsed += 152_519;
  diagnostics.setPhase('reopen');
  elapsed = 185_667;
  diagnostics.setPhase('cleanup-targeted-restart');
  elapsed += 152_519;
  diagnostics.setPhase('cleanup-document-deletion');
  elapsed += 1000;
  diagnostics.setPhase('evidence');
  const timings = diagnostics.snapshot().phaseTimings;
  assert.deepEqual(timings.filter((entry) => entry.phase.endsWith('targeted-restart')), [
    { phase: 'targeted-restart', startedAfterMs: 17_737, elapsedMs: 152_519 },
    { phase: 'cleanup-targeted-restart', startedAfterMs: 185_667, elapsedMs: 152_519 },
  ]);
  assert.equal(timings.find((entry) => entry.phase === 'cleanup-document-deletion').elapsedMs, 1000);
  assert.equal(timings.at(-1).phase, 'evidence');
  assert.equal(timings.at(-1).elapsedMs, 0);
});

function testEvidence(root, { rejectAttachment = '' } = {}) {
  const attachments = [];
  return {
    attachments,
    outputPath: (name) => path.join(root, name),
    async attach(name, options) {
      if (name === rejectAttachment) throw new Error('fixture attachment failure');
      attachments.push({ name, ...options });
    },
  };
}

test('OnlyOffice diagnostics fail on unfiltered first-navigation, iframe, popup, restart, and cleanup errors', { timeout: 30_000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'onlyoffice-diagnostics-errors-'));
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    const diagnostics = createOnlyOfficeGateDiagnostics(context);
    const collector = createReleaseGateFailureCollector({ env: {} });
    const testInfo = testEvidence(root, { rejectAttachment: 'onlyoffice-browser-diagnostics.json' });
    await context.route('http://onlyoffice-diagnostic.test/**', (route) => {
      const pathname = new URL(route.request().url()).pathname;
      const html = pathname === '/frame'
        ? '<script>console.error("source map failure in iframe"); throw new Error("iframe uncaught failure");</script>'
        : pathname === '/popup'
          ? '<script>console.error("popup first-navigation failure");</script>'
          : '<script>console.error("ResizeObserver loop limit exceeded");</script><iframe src="/frame"></iframe>';
      return route.fulfill({ contentType: 'text/html', body: html });
    });
    const page = await context.newPage();
    await page.goto('http://onlyoffice-diagnostic.test/', { waitUntil: 'load' });
    const popupPromise = context.waitForEvent('page');
    await page.evaluate(() => window.open('/popup'));
    const popup = await popupPromise;
    await popup.waitForLoadState('load');
    diagnostics.setPhase('targeted-restart');
    await page.evaluate(() => console.error('WebSocket connection failed: net::ERR_FAILED'));
    let cleanupCalled = false;
    await finalizeOnlyOfficeGate({
      context,
      testInfo,
      diagnostics,
      failureCollector: collector,
      traceStarted: false,
      cleanupTarget: { documentPath: '/Confidential/My Space/fixture.docx' },
      cleanup: async () => {
        cleanupCalled = true;
        await Promise.all([
          page.waitForEvent('pageerror'),
          page.evaluate(() => {
            console.error('password=fixture-dynamic-password');
            setTimeout(() => { throw new Error('cleanup uncaught failure'); }, 0);
          }),
        ]);
        throw new Error('fixture cleanup failure');
      },
    });
    assert.equal(cleanupCalled, true);
    const snapshot = diagnostics.snapshot();
    assert.equal(snapshot.contextClosed, true);
    assert.equal(snapshot.ignoredBrowserErrors, 0);
    assert.equal(snapshot.consoleErrors.length, 5);
    assert.equal(snapshot.pageErrors.length, 2);
    assert(snapshot.consoleErrors.some((event) => event.phase === 'targeted-restart'));
    assert(snapshot.consoleErrors.some((event) => event.phase === 'cleanup'));
    assert.equal(JSON.stringify(snapshot).includes('fixture-dynamic-password'), false);
    assert.throws(() => diagnostics.assertNoErrors(), /zero console or page errors/);
    const cleanupEvidence = JSON.parse(await fs.readFile(testInfo.outputPath('onlyoffice-cleanup-evidence.json'), 'utf8'));
    assert.equal(cleanupEvidence.attempted, true);
    assert.equal(cleanupEvidence.deleted, false);
    assert.equal(cleanupEvidence.error, 'fixture cleanup failure');
    assert.equal(collector.failures.length, 4, 'cleanup, missing trace, diagnostic attachment, and browser errors must all remain visible');
    assert.throws(() => collector.throwIfAny({ primaryError: new Error('primary assertion failure') }), (error) => (
      error instanceof AggregateError && error.errors.length === 5
        && /primary assertion failure/.test(error.message)
        && /fixture cleanup failure/.test(error.message)
        && /fixture attachment failure/.test(error.message)
        && /zero console or page errors/.test(error.message)
    ));
  } finally {
    await browser.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('OnlyOffice success captures its document viewport, redacted trace, cleanup and diagnostics through context close', { timeout: 30_000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'onlyoffice-diagnostics-success-'));
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    const diagnostics = createOnlyOfficeGateDiagnostics(context);
    const collector = createReleaseGateFailureCollector({ env: {} });
    const testInfo = testEvidence(root);
    await context.tracing.start({ screenshots: false, snapshots: true, sources: true });
    await context.route('http://onlyoffice-diagnostic.test/**', (route) => route.fulfill({
      contentType: 'text/html',
      body: new URL(route.request().url()).pathname === '/frame'
        ? '<canvas id="id_viewer_overlay" width="400" height="200"></canvas><script>const ctx=document.querySelector("canvas").getContext("2d");ctx.fillText("OnlyOffice synthetic document",20,40);</script>'
        : '<input name="username"><input name="password" type="password"><iframe src="/frame"></iframe>',
    }));
    const page = await context.newPage();
    await page.goto('http://onlyoffice-diagnostic.test/', { waitUntil: 'load' });
    await page.locator('input[name="username"]').fill('fixture-private-account@example.test');
    await page.locator('input[name="password"]').fill('fixture-private-password');
    const frame = page.frames().find((candidate) => candidate.url().endsWith('/frame'));
    await attachOnlyOfficeDocumentScreenshot(frame, testInfo, 'onlyoffice-success');
    const screenshot = await fs.readFile(testInfo.outputPath('onlyoffice-success.png'));
    assert.equal(screenshot.subarray(1, 4).toString(), 'PNG');
    assert.equal(screenshot.readUInt32BE(16), 400, 'the screenshot must crop to the document canvas');
    assert.equal(screenshot.readUInt32BE(20), 200);
    await finalizeOnlyOfficeGate({
      context,
      testInfo,
      diagnostics,
      failureCollector: collector,
      traceStarted: true,
      cleanup: async () => {
        await page.evaluate(() => console.log('cleanup-observed'));
        return { deleted: true, objectId: 'synthetic-object' };
      },
    });
    collector.throwIfAny();
    assert.deepEqual(testInfo.attachments.map((entry) => entry.name), [
      'onlyoffice-success', 'onlyoffice-cleanup-evidence.json', 'onlyoffice-redacted-trace', 'onlyoffice-browser-diagnostics.json',
    ]);
    const evidence = JSON.parse(await fs.readFile(testInfo.outputPath('onlyoffice-browser-diagnostics.json'), 'utf8'));
    assert.equal(evidence.contextClosed, true);
    assert.deepEqual(evidence.consoleErrors, []);
    assert.deepEqual(evidence.pageErrors, []);
    assert(evidence.events.some((event) => event.phase === 'cleanup' && event.text === 'cleanup-observed'));
    assert.equal(evidence.events.at(-1).kind, 'contextclosed');
    const { stdout: trace } = await execFileAsync('/usr/bin/unzip', ['-p', testInfo.outputPath('onlyoffice.trace.zip')], { encoding: 'buffer', maxBuffer: 10 * 1024 * 1024 });
    assert.equal(trace.includes(Buffer.from('fixture-private-account@example.test')), false);
    assert.equal(trace.includes(Buffer.from('fixture-private-password')), false);
  } finally {
    await browser.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
