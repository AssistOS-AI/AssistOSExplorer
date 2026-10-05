import { createHash } from 'node:crypto';
import path from 'node:path';
import { inspectBoxWorkspace } from './box-workspace.mjs';
import {
  assertRouterBindAddressLabel,
  DEFAULT_ROUTER_BIND_ADDRESS,
  ROUTER_BIND_ADDRESS_LABEL,
  validateRouterBindAddress,
} from './router-bind-address.mjs';

const BOX_LABELS = Object.freeze({
  role: 'io.assistos.ploinky-box.role',
  pathHash: 'io.assistos.ploinky-box.path-hash',
  imageRef: 'io.assistos.ploinky-box.image-ref',
  routerHostPort: 'io.assistos.ploinky-box.router-host-port',
  mediaHostPort: 'io.assistos.ploinky-box.media-host-port',
  seccompFingerprint: 'io.assistos.ploinky-box.seccomp-fingerprint',
  dependenciesFingerprint: 'io.assistos.ploinky-box.dependencies-fingerprint',
  imagesFingerprint: 'io.assistos.ploinky-box.images-fingerprint',
  agentLibMode: 'io.assistos.ploinky-box.agentlib-mode',
  agentLibSourceIdHash: 'io.assistos.ploinky-box.agentlib-source-id',
  agentLibFingerprint: 'io.assistos.ploinky-box.agentlib-fingerprint',
  agentLibSourceRelativePath: 'io.assistos.ploinky-box.agentlib-source-path',
  agentLibCommit: 'io.assistos.ploinky-box.agentlib-commit',
});
// Ploinky adds this label and a read-only grant marker from the grant's
// fingerprint directory whenever the Box has GPU wiring. Active wiring also
// binds the CDI spec from that same directory and the NVIDIA driver files
// under /usr/local/nvidia; stale or revoked wiring binds only the marker. A
// gate accepts that surface only when the operator names the exact
// fingerprint in SMOKE_BOX_GPU_GRANT.
export const GPU_GRANT_LABEL = 'io.assistos.ploinky-box.gpu-grant';
export const HARDWARE_LIMITS_LABEL = 'io.assistos.ploinky-box.hardware-limits';
const HARDWARE_MARKER_PATH = '/etc/ploinky-box-hardware-limits.json';
const HARDWARE_STORE_PATH = '/run/ploinky/hardware-limits';
const MPS_TOOLS = ['/usr/local/nvidia/bin/nvidia-cuda-mps-control', '/usr/local/nvidia/bin/nvidia-cuda-mps-server'];
const GPU_GRANT_MARKER_PATH = '/etc/ploinky-box-gpu-grant.json';
const GPU_GRANT_CDI_SPEC_PATH = '/etc/cdi/ploinky-gpu.json';
const GPU_DRIVER_DIRECTORY = '/usr/local/nvidia';
const ROUTER_TARGET = '8080/tcp';
const MEDIA_TARGET = '7882/udp';
const TCP_SCAN_START = 1;
const TCP_SCAN_END = 65_535;

function record(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must be an object.`);
  }
  return value;
}

function exactString(value, name) {
  const text = String(value || '').trim();
  if (!text) throw new Error(`${name} is required.`);
  return text;
}

function exactPort(value, name) {
  const text = String(value ?? '');
  if (!/^[1-9][0-9]*$/.test(text) || Number(text) > 65_535) {
    throw new Error(`${name} must be an exact TCP/UDP port.`);
  }
  return text;
}

function exactImageId(value, name) {
  const text = exactString(value, name).toLowerCase();
  if (/^[0-9a-f]{64}$/.test(text)) return `sha256:${text}`;
  if (!/^sha256:[0-9a-f]{64}$/.test(text)) {
    throw new Error(`${name} must be an exact sha256 image ID.`);
  }
  return text;
}

function exactContainerId(value, name) {
  const text = exactString(value, name).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(text)) {
    throw new Error(`${name} must be an exact 64-hex container ID.`);
  }
  return text;
}

function exactSha256(value, name) {
  const text = exactString(value, name).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(text)) throw new Error(`${name} must be a SHA-256 digest.`);
  return text;
}

function exactPathHash(value, name) {
  const text = exactString(value, name);
  if (!/^[0-9a-f]{12}$/.test(text)) {
    throw new Error(`${name} must be exactly 12 lowercase hexadecimal characters.`);
  }
  return text;
}

function exactAgentLibMode(value, name) {
  const text = exactString(value, name);
  if (!['local', 'managed', 'image'].includes(text)) {
    throw new Error(`${name} must be local, managed, or image.`);
  }
  return text;
}

function exactAgentLibSourceRelativePath(value, name) {
  const text = exactString(value, name);
  if (text.startsWith('/') || text.split('/').includes('..')) {
    throw new Error(`${name} must be a workspace-relative path without '..'.`);
  }
  return text;
}

// The labels an image AgentLib selection does not carry.
const IMAGE_AGENTLIB_ABSENT_LABELS = Object.freeze([BOX_LABELS.agentLibFingerprint, BOX_LABELS.agentLibCommit]);

// Ploinky's source identity of the AchillesAgentLib copy an outer Box image
// supplies: a hash of that image ID and the library name, never of content.
export function imageAgentLibSourceIdHash(imageId) {
  return createHash('sha256')
    .update(JSON.stringify({ kind: 'image', library: 'achillesAgentLib', supplyingImageId: imageId }))
    .digest('hex');
}

function exactAgentLibCommit(value, name) {
  const text = String(value ?? '');
  if (text !== '' && !/^[0-9a-f]{40}$/.test(text)) {
    throw new Error(`${name} must be empty or exactly 40 lowercase hexadecimal characters.`);
  }
  return text;
}

function exactGpuGrant(value, name) {
  const text = String(value ?? '');
  if (!/^[0-9a-f]{64}$/.test(text)) {
    throw new Error(`${name} must be exactly 64 lowercase hexadecimal characters.`);
  }
  return text;
}

export function readExpectedGpuGrant(env = process.env) {
  const text = String(env.SMOKE_BOX_GPU_GRANT ?? '').trim();
  return text ? exactGpuGrant(text, 'SMOKE_BOX_GPU_GRANT') : null;
}

function canonicalSource(value, name) {
  const source = exactString(value, name);
  if (!path.posix.isAbsolute(source) || path.posix.normalize(source) !== source) throw new Error(`${name} must be an exact canonical absolute source.`);
  return source;
}

function expectedHardware(value) {
  if (value == null) return null;
  const fingerprint = exactGpuGrant(value.fingerprint, 'expected hardware-limits fingerprint');
  const markerSource = canonicalSource(value.markerSource, 'expected hardware-limits marker source');
  const storeSource = canonicalSource(value.storeSource, 'expected hardware-limits store source');
  const instanceRoot = path.posix.dirname(storeSource);
  if (path.posix.basename(storeSource) !== 'store' || path.posix.basename(path.posix.dirname(instanceRoot)) !== 'hardware-limits'
    || markerSource !== path.posix.join(instanceRoot, fingerprint, 'marker.json')) {
    throw new Error('Hardware limits sources must identify the exact instance store and fingerprint marker.');
  }
  return { fingerprint, markerSource, storeSource };
}

export function readExpectedHardwareLimits(env = process.env) {
  const fingerprint = String(env.SMOKE_BOX_HARDWARE_LIMITS ?? '').trim();
  if (!fingerprint) {
    if (env.SMOKE_BOX_HARDWARE_MARKER_SOURCE || env.SMOKE_BOX_HARDWARE_STORE_SOURCE) throw new Error('Hardware bind sources require SMOKE_BOX_HARDWARE_LIMITS.');
    return null;
  }
  return expectedHardware({ fingerprint, markerSource: env.SMOKE_BOX_HARDWARE_MARKER_SOURCE, storeSource: env.SMOKE_BOX_HARDWARE_STORE_SOURCE });
}

export function readExpectedMpsTools(env = process.env) {
  const controlSource = String(env.SMOKE_BOX_MPS_CONTROL_SOURCE || '');
  const serverSource = String(env.SMOKE_BOX_MPS_SERVER_SOURCE || '');
  if (!controlSource && !serverSource) return null;
  return {
    controlSource: canonicalSource(controlSource, 'SMOKE_BOX_MPS_CONTROL_SOURCE'),
    serverSource: canonicalSource(serverSource, 'SMOKE_BOX_MPS_SERVER_SOURCE'),
  };
}

function requireHardwareMounts(mounts, expected, expectedMpsTools, gpuGrant) {
  const wiring = expectedHardware(expected);
  if (!Array.isArray(mounts)) {
    if (wiring || expectedMpsTools) throw new Error('Hardware wiring requires the exact inspected mount inventory.');
    return null;
  }
  function bind(destination, source, writable) {
    const found = mounts.filter((mount) => mount?.Destination === destination);
    if (found.length !== 1 || found[0].Type !== 'bind' || found[0].RW !== writable || found[0].Source !== source) {
      throw new Error(`Hardware wiring requires exactly one ${writable ? 'read-write' : 'read-only'} ${destination} bind from its exact source.`);
    }
  }
  const targets = [HARDWARE_MARKER_PATH, HARDWARE_STORE_PATH, ...MPS_TOOLS];
  for (const mount of mounts) {
    const destination = mount?.Destination;
    if (typeof destination !== 'string') continue;
    if (wiring && ![HARDWARE_MARKER_PATH, HARDWARE_STORE_PATH].includes(destination) && typeof mount.Source === 'string') {
      const privateRoot = path.posix.dirname(wiring.storeSource);
      const source = path.posix.normalize(mount.Source);
      if (source === privateRoot || source.startsWith(`${privateRoot}/`) || privateRoot.startsWith(`${source.replace(/\/$/, '')}/`)) throw new Error('Hardware private sources must not be exposed through an extra bind.');
    }
    const normalized = path.posix.normalize(destination);
    if (targets.some((target) => target === normalized || target.startsWith(`${normalized.replace(/\/$/, '')}/`) || normalized.startsWith(`${target}/`))) {
      if (!targets.includes(destination)) throw new Error('Hardware wiring rejects extra mounts shadowing a marker, store, or MPS tool.');
      if ([HARDWARE_MARKER_PATH, HARDWARE_STORE_PATH].includes(destination) && !wiring) throw new Error('Hardware binds require explicit SMOKE_BOX_HARDWARE_LIMITS expectations.');
      if (MPS_TOOLS.includes(destination) && !expectedMpsTools) throw new Error('MPS tool binds require an explicit MPS expectation and GPU marker.');
    }
  }
  if (wiring) {
    bind(HARDWARE_MARKER_PATH, wiring.markerSource, false);
    bind(HARDWARE_STORE_PATH, wiring.storeSource, true);
  }
  if (expectedMpsTools) {
    if (!gpuGrant) throw new Error('MPS tool binds require the expected GPU grant marker.');
    bind(MPS_TOOLS[0], canonicalSource(expectedMpsTools.controlSource, 'expected MPS control source'), false);
    bind(MPS_TOOLS[1], canonicalSource(expectedMpsTools.serverSource, 'expected MPS server source'), false);
  }
  return wiring;
}

function mpsMarkerProof(marker, tools, gpuGrant) {
  if (!tools) {
    if (marker != null) throw new Error('MPS marker content requires an explicit tooling expectation.');
    return null;
  }
  if (!marker || marker.fingerprint !== gpuGrant || marker.state !== 'active' || !marker.mps) throw new Error('MPS tool evidence requires actual active GPU marker content with its exact fingerprint and MPS descriptors.');
  const proof = { fingerprint: gpuGrant, state: 'active', mps: {} };
  for (const [name, source, destination] of [
    ['control', tools.controlSource, MPS_TOOLS[0]],
    ['server', tools.serverSource, MPS_TOOLS[1]],
  ]) {
    if (marker.mps[name]?.source !== source || marker.mps[name]?.destination !== destination) throw new Error('MPS marker descriptor must match the exact expected source and read-only Box tool destination.');
    proof.mps[name] = { source, destination };
  }
  return proof;
}

function assertGpuGrantLabel(labels, expectedGpuGrant) {
  const expected = expectedGpuGrant == null ? null : exactGpuGrant(expectedGpuGrant, 'expected Box GPU grant');
  const present = Object.hasOwn(labels, GPU_GRANT_LABEL);
  if (expected === null) {
    if (present) {
      throw new Error(`Outer container Box ${GPU_GRANT_LABEL} label requires an explicit SMOKE_BOX_GPU_GRANT expectation.`);
    }
    return null;
  }
  if (labels[GPU_GRANT_LABEL] !== expected) {
    throw new Error(`Outer container Box ${GPU_GRANT_LABEL} label must equal ${expected}.`);
  }
  return expected;
}

function grantFileDirectory(found, file, gpuGrant) {
  const source = found[0]?.Source;
  if (found.length !== 1 || found[0].Type !== 'bind' || found[0].RW !== false
    || typeof source !== 'string' || !path.posix.isAbsolute(source)
    || path.posix.normalize(source) !== source || path.posix.basename(source) !== file
    || path.posix.basename(path.posix.dirname(source)) !== gpuGrant) {
    throw new Error(`Box gpu-grant label requires exactly one read-only ${file} bind from its ${gpuGrant} grant directory.`);
  }
  return path.posix.dirname(source);
}

function requireGpuGrantMounts(mounts, gpuGrant) {
  if (!Array.isArray(mounts)) throw new Error('GPU grant evidence requires the inspected container mount inventory.');
  const at = (destination) => mounts.filter((mount) => mount?.Destination === destination);
  const marker = at(GPU_GRANT_MARKER_PATH);
  const spec = at(GPU_GRANT_CDI_SPEC_PATH);
  const drivers = mounts.filter((mount) => typeof mount?.Destination === 'string'
    && (mount.Destination === GPU_DRIVER_DIRECTORY || mount.Destination.startsWith(`${GPU_DRIVER_DIRECTORY}/`)));
  if (gpuGrant === null) {
    if (marker.length || spec.length || drivers.length) {
      throw new Error('GPU grant marker, CDI spec, or driver mounts require the Box gpu-grant label.');
    }
    return;
  }
  const directory = grantFileDirectory(marker, 'marker.json', gpuGrant);
  if (spec.length === 0) {
    // Stale or revoked wiring: Ploinky keeps only the marker.
    if (drivers.length) throw new Error('A Box GPU grant without a CDI spec must not bind GPU driver files.');
    return;
  }
  if (grantFileDirectory(spec, 'box.json', gpuGrant) !== directory) {
    throw new Error('Box GPU grant marker and CDI spec must come from the same grant directory.');
  }
}

function exactBoxLabels(labels, {
  expectedImageRef,
  expectedImageId,
  selectedRouterHostPort,
  selectedMediaHostPort,
  expectedRouterBindAddress = DEFAULT_ROUTER_BIND_ADDRESS,
  expectedGpuGrant = null,
  expectedHardwareLimits = null,
} = {}) {
  const source = record(labels, 'outer container Config.Labels');
  const routerBindAddress = assertRouterBindAddressLabel(source, expectedRouterBindAddress);
  const gpuGrant = assertGpuGrantLabel(source, expectedGpuGrant);
  // Ploinky identifies the AchillesAgentLib copy a Box image supplies by that
  // outer image and the library, so an image selection carries no content
  // fingerprint or Git commit label; a local checkout carries both.
  const imageAgentLib = source[BOX_LABELS.agentLibMode] === 'image';
  const hardware = expectedHardware(expectedHardwareLimits);
  if ((hardware === null && Object.hasOwn(source, HARDWARE_LIMITS_LABEL)) || (hardware && source[HARDWARE_LIMITS_LABEL] !== hardware.fingerprint)) {
    throw new Error('Outer Box hardware-limits label requires its exact explicit expectation.');
  }
  const semanticEntries = Object.entries(source)
    .sort(([left], [right]) => left.localeCompare(right));
  const expectedNames = [
    ...Object.values(BOX_LABELS).filter((name) => !imageAgentLib || !IMAGE_AGENTLIB_ABSENT_LABELS.includes(name)),
    ...(routerBindAddress === DEFAULT_ROUTER_BIND_ADDRESS ? [] : [ROUTER_BIND_ADDRESS_LABEL]),
    ...(gpuGrant === null ? [] : [GPU_GRANT_LABEL]),
    ...(hardware === null ? [] : [HARDWARE_LIMITS_LABEL]),
  ].sort();
  if (JSON.stringify(semanticEntries.map(([name]) => name)) !== JSON.stringify(expectedNames)) {
    throw new Error(`Outer container Box labels must be exactly ${JSON.stringify(expectedNames)}.`);
  }
  if (source[BOX_LABELS.role] !== 'box') {
    throw new Error('Outer container Box role label must equal box.');
  }
  const pathHash = exactPathHash(source[BOX_LABELS.pathHash], 'outer container Box path-hash label');
  const imageRef = exactString(source[BOX_LABELS.imageRef], 'outer container Box image-ref label');
  if (expectedImageRef !== undefined && imageRef !== expectedImageRef) {
    throw new Error(`Outer container Box image-ref label does not equal ${expectedImageRef}.`);
  }
  const routerHostPort = exactPort(
    source[BOX_LABELS.routerHostPort],
    'outer container Box router-host-port label',
  );
  if (selectedRouterHostPort !== undefined && routerHostPort !== selectedRouterHostPort) {
    throw new Error('Outer container Box router-host-port label does not match its exact publication.');
  }
  const mediaHostPort = exactPort(
    source[BOX_LABELS.mediaHostPort],
    'outer container Box media-host-port label',
  );
  if (mediaHostPort !== selectedMediaHostPort) {
    throw new Error('Outer container Box media-host-port label does not match its exact publication.');
  }
  const seccompFingerprint = exactSha256(
    source[BOX_LABELS.seccompFingerprint],
    'outer container Box seccomp-fingerprint label',
  );
  const dependenciesFingerprint = exactSha256(
    source[BOX_LABELS.dependenciesFingerprint],
    'outer container Box dependencies-fingerprint label',
  );
  const imagesFingerprint = exactSha256(
    source[BOX_LABELS.imagesFingerprint],
    'outer container Box images-fingerprint label',
  );
  const agentLibMode = exactAgentLibMode(
    source[BOX_LABELS.agentLibMode],
    'outer container Box AgentLib mode label',
  );
  const agentLibSourceIdHash = exactSha256(
    source[BOX_LABELS.agentLibSourceIdHash],
    'outer container Box AgentLib source-id label',
  );
  const agentLibFingerprint = imageAgentLib ? null : exactSha256(
    source[BOX_LABELS.agentLibFingerprint],
    'outer container Box AgentLib fingerprint label',
  );
  const agentLibSourceRelativePath = exactAgentLibSourceRelativePath(
    source[BOX_LABELS.agentLibSourceRelativePath],
    'outer container Box AgentLib source-path label',
  );
  const agentLibCommit = imageAgentLib ? null : exactAgentLibCommit(
    source[BOX_LABELS.agentLibCommit],
    'outer container Box AgentLib commit label',
  );
  if (agentLibMode === 'image') {
    if (source[BOX_LABELS.agentLibMode] !== 'image'
      || source[BOX_LABELS.agentLibSourceIdHash] !== agentLibSourceIdHash) {
      throw new Error('Image AgentLib labels require exact image mode and a lowercase SHA-256 source identity.');
    }
    if (source[BOX_LABELS.agentLibSourceRelativePath] !== 'image') {
      throw new Error('Image AgentLib evidence requires source-path image.');
    }
    const imageId = exactImageId(expectedImageId, 'image AgentLib expected image ID');
    if (agentLibSourceIdHash !== imageAgentLibSourceIdHash(imageId)) {
      throw new Error('Image AgentLib source identity must bind the exact outer image ID and the library.');
    }
  }
  return Object.freeze({
    role: 'box',
    pathHash,
    imageRef,
    routerHostPort,
    ...(routerBindAddress === DEFAULT_ROUTER_BIND_ADDRESS ? {} : { routerBindAddress }),
    mediaHostPort,
    seccompFingerprint,
    dependenciesFingerprint,
    imagesFingerprint,
    agentLibMode,
    agentLibSourceIdHash,
    ...(imageAgentLib ? {} : { agentLibFingerprint }),
    agentLibSourceRelativePath,
    ...(imageAgentLib ? {} : { agentLibCommit }),
    ...(gpuGrant === null ? {} : { gpuGrant }),
    ...(hardware === null ? {} : { hardwareLimits: hardware.fingerprint }),
  });
}

function requireUnshadowedImageAgentLib(mounts) {
    if (!Array.isArray(mounts)) throw new Error('Image AgentLib evidence requires the inspected container mount inventory.');
    const stablePath = '/opt/ploinky-agentlib';
    for (const mount of mounts) {
        const destination = mount?.Destination;
        if (typeof destination !== 'string' || !destination.startsWith('/') || destination.includes('\\') || destination.includes('\0')) {
            throw new Error('Image AgentLib mount inventory contains an invalid destination.');
        }
        const normalized = path.posix.normalize(destination).replace(/\/+$/, '') || '/';
        if (normalized === '/' || normalized === stablePath || normalized.startsWith(`${stablePath}/`)
            || stablePath.startsWith(`${normalized}/`)) {
            throw new Error('Image AgentLib source must not be shadowed by a container mount.');
        }
    }
}

function exactBoxSecurityOptions(options) {
  if (!Array.isArray(options) || options.length !== 3) {
    throw new Error('Outer container Box SecurityOpt must contain exactly three entries.');
  }
  let seccompPath = '';
  const normalized = options.map((raw) => {
    const option = exactString(raw, 'outer container Box SecurityOpt entry');
    const separator = option.indexOf('=');
    const key = (separator === -1 ? option : option.slice(0, separator)).toLowerCase();
    const value = separator === -1 ? '' : option.slice(separator + 1);
    if (key !== 'seccomp') return option.toLowerCase();
    if (!value.startsWith('/') || value.includes('\0') || value.split('/').includes('..')) {
      throw new Error('Outer container Box seccomp SecurityOpt must use one absolute profile path.');
    }
    seccompPath = value;
    return `seccomp=${value}`;
  }).sort();
  const expected = ['label=disable', `seccomp=${seccompPath}`, 'unmask=all'].sort();
  if (!seccompPath || JSON.stringify(normalized) !== JSON.stringify(expected)) {
    throw new Error('Outer container Box SecurityOpt must equal label=disable, unmask=all, and one seccomp profile.');
  }
  return Object.freeze(normalized);
}

function exactSshHostKeySha256(value, name) {
  const text = exactString(value, name);
  if (!/^SHA256:[A-Za-z0-9+/]{43}$/.test(text)) {
    throw new Error(`${name} must be an exact OpenSSH SHA256 host-key fingerprint.`);
  }
  return text;
}

function oneInspectRecord(value, name) {
  const rows = Array.isArray(value) ? value : [value];
  if (rows.length !== 1) throw new Error(`${name} must contain exactly one inspection record.`);
  return record(rows[0], `${name}[0]`);
}

function sortedObject(value) {
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
}

export function normalizeOuterPortBindings(bindings) {
  const source = record(bindings, 'HostConfig.PortBindings');
  const normalized = {};
  for (const [target, rawValues] of Object.entries(source)) {
    if (!/^\d+\/(?:tcp|udp)$/.test(target)) {
      throw new Error(`HostConfig.PortBindings has invalid target ${JSON.stringify(target)}.`);
    }
    if (!Array.isArray(rawValues) || rawValues.length < 1) {
      throw new Error(`HostConfig.PortBindings ${target} must contain at least one mapping.`);
    }
    normalized[target] = rawValues.map((rawValue, index) => {
      const value = record(rawValue, `HostConfig.PortBindings ${target}[${index}]`);
      const hostIp = value.HostIp === undefined || value.HostIp === null
        ? ''
        : String(value.HostIp);
      return {
        HostIp: hostIp === '' ? '0.0.0.0' : hostIp,
        HostPort: exactPort(value.HostPort, `HostConfig.PortBindings ${target}[${index}].HostPort`),
      };
    }).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  }
  return sortedObject(normalized);
}

function expectedBindings(selectedRouterHostPort, selectedMediaHostPort, expectedRouterBindAddress = DEFAULT_ROUTER_BIND_ADDRESS) {
  return normalizeOuterPortBindings({
    [ROUTER_TARGET]: [{ HostIp: validateRouterBindAddress(expectedRouterBindAddress), HostPort: selectedRouterHostPort }],
    [MEDIA_TARGET]: [{ HostIp: '0.0.0.0', HostPort: selectedMediaHostPort }],
  });
}

function assertExactBindings(bindings, expectedRouterBindAddress = DEFAULT_ROUTER_BIND_ADDRESS) {
  const normalized = normalizeOuterPortBindings(bindings);
  const router = normalized[ROUTER_TARGET];
  if (!router || router.length !== 1) {
    throw new Error(`Box PortBindings must contain exactly one ${ROUTER_TARGET} mapping.`);
  }
  const media = normalized[MEDIA_TARGET];
  if (!media || media.length !== 1) {
    throw new Error(`Box PortBindings must contain exactly one ${MEDIA_TARGET} mapping.`);
  }
  const selectedRouterHostPort = router[0].HostPort;
  const selectedMediaHostPort = media[0].HostPort;
  const expected = expectedBindings(selectedRouterHostPort, selectedMediaHostPort, expectedRouterBindAddress);
  if (JSON.stringify(normalized) !== JSON.stringify(expected)) {
    throw new Error(`Box normalized PortBindings must equal ${JSON.stringify(expected)}; got ${JSON.stringify(normalized)}.`);
  }
  return { normalized, selectedRouterHostPort, selectedMediaHostPort };
}

function isoTime(value, name) {
  const text = exactString(value, name);
  const milliseconds = Date.parse(text);
  if (!Number.isFinite(milliseconds)) throw new Error(`${name} must be an ISO timestamp.`);
  return { text: new Date(milliseconds).toISOString(), milliseconds };
}

export function buildBoxEvidence({
  containerInspect,
  imageInspect,
  expectedContainerName,
  expectedImageId,
  expectedImageRef,
  baseURL,
  publicIPv4,
  expectedRouterBindAddress = DEFAULT_ROUTER_BIND_ADDRESS,
  expectedGpuGrant = null,
  expectedHardwareLimits = null,
  expectedMpsTools = null,
  observedGpuMarker = null,
}) {
  const container = oneInspectRecord(containerInspect, 'outer container inspection');
  const image = oneInspectRecord(imageInspect, 'outer image inspection');
  const containerName = String(container.Name || '').replace(/^\//, '');
  if (containerName !== expectedContainerName) {
    throw new Error(`Outer inspection name must equal ${expectedContainerName}; got ${containerName || '<missing>'}.`);
  }
  if (container?.State?.Running !== true) throw new Error(`Outer container ${containerName} is not running.`);
  const containerId = exactContainerId(container.Id || container.ID, 'outer container ID');
  const startedAt = isoTime(container?.State?.StartedAt, 'outer container State.StartedAt');
  const requiredImageId = exactImageId(expectedImageId, 'expected outer image ID');
  const imageId = exactImageId(container.Image || container.ImageID, 'outer container image ID');
  if (imageId !== requiredImageId) {
    throw new Error(`Outer container image ID must equal ${requiredImageId}; got ${imageId}.`);
  }
  const inspectedImageId = exactImageId(image.Id || image.ID, 'outer image inspection ID');
  if (inspectedImageId !== requiredImageId) {
    throw new Error(`Inspected image ID must equal ${requiredImageId}; got ${inspectedImageId}.`);
  }
  const imageConfig = record(image.Config || {}, 'outer image Config');
  const imageLabels = record(imageConfig.Labels || image.Labels || {}, 'outer image labels');
  if (Object.keys(imageLabels).length !== 0) {
    throw new Error(`Outer image ${requiredImageId} must not carry labels.`);
  }
  if (String(imageConfig.User || '') !== 'podman') throw new Error('Box image user must be podman.');
  if (String(imageConfig.WorkingDir || '') !== '/') throw new Error('Box image workdir must be /.');
  if ((imageConfig.Env || []).some((entry) => typeof entry === 'string'
    && entry.startsWith('PLOINKY_WORKSPACE_ROOT='))) {
    throw new Error('Box image must not contain a workspace root default.');
  }
  if (JSON.stringify(imageConfig.Entrypoint || []) !== JSON.stringify(['/usr/local/bin/ploinky-box-entrypoint'])) {
    throw new Error('Box image entrypoint is invalid.');
  }
  const { normalized, selectedRouterHostPort, selectedMediaHostPort } = assertExactBindings(container?.HostConfig?.PortBindings, expectedRouterBindAddress);
  const securityOptions = exactBoxSecurityOptions(container?.HostConfig?.SecurityOpt);
  const semanticLabels = exactBoxLabels(container?.Config?.Labels || {}, {
    expectedImageRef,
    expectedImageId: requiredImageId,
    selectedRouterHostPort,
    selectedMediaHostPort,
    expectedRouterBindAddress,
    expectedGpuGrant,
    expectedHardwareLimits,
  });
  if (semanticLabels.agentLibMode === 'image') requireUnshadowedImageAgentLib(container.Mounts);
  requireGpuGrantMounts(container.Mounts, semanticLabels.gpuGrant ?? null);
  const hardwareWiring = requireHardwareMounts(container.Mounts, expectedHardwareLimits, expectedMpsTools, semanticLabels.gpuGrant ?? null);
  const mpsMarker = mpsMarkerProof(observedGpuMarker, expectedMpsTools, semanticLabels.gpuGrant ?? null);
  inspectBoxWorkspace(container);
  return validateBoxEvidence({
    containerName,
    containerId,
    startedAt: startedAt.text,
    running: true,
    semanticLabels,
    imageRef: expectedImageRef,
    imageId: requiredImageId,
    baseURL,
    publicIPv4,
    selectedRouterHostPort,
    normalizedPortBindings: normalized,
    securityOptions,
    ...(hardwareWiring ? { hardwareWiring } : {}),
    ...(expectedMpsTools ? { mpsTools: expectedMpsTools } : {}),
    ...(mpsMarker ? { mpsMarker } : {}),
  }, {
    expectedContainerName,
    expectedImageId,
    expectedImageRef,
    baseURL,
    publicIPv4,
    expectedRouterBindAddress,
    expectedGpuGrant,
    expectedHardwareLimits,
    expectedMpsTools,
  });
}

export function validateBoxEvidence(input, {
  expectedContainerName,
  expectedImageId,
  expectedImageRef,
  baseURL,
  publicIPv4,
  expectedRouterBindAddress = DEFAULT_ROUTER_BIND_ADDRESS,
  expectedGpuGrant = null,
  expectedHardwareLimits = null,
  expectedMpsTools = null,
} = {}) {
  const evidence = record(input, 'Box evidence');
  if (evidence.containerName !== expectedContainerName) throw new Error('Box evidence container name mismatch.');
  const containerId = exactContainerId(evidence.containerId, 'Box evidence container ID');
  const requiredImageId = exactImageId(expectedImageId, 'expected Box evidence image ID');
  if (exactImageId(evidence.imageId, 'Box evidence image ID') !== requiredImageId) {
    throw new Error('Box evidence image ID mismatch.');
  }
  if (evidence.imageRef !== expectedImageRef) throw new Error('Box evidence image reference mismatch.');
  if (evidence.running !== true) throw new Error('Box evidence must describe a running outer container.');
  if (String(evidence.baseURL || '').replace(/\/+$/, '') !== String(baseURL || '').replace(/\/+$/, '')) {
    throw new Error('Box evidence base URL mismatch.');
  }
  if (evidence.publicIPv4 !== publicIPv4) throw new Error('Box evidence public IPv4 mismatch.');
  const startedAt = isoTime(evidence.startedAt, 'Box evidence startedAt');
  const selectedRouterHostPort = exactPort(evidence.selectedRouterHostPort, 'Box evidence selectedRouterHostPort');
  const { normalized, selectedMediaHostPort } = assertExactBindings(evidence.normalizedPortBindings, expectedRouterBindAddress);
  if (JSON.stringify(normalized) !== JSON.stringify(expectedBindings(selectedRouterHostPort, selectedMediaHostPort, expectedRouterBindAddress))) {
    throw new Error('Box evidence normalized PortBindings are not the exact two-publication boundary.');
  }
  const securityOptions = exactBoxSecurityOptions(evidence.securityOptions);
  const semanticLabels = exactBoxLabels(
    Object.fromEntries([
      // A label the evidence does not record stays absent, so the exact label
      // set check decides whether this AgentLib mode may omit it.
      ...Object.entries(BOX_LABELS)
        .filter(([name]) => Object.hasOwn(evidence.semanticLabels || {}, name))
        .map(([name, label]) => [label, evidence.semanticLabels[name]]),
      ...(Object.hasOwn(evidence.semanticLabels || {}, 'routerBindAddress')
        ? [[ROUTER_BIND_ADDRESS_LABEL, evidence.semanticLabels.routerBindAddress]] : []),
      ...(Object.hasOwn(evidence.semanticLabels || {}, 'gpuGrant')
        ? [[GPU_GRANT_LABEL, evidence.semanticLabels.gpuGrant]] : []),
      ...(Object.hasOwn(evidence.semanticLabels || {}, 'hardwareLimits')
        ? [[HARDWARE_LIMITS_LABEL, evidence.semanticLabels.hardwareLimits]] : []),
    ]),
    {
      expectedImageRef,
      expectedImageId: requiredImageId,
      selectedRouterHostPort,
      selectedMediaHostPort,
      expectedRouterBindAddress,
      expectedGpuGrant,
      expectedHardwareLimits,
    },
  );
  const hardwareWiring = expectedHardware(expectedHardwareLimits);
  if (JSON.stringify(evidence.hardwareWiring ?? null) !== JSON.stringify(hardwareWiring)) throw new Error('Box hardware-limits evidence must retain the exact inspected sources.');
  if (JSON.stringify(evidence.mpsTools ?? null) !== JSON.stringify(expectedMpsTools)) throw new Error('Box MPS evidence requires the exact expected tool sources.');
  const mpsMarker = mpsMarkerProof(evidence.mpsMarker, expectedMpsTools, semanticLabels.gpuGrant ?? null);
  return Object.freeze({
    containerName: evidence.containerName,
    containerId,
    startedAt: startedAt.text,
    running: true,
    semanticLabels,
    imageRef: evidence.imageRef,
    imageId: requiredImageId,
    baseURL: String(evidence.baseURL).replace(/\/+$/, ''),
    publicIPv4: evidence.publicIPv4,
    selectedRouterHostPort,
    normalizedPortBindings: normalized,
    securityOptions,
    ...(hardwareWiring ? { hardwareWiring } : {}),
    ...(expectedMpsTools ? { mpsTools: expectedMpsTools } : {}),
    ...(mpsMarker ? { mpsMarker } : {}),
  });
}

export function validateExternalTcpNegativeEvidence(input, {
  runId,
  boxEvidence,
  networkSources,
  nowMs = Date.now(),
  maxAgeMs = 15 * 60_000,
} = {}) {
  if (boxEvidence?.semanticLabels?.mediaHostPort !== '7882') {
    throw new Error('External TCP-negative evidence requires the Box publication on fixed UDP host port 7882.');
  }
  const evidence = record(input, 'external TCP-negative evidence');
  if (evidence.runId !== runId) throw new Error('External TCP-negative evidence runId mismatch.');
  if (evidence.containerName !== boxEvidence.containerName) throw new Error('External TCP-negative evidence container mismatch.');
  if (evidence.containerId !== boxEvidence.containerId) throw new Error('External TCP-negative evidence container ID mismatch.');
  const containerStartedAt = isoTime(evidence.containerStartedAt, 'external TCP-negative containerStartedAt');
  if (containerStartedAt.text !== boxEvidence.startedAt) {
    throw new Error('External TCP-negative evidence container start mismatch.');
  }
  if (evidence.imageId !== boxEvidence.imageId) throw new Error('External TCP-negative evidence image mismatch.');
  if (evidence.targetPublicIPv4 !== boxEvidence.publicIPv4) throw new Error('External TCP-negative target IPv4 mismatch.');
  const observedAt = isoTime(evidence.observedAt, 'external TCP-negative observedAt');
  const boxStartedAtMs = Date.parse(boxEvidence.startedAt);
  if (observedAt.milliseconds < boxStartedAtMs) {
    throw new Error('External TCP-negative scan predates the current outer container generation.');
  }
  if (observedAt.milliseconds > nowMs + 30_000 || nowMs - observedAt.milliseconds > maxAgeMs) {
    throw new Error('External TCP-negative evidence is stale or from the future.');
  }
  if (!Array.isArray(networkSources) || networkSources.length !== 2) {
    throw new Error('Exactly two expected external network sources are required.');
  }
  if (!Array.isArray(evidence.sources) || evidence.sources.length !== 2) {
    throw new Error('External TCP-negative evidence must contain exactly two source scans.');
  }
  const expected = new Map(networkSources.map((source) => [source.networkId, source]));
  if (expected.size !== 2) throw new Error('Expected external network source ids must be distinct.');
  const seen = new Set();
  const sources = evidence.sources.map((rawSource, index) => {
    const source = record(rawSource, `external TCP-negative sources[${index}]`);
    const networkId = exactString(source.networkId, `sources[${index}].networkId`);
    if (seen.has(networkId)) throw new Error(`External TCP-negative source ${networkId} is duplicated.`);
    seen.add(networkId);
    if (!expected.has(networkId)) throw new Error(`External TCP-negative source ${networkId} is unexpected.`);
    const expectedSource = expected.get(networkId);
    if (source.egressIPv4 !== expectedSource.egressIPv4) throw new Error(`External TCP-negative source ${networkId} egress mismatch.`);
    if (source.protocol !== 'tcp') throw new Error(`External TCP-negative source ${networkId} must scan TCP.`);
    if (source.targetPublicIPv4 !== boxEvidence.publicIPv4) throw new Error(`External TCP-negative source ${networkId} target mismatch.`);
    if (source.scanStart !== TCP_SCAN_START || source.scanEnd !== TCP_SCAN_END) {
      throw new Error(`External TCP-negative source ${networkId} must scan every TCP port 1..65535.`);
    }
    if (!Array.isArray(source.openPorts) || source.openPorts.length !== 0) {
      throw new Error(`External TCP-negative source ${networkId} found an inbound TCP port.`);
    }
    const sourceStartedAt = isoTime(source.startedAt, `sources[${index}].startedAt`);
    const sourceObservedAt = isoTime(source.observedAt, `sources[${index}].observedAt`);
    if (sourceStartedAt.milliseconds < boxStartedAtMs) {
      throw new Error(`External TCP-negative source ${networkId} scan predates the current outer container generation.`);
    }
    if (sourceStartedAt.milliseconds > sourceObservedAt.milliseconds) {
      throw new Error(`External TCP-negative source ${networkId} scan completion predates its start.`);
    }
    if (sourceObservedAt.milliseconds < boxStartedAtMs) {
      throw new Error(`External TCP-negative source ${networkId} scan predates the current outer container generation.`);
    }
    if (sourceObservedAt.milliseconds > observedAt.milliseconds) {
      throw new Error(`External TCP-negative source ${networkId} scan completion is later than the evidence observation.`);
    }
    if (sourceObservedAt.milliseconds > nowMs + 30_000 || nowMs - sourceObservedAt.milliseconds > maxAgeMs) {
      throw new Error(`External TCP-negative source ${networkId} scan is stale or from the future.`);
    }
    const scanner = exactString(source.scanner, `sources[${index}].scanner`);
    if (scanner !== 'ploinky-external-boundary') {
      throw new Error(`External TCP-negative source ${networkId} scanner identity mismatch.`);
    }
    if (source.scannerTransport !== 'ssh-pinned-host') {
      throw new Error(`External TCP-negative source ${networkId} must use the pinned SSH scanner transport.`);
    }
    const scannerSourceSha256 = exactSha256(source.scannerSourceSha256, `sources[${index}].scannerSourceSha256`);
    const scannerTargetSha256 = exactSha256(source.scannerTargetSha256, `sources[${index}].scannerTargetSha256`);
    const scannerHostKeySha256 = exactSshHostKeySha256(
      source.scannerHostKeySha256,
      `sources[${index}].scannerHostKeySha256`,
    );
    const rawResultSha256 = exactSha256(source.rawResultSha256, `sources[${index}].rawResultSha256`);
    if (scannerSourceSha256 !== exactSha256(expectedSource.scannerSourceSha256, `expected ${networkId} scannerSourceSha256`)) {
      throw new Error(`External TCP-negative source ${networkId} scanner source mismatch.`);
    }
    if (scannerTargetSha256 !== exactSha256(expectedSource.scannerTargetSha256, `expected ${networkId} scannerTargetSha256`)) {
      throw new Error(`External TCP-negative source ${networkId} scanner target mismatch.`);
    }
    if (scannerHostKeySha256 !== exactSshHostKeySha256(expectedSource.scannerHostKeySha256, `expected ${networkId} scannerHostKeySha256`)) {
      throw new Error(`External TCP-negative source ${networkId} scanner host-key mismatch.`);
    }
    const scanId = exactString(source.scanId, `sources[${index}].scanId`);
    const invalidIceProbe = record(source.invalidIceProbe, `sources[${index}].invalidIceProbe`);
    if (
      invalidIceProbe.protocol !== 'udp'
      || invalidIceProbe.targetPort !== 7882
      || invalidIceProbe.requestHadMessageIntegrity !== false
      || invalidIceProbe.successResponse !== false
      || !['timeout', 'error-response'].includes(invalidIceProbe.outcome)
      || (invalidIceProbe.outcome === 'timeout' && invalidIceProbe.responseType !== null)
      || (invalidIceProbe.outcome === 'error-response' && invalidIceProbe.responseType !== 0x0111)
    ) {
      throw new Error(`External TCP-negative source ${networkId} did not prove invalid ICE fails on UDP 7882.`);
    }
    return Object.freeze({
      networkId,
      egressIPv4: source.egressIPv4,
      protocol: 'tcp',
      targetPublicIPv4: source.targetPublicIPv4,
      scanStart: TCP_SCAN_START,
      scanEnd: TCP_SCAN_END,
      openPorts: Object.freeze([]),
      startedAt: sourceStartedAt.text,
      observedAt: sourceObservedAt.text,
      scanner,
      scanId,
      scannerTransport: 'ssh-pinned-host',
      scannerSourceSha256,
      scannerTargetSha256,
      scannerHostKeySha256,
      rawResultSha256,
      invalidIceProbe: Object.freeze({
        protocol: 'udp',
        targetPort: 7882,
        requestHadMessageIntegrity: false,
        outcome: invalidIceProbe.outcome,
        successResponse: false,
        responseType: invalidIceProbe.responseType,
      }),
    });
  });
  if (seen.size !== expected.size || [...expected.keys()].some((networkId) => !seen.has(networkId))) {
    throw new Error('External TCP-negative evidence is missing an expected network source.');
  }
  if (new Set(sources.map((source) => source.scanId)).size !== sources.length) {
    throw new Error('External TCP-negative scan ids must be distinct.');
  }
  return Object.freeze({
    runId,
    containerName: boxEvidence.containerName,
    containerId: boxEvidence.containerId,
    containerStartedAt: containerStartedAt.text,
    imageId: boxEvidence.imageId,
    targetPublicIPv4: boxEvidence.publicIPv4,
    observedAt: observedAt.text,
    sources: Object.freeze(sources.sort((left, right) => left.networkId.localeCompare(right.networkId))),
  });
}
