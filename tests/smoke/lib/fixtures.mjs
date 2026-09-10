import fs from 'node:fs';
import path from 'node:path';

import { expect, test as base } from '@playwright/test';

import { smokeConfig } from './config.mjs';
import { createDiagnosticLedger } from './diagnostic-ledger.mjs';
import { findTraceCredentialResidue, redactTraceText } from './redacted-trace.mjs';
import { createRedactor, findSecretLeaks } from './security.mjs';

const diagnosticControllers = new WeakMap();

const ignoredUrlPatterns = [
  /\/favicon\.ico(?:$|\?)/i,
  /\.map(?:$|\?)/i,
  /^data:/i,
  /^blob:/i,
];

const ignoredConsolePatterns = [
  /ResizeObserver loop limit exceeded/i,
  /Failed to load resource.*favicon\.ico/i,
  /source map/i,
];

function shouldIgnoreUrl(url) {
  return ignoredUrlPatterns.some((pattern) => pattern.test(String(url || '')));
}

function shouldIgnoreRequestFailure(url, method, failure) {
  if (shouldIgnoreUrl(url)) return true;
  if (failure !== 'net::ERR_ABORTED' || String(method || '').toUpperCase() !== 'POST') return false;
  try {
    const pathname = new URL(url).pathname;
    return pathname === '/webchat/input'
      || pathname === '/mcp'
      || pathname.endsWith('/mcp');
  } catch (_) {
    return false;
  }
}

function shouldIgnoreConsole(event) {
  const text = `${event.type || ''} ${event.text || ''}`;
  return ignoredConsolePatterns.some((pattern) => pattern.test(text));
}

function expectedOfflineFailure(text) {
  return /net::ERR_(?:INTERNET_DISCONNECTED|NETWORK_CHANGED|NETWORK_ACCESS_DENIED|FAILED|ABORTED)\b/i.test(String(text || ''));
}

export function setPageDiagnosticsExpectedOffline(page, expected) {
  for (const controller of diagnosticControllers.get(page) || []) {
    controller.setExpectedOffline(expected);
  }
}

export function recordPageNavigationFailure(page, snapshot) {
  for (const controller of diagnosticControllers.get(page) || []) {
    controller.events.push({ kind: 'navigationfailure', type: 'info', ...snapshot });
  }
}

export function checkpointPageDiagnostics(page, label) {
  const controllers = [...(diagnosticControllers.get(page) || [])];
  if (controllers.length === 0) {
    throw new Error('the page has no attached diagnostic controller');
  }
  return Object.freeze({
    page,
    entries: controllers.map((controller) => ({
      controller,
      checkpoint: controller.checkpoint(label),
    })),
  });
}

export function assertPageDiagnosticsClean(page, label = 'browser console, page, or network errors') {
  const controllers = [...(diagnosticControllers.get(page) || [])];
  if (controllers.length === 0) throw new Error('the page has no attached diagnostic controller');
  for (const controller of controllers) expect(controller.actionableEvents(), label).toEqual([]);
}

export function acknowledgeExactPageDiagnostics(page, checkpoint, expectedSignatures) {
  if (checkpoint?.page !== page || !Array.isArray(checkpoint?.entries)) {
    throw new Error('the diagnostic checkpoint does not belong to this page');
  }
  for (const { controller, checkpoint: controllerCheckpoint } of checkpoint.entries) {
    controller.assertExact(controllerCheckpoint, expectedSignatures);
  }
  return checkpoint.entries.map(({ controller, checkpoint: controllerCheckpoint }) => (
    controller.acknowledgeExact(controllerCheckpoint, expectedSignatures)
  ));
}

export function installRtcProbe(context, { networkLane = '', expectedTurnEndpoint = null } = {}) {
  const normalizedLane = String(networkLane || '').trim();
  if (normalizedLane && !['direct-udp', 'turn-udp', 'turn-tls'].includes(normalizedLane)) {
    throw new Error(`Unsupported RTC probe network lane: ${normalizedLane}`);
  }
  const relayLane = normalizedLane === 'turn-udp' || normalizedLane === 'turn-tls';
  const turnEndpoint = expectedTurnEndpoint && typeof expectedTurnEndpoint === 'object'
    ? {
        scheme: String(expectedTurnEndpoint.scheme || '').toLowerCase(),
        host: String(expectedTurnEndpoint.host || '').toLowerCase(),
        port: Number(expectedTurnEndpoint.port || 0),
        transport: String(expectedTurnEndpoint.transport || '').toLowerCase(),
      }
    : null;
  if (relayLane && (
    !turnEndpoint
    || !['turn', 'turns'].includes(turnEndpoint.scheme)
    || !turnEndpoint.host
    || !Number.isInteger(turnEndpoint.port)
    || turnEndpoint.port < 1
    || turnEndpoint.port > 65_535
    || !['udp', 'tcp'].includes(turnEndpoint.transport)
  )) {
    throw new Error(`RTC probe ${normalizedLane} requires an exact non-secret TURN endpoint.`);
  }
  return context.addInitScript(({ lane, requiredTurnEndpoint }) => {
    const NativeRTCPeerConnection = window.RTCPeerConnection;
    if (!NativeRTCPeerConnection || window.__e2ePeerConnectionProbeInstalled) return;
    window.__e2ePeerConnectionProbeInstalled = true;
    window.__e2ePeerConnections = [];
    window.__e2eRtcConfigurations = [];
    window.__e2eIceCandidateEvents = [];

    function parseTurnUrl(value) {
      const text = String(value || '').trim();
      const match = text.match(/^(turns?):(.*)$/i);
      if (!match) return null;
      try {
        const scheme = match[1].toLowerCase();
        const remainder = match[2].replace(/^\/\//, '');
        const url = new URL(`${scheme}://${remainder}`);
        const transport = String(url.searchParams.get('transport') || '').toLowerCase();
        if (!transport) return null;
        return {
          scheme,
          host: String(url.hostname || '').toLowerCase(),
          port: Number(url.port || (scheme === 'turns' ? 5349 : 3478)),
          transport,
        };
      } catch (_) {
        return null;
      }
    }

    function exactTurnUrl(value) {
      const parsed = parseTurnUrl(value);
      return Boolean(parsed && requiredTurnEndpoint
        && parsed.scheme === requiredTurnEndpoint.scheme
        && parsed.host === requiredTurnEndpoint.host
        && parsed.port === requiredTurnEndpoint.port
        && parsed.transport === requiredTurnEndpoint.transport);
    }

    function publicIceServerShape(server) {
      const originalUrls = Array.isArray(server?.urls) ? server.urls : [server?.urls];
      return {
        endpoints: originalUrls.map(parseTurnUrl).filter(Boolean),
        hasUsername: Boolean(String(server?.username || '')),
        hasCredential: Boolean(String(server?.credential || '')),
      };
    }

    function forceNetworkLane(configuration = {}) {
      if (!lane) return configuration;
      if (lane === 'direct-udp') {
        window.__e2eRtcConfigurations.push({ lane, iceTransportPolicy: 'all', iceServers: [] });
        return { ...configuration, iceTransportPolicy: 'all', iceServers: [] };
      }
      const iceServers = Array.from(configuration?.iceServers || [])
        .map((server) => {
          const originalUrls = Array.isArray(server?.urls) ? server.urls : [server?.urls];
          const urls = originalUrls.filter(exactTurnUrl);
          if (!urls.length) return null;
          if (!String(server?.username || '') || !String(server?.credential || '')) {
            throw new Error(`The exact ${lane} server has no short-lived TURN credentials.`);
          }
          return {
            ...server,
            urls: Array.isArray(server?.urls) ? urls : urls[0],
          };
        })
        .filter(Boolean);
      if (!iceServers.length) {
        throw new Error(`Join material does not contain the exact configured ${lane} endpoint.`);
      }
      window.__e2eRtcConfigurations.push({
        lane,
        iceTransportPolicy: 'relay',
        iceServers: iceServers.map(publicIceServerShape),
      });
      return { ...configuration, iceTransportPolicy: 'relay', iceServers };
    }

    function patchedRTCPeerConnection(...args) {
      const [configuration, ...rest] = args;
      const pc = new NativeRTCPeerConnection(forceNetworkLane(configuration), ...rest);
      const peerConnectionIndex = window.__e2ePeerConnections.length;
      const nativeSetConfiguration = pc.setConfiguration?.bind(pc);
      if (nativeSetConfiguration) {
        pc.setConfiguration = (nextConfiguration) => nativeSetConfiguration(forceNetworkLane(nextConfiguration));
      }
      Object.defineProperty(pc, '__e2ePeerConnectionId', {
        value: peerConnectionIndex,
        configurable: false,
        enumerable: false,
      });
      pc.addEventListener('icecandidate', (event) => {
        const candidate = event.candidate;
        if (!candidate) return;
        window.__e2eIceCandidateEvents.push({
          peerConnectionIndex,
          address: String(candidate.address || ''),
          port: Number(candidate.port || 0),
          candidateType: String(candidate.type || ''),
          protocol: String(candidate.protocol || ''),
          relayProtocol: String(candidate.relayProtocol || ''),
          turnEndpoint: parseTurnUrl(candidate.url),
        });
      });
      window.__e2ePeerConnections.push(pc);
      return pc;
    }
    patchedRTCPeerConnection.prototype = NativeRTCPeerConnection.prototype;
    Object.setPrototypeOf(patchedRTCPeerConnection, NativeRTCPeerConnection);
    window.RTCPeerConnection = patchedRTCPeerConnection;
    window.__e2eForcedNetworkLane = lane;
    window.__e2eRequiredTurnEndpoint = requiredTurnEndpoint;
  }, { lane: normalizedLane, requiredTurnEndpoint: turnEndpoint });
}

export function attachPageDiagnostics(page, testInfo, label = 'page') {
  const redact = createRedactor();
  const events = [];
  let expectedOffline = false;
  let paused = false;
  const ledger = createDiagnosticLedger(events, {
    isActionable: (event) => event.type === 'error' && !shouldIgnoreConsole(event),
  });

  page.on('console', (message) => {
    if (paused) return;
    if (expectedOffline && expectedOfflineFailure(message.text())) return;
    events.push({
      kind: 'console',
      type: message.type(),
      text: redact(message.text()),
      location: message.location(),
    });
  });

  page.on('pageerror', (error) => {
    if (paused) return;
    events.push({
      kind: 'pageerror',
      type: 'error',
      text: redact(error?.stack || error?.message || String(error)),
    });
  });

  page.on('requestfailed', (request) => {
    if (paused) return;
    const url = request.url();
    const method = request.method();
    const failure = request.failure()?.errorText || '';
    if (expectedOffline && expectedOfflineFailure(failure)) return;
    if (shouldIgnoreRequestFailure(url, method, failure)) return;
    events.push({
      kind: 'requestfailed',
      type: 'error',
      url: redact(url),
      method,
      failure,
    });
  });

  page.on('response', (response) => {
    if (paused) return;
    const status = response.status();
    const url = response.url();
    if (status < 400 || shouldIgnoreUrl(url)) return;
    events.push({
      kind: 'response',
      type: 'error',
      status,
      url: redact(url),
      method: response.request().method(),
    });
  });

  async function flush() {
    const outDir = testInfo.outputPath('diagnostics');
    fs.mkdirSync(outDir, { recursive: true });
    const filePath = path.join(outDir, `${label}.browser-events.json`);
    const payload = redactTraceText(JSON.stringify(events, null, 2));
    const leaks = findSecretLeaks(payload);
    expect(leaks, `secret values leaked into ${label} browser diagnostics`).toEqual([]);
    expect(
      findTraceCredentialResidue(payload),
      `credential-shaped values leaked into ${label} browser diagnostics`,
    ).toEqual([]);
    fs.writeFileSync(filePath, payload);
    ledger.assertNoOpenCheckpoints();
    return events;
  }

  function actionableEvents() {
    return ledger.actionableEvents();
  }

  const controller = {
    events,
    flush,
    actionableEvents,
    checkpoint: ledger.checkpoint,
    acknowledgeExact: ledger.acknowledgeExact,
    assertExact: ledger.assertExact,
    pause() { paused = true; },
    resume() { paused = false; },
    setExpectedOffline(value) { expectedOffline = Boolean(value); },
  };
  const controllers = diagnosticControllers.get(page) || new Set();
  controllers.add(controller);
  diagnosticControllers.set(page, controllers);
  return controller;
}

export const test = base.extend({
  context: async ({ context }, use) => {
    await installRtcProbe(context);
    await context.grantPermissions(['camera', 'microphone'], { origin: smokeConfig.baseURL }).catch(() => null);
    await use(context);
  },

  page: async ({ page }, use, testInfo) => {
    const diagnostics = attachPageDiagnostics(page, testInfo, 'primary');
    await use(page);
    await diagnostics.flush();
    if (smokeConfig.flags.failOnBrowserErrors && testInfo.status === testInfo.expectedStatus) {
      expect(diagnostics.actionableEvents(), 'browser console, page, or network errors').toEqual([]);
    }
  },
});

export { expect };
