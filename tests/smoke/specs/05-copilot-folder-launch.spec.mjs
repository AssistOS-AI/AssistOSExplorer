import crypto from 'node:crypto';

import { test, expect } from '../lib/fixtures.mjs';
import { smokeConfig } from '../lib/config.mjs';
import {
  createDirectory,
  deleteDirectoryIfPresent,
  openCopilotForDirectory,
} from '../lib/copilot.mjs';
import { openExplorer } from '../lib/explorer.mjs';
import { stopAndAttachRedactedTrace } from '../lib/redacted-trace.mjs';
import { setComposer, waitForWebchatIdle } from '../lib/webchat.mjs';
import { createCopilotDiagnostics } from '../lib/copilot-terminal-diagnostics.mjs';
import { withFailureArtifact } from '../lib/readiness-diagnostics.mjs';

const BOT_MESSAGE = '#chatList > .wa-message.in:not(.wa-typing):not(.wa-task-item) .wa-message-bubble';
const STARTUP_FAILURE = /\[input error\]|bwrap:|Agent process exited repeatedly|open \/proc\/\d+\/ns/i;
const COMPLETION_FAILURE = /\[input error\]|\[error\]|\b421\b|UNKNOWN_HOST|Misdirected Request|tier[_\s-]+exhausted|All models in tier exhausted|provider\s+(?:error|failure)|API\s+(?:error|failure)|startup\s+(?:error|failure)/i;

async function assistantMessages(page) {
  return page.locator(BOT_MESSAGE).evaluateAll((messages) => messages.map((message, index) => ({
    id: message.dataset.messageId || `baseline-index-${index}`,
    text: (message.dataset.fullText || message.textContent || '').trim(),
  })));
}

async function waitForStableEdge(page, consecutiveChecks = 10) {
  let activeChecks = 0;
  await expect.poll(
    async () => {
      const response = await page.request.get('/auth/login?agent=explorer', {
        failOnStatusCode: false,
      }).catch(() => null);
      if (!response || response.status() >= 500) {
        activeChecks = 0;
        return activeChecks;
      }
      activeChecks += 1;
      return activeChecks;
    },
    {
      message: 'Explorer edge generation should remain continuously active',
      timeout: Math.max(smokeConfig.timeouts.navigation, 90_000),
      intervals: [500],
    },
  ).toBeGreaterThanOrEqual(consecutiveChecks);
}

test.describe('Copilot launch from Explorer', () => {
  test('opens a working Copilot from a newly created folder', async ({ page }, testInfo) => {
    test.setTimeout(Math.max(
      smokeConfig.timeouts.test,
      smokeConfig.timeouts.relay + 120_000,
    ));
    const directoryName = `copilot-smoke-${smokeConfig.runId}`;
    const directoryPath = `/${directoryName}`;
    let releaseEvidence;
    expect(() => {
      releaseEvidence = JSON.parse(String(process.env.SMOKE_COPILOT_RELEASE_EVIDENCE || ''));
    }).not.toThrow();
    expect(releaseEvidence?.imageDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(releaseEvidence?.liveBox?.box?.imageId).toBe(releaseEvidence.imageDigest);
    expect(releaseEvidence?.applicationBaseURL).toBe(smokeConfig.baseURL);
    expect(releaseEvidence?.liveBox?.box?.baseURL).toBe(releaseEvidence?.boxBaseURL);
    const networkEvidence = [];
    const requestFailures = [];
    const successfulRequests = new WeakSet();
    const browserErrors = [];
    const observedPages = new Set();
    const captureConsoleError = (message) => {
      if (message.type() === 'error') browserErrors.push(`console: ${message.text()}`);
    };
    const capturePageError = (error) => browserErrors.push(`page: ${error.message}`);
    const attachBrowserErrorListeners = (candidate) => {
      if (observedPages.has(candidate)) return;
      observedPages.add(candidate);
      candidate.on('console', captureConsoleError);
      candidate.on('pageerror', capturePageError);
    };
    const captureInputRequest = (request) => {
      if (new URL(request.url()).pathname !== '/webchat/input') return;
      networkEvidence.push({
        kind: 'request',
        method: request.method(),
        url: request.url(),
        body: request.postData() || '',
      });
    };
    const captureInputResponse = (response) => {
      const pathname = new URL(response.url()).pathname;
      if (pathname !== '/webchat/input'
        && !pathname.startsWith('/base-agent-additional-server/')) return;
      if (response.status() >= 200 && response.status() < 300) {
        successfulRequests.add(response.request());
      }
      networkEvidence.push({
        kind: 'response',
        status: response.status(),
        url: response.url(),
        // A successful WebChat input is deliberately a bodyless 204. Do not ask
        // Chromium/Playwright to read a body that cannot exist: doing so can
        // surface a synthetic net::ERR_ABORTED after the 204 response event.
        body: response.status() === 204 ? '' : response.text().catch(() => ''),
      });
    };
    const captureRequestFailure = (request) => {
      const pathname = new URL(request.url()).pathname;
      if (pathname !== '/webchat/input'
        && !pathname.startsWith('/base-agent-additional-server/')) return;
      requestFailures.push({
        request,
        url: request.url(),
        error: request.failure()?.errorText || 'request failed',
      });
    };
    let copilotPage = null;

    await waitForStableEdge(page);
    await openExplorer(page);
    await expect(page.locator('#toolbarMenuButton')).toBeEnabled();
    await createDirectory(page, directoryName, directoryPath);
    page.context().on('request', captureInputRequest);
    page.context().on('response', captureInputResponse);
    page.context().on('requestfailed', captureRequestFailure);
    page.context().on('page', attachBrowserErrorListeners);

    await page.context().tracing.start({ screenshots: true, snapshots: true, sources: true });
    let traceStarted = true;
    const terminalDiagnostics = createCopilotDiagnostics();
    try {
      await withFailureArtifact(async () => {
      copilotPage = await openCopilotForDirectory(page, directoryPath);
      attachBrowserErrorListeners(copilotPage);

      await expect(copilotPage.locator('#cmd')).toBeEditable({
        timeout: smokeConfig.timeouts.navigation,
      });
      await expect(copilotPage.locator('#send')).toBeVisible();
      terminalDiagnostics.observe(await copilotPage.locator(BOT_MESSAGE).allTextContents());
      await expect(copilotPage.locator('#chatList')).not.toContainText(STARTUP_FAILURE);

      await waitForWebchatIdle(copilotPage);
      const baseline = await assistantMessages(copilotPage);
      const baselineIds = new Set(baseline.map((message) => message.id));
      const correlation = crypto.randomUUID();
      const completionToken = `COPILOT_CHAT_OK_${correlation}`;
      const prompt = `Reply with exactly this token and no Markdown: ${completionToken}`;

      await setComposer(copilotPage, prompt);
      await copilotPage.locator('#send').click();
      terminalDiagnostics.submitted();

      let lastNewMessage = '';
      let stableChecks = 0;
      const completionDeadline = Date.now() + smokeConfig.timeouts.relay;
      while (Date.now() < completionDeadline && stableChecks < 3) {
        const terminalResponse = networkEvidence.find((entry) => (
          entry.kind === 'response'
          && new URL(entry.url).pathname.startsWith('/base-agent-additional-server/')
          && entry.status >= 400
        ));
        if (terminalResponse) {
          throw new Error(`Copilot Router request failed with HTTP ${terminalResponse.status}: ${terminalResponse.url}`);
        }
        const messages = await assistantMessages(copilotPage);
        terminalDiagnostics.observe(messages.map(message => message.text));
        const created = messages.filter((message, index) => (
          !baselineIds.has(message.id) && index >= baseline.length && message.text
        ));
        const candidate = created.at(-1)?.text || '';
        if (candidate && COMPLETION_FAILURE.test(candidate)) {
          throw new Error(`Copilot returned a terminal completion failure: ${candidate}`);
        }
        if (!candidate || !candidate.includes(completionToken)) {
          lastNewMessage = candidate;
          stableChecks = 0;
        } else if (candidate === lastNewMessage) {
          stableChecks += 1;
        } else {
          lastNewMessage = candidate;
          stableChecks = 1;
        }
        if (stableChecks < 3) await copilotPage.waitForTimeout(250);
      }
      expect(
        stableChecks,
        `Copilot should produce a stable ordinary-chat completion containing ${completionToken}`,
      ).toBeGreaterThanOrEqual(3);
      await waitForWebchatIdle(copilotPage);
      terminalDiagnostics.replied();

      const completed = (await assistantMessages(copilotPage)).filter((message, index) => (
        !baselineIds.has(message.id) && index >= baseline.length && message.text
      ));
      expect(completed.length).toBeGreaterThan(0);
      expect(completed.at(-1).text).toContain(completionToken);
      expect(completed.at(-1).text).not.toMatch(COMPLETION_FAILURE);
      const resolvedNetworkEvidence = await Promise.all(networkEvidence.map(async (entry) => ({
        ...entry,
        body: entry.body instanceof Promise ? await entry.body : entry.body,
      })));
      const correlatedInputs = resolvedNetworkEvidence.filter((entry) => (
        entry.kind === 'request'
        && new URL(entry.url).pathname === '/webchat/input'
        && entry.body.includes(correlation)
      ));
      expect(correlatedInputs, JSON.stringify(resolvedNetworkEvidence)).toHaveLength(1);
      expect(correlatedInputs[0].method).toBe('POST');
      const inputResponses = resolvedNetworkEvidence.filter((entry) => (
        entry.kind === 'response' && new URL(entry.url).pathname === '/webchat/input'
      ));
      expect(inputResponses.length).toBeGreaterThan(0);
      expect(
        inputResponses.every((entry) => entry.status >= 200 && entry.status < 300),
        `Copilot network evidence: ${JSON.stringify(resolvedNetworkEvidence)}`,
      ).toBe(true);
      const routerResponses = resolvedNetworkEvidence.filter((entry) => (
        entry.kind === 'response'
        && new URL(entry.url).pathname.startsWith('/base-agent-additional-server/')
      ));
      expect(
        routerResponses.every((entry) => entry.status >= 200 && entry.status < 300),
        `Copilot Router response evidence: ${JSON.stringify(routerResponses)}`,
      ).toBe(true);
      expect(
        resolvedNetworkEvidence.map((entry) => `${entry.status || ''} ${entry.body || ''}`).join('\n'),
      ).not.toMatch(COMPLETION_FAILURE);
      const terminalRequestFailures = requestFailures
        .filter(({ request, error }) => !(
          error === 'net::ERR_ABORTED' && successfulRequests.has(request)
        ))
        .map(({ url, error }) => ({ url, error }));
      expect(
        terminalRequestFailures,
        JSON.stringify(terminalRequestFailures),
      ).toHaveLength(0);
      expect(browserErrors, JSON.stringify(browserErrors)).toHaveLength(0);
      await expect(copilotPage.locator('#chatList')).not.toContainText(STARTUP_FAILURE);
      await expect(copilotPage.locator('#chatList')).not.toContainText(COMPLETION_FAILURE);
      const screenshotPath = testInfo.outputPath('copilot-421-success.png');
      await copilotPage.screenshot({ path: screenshotPath, fullPage: true });
      await testInfo.attach('copilot-421-success-screenshot', {
        path: screenshotPath,
        contentType: 'image/png',
      });
      await testInfo.attach('copilot-421-success-evidence.json', {
        body: Buffer.from(JSON.stringify({
          applicationBaseURL: releaseEvidence.applicationBaseURL,
          boxBaseURL: releaseEvidence.boxBaseURL,
          imageDigest: releaseEvidence.imageDigest,
          ploinkyCommit: releaseEvidence.ploinkySource.commit,
          directoryPath,
          completionTokenObserved: true,
          terminal421Observed: false,
        }, null, 2)),
        contentType: 'application/json',
      });
      }, body => testInfo.attach('copilot-terminal_codex.json', {
        body,
        contentType: 'application/json',
      }), terminalDiagnostics.evidence);
    } finally {
      page.context().off('request', captureInputRequest);
      page.context().off('response', captureInputResponse);
      page.context().off('requestfailed', captureRequestFailure);
      page.context().off('page', attachBrowserErrorListeners);
      for (const observedPage of observedPages) {
        observedPage.off('console', captureConsoleError);
        observedPage.off('pageerror', capturePageError);
      }
      await copilotPage?.close().catch(() => {});
      await waitForStableEdge(page);
      await deleteDirectoryIfPresent(page, directoryPath);
      if (traceStarted) {
        traceStarted = false;
        await stopAndAttachRedactedTrace(page.context(), testInfo, 'copilot-421');
      }
    }
  });
});
