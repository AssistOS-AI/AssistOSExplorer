import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { inspectBoxWorkspace, validateSamePathWorkspaceMount } from './box-workspace.mjs';

import {
  buildBoxEvidence,
  normalizeOuterPortBindings,
  validateBoxEvidence,
} from './box-evidence.mjs';
import {
  assertRouterBindAddressLabel,
  DEFAULT_ROUTER_BIND_ADDRESS,
  readExpectedRouterBindAddress,
  validateRouterBindAddress,
} from './router-bind-address.mjs';

const BOX_ROLE_LABEL = 'io.assistos.ploinky-box.role';
const BOX_IMAGE_REF_LABEL = 'io.assistos.ploinky-box.image-ref';
const BOX_ROUTER_HOST_PORT_LABEL = 'io.assistos.ploinky-box.router-host-port';
const BOX_MEDIA_HOST_PORT_LABEL = 'io.assistos.ploinky-box.media-host-port';
const DEFAULT_GENERATION_MAX_AGE_MS = 30 * 60_000;
const DEFAULT_IMAGE_MAX_AGE_MS = 4 * 60 * 60_000;
const PLOINKY_SOURCE_DESTINATION = '/opt/ploinky';
const NESTED_PODMAN_SECCOMP_RELATIVE_PATH = 'ploinky-box/seccomp/podman-nested-pid-fallback.json';

function exactDate(value, name) {
  const milliseconds = Date.parse(String(value || ''));
  if (!Number.isFinite(milliseconds)) throw new Error(`${name} must be an ISO timestamp.`);
  return { text: new Date(milliseconds).toISOString(), milliseconds };
}

function positiveDuration(value, fallback, name) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer.`);
  return parsed;
}

function oneRecord(value, name) {
  const rows = Array.isArray(value) ? value : [value];
  if (rows.length !== 1 || !rows[0] || typeof rows[0] !== 'object' || Array.isArray(rows[0])) {
    throw new Error(`${name} must contain exactly one record.`);
  }
  return rows[0];
}

export function validateReadOnlyPloinkySourceMount(mounts, expectedSource, {
  realpathSync = fs.realpathSync,
} = {}) {
  if (!pathIsAbsolute(expectedSource)) {
    throw new Error('Verified Ploinky repository path must be absolute.');
  }
  if (!Array.isArray(mounts)) {
    throw new Error('Live Box inspection must include its exact mount inventory.');
  }
  const candidates = mounts.filter((mount) => (
    String(mount?.Destination ?? mount?.destination ?? '') === PLOINKY_SOURCE_DESTINATION
  ));
  if (candidates.length !== 1) {
    throw new Error(`Live Box must have exactly one ${PLOINKY_SOURCE_DESTINATION} source mount.`);
  }
  const mount = candidates[0];
  const type = String(mount?.Type ?? mount?.type ?? '').toLowerCase();
  const source = String(mount?.Source ?? mount?.source ?? '');
  const readWrite = mount?.RW ?? mount?.rw;
  if (type !== 'bind' || readWrite !== false || !pathIsAbsolute(source)) {
    throw new Error(`Live Box ${PLOINKY_SOURCE_DESTINATION} must be one absolute read-only bind mount.`);
  }
  let expectedRealpath;
  let sourceRealpath;
  try {
    expectedRealpath = realpathSync(expectedSource);
    sourceRealpath = realpathSync(source);
  } catch (error) {
    throw new Error(`Unable to resolve the live Box Ploinky source mount: ${error.message}`);
  }
  if (sourceRealpath !== expectedRealpath) {
    throw new Error('Live Box Ploinky source mount does not equal the verified Ploinky checkout.');
  }
  return Object.freeze({
    type: 'bind',
    source: sourceRealpath,
    destination: PLOINKY_SOURCE_DESTINATION,
    readWrite: false,
  });
}

export function validateWorkspaceSourceMount(mounts, expectedSource, {
  realpathSync = fs.realpathSync,
} = {}) {
  if (!pathIsAbsolute(expectedSource)) {
    throw new Error('Expected host workspace path must be absolute.');
  }
  let expectedRealpath;
  try {
    expectedRealpath = realpathSync(expectedSource);
  } catch (error) {
    throw new Error(`Unable to resolve the live Box workspace source mount: ${error.message}`);
  }
  return validateSamePathWorkspaceMount(mounts, expectedRealpath);
}

export function validateVerifiedSeccompRuntime(box, expectedPloinkySource, {
  fsApi = fs,
  realpathSync = fs.realpathSync,
} = {}) {
  if (!pathIsAbsolute(expectedPloinkySource)) {
    throw new Error('Verified Ploinky repository path must be absolute for seccomp evidence.');
  }
  const sourceRoot = realpathSync(expectedPloinkySource);
  const profilePath = path.join(sourceRoot, NESTED_PODMAN_SECCOMP_RELATIVE_PATH);
  const profileStat = fsApi.lstatSync(profilePath);
  if (profileStat.isSymbolicLink() || !profileStat.isFile()) {
    throw new Error('Verified nested-Podman seccomp profile must be one regular non-symlink file.');
  }
  if (realpathSync(profilePath) !== profilePath) {
    throw new Error('Verified nested-Podman seccomp profile must resolve inside the Ploinky repository.');
  }
  const profileBytes = fsApi.readFileSync(profilePath);
  let profile;
  try {
    profile = JSON.parse(profileBytes.toString('utf8'));
  } catch (error) {
    throw new Error(`Verified nested-Podman seccomp profile is not JSON: ${error.message}`);
  }
  const matching = profile?.syscalls?.filter((entry) => entry?.names?.includes('name_to_handle_at'));
  if (profile?.defaultAction !== 'SCMP_ACT_ERRNO'
      || JSON.stringify(matching?.map((entry) => ({
        action: entry.action,
        errnoRet: entry.errnoRet,
      }))) !== JSON.stringify([{ action: 'SCMP_ACT_ERRNO', errnoRet: 95 }])) {
    throw new Error('Verified nested-Podman seccomp profile does not preserve the ENOTSUP fallback contract.');
  }
  const fingerprint = crypto.createHash('sha256').update(profileBytes).digest('hex');
  if (box?.semanticLabels?.seccompFingerprint !== fingerprint) {
    throw new Error('Live Box seccomp fingerprint label does not match the verified Ploinky profile bytes.');
  }
  const expectedSecurityOptions = [
    'label=disable',
    `seccomp=${profilePath}`,
    'unmask=all',
  ].sort();
  if (JSON.stringify(box?.securityOptions) !== JSON.stringify(expectedSecurityOptions)) {
    throw new Error('Live Box SecurityOpt does not apply the verified Ploinky seccomp profile exactly.');
  }
  return Object.freeze({
    path: profilePath,
    fingerprint,
    securityOptions: Object.freeze(expectedSecurityOptions),
  });
}

function pathIsAbsolute(value) {
  return typeof value === 'string' && value.length > 0 && value.startsWith('/');
}

export function validateBoxFreshness({
  capturedAt,
  imageCreatedAt,
  box,
  generationMaxAgeMs,
  imageMaxAgeMs,
  requireFreshImage = true,
} = {}, {
  nowMs = Date.now(),
} = {}) {
  if (!box || typeof box !== 'object' || Array.isArray(box)) {
    throw new Error('Box freshness requires exact Box evidence.');
  }
  const captured = exactDate(capturedAt, 'Box freshness capturedAt');
  const imageCreated = exactDate(imageCreatedAt, 'Box freshness imageCreatedAt');
  const started = exactDate(box.startedAt, 'Box freshness box startedAt');
  const maxGenerationAge = Math.min(
    positiveDuration(
      generationMaxAgeMs,
      DEFAULT_GENERATION_MAX_AGE_MS,
      'Box generation max age',
    ),
    DEFAULT_GENERATION_MAX_AGE_MS,
  );
  const enforceImageFreshness = requireFreshImage !== false;
  const maxImageAge = enforceImageFreshness
    ? Math.min(
      positiveDuration(
        imageMaxAgeMs,
        DEFAULT_IMAGE_MAX_AGE_MS,
        'Box image max age',
      ),
      DEFAULT_IMAGE_MAX_AGE_MS,
    )
    : null;
  if (captured.milliseconds > nowMs + 30_000 || nowMs - captured.milliseconds > 60_000) {
    throw new Error('Box freshness evidence is stale or from the future.');
  }
  if (started.milliseconds > nowMs + 30_000 || nowMs - started.milliseconds > maxGenerationAge) {
    throw new Error('Box outer container generation is not fresh enough for the release gate.');
  }
  if (
    enforceImageFreshness
    && (imageCreated.milliseconds > nowMs + 30_000 || nowMs - imageCreated.milliseconds > maxImageAge)
  ) {
    throw new Error('Box outer image is not fresh enough for the release gate.');
  }
  if (imageCreated.milliseconds > started.milliseconds + 30_000) {
    throw new Error('Box outer image creation is later than the running container generation.');
  }
  return Object.freeze({
    capturedAt: captured.text,
    imageCreatedAt: imageCreated.text,
    generationMaxAgeMs: maxGenerationAge,
    imageMaxAgeMs: maxImageAge,
    requireFreshImage: enforceImageFreshness,
  });
}

export function verifyNetworkLaneCompletion({
  lane,
  laneResult,
  beforeBox,
  collectAfter,
} = {}) {
  const failures = [];
  if (laneResult?.error) {
    failures.push(laneResult.error);
  } else if (laneResult?.status !== 0) {
    failures.push(new Error(`WebMeet ${lane} lane failed with exit ${laneResult?.status ?? 'unknown'}.`));
  }
  let after = null;
  try {
    after = collectAfter();
    if (JSON.stringify(after?.box) !== JSON.stringify(beforeBox)) {
      throw new Error(`The exact Box outer container generation changed during the ${lane} lane.`);
    }
  } catch (error) {
    failures.push(error);
  }
  if (failures.length) {
    throw new AggregateError(failures, `WebMeet ${lane} lane or post-lane runtime evidence failed.`);
  }
  return after;
}

function defaultCommand(command, args, { json = false } = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: 10_000,
    killSignal: 'SIGKILL',
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

export function parseLocalScreenBaseUrl(baseURL) {
  let parsed;
  try {
    parsed = new URL(String(baseURL || ''));
  } catch (_) {
    throw new Error('SMOKE_WEBMEET_SCREEN requires an exact loopback HTTP SMOKE_BASE_URL.');
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
    throw new Error('SMOKE_WEBMEET_SCREEN requires SMOKE_BASE_URL=http://127.0.0.1:<selectedRouterHostPort>.');
  }
  const port = parsed.port || '80';
  if (!/^[1-9][0-9]*$/.test(port) || Number(port) > 65_535) {
    throw new Error('SMOKE_WEBMEET_SCREEN loopback URL has an invalid port.');
  }
  return Object.freeze({ baseURL: `http://127.0.0.1:${port}`, port });
}

function exactScreenBindings(port, mediaPort, expectedRouterBindAddress) {
  return normalizeOuterPortBindings({
    '8080/tcp': [{ HostIp: expectedRouterBindAddress, HostPort: port }],
    '7882/udp': [{ HostIp: '0.0.0.0', HostPort: mediaPort }],
  });
}

export function selectLocalScreenContainer(containerInspects, port, { expectedRouterBindAddress = DEFAULT_ROUTER_BIND_ADDRESS } = {}) {
  const bindAddress = validateRouterBindAddress(expectedRouterBindAddress);
  if (!Array.isArray(containerInspects)) throw new Error('Running outer container inspection must be an array.');
  const candidates = containerInspects.filter((container) => {
    if (container?.State?.Running !== true) return false;
    const labels = container?.Config?.Labels;
    if (labels?.[BOX_ROLE_LABEL] !== 'box') return false;
    if (labels[BOX_ROUTER_HOST_PORT_LABEL] !== String(port)) return false;
    try {
      assertRouterBindAddressLabel(labels, bindAddress);
      const expected = JSON.stringify(exactScreenBindings(port, labels[BOX_MEDIA_HOST_PORT_LABEL], bindAddress));
      return JSON.stringify(normalizeOuterPortBindings(container?.HostConfig?.PortBindings)) === expected;
    } catch (_) {
      return false;
    }
  });
  if (candidates.length !== 1) {
    throw new Error(`Smoke evidence requires exactly one running Box outer container with the exact ${bindAddress}:${port}:8080/tcp and 0.0.0.0:<media-host-port label>:7882/udp publications; found ${candidates.length}.`);
  }
  return candidates[0];
}

export function validateLiveBoxEvidence(input, {
  baseURL,
  expectedRouterBindAddress = DEFAULT_ROUTER_BIND_ADDRESS,
  nowMs = Date.now(),
  generationMaxAgeMs,
  imageMaxAgeMs,
  requireFreshImage,
} = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Live Box evidence must be an object.');
  }
  const local = parseLocalScreenBaseUrl(baseURL);
  const box = validateBoxEvidence(input.box, {
    expectedContainerName: input.box?.containerName,
    expectedImageId: input.box?.imageId,
    expectedImageRef: input.box?.imageRef,
    baseURL: local.baseURL,
    publicIPv4: String(input.box?.publicIPv4 || ''),
    expectedRouterBindAddress,
  });
  if (box.selectedRouterHostPort !== local.port) {
    throw new Error('Live Box Router publication does not match SMOKE_BASE_URL.');
  }
  const freshness = validateBoxFreshness({
    capturedAt: input.capturedAt,
    imageCreatedAt: input.imageCreatedAt,
    box,
    generationMaxAgeMs: generationMaxAgeMs ?? input.generationMaxAgeMs,
    imageMaxAgeMs: imageMaxAgeMs ?? input.imageMaxAgeMs,
    requireFreshImage: requireFreshImage ?? input.requireFreshImage,
  }, { nowMs });
  return Object.freeze({
    ...freshness,
    box,
  });
}

export function collectLiveBoxEvidence({
  baseURL,
  expectedRouterBindAddress = readExpectedRouterBindAddress(),
  expectedContainerName = '',
  expectedImageId = '',
  expectedImageRef = '',
  publicIPv4 = '',
  generationMaxAgeMs = DEFAULT_GENERATION_MAX_AGE_MS,
  imageMaxAgeMs = DEFAULT_IMAGE_MAX_AGE_MS,
  requireFreshImage = true,
  expectedPloinkySource = '',
  expectedWorkspaceSource = String(process.env.SMOKE_WORKSPACE_ROOT || ''),
  nowMs = Date.now(),
  command = defaultCommand,
  realpathSync = fs.realpathSync,
} = {}) {
  const local = parseLocalScreenBaseUrl(baseURL);
  const ids = String(command('podman', [
    'container', 'ls', '--filter', 'status=running', '--quiet', '--no-trunc',
  ]) || '').split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  if (!ids.length) throw new Error('SMOKE_WEBMEET_SCREEN found no running Podman containers.');
  const containers = command('podman', ['container', 'inspect', ...ids], { json: true });
  const selected = selectLocalScreenContainer(containers, local.port, { expectedRouterBindAddress });
  const containerName = String(selected.Name || '').replace(/^\//, '');
  const labels = selected?.Config?.Labels || {};
  const imageRef = String(labels[BOX_IMAGE_REF_LABEL] || '').trim();
  if (!imageRef) throw new Error('Selected live Box outer container has no image-ref label.');
  const selectedImageId = String(selected.Image || selected.ImageID || '').trim();
  if (expectedContainerName && containerName !== expectedContainerName) {
    throw new Error(`Selected local screen outer container does not equal ${expectedContainerName}.`);
  }
  const requiredImageId = expectedImageId || selectedImageId;
  const requiredImageRef = expectedImageRef || imageRef;
  const imageInspection = command('podman', ['image', 'inspect', requiredImageId], { json: true });
  const image = oneRecord(imageInspection, 'outer image inspection');
  const box = buildBoxEvidence({
    containerInspect: [selected],
    imageInspect: imageInspection,
    expectedContainerName: expectedContainerName || containerName,
    expectedImageId: requiredImageId,
    expectedImageRef: requiredImageRef,
    baseURL: local.baseURL,
    publicIPv4: String(publicIPv4 || ''),
    expectedRouterBindAddress,
  });
  const validated = validateLiveBoxEvidence({
    capturedAt: new Date(nowMs).toISOString(),
    imageCreatedAt: image.Created,
    generationMaxAgeMs: positiveDuration(generationMaxAgeMs, DEFAULT_GENERATION_MAX_AGE_MS, 'SMOKE_BOX_MAX_GENERATION_AGE_MS'),
    imageMaxAgeMs: requireFreshImage
      ? positiveDuration(imageMaxAgeMs, DEFAULT_IMAGE_MAX_AGE_MS, 'SMOKE_BOX_MAX_IMAGE_AGE_MS')
      : null,
    requireFreshImage,
    box,
  }, { baseURL: local.baseURL, nowMs, expectedRouterBindAddress });
  const observedWorkspace = inspectBoxWorkspace(selected);
  const ploinkySourceMount = expectedPloinkySource
    ? validateReadOnlyPloinkySourceMount(
      selected?.Mounts,
      expectedPloinkySource,
      { realpathSync },
    )
    : null;
  const workspaceSourceMount = expectedWorkspaceSource
    ? validateWorkspaceSourceMount(
      selected?.Mounts,
      expectedWorkspaceSource,
      { realpathSync },
    )
    : observedWorkspace;
  if (workspaceSourceMount.source !== observedWorkspace.source) {
    throw new Error('Live Box runtime workspace does not equal the selected host workspace.');
  }
  const seccompProfile = ploinkySourceMount
    ? validateVerifiedSeccompRuntime(validated.box, ploinkySourceMount.source, {
      fsApi: fs,
      realpathSync,
    })
    : null;
  return Object.freeze({
    ...validated,
    ...(ploinkySourceMount ? { ploinkySourceMount, seccompProfile } : {}),
    ...(workspaceSourceMount ? { workspaceSourceMount } : {}),
  });
}

export function sameLiveBoxGeneration(left, right) {
  return Boolean(
    left?.box?.containerId
    && left.box.containerId === right?.box?.containerId
    && left.box.startedAt === right?.box?.startedAt
    && left.box.imageId === right?.box?.imageId
    && left.box.semanticLabels
    && JSON.stringify(left.box.semanticLabels) === JSON.stringify(right?.box?.semanticLabels)
    && JSON.stringify(left.box.normalizedPortBindings) === JSON.stringify(right?.box?.normalizedPortBindings)
    && JSON.stringify(left.ploinkySourceMount ?? null) === JSON.stringify(right?.ploinkySourceMount ?? null)
    && JSON.stringify(left.seccompProfile ?? null) === JSON.stringify(right?.seccompProfile ?? null)
    && JSON.stringify(left.workspaceSourceMount ?? null) === JSON.stringify(right?.workspaceSourceMount ?? null)
  );
}
