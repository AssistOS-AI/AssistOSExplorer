#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import {
  UI_BENCHMARK_SCHEMA_VERSION,
  UI_BENCHMARK_SCENARIO_VERSION,
  UI_BENCHMARK_ACTIVE_REQUEST_COUNT_LIMIT,
  createScenarioFingerprint,
  normalizeBenchmarkBaseUrl,
  normalizeBenchmarkLabel,
  normalizeBenchmarkPath,
  roundMetric,
  safeRequestTarget,
  sanitizeError,
  summarizeBenchmarkIterations,
  summarizeRequests,
  summarizeValues,
} from '../lib/ui-benchmark-metrics.mjs';

const smokeRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repoRoot = path.dirname(path.dirname(smokeRoot));
export const NETWORK_TAIL_DEADLINE_MS = 1_500;
const NETWORK_TAIL_QUIET_MS = 150;

const scenarioSteps = Object.freeze([
  'router-login-page',
  'login-to-explorer-interactive',
  'refresh-root-listing',
  'open-workspace-directory',
  'return-root-from-workspace-directory',
  'open-confidential',
  'open-confidential-my-space',
  'return-root-from-confidential',
  'open-workspace-file',
  'open-git-panel',
]);

function printHelp() {
  console.log(`Explorer UI benchmark

Usage:
  npm run benchmark:ui -- --base-url http://127.0.0.1:8080 --label master

Options:
  --base-url <url>         Router origin (or UI_BENCHMARK_BASE_URL / SMOKE_BASE_URL)
  --label <name>           Deployment label (or UI_BENCHMARK_LABEL)
  --iterations <count>     Fresh browser contexts to run; default 3
  --artifact-dir <path>    Output directory
  --directory-path <path>  Normal workspace directory; default /.ploinky
  --file-path <path>       Normal workspace file; default /.env
  --timeout-ms <ms>        Per-operation timeout; default 60000
  --deployment-id <id>     Optional non-secret deployment identifier
  --ploinky-sha <sha>      Optional deployed Ploinky commit
  --explorer-sha <sha>     Optional deployed AssistOSExplorer commit
  --headed                 Show Chromium
  --help                   Show this help

Credentials are accepted only through UI_BENCHMARK_USERNAME and
UI_BENCHMARK_PASSWORD (falling back to SMOKE_USERNAME / SMOKE_PASSWORD and
then the documented local admin defaults). Passwords are never written to the
result.`);
}

function parseArgs(argv) {
  const values = {};
  const boolean = new Set(['--headed', '--help']);
  const known = new Set([
    '--base-url',
    '--label',
    '--iterations',
    '--artifact-dir',
    '--directory-path',
    '--file-path',
    '--timeout-ms',
    '--deployment-id',
    '--ploinky-sha',
    '--explorer-sha',
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (boolean.has(arg)) {
      values[arg.slice(2)] = true;
      continue;
    }
    if (!known.has(arg)) throw new Error(`Unknown UI benchmark option: ${arg}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`Missing value for ${arg}.`);
    }
    values[arg.slice(2)] = value;
    index += 1;
  }
  return values;
}

function positiveInteger(value, fallback, name, maximum = Number.MAX_SAFE_INTEGER) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${name} must be an integer from 1 to ${maximum}.`);
  }
  return parsed;
}

function optionalIdentifier(value, name, pattern) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (!pattern.test(text)) throw new Error(`${name} is invalid.`);
  return text;
}

function envBoolean(value, fallback = false) {
  if (value === undefined || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value).trim());
}

function createRunId(label) {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `${label}-${stamp}-${process.pid}`;
}

function loadConfig(argv) {
  const args = parseArgs(argv);
  if (args.help) return { help: true };
  const baseURL = normalizeBenchmarkBaseUrl(
    args['base-url']
      || process.env.UI_BENCHMARK_BASE_URL
      || process.env.SMOKE_BASE_URL
      || process.env.PLAYWRIGHT_BASE_URL
      || 'http://127.0.0.1:8080',
  );
  const label = normalizeBenchmarkLabel(args.label || process.env.UI_BENCHMARK_LABEL);
  const runId = createRunId(label);
  const artifactRoot = path.resolve(
    args['artifact-dir']
      || process.env.UI_BENCHMARK_ARTIFACT_DIR
      || path.join(repoRoot, '.ploinky', 'test-artifacts', 'ui-benchmark', runId),
  );
  const directoryPath = normalizeBenchmarkPath(
    args['directory-path'] || process.env.UI_BENCHMARK_DIRECTORY_PATH || '/.ploinky',
    'UI benchmark directory path',
  );
  const filePath = normalizeBenchmarkPath(
    args['file-path'] || process.env.UI_BENCHMARK_FILE_PATH || '/.env',
    'UI benchmark file path',
  );
  const shaPattern = /^[0-9a-f]{7,64}$/i;
  return {
    help: false,
    baseURL,
    label,
    runId,
    artifactRoot,
    directoryPath,
    filePath,
    iterations: positiveInteger(
      args.iterations || process.env.UI_BENCHMARK_ITERATIONS,
      3,
      'UI benchmark iterations',
      20,
    ),
    timeoutMs: positiveInteger(
      args['timeout-ms'] || process.env.UI_BENCHMARK_TIMEOUT_MS,
      60_000,
      'UI benchmark timeout',
      600_000,
    ),
    headless: !args.headed && !envBoolean(process.env.UI_BENCHMARK_HEADED, false),
    username: String(
      process.env.UI_BENCHMARK_USERNAME
        || process.env.SMOKE_USERNAME
        || 'admin',
    ),
    password: String(
      process.env.UI_BENCHMARK_PASSWORD
        || process.env.SMOKE_PASSWORD
        || 'admin',
    ),
    deployment: {
      id: optionalIdentifier(
        args['deployment-id'] || process.env.UI_BENCHMARK_DEPLOYMENT_ID,
        'UI benchmark deployment id',
        /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/,
      ),
      ploinkySha: optionalIdentifier(
        args['ploinky-sha'] || process.env.UI_BENCHMARK_PLOINKY_SHA,
        'Ploinky SHA',
        shaPattern,
      ),
      explorerSha: optionalIdentifier(
        args['explorer-sha'] || process.env.UI_BENCHMARK_EXPLORER_SHA,
        'Explorer SHA',
        shaPattern,
      ),
    },
  };
}

function addPerformanceObservers(context) {
  return context.addInitScript(() => {
    const state = {
      timeOrigin: performance.timeOrigin,
      longTasks: [],
      eventTimings: [],
      lcpMs: null,
      cls: 0,
      performanceObservers: {},
    };
    Object.defineProperty(window, '__uiBenchmarkPerformance', {
      value: state,
      configurable: true,
    });
    const observe = (type, callback, options = {}) => {
      const Observer = typeof PerformanceObserver === 'function' ? PerformanceObserver : null;
      const supportedEntryTypes = Array.isArray(Observer?.supportedEntryTypes)
        ? Observer.supportedEntryTypes
        : null;
      const observerState = {
        supported: supportedEntryTypes ? supportedEntryTypes.includes(type) : (Observer ? null : false),
        available: false,
      };
      state.performanceObservers[type] = observerState;
      if (!Observer || observerState.supported === false) return;
      try {
        const observer = new Observer((list) => callback(list.getEntries()));
        observer.observe({ type, buffered: true, ...options });
        observerState.supported ??= true;
        observerState.available = true;
      } catch {
        // Availability is recorded without retaining browser error text.
      }
    };
    observe('longtask', (entries) => {
      for (const entry of entries) {
        if (state.longTasks.length >= 2_000) break;
        state.longTasks.push({
          startTime: entry.startTime,
          duration: entry.duration,
        });
      }
    });
    observe('event', (entries) => {
      for (const entry of entries) {
        if (state.eventTimings.length >= 2_000) break;
        state.eventTimings.push({
          startTime: entry.startTime,
          duration: entry.duration,
          interactionId: Number(entry.interactionId || 0),
        });
      }
    }, { durationThreshold: 16 });
    observe('largest-contentful-paint', (entries) => {
      const last = entries.at(-1);
      if (last) state.lcpMs = last.startTime;
    });
    observe('layout-shift', (entries) => {
      for (const entry of entries) {
        if (!entry.hadRecentInput) state.cls += entry.value;
      }
    });
  });
}

export class NetworkRecorder {
  constructor(session, baseURL) {
    this.session = session;
    this.baseURL = baseURL;
    this.currentStep = 'background';
    this.sequence = 0;
    this.originTimestamp = null;
    this.openByRequestId = new Map();
    this.records = [];
    this.webSockets = new Map();
  }

  async install() {
    await this.session.send('Network.enable');
    await this.session.send('Network.setCacheDisabled', { cacheDisabled: true });
    this.session.on('Network.requestWillBeSent', (event) => this.requestStarted(event));
    this.session.on('Network.responseReceived', (event) => this.responseReceived(event));
    this.session.on('Network.requestServedFromCache', (event) => {
      const record = this.openByRequestId.get(event.requestId);
      if (record) record.cacheHit = true;
    });
    this.session.on('Network.loadingFinished', (event) => this.requestFinished(event));
    this.session.on('Network.loadingFailed', (event) => this.requestFailed(event));
    this.session.on('Network.webSocketCreated', (event) => this.webSocketCreated(event));
    this.session.on('Network.webSocketClosed', (event) => this.webSocketClosed(event));
  }

  beginStep(name) {
    this.currentStep = name;
  }

  endStep() {
    this.currentStep = 'background';
  }

  relativeMs(timestamp) {
    if (!Number.isFinite(timestamp)) return null;
    if (!Number.isFinite(this.originTimestamp)) this.originTimestamp = timestamp;
    return roundMetric((timestamp - this.originTimestamp) * 1_000);
  }

  requestStarted(event) {
    if (!Number.isFinite(this.originTimestamp)) this.originTimestamp = event.timestamp;
    const existing = this.openByRequestId.get(event.requestId);
    if (existing) {
      if (event.redirectResponse) {
        existing.status = event.redirectResponse.status;
        existing.ttfbMs = roundMetric((event.timestamp - existing.startTimestamp) * 1_000);
      }
      this.finalize(existing, event.timestamp, 0);
    }
    const target = safeRequestTarget(event.request?.url, this.baseURL);
    const record = {
      sequence: ++this.sequence,
      requestId: event.requestId,
      step: this.currentStep,
      method: String(event.request?.method || 'GET').toUpperCase(),
      type: String(event.type || 'Other'),
      scope: target.scope,
      pathname: target.pathname,
      category: target.category,
      status: null,
      startTimestamp: event.timestamp,
      startedOffsetMs: this.relativeMs(event.timestamp),
      responseOffsetMs: null,
      endOffsetMs: null,
      ttfbMs: null,
      totalMs: null,
      transferBytes: 0,
      cacheHit: false,
      failed: false,
      canceled: false,
    };
    this.records.push(record);
    this.openByRequestId.set(event.requestId, record);
  }

  responseReceived(event) {
    const record = this.openByRequestId.get(event.requestId);
    if (!record) return;
    record.status = event.response?.status ?? null;
    record.responseOffsetMs = this.relativeMs(event.timestamp);
    record.ttfbMs = roundMetric((event.timestamp - record.startTimestamp) * 1_000);
    record.cacheHit = Boolean(
      record.cacheHit
      || event.response?.fromDiskCache
      || event.response?.fromPrefetchCache
      || event.response?.fromServiceWorker,
    );
  }

  requestFinished(event) {
    const record = this.openByRequestId.get(event.requestId);
    if (!record) return;
    this.finalize(record, event.timestamp, event.encodedDataLength);
    this.openByRequestId.delete(event.requestId);
  }

  requestFailed(event) {
    const record = this.openByRequestId.get(event.requestId);
    if (!record) return;
    record.failed = true;
    record.canceled = Boolean(event.canceled || /ERR_ABORTED/i.test(String(event.errorText || '')));
    this.finalize(record, event.timestamp, 0);
    this.openByRequestId.delete(event.requestId);
  }

  finalize(record, timestamp, transferBytes) {
    record.endOffsetMs = this.relativeMs(timestamp);
    record.totalMs = roundMetric((timestamp - record.startTimestamp) * 1_000);
    record.transferBytes = Number.isFinite(transferBytes) ? Math.max(0, Math.round(transferBytes)) : 0;
  }

  webSocketCreated(event) {
    const target = safeRequestTarget(event.url, this.baseURL);
    this.webSockets.set(event.requestId, {
      step: this.currentStep,
      scope: target.scope,
      pathname: target.pathname,
      category: target.category,
      startedOffsetMs: this.relativeMs(event.timestamp),
      closedOffsetMs: null,
    });
  }

  webSocketClosed(event) {
    const record = this.webSockets.get(event.requestId);
    if (record) record.closedOffsetMs = this.relativeMs(event.timestamp);
  }

  activeCountForStep(name) {
    let count = 0;
    for (const record of this.openByRequestId.values()) {
      if (record.step !== name) continue;
      if (['EventSource', 'WebSocket'].includes(record.type)) continue;
      count += 1;
    }
    return count;
  }

  async waitForStepNetworkTail(
    name,
    maximumMs = NETWORK_TAIL_DEADLINE_MS,
    quietMs = NETWORK_TAIL_QUIET_MS,
  ) {
    const started = performance.now();
    let idleSince = null;
    while (performance.now() - started < maximumMs) {
      if (this.activeCountForStep(name) === 0) {
        idleSince ??= performance.now();
        if (performance.now() - idleSince >= quietMs) {
          return {
            status: 'complete',
            complete: true,
            deadlineMs: maximumMs,
            quietPeriodMs: quietMs,
            activeRequestsAtCutoff: null,
            activeRequestsAtCutoffCapped: false,
          };
        }
      } else {
        idleSince = null;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const activeRequests = this.activeCountForStep(name);
    return {
      status: 'cutoff',
      complete: false,
      deadlineMs: maximumMs,
      quietPeriodMs: quietMs,
      activeRequestsAtCutoff: Math.min(
        activeRequests,
        UI_BENCHMARK_ACTIVE_REQUEST_COUNT_LIMIT,
      ),
      activeRequestsAtCutoffCapped: activeRequests > UI_BENCHMARK_ACTIVE_REQUEST_COUNT_LIMIT,
    };
  }

  requestsForStep(name) {
    return this.records.filter((record) => record.step === name).map((record) => this.publicRequest(record));
  }

  publicRequest(record) {
    return {
      sequence: record.sequence,
      step: record.step,
      method: record.method,
      type: record.type,
      scope: record.scope,
      pathname: record.pathname,
      category: record.category,
      status: record.status,
      startedOffsetMs: record.startedOffsetMs,
      responseOffsetMs: record.responseOffsetMs,
      endOffsetMs: record.endOffsetMs,
      ttfbMs: record.ttfbMs,
      totalMs: record.totalMs,
      transferBytes: record.transferBytes,
      cacheHit: record.cacheHit,
      failed: record.failed,
      canceled: record.canceled,
    };
  }

  export() {
    return {
      requests: this.records.map((record) => this.publicRequest(record)),
      webSockets: Array.from(this.webSockets.values(), (record) => ({ ...record })),
    };
  }
}

async function readCdpMetrics(session) {
  try {
    const result = await session.send('Performance.getMetrics');
    return Object.fromEntries((result.metrics || []).map((metric) => [metric.name, metric.value]));
  } catch {
    return {};
  }
}

function metricDelta(before, after, name, scale = 1) {
  const left = before?.[name];
  const right = after?.[name];
  return Number.isFinite(left) && Number.isFinite(right)
    ? roundMetric((right - left) * scale)
    : null;
}

function diffCdpMetrics(before, after) {
  return {
    taskDurationMs: metricDelta(before, after, 'TaskDuration', 1_000),
    scriptDurationMs: metricDelta(before, after, 'ScriptDuration', 1_000),
    layoutDurationMs: metricDelta(before, after, 'LayoutDuration', 1_000),
    recalcStyleDurationMs: metricDelta(before, after, 'RecalcStyleDuration', 1_000),
    layoutCount: metricDelta(before, after, 'LayoutCount'),
    recalcStyleCount: metricDelta(before, after, 'RecalcStyleCount'),
    jsHeapUsedBytesDelta: metricDelta(before, after, 'JSHeapUsedSize'),
  };
}

async function readPagePerformance(page) {
  try {
    return await page.evaluate(() => {
      const state = window.__uiBenchmarkPerformance || {
        timeOrigin: performance.timeOrigin,
        longTasks: [],
        eventTimings: [],
        lcpMs: null,
        cls: 0,
        performanceObservers: {},
      };
      const navigation = performance.getEntriesByType('navigation')[0] || null;
      const fcp = performance.getEntriesByName('first-contentful-paint')[0] || null;
      return {
        timeOrigin: performance.timeOrigin,
        now: performance.now(),
        longTasks: state.longTasks.map((entry) => ({
          startTime: entry.startTime,
          duration: entry.duration,
        })),
        eventTimings: state.eventTimings.map((entry) => ({
          startTime: entry.startTime,
          duration: entry.duration,
          interactionId: entry.interactionId,
        })),
        performanceObservers: {
          longTask: state.performanceObservers?.longtask || null,
          eventTiming: state.performanceObservers?.event || null,
          largestContentfulPaint: state.performanceObservers?.['largest-contentful-paint'] || null,
          layoutShift: state.performanceObservers?.['layout-shift'] || null,
        },
        webVitals: {
          fcpMs: fcp?.startTime ?? null,
          lcpMs: state.lcpMs,
          cls: state.cls,
        },
        navigation: navigation ? {
          responseStartMs: navigation.responseStart,
          domContentLoadedMs: navigation.domContentLoadedEventEnd,
          loadMs: navigation.loadEventEnd,
          durationMs: navigation.duration,
          transferBytes: navigation.transferSize,
          encodedBodyBytes: navigation.encodedBodySize,
        } : null,
      };
    });
  } catch {
    return null;
  }
}

function normalizeObserverState(value) {
  return {
    supported: typeof value?.supported === 'boolean' ? value.supported : null,
    available: value?.available === true,
  };
}

export function summarizeBrowserWindow(before, after) {
  const missingObserver = normalizeObserverState(null);
  if (!after) {
    return {
      documentChanged: null,
      longTasks: {
        observer: missingObserver,
        count: null,
        totalDurationMs: null,
        maxDurationMs: null,
        totalBlockingTimeMs: null,
      },
      eventTiming: {
        observer: missingObserver,
        count: null,
        maxDurationMs: null,
      },
    };
  }
  const sameDocument = Boolean(before && before.timeOrigin === after.timeOrigin);
  const lowerBound = sameDocument ? before.now : 0;
  const longTasks = (after.longTasks || []).filter((entry) => (
    entry.startTime >= lowerBound && entry.startTime <= after.now
  ));
  const events = (after.eventTimings || []).filter((entry) => (
    entry.startTime >= lowerBound && entry.startTime <= after.now
  ));
  const longTaskObserver = normalizeObserverState(after.performanceObservers?.longTask);
  const eventTimingObserver = normalizeObserverState(after.performanceObservers?.eventTiming);
  const longDurations = longTasks.map((entry) => entry.duration);
  return {
    documentChanged: before ? !sameDocument : null,
    longTasks: {
      observer: longTaskObserver,
      count: longTaskObserver.available ? longTasks.length : null,
      totalDurationMs: longTaskObserver.available
        ? roundMetric(longDurations.reduce((sum, value) => sum + value, 0))
        : null,
      maxDurationMs: longTaskObserver.available
        ? roundMetric(longDurations.length ? Math.max(...longDurations) : 0)
        : null,
      totalBlockingTimeMs: longTaskObserver.available
        ? roundMetric(longDurations.reduce((sum, value) => sum + Math.max(0, value - 50), 0))
        : null,
    },
    eventTiming: {
      observer: eventTimingObserver,
      count: eventTimingObserver.available ? events.length : null,
      maxDurationMs: eventTimingObserver.available
        ? roundMetric(events.length ? Math.max(...events.map((entry) => entry.duration)) : 0)
        : null,
    },
  };
}

async function waitForAnimationFrames(page) {
  await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  })).catch(() => {});
}

async function waitForGlobalLoader(page, timeoutMs) {
  await page.waitForFunction(() => (
    Number(window.__assistosExplorerGlobalLoader?.depth || 0) === 0
  ), null, { timeout: timeoutMs });
}

async function waitForDirectory(page, expectedPath, timeoutMs) {
  await page.waitForFunction((targetPath) => {
    const explorer = document.querySelector('file-exp');
    const presenter = explorer?.webSkelPresenter;
    return Boolean(
      presenter
      && presenter.state?.path === targetPath
      && document.querySelector('#entriesBody'),
    );
  }, expectedPath, { timeout: timeoutMs });
  await waitForGlobalLoader(page, timeoutMs);
}

async function waitForWorkspaceFile(page, expectedPath, timeoutMs) {
  const filename = path.posix.basename(expectedPath);
  await page.waitForFunction(({ targetPath, targetName }) => {
    const explorer = document.querySelector('file-exp');
    const presenter = explorer?.webSkelPresenter;
    const displayedName = document.querySelector('#editorFileName')?.textContent?.trim();
    return Boolean(
      presenter
      && presenter.state?.selectedPath === targetPath
      && displayedName === targetName
      && Number(window.__assistosExplorerGlobalLoader?.depth || 0) === 0,
    );
  }, { targetPath: expectedPath, targetName: filename }, { timeout: timeoutMs });
}

async function waitForExplorerInteractive(page, config) {
  await page.locator('#page_content').waitFor({ state: 'visible', timeout: config.timeoutMs });
  await page.locator('#before_webskel_loader').waitFor({ state: 'detached', timeout: config.timeoutMs });
  await page.waitForFunction(({ directoryPath, filePath }) => {
    const explorer = document.querySelector('file-exp');
    const presenter = explorer?.webSkelPresenter;
    const entryPaths = new Set(
      Array.from(document.querySelectorAll('#entriesBody [data-entry-path]'))
        .map((entry) => entry.getAttribute('data-entry-path')),
    );
    return Boolean(
      window.webSkel
      && presenter
      && presenter.state?.path === '/'
      && document.querySelector('#gitButton')
      && entryPaths.has('/Confidential')
      && entryPaths.has(directoryPath)
      && entryPaths.has(filePath)
      && !presenter.__appPluginRenderPromise
      && Number(window.__assistosExplorerGlobalLoader?.depth || 0) === 0,
    );
  }, {
    directoryPath: config.directoryPath,
    filePath: config.filePath,
  }, { timeout: config.timeoutMs });
}

function entryLocator(page, entryPath) {
  return page.locator(
    `.col-name[data-local-action="selectEntry"][data-entry-path=${JSON.stringify(entryPath)}]`,
  ).first();
}

async function measureStep(state, name, action) {
  const { page, session, network, steps } = state;
  network.beginStep(name);
  const nodeStarted = performance.now();
  const cpuBefore = await readCdpMetrics(session);
  const browserBefore = await readPagePerformance(page);
  let details = null;
  let failure = null;
  let visibleEnded = null;
  try {
    details = await action({
      elapsedMs: () => roundMetric(performance.now() - nodeStarted),
    });
    await waitForAnimationFrames(page);
    visibleEnded = performance.now();
  } catch (error) {
    visibleEnded = performance.now();
    failure = error;
  }
  const networkTail = await network.waitForStepNetworkTail(name);
  const settledEnded = performance.now();
  network.endStep();
  const [cpuAfter, browserAfter] = await Promise.all([
    readCdpMetrics(session),
    readPagePerformance(page),
  ]);
  const requests = network.requestsForStep(name);
  const step = {
    name,
    status: failure ? 'failed' : 'passed',
    durationMs: roundMetric(visibleEnded - nodeStarted),
    settledMs: roundMetric(settledEnded - nodeStarted),
    networkTail,
    details,
    network: summarizeRequests(requests),
    cpu: diffCdpMetrics(cpuBefore, cpuAfter),
    browser: summarizeBrowserWindow(browserBefore, browserAfter),
    error: failure ? sanitizeError(failure) : null,
  };
  steps.push(step);
  if (failure) throw failure;
  return step;
}

export function finalizeStepNetworkSummaries(steps, waterfallRequests) {
  const finalRequests = Array.isArray(waterfallRequests) ? waterfallRequests : [];
  const requestsByStep = new Map();
  for (const request of finalRequests) {
    const name = request?.step;
    if (typeof name !== 'string') continue;
    if (!requestsByStep.has(name)) requestsByStep.set(name, []);
    requestsByStep.get(name).push(request);
  }
  return (Array.isArray(steps) ? steps : []).map((step) => ({
    ...step,
    network: summarizeRequests(requestsByStep.get(step.name) || []),
  }));
}

async function runIteration(browser, config, index) {
  const startedAt = new Date().toISOString();
  const nodeStarted = performance.now();
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    ignoreHTTPSErrors: true,
  });
  await addPerformanceObservers(context);
  const page = await context.newPage();
  page.setDefaultTimeout(config.timeoutMs);
  page.setDefaultNavigationTimeout(config.timeoutMs);
  const diagnostics = {
    consoleErrors: 0,
    consoleWarnings: 0,
    pageErrors: 0,
  };
  page.on('console', (message) => {
    if (message.type() === 'error') diagnostics.consoleErrors += 1;
    if (message.type() === 'warning') diagnostics.consoleWarnings += 1;
  });
  page.on('pageerror', () => {
    diagnostics.pageErrors += 1;
  });
  const session = await context.newCDPSession(page);
  await session.send('Performance.enable');
  const network = new NetworkRecorder(session, config.baseURL);
  await network.install();
  const steps = [];
  const state = { page, session, network, steps };
  let failure = null;
  let initialPagePerformance = null;
  try {
    await measureStep(state, 'router-login-page', async () => {
      const response = await page.goto(`${config.baseURL}/explorer/index.html`, { waitUntil: 'load' });
      if (response && response.status() >= 400) {
        throw new Error(`Router returned HTTP ${response.status()} for the Explorer entry route.`);
      }
      const loginForm = page.locator(
        'form[action="/auth/login"], input#username, input[name="username"]',
      ).first();
      await loginForm.waitFor({ state: 'visible', timeout: config.timeoutMs });
      return {
        finalPathname: new URL(page.url()).pathname,
        responseStatus: response?.status() ?? null,
      };
    });

    await page.locator('input#username, input[name="username"]').first().fill(config.username);
    await page.locator('input#password, input[name="password"]').first().fill(config.password);

    await measureStep(state, 'login-to-explorer-interactive', async ({ elapsedMs }) => {
      const navigation = page.waitForNavigation({ waitUntil: 'load', timeout: config.timeoutMs });
      await page.locator(
        'form[action="/auth/login"] button[type="submit"], button[type="submit"], .auth-btn',
      ).first().click();
      await navigation;
      const navigationLoadedMs = elapsedMs();
      await page.locator('#page_content').waitFor({ state: 'visible', timeout: config.timeoutMs });
      await page.waitForFunction(() => Boolean(
        window.webSkel
        && document.querySelector('#page_content')?.children.length,
      ), null, { timeout: config.timeoutMs });
      const shellReadyMs = elapsedMs();
      await waitForExplorerInteractive(page, config);
      return {
        navigationLoadedMs,
        shellReadyMs,
        interactiveReadyMs: elapsedMs(),
      };
    });
    initialPagePerformance = await readPagePerformance(page);

    await measureStep(state, 'refresh-root-listing', async () => {
      await page.locator('#refreshButton').click();
      await waitForDirectory(page, '/', config.timeoutMs);
      return {
        visibleEntries: await page.locator('#entriesBody tr:not(.entries-virtual-spacer)').count(),
      };
    });

    await measureStep(state, 'open-workspace-directory', async () => {
      const locator = entryLocator(page, config.directoryPath);
      await locator.waitFor({ state: 'visible', timeout: config.timeoutMs });
      await locator.click();
      await waitForDirectory(page, config.directoryPath, config.timeoutMs);
      return {
        path: config.directoryPath,
        visibleEntries: await page.locator('#entriesBody tr:not(.entries-virtual-spacer)').count(),
      };
    });

    await measureStep(state, 'return-root-from-workspace-directory', async () => {
      await page.locator('#upButton').click();
      await waitForDirectory(page, '/', config.timeoutMs);
      return { path: '/' };
    });

    await measureStep(state, 'open-confidential', async () => {
      const locator = entryLocator(page, '/Confidential');
      await locator.waitFor({ state: 'visible', timeout: config.timeoutMs });
      await locator.click();
      await waitForDirectory(page, '/Confidential', config.timeoutMs);
      return {
        path: '/Confidential',
        visibleEntries: await page.locator('#entriesBody tr:not(.entries-virtual-spacer)').count(),
      };
    });

    await measureStep(state, 'open-confidential-my-space', async () => {
      const locator = entryLocator(page, '/Confidential/My Space');
      await locator.waitFor({ state: 'visible', timeout: config.timeoutMs });
      await locator.click();
      await waitForDirectory(page, '/Confidential/My Space', config.timeoutMs);
      return {
        path: '/Confidential/My Space',
        visibleEntries: await page.locator('#entriesBody tr:not(.entries-virtual-spacer)').count(),
      };
    });

    await measureStep(state, 'return-root-from-confidential', async () => {
      await page.locator('#breadcrumbs button').first().click();
      await waitForDirectory(page, '/', config.timeoutMs);
      return { path: '/' };
    });

    await measureStep(state, 'open-workspace-file', async () => {
      const locator = entryLocator(page, config.filePath);
      await locator.waitFor({ state: 'visible', timeout: config.timeoutMs });
      await locator.click();
      await waitForWorkspaceFile(page, config.filePath, config.timeoutMs);
      return { path: config.filePath };
    });

    await measureStep(state, 'open-git-panel', async () => {
      await page.locator('#gitButton').click();
      await page.locator('git-panel .git-panel').waitFor({
        state: 'visible',
        timeout: config.timeoutMs,
      });
      await page.waitForFunction(() => {
        const modal = document.querySelector('git-panel');
        const presenter = modal?.webSkelPresenter;
        return Boolean(
          presenter
          && !presenter.state?.repoOverviewsLoading
          && (presenter.state?.repoOverviewsLoaded || presenter.state?.credentialsGate)
          && Number(window.__assistosExplorerGlobalLoader?.depth || 0) === 0,
        );
      }, null, { timeout: config.timeoutMs });
      return {
        readiness: await page.locator('git-panel').evaluate((modal) => {
          const state = modal.webSkelPresenter?.state || {};
          return state.credentialsGate ? 'credentials-gate' : 'repository-overview';
        }),
      };
    });
  } catch (error) {
    failure = error;
  }

  const networkExport = network.export();
  const finalizedSteps = finalizeStepNetworkSummaries(steps, networkExport.requests);
  const result = {
    index,
    status: failure ? 'failed' : 'passed',
    startedAt,
    completedAt: new Date().toISOString(),
    durationMs: roundMetric(performance.now() - nodeStarted),
    steps: finalizedSteps,
    diagnostics,
    initialPage: initialPagePerformance ? {
      navigation: {
        responseStartMs: roundMetric(initialPagePerformance.navigation?.responseStartMs),
        domContentLoadedMs: roundMetric(initialPagePerformance.navigation?.domContentLoadedMs),
        loadMs: roundMetric(initialPagePerformance.navigation?.loadMs),
        durationMs: roundMetric(initialPagePerformance.navigation?.durationMs),
        transferBytes: initialPagePerformance.navigation?.transferBytes ?? null,
        encodedBodyBytes: initialPagePerformance.navigation?.encodedBodyBytes ?? null,
      },
      webVitals: {
        fcpMs: roundMetric(initialPagePerformance.webVitals?.fcpMs),
        lcpMs: roundMetric(initialPagePerformance.webVitals?.lcpMs),
        cls: roundMetric(initialPagePerformance.webVitals?.cls, 5),
        totalBlockingTimeMs: roundMetric(
          initialPagePerformance.performanceObservers?.longTask?.available
            ? (initialPagePerformance.longTasks || []).reduce(
              (sum, entry) => sum + Math.max(0, entry.duration - 50),
              0,
            )
            : null,
        ),
      },
      performanceObservers: Object.fromEntries(
        Object.entries(initialPagePerformance.performanceObservers || {})
          .map(([name, state]) => [name, normalizeObserverState(state)]),
      ),
    } : null,
    waterfall: networkExport,
    error: failure ? sanitizeError(failure) : null,
  };
  await context.close();
  return result;
}

function scenarioDescriptor(config) {
  const definition = {
    version: UI_BENCHMARK_SCENARIO_VERSION,
    steps: scenarioSteps,
    cacheDisabled: true,
    viewport: { width: 1440, height: 1000 },
    directoryPath: config.directoryPath,
    filePath: config.filePath,
  };
  return {
    ...definition,
    fingerprint: createScenarioFingerprint(definition),
  };
}

function printSummary(report, resultPath) {
  console.log(`Explorer UI benchmark: ${report.label}`);
  console.log(`Status: ${report.summary.status}; iterations: ${report.summary.passedIterations}/${report.summary.iterations} passed`);
  console.log(`Artifact: ${resultPath}`);
  console.log('');
  console.log('Operation                                      median ms     p95 ms   passed');
  for (const step of report.summary.steps) {
    const name = step.name.padEnd(44);
    const median = String(step.durationMs.median ?? 'n/a').padStart(10);
    const p95 = String(step.durationMs.p95 ?? 'n/a').padStart(10);
    console.log(`${name}${median}${p95}${String(`${step.passed}/${step.attempts}`).padStart(9)}`);
  }
}

async function main() {
  const config = loadConfig(process.argv.slice(2));
  if (config.help) {
    printHelp();
    return;
  }
  fs.mkdirSync(config.artifactRoot, { recursive: true });
  const startedAt = new Date().toISOString();
  const nodeStarted = performance.now();
  const { chromium } = await import('@playwright/test');
  const browser = await chromium.launch({ headless: config.headless });
  const browserVersion = browser.version();
  const iterations = [];
  try {
    for (let index = 1; index <= config.iterations; index += 1) {
      console.log(`[${index}/${config.iterations}] ${config.label}: running fixed Explorer UI scenario`);
      iterations.push(await runIteration(browser, config, index));
    }
  } finally {
    await browser.close();
  }
  const report = {
    schemaVersion: UI_BENCHMARK_SCHEMA_VERSION,
    kind: 'explorer-ui-benchmark',
    label: config.label,
    runId: config.runId,
    status: iterations.every((iteration) => iteration.status === 'passed') ? 'passed' : 'failed',
    startedAt,
    completedAt: new Date().toISOString(),
    durationMs: roundMetric(performance.now() - nodeStarted),
    target: {
      baseURL: config.baseURL,
    },
    deployment: Object.fromEntries(Object.entries(config.deployment).filter(([, value]) => value)),
    environment: {
      platform: process.platform,
      architecture: process.arch,
      osRelease: os.release(),
      nodeVersion: process.version,
      browser: 'chromium',
      browserVersion,
      headless: config.headless,
      cacheDisabled: true,
      viewport: { width: 1440, height: 1000 },
    },
    scenario: scenarioDescriptor(config),
    iterations,
    initialPage: {
      fcpMs: summarizeValues(iterations.map((iteration) => iteration.initialPage?.webVitals?.fcpMs)),
      lcpMs: summarizeValues(iterations.map((iteration) => iteration.initialPage?.webVitals?.lcpMs)),
      cls: summarizeValues(iterations.map((iteration) => iteration.initialPage?.webVitals?.cls)),
      totalBlockingTimeMs: summarizeValues(
        iterations.map((iteration) => iteration.initialPage?.webVitals?.totalBlockingTimeMs),
      ),
      longTaskObserver: {
        available: iterations.filter((iteration) => (
          iteration.initialPage?.performanceObservers?.longTask?.available === true
        )).length,
        unsupported: iterations.filter((iteration) => (
          iteration.initialPage?.performanceObservers?.longTask?.supported === false
        )).length,
        failed: iterations.filter((iteration) => {
          const observer = iteration.initialPage?.performanceObservers?.longTask;
          return observer?.supported === true && observer.available !== true;
        }).length,
        unknown: iterations.filter((iteration) => (
          iteration.initialPage?.performanceObservers?.longTask?.supported !== true
          && iteration.initialPage?.performanceObservers?.longTask?.supported !== false
        )).length,
      },
    },
    summary: summarizeBenchmarkIterations(iterations),
  };
  const resultPath = path.join(config.artifactRoot, 'result.json');
  fs.writeFileSync(resultPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  printSummary(report, resultPath);
  if (report.status !== 'passed') process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const safe = sanitizeError(error);
    console.error(`${safe.name}: ${safe.message}`);
    process.exitCode = 1;
  });
}
