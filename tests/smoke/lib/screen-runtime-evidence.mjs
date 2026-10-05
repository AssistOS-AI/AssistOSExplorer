import { spawnSync } from 'node:child_process';

import {
  collectLiveBoxEvidence,
  sameLiveBoxGeneration,
  validateLiveBoxEvidence,
} from './live-box.mjs';
import { imageAgentLibSourceIdHash, normalizeOuterPortBindings, readExpectedGpuGrant, readExpectedHardwareLimits, readExpectedMpsTools } from './box-evidence.mjs';

const MANAGED_LABEL = 'io.assistos.ploinky.managed';
const BOX_ROLE_LABEL = 'io.assistos.ploinky-box.role';
const DEFAULT_GENERATION_MAX_AGE_MS = 30 * 60_000;
const LIVEKIT_NAME = /(?:^|_)liveKitServerAgent(?:_|$)/;
const UDP_MUX_PORT = 7882;
const LISTENER_COMMAND = Object.freeze(['ss', '-H', '-lun', 'sport = :7882']);

function exactRecord(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must be an object.`);
  }
  return value;
}

// A local checkout is identified by its content fingerprint and Git commit; the
// copy a Box image supplies only by that outer image and the library.
function boxAgentLibLabelsMatch(labels, imageId) {
  if (!/^[0-9a-f]{64}$/.test(String(labels.agentLibSourceIdHash || ''))) return false;
  if (labels.agentLibMode === 'image') {
    return labels.agentLibSourceRelativePath === 'image'
      && labels.agentLibSourceIdHash === imageAgentLibSourceIdHash(imageId)
      && !Object.hasOwn(labels, 'agentLibFingerprint')
      && !Object.hasOwn(labels, 'agentLibCommit');
  }
  return ['local', 'managed'].includes(labels.agentLibMode)
    && /^[0-9a-f]{64}$/.test(String(labels.agentLibFingerprint || ''))
    && String(labels.agentLibSourceRelativePath || '').length > 0
    && !String(labels.agentLibSourceRelativePath).startsWith('/')
    && !String(labels.agentLibSourceRelativePath).split('/').includes('..')
    && (labels.agentLibCommit === ''
      || /^[0-9a-f]{40}$/.test(String(labels.agentLibCommit || '')));
}

function exactDate(value, name) {
  const milliseconds = Date.parse(String(value || ''));
  if (!Number.isFinite(milliseconds)) throw new Error(`${name} must be an ISO timestamp.`);
  return { text: new Date(milliseconds).toISOString(), milliseconds };
}

function exactContainerId(value, name) {
  const text = String(value || '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(text)) throw new Error(`${name} must be an exact 64-hex container ID.`);
  return text;
}

function positiveDuration(value, fallback, name) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer.`);
  return parsed;
}

function parseLoopbackBaseUrl(baseURL) {
  let parsed;
  try {
    parsed = new URL(String(baseURL || ''));
  } catch (_) {
    throw new Error('Screen-share smoke requires an exact loopback HTTP SMOKE_BASE_URL.');
  }
  if (
    parsed.protocol !== 'http:'
    || parsed.hostname !== '127.0.0.1'
    || parsed.username
    || parsed.password
    || (parsed.pathname !== '/' && parsed.pathname !== '')
    || parsed.search
    || parsed.hash
  ) {
    throw new Error('Screen-share smoke requires SMOKE_BASE_URL=http://127.0.0.1:<router-port>.');
  }
  return `http://127.0.0.1:${parsed.port || '80'}`;
}

function defaultCommand(command, args, { json = false } = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit ${result.status ?? 'unknown'}: ${String(result.stderr || '').trim()}`);
  }
  if (!json) return String(result.stdout || '');
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`${command} returned invalid JSON: ${error.message}`);
  }
}

function runningContainerIds(output, name) {
  const ids = String(output || '').split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  for (const id of ids) exactContainerId(id, `${name} container ID`);
  return ids;
}

function liveKitCandidates(containers) {
  return containers.filter((container) => {
    const name = String(container?.Name || '').replace(/^\//, '');
    const labels = container?.Config?.Labels || {};
    return container?.State?.Running === true
      && labels[MANAGED_LABEL] === '1'
      && LIVEKIT_NAME.test(name);
  });
}

function parseUdpListenerLine(line, name) {
  const text = String(line || '').trim();
  const columns = text.split(/\s+/);
  if (columns.length < 5 || columns[0] !== 'UNCONN') {
    throw new Error(`${name} must be an ss UDP UNCONN row.`);
  }
  const localEndpoint = columns[3];
  const match = localEndpoint.match(/^(.+):([0-9]+)$/);
  if (!match || Number(match[2]) !== UDP_MUX_PORT) {
    throw new Error(`${name} must bind UDP ${UDP_MUX_PORT}.`);
  }
  return Object.freeze({
    raw: text,
    localAddress: match[1],
    localPort: UDP_MUX_PORT,
  });
}

function validateUdpListener(input, {
  namespace,
  outerContainerId = '',
} = {}) {
  const listener = exactRecord(input, 'LiveKit UDP listener evidence');
  if (listener.namespace !== namespace) {
    throw new Error(`LiveKit UDP listener namespace must equal ${namespace}.`);
  }
  if (JSON.stringify(listener.command) !== JSON.stringify(LISTENER_COMMAND)) {
    throw new Error('LiveKit UDP listener evidence must use the exact ss command.');
  }
  if (!Array.isArray(listener.lines) || listener.lines.length < 1) {
    throw new Error(`LiveKit must have a real UDP listener on ${UDP_MUX_PORT}.`);
  }
  const lines = listener.lines.map((line, index) => {
    const parsed = parseUdpListenerLine(line, `LiveKit UDP listener line ${index}`);
    return parsed.raw;
  });
  const boundOuterContainerId = String(listener.outerContainerId || '');
  if (namespace === 'box-nested-livekit') {
    if (exactContainerId(boundOuterContainerId, 'listener outer Box container ID') !== outerContainerId) {
      throw new Error('Nested LiveKit UDP listener proof is not bound to the exact outer Box generation.');
    }
  } else if (boundOuterContainerId) {
    throw new Error('Host-local LiveKit UDP listener proof must not claim an outer Box container.');
  }
  return Object.freeze({
    namespace,
    outerContainerId: boundOuterContainerId,
    command: LISTENER_COMMAND,
    lines: Object.freeze(lines),
  });
}

function collectUdpListener(command, {
  liveKitContainerId,
  namespace,
  outerContainerId = '',
}) {
  const execArgs = namespace === 'box-nested-livekit'
    ? ['exec', outerContainerId, 'podman', 'exec', liveKitContainerId, ...LISTENER_COMMAND]
    : ['exec', liveKitContainerId, ...LISTENER_COMMAND];
  const output = command('podman', execArgs);
  return {
    namespace,
    outerContainerId,
    command: LISTENER_COMMAND,
    lines: String(output || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
  };
}

function validateLiveKitEvidence(input, {
  capturedAtMs,
  nowMs,
  generationMaxAgeMs,
  namespace,
  outerContainerId = '',
} = {}) {
  const liveKit = exactRecord(input, 'screen runtime LiveKit evidence');
  if (!LIVEKIT_NAME.test(String(liveKit.containerName || ''))) {
    throw new Error('Screen runtime evidence does not identify the LiveKit agent container.');
  }
  const containerId = exactContainerId(liveKit.containerId, 'LiveKit container ID');
  const startedAt = exactDate(liveKit.startedAt, 'LiveKit State.StartedAt');
  if (startedAt.milliseconds > nowMs + 30_000 || nowMs - startedAt.milliseconds > generationMaxAgeMs) {
    throw new Error('LiveKit container is not fresh enough for the smoke gate.');
  }
  if (startedAt.milliseconds > capturedAtMs + 30_000) {
    throw new Error('LiveKit container start is later than the runtime evidence capture.');
  }
  if (liveKit.networkMode !== 'host') {
    throw new Error('LiveKit must own its Podman host network for the fixed UDP media mux.');
  }
  const portBindings = exactRecord(liveKit.portBindings, 'LiveKit HostConfig.PortBindings');
  if (Object.keys(portBindings).length !== 0) {
    throw new Error('LiveKit must have zero inner PortBindings while using host networking.');
  }
  return Object.freeze({
    containerName: String(liveKit.containerName),
    containerId,
    startedAt: startedAt.text,
    networkMode: 'host',
    portBindings: Object.freeze({}),
    udpListener: validateUdpListener(liveKit.udpListener, { namespace, outerContainerId }),
  });
}

function collectInspectedLiveKit({
  containers,
  command,
  namespace,
  outerContainerId = '',
}) {
  if (!Array.isArray(containers)) throw new Error('Running Podman container inspection must be an array.');
  const candidates = liveKitCandidates(containers);
  if (candidates.length !== 1) {
    throw new Error(`Screen smoke requires exactly one managed liveKitServerAgent container; found ${candidates.length}.`);
  }
  const selected = candidates[0];
  const containerId = exactContainerId(selected.Id || selected.ID, 'selected LiveKit container ID');
  return {
    containerName: String(selected.Name || '').replace(/^\//, ''),
    containerId,
    startedAt: selected?.State?.StartedAt,
    networkMode: String(selected?.HostConfig?.NetworkMode || ''),
    portBindings: selected?.HostConfig?.PortBindings || {},
    udpListener: collectUdpListener(command, {
      liveKitContainerId: containerId,
      namespace,
      outerContainerId,
    }),
  };
}

export function validateHostLocalScreenEvidence(input, {
  baseURL,
  nowMs = Date.now(),
  generationMaxAgeMs = DEFAULT_GENERATION_MAX_AGE_MS,
} = {}) {
  const evidence = exactRecord(input, 'host-local screen evidence');
  if (evidence.deployment !== 'local') throw new Error('Host-local screen evidence deployment must equal local.');
  const expectedBaseURL = parseLoopbackBaseUrl(baseURL);
  if (evidence.baseURL !== expectedBaseURL) throw new Error('Host-local screen evidence base URL mismatch.');
  if (evidence.outerBoxCount !== 0) throw new Error('Host-local screen evidence must not include an outer Ploinky Box.');
  const capturedAt = exactDate(evidence.capturedAt, 'host-local screen evidence capturedAt');
  const maxAge = positiveDuration(
    generationMaxAgeMs,
    DEFAULT_GENERATION_MAX_AGE_MS,
    'host-local generation max age',
  );
  if (capturedAt.milliseconds > nowMs + 30_000 || nowMs - capturedAt.milliseconds > 60_000) {
    throw new Error('Host-local screen evidence is stale or from the future.');
  }
  return Object.freeze({
    deployment: 'local',
    capturedAt: capturedAt.text,
    baseURL: expectedBaseURL,
    outerBoxCount: 0,
    liveKit: validateLiveKitEvidence(evidence.liveKit, {
      capturedAtMs: capturedAt.milliseconds,
      nowMs,
      generationMaxAgeMs: maxAge,
      namespace: 'host-local-livekit',
    }),
  });
}

export function collectHostLocalScreenEvidence({
  baseURL,
  nowMs = Date.now(),
  generationMaxAgeMs = DEFAULT_GENERATION_MAX_AGE_MS,
  command = defaultCommand,
} = {}) {
  const ids = runningContainerIds(command('podman', [
    'container', 'ls', '--filter', 'status=running', '--quiet', '--no-trunc',
  ]), 'host-local');
  if (!ids.length) throw new Error('Screen-share smoke found no running Podman containers.');
  const containers = command('podman', ['container', 'inspect', ...ids], { json: true });
  const outerBoxCount = containers.filter((container) => (
    container?.Config?.Labels?.[BOX_ROLE_LABEL] === 'box'
  )).length;
  return validateHostLocalScreenEvidence({
    deployment: 'local',
    capturedAt: new Date(nowMs).toISOString(),
    baseURL: parseLoopbackBaseUrl(baseURL),
    outerBoxCount,
    liveKit: collectInspectedLiveKit({
      containers,
      command,
      namespace: 'host-local-livekit',
    }),
  }, {
    baseURL,
    nowMs,
    generationMaxAgeMs,
  });
}

export function validateBoxScreenEvidence(input, {
  baseURL,
  nowMs = Date.now(),
  generationMaxAgeMs = DEFAULT_GENERATION_MAX_AGE_MS,
  imageMaxAgeMs,
  expectedGpuGrant = null,
  expectedHardwareLimits = null,
  expectedMpsTools = null,
} = {}) {
  const evidence = exactRecord(input, 'Box screen evidence');
  if (evidence.deployment !== 'box') throw new Error('Box screen evidence deployment must equal box.');
  const expectedBaseURL = parseLoopbackBaseUrl(baseURL);
  if (evidence.baseURL !== expectedBaseURL) throw new Error('Box screen evidence base URL mismatch.');
  const capturedAt = exactDate(evidence.capturedAt, 'Box screen evidence capturedAt');
  if (capturedAt.milliseconds > nowMs + 30_000 || nowMs - capturedAt.milliseconds > 60_000) {
    throw new Error('Box screen evidence is stale or from the future.');
  }
  const box = validateLiveBoxEvidence(evidence.box, {
    baseURL: expectedBaseURL,
    nowMs,
    generationMaxAgeMs,
    imageMaxAgeMs,
    expectedGpuGrant,
    expectedHardwareLimits,
    expectedMpsTools,
  });
  if (box.capturedAt !== capturedAt.text) {
    throw new Error('Box screen evidence capture is not bound to its exact outer Box evidence.');
  }
  return Object.freeze({
    deployment: 'box',
    capturedAt: capturedAt.text,
    baseURL: expectedBaseURL,
    box,
    liveKit: validateLiveKitEvidence(evidence.liveKit, {
      capturedAtMs: capturedAt.milliseconds,
      nowMs,
      generationMaxAgeMs: positiveDuration(
        generationMaxAgeMs,
        DEFAULT_GENERATION_MAX_AGE_MS,
        'Box nested LiveKit generation max age',
      ),
      namespace: 'box-nested-livekit',
      outerContainerId: box.box.containerId,
    }),
  });
}

export function collectBoxScreenEvidence({
  baseURL,
  nowMs = Date.now(),
  generationMaxAgeMs = DEFAULT_GENERATION_MAX_AGE_MS,
  imageMaxAgeMs,
  expectedGpuGrant = readExpectedGpuGrant(),
  expectedHardwareLimits = readExpectedHardwareLimits(),
  expectedMpsTools = readExpectedMpsTools(),
  command = defaultCommand,
  ...boxOptions
} = {}) {
  const box = collectLiveBoxEvidence({
    ...boxOptions,
    baseURL,
    nowMs,
    generationMaxAgeMs,
    imageMaxAgeMs,
    expectedGpuGrant,
    expectedHardwareLimits,
    expectedMpsTools,
    command,
  });
  const outerContainerId = box.box.containerId;
  const nestedIds = runningContainerIds(command('podman', [
    'exec', outerContainerId,
    'podman', 'container', 'ls', '--filter', 'status=running', '--quiet', '--no-trunc',
  ]), 'nested');
  if (!nestedIds.length) throw new Error('Box screen smoke found no running nested Podman containers.');
  const containers = command('podman', [
    'exec', outerContainerId,
    'podman', 'container', 'inspect', ...nestedIds,
  ], { json: true });
  return validateBoxScreenEvidence({
    deployment: 'box',
    capturedAt: new Date(nowMs).toISOString(),
    baseURL: parseLoopbackBaseUrl(baseURL),
    box,
    liveKit: collectInspectedLiveKit({
      containers,
      command,
      namespace: 'box-nested-livekit',
      outerContainerId,
    }),
  }, {
    baseURL,
    nowMs,
    generationMaxAgeMs,
    imageMaxAgeMs,
    expectedGpuGrant,
    expectedHardwareLimits,
    expectedMpsTools,
  });
}

export function collectScreenRuntimeEvidence({
  deployment,
  ...options
} = {}) {
  if (deployment === 'local') return collectHostLocalScreenEvidence(options);
  if (deployment === 'box') return collectBoxScreenEvidence(options);
  throw new Error('SMOKE_DEPLOYMENT_MODE must be local or box when screen sharing is enabled.');
}

export function validateScreenRuntimeEvidence(input, {
  baseURL,
  nowMs = Date.now(),
  expectedGpuGrant = null,
  expectedHardwareLimits = null,
  expectedMpsTools = null,
} = {}) {
  const evidence = exactRecord(input, 'screen runtime evidence');
  if (evidence.deployment === 'local') {
    return validateHostLocalScreenEvidence(evidence, { baseURL, nowMs });
  }
  if (evidence.deployment === 'box') {
    return validateBoxScreenEvidence(evidence, { baseURL, nowMs, expectedGpuGrant, expectedHardwareLimits, expectedMpsTools });
  }
  throw new Error('Screen runtime evidence deployment must be local or box.');
}

export function sameScreenRuntimeGeneration(before, after) {
  if (before?.deployment !== after?.deployment) return false;
  const sameLiveKit = before?.liveKit?.containerId
    && before.liveKit.containerId === after?.liveKit?.containerId
    && before.liveKit.startedAt === after?.liveKit?.startedAt
    && before.liveKit.networkMode === after?.liveKit?.networkMode
    && JSON.stringify(before.liveKit.portBindings) === JSON.stringify(after?.liveKit?.portBindings);
  if (!sameLiveKit || before.baseURL !== after.baseURL) return false;
  if (before.deployment === 'local') return before.outerBoxCount === 0 && after.outerBoxCount === 0;
  if (before.deployment === 'box') return sameLiveBoxGeneration(before.box, after.box);
  return false;
}

export function screenRuntimeEvidenceProvesUdpMux(evidence) {
  try {
    const input = exactRecord(evidence, 'screen runtime evidence');
    const namespace = input.deployment === 'box' ? 'box-nested-livekit' : 'host-local-livekit';
    if (!['local', 'box'].includes(input.deployment)) return false;
    const capturedAt = exactDate(input.capturedAt, 'screen runtime evidence capturedAt');
    const liveKit = exactRecord(input.liveKit, 'screen runtime LiveKit evidence');
    if (!LIVEKIT_NAME.test(String(liveKit.containerName || ''))) return false;
    exactContainerId(liveKit.containerId, 'LiveKit container ID');
    const liveKitStartedAt = exactDate(liveKit.startedAt, 'LiveKit State.StartedAt');
    if (liveKitStartedAt.milliseconds > capturedAt.milliseconds + 30_000) return false;
    if (liveKit.networkMode !== 'host') return false;
    if (Object.keys(exactRecord(liveKit.portBindings, 'LiveKit PortBindings')).length !== 0) return false;
    const outerContainerId = input.deployment === 'box'
      ? exactContainerId(input.box?.box?.containerId, 'outer Box container ID')
      : '';
    validateUdpListener(liveKit.udpListener, { namespace, outerContainerId });
    if (input.deployment === 'local') return input.outerBoxCount === 0;
    const box = exactRecord(input.box?.box, 'outer Box evidence');
    const boxCapturedAt = exactDate(input.box?.capturedAt, 'outer Box evidence capturedAt');
    const boxStartedAt = exactDate(box.startedAt, 'outer Box State.StartedAt');
    if (boxCapturedAt.text !== capturedAt.text) return false;
    if (boxStartedAt.milliseconds > capturedAt.milliseconds + 30_000) return false;
    if (!/^sha256:[0-9a-f]{64}$/.test(String(box.imageId || '').toLowerCase())) return false;
    const selectedRouterHostPort = String(box.selectedRouterHostPort || '');
    if (!/^[1-9][0-9]*$/.test(selectedRouterHostPort) || Number(selectedRouterHostPort) > 65_535) return false;
    const expectedBindings = normalizeOuterPortBindings({
      '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: selectedRouterHostPort }],
      '7882/udp': [{ HostIp: '0.0.0.0', HostPort: '7882' }],
    });
    return box.semanticLabels?.role === 'box'
      && /^[0-9a-f]{12}$/.test(String(box.semanticLabels.pathHash || '').toLowerCase())
      && box.semanticLabels.imageRef === box.imageRef
      && box.semanticLabels.routerHostPort === selectedRouterHostPort
      && box.semanticLabels.mediaHostPort === '7882'
      && /^[0-9a-f]{64}$/.test(String(box.semanticLabels.dependenciesFingerprint || ''))
      && /^[0-9a-f]{64}$/.test(String(box.semanticLabels.imagesFingerprint || ''))
      && boxAgentLibLabelsMatch(box.semanticLabels, String(box.imageId).toLowerCase())
      && JSON.stringify(normalizeOuterPortBindings(box.normalizedPortBindings))
        === JSON.stringify(expectedBindings);
  } catch (_) {
    return false;
  }
}
