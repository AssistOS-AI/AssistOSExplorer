#!/usr/bin/env node

import { spawnSync } from 'node:child_process';

import {
  buildExternalBoundaryEvidence,
  runExternalScanner,
  scannerAttestation,
} from '../lib/external-scanner.mjs';
import {
  parseTurnEndpoint,
  requireCredentialFreeCdpUrl,
  requirePublicIpv4,
} from '../lib/network.mjs';
import {
  buildBoxEvidence,
  readExpectedGpuGrant,
  validateExternalTcpNegativeEvidence,
} from '../lib/box-evidence.mjs';
import {
  validateBoxFreshness,
  verifyNetworkLaneCompletion,
} from '../lib/live-box.mjs';

function required(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function commandJson(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed: ${String(result.stderr || result.stdout || '').trim()}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`${command} returned invalid JSON: ${error.message}`);
  }
}

function oneJsonRecord(value, name) {
  const records = Array.isArray(value) ? value : [value];
  if (records.length !== 1 || !records[0] || typeof records[0] !== 'object' || Array.isArray(records[0])) {
    throw new Error(`${name} must contain exactly one record.`);
  }
  return records[0];
}

function collectContainerEngineAndBox({
  containerName,
  expectedImageId,
  expectedImageRef,
  baseURL,
  publicIPv4,
}) {
  const version = commandJson('podman', ['version', '--format', 'json']);
  const info = commandJson('podman', ['info', '--format', 'json']);
  const server = version.Server || version.server || {};
  const host = info.host || info.Host || {};
  const backend = host.networkBackendInfo || host.NetworkBackendInfo || {};
  const dns = backend.dns || backend.DNS || {};
  const security = host.security || host.Security || {};
  const expectedEngineArch = process.arch === 'x64' ? 'amd64' : process.arch;
  const serverOsArch = String(server.OsArch || server.osArch || '').toLowerCase();
  if (serverOsArch !== `linux/${expectedEngineArch}`) {
    throw new Error(`Podman server must be native linux/${expectedEngineArch}; got ${serverOsArch || '<missing>'}.`);
  }
  if (String(host.networkBackend || host.NetworkBackend || backend.backend || '').toLowerCase() !== 'netavark') {
    throw new Error('Native media gate requires the Netavark Podman network backend.');
  }
  if (security.rootless !== true) {
    throw new Error('Native media gate requires a rootless Podman server.');
  }
  const engineEvidence = {
    podmanClientVersion: String((version.Client || version.client || {}).Version || ''),
    podmanServerVersion: String(server.Version || ''),
    podmanServerOsArch: serverOsArch,
    networkBackend: 'netavark',
    rootless: true,
    netavarkVersion: String(backend.version || ''),
    aardvarkDnsVersion: String(dns.version || ''),
  };
  for (const [name, value] of Object.entries(engineEvidence)) {
    if (!value) throw new Error(`Container-engine evidence is missing ${name}.`);
  }
  const capturedAtMs = Date.now();
  const containerInspect = commandJson('podman', ['container', 'inspect', containerName]);
  const imageInspect = commandJson('podman', ['image', 'inspect', expectedImageId]);
  const image = oneJsonRecord(imageInspect, 'outer image inspection');
  const box = buildBoxEvidence({
    containerInspect,
    imageInspect,
    expectedContainerName: containerName,
    expectedImageId,
    expectedImageRef,
    baseURL,
    publicIPv4,
    expectedGpuGrant: readExpectedGpuGrant(),
  });
  const boxFreshness = validateBoxFreshness({
    capturedAt: new Date(capturedAtMs).toISOString(),
    imageCreatedAt: image.Created,
    box,
    generationMaxAgeMs: process.env.SMOKE_BOX_MAX_GENERATION_AGE_MS,
    imageMaxAgeMs: process.env.SMOKE_BOX_MAX_IMAGE_AGE_MS,
  }, { nowMs: capturedAtMs });
  return Object.freeze({ ...engineEvidence, boxFreshness, box });
}

async function collectContainerEngineEvidence(options, { lane }) {
  const engine = collectContainerEngineAndBox(options);
  const scannedSources = await Promise.all(options.networkSources.map((source) => runExternalScanner({
    sshTarget: source.sshTarget,
    networkId: source.networkId,
    expectedEgressIPv4: source.egressIPv4,
    targetPublicIPv4: options.publicIPv4,
    echoUrl: options.networkEchoUrl,
    runId: `${options.tcpProbeRunId}-${lane}-${source.networkId}`,
    expectedHostKeySha256: source.scannerHostKeySha256,
  })));
  const executedEvidence = buildExternalBoundaryEvidence({
    runId: options.tcpProbeRunId,
    boxEvidence: engine.box,
    sources: scannedSources,
  });
  const externalTcpNegative = validateExternalTcpNegativeEvidence(
    executedEvidence,
    {
      runId: options.tcpProbeRunId,
      boxEvidence: engine.box,
      networkSources: options.networkSources,
    },
  );
  return Object.freeze({ ...engine, externalTcpNegative });
}

if (process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch)) {
  throw new Error(`The native WebMeet network matrix requires Linux amd64 or arm64; got ${process.platform}/${process.arch}.`);
}
const expectedArch = required('SMOKE_EXPECT_ARCH');
if (expectedArch !== process.arch) {
  throw new Error(`SMOKE_EXPECT_ARCH=${expectedArch} does not match native ${process.arch}.`);
}
for (const name of [
  'SMOKE_BASE_URL',
  'SMOKE_WEBMEET_PUBLIC_IPV4',
  'SMOKE_BROWSER_A_CDP_URL',
  'SMOKE_BROWSER_B_CDP_URL',
  'SMOKE_BROWSER_A_NETWORK_ID',
  'SMOKE_BROWSER_B_NETWORK_ID',
  'SMOKE_BROWSER_A_EXPECTED_EGRESS_IPV4',
  'SMOKE_BROWSER_B_EXPECTED_EGRESS_IPV4',
  'SMOKE_NETWORK_ECHO_URL',
  'SMOKE_PLOINKY_BOX_CONTAINER',
  'SMOKE_EXPECT_BOX_IMAGE_ID',
  'SMOKE_EXPECT_BOX_IMAGE_REF',
  'SMOKE_EXTERNAL_TCP_PROBE_RUN_ID',
  'SMOKE_EXTERNAL_SCANNER_A_SSH_TARGET',
  'SMOKE_EXTERNAL_SCANNER_B_SSH_TARGET',
  'SMOKE_EXTERNAL_SCANNER_A_HOST_FINGERPRINT_SHA256',
  'SMOKE_EXTERNAL_SCANNER_B_HOST_FINGERPRINT_SHA256',
  'SMOKE_EXTERNAL_TURN_UDP_URL',
  'SMOKE_EXTERNAL_TURN_TLS_URL',
  'SMOKE_USERNAME',
  'SMOKE_PASSWORD',
  'SMOKE_SECONDARY_USERNAME',
  'SMOKE_SECONDARY_PASSWORD',
]) required(name);
const browserACdpUrl = requireCredentialFreeCdpUrl(
  process.env.SMOKE_BROWSER_A_CDP_URL,
  'SMOKE_BROWSER_A_CDP_URL',
);
const browserBCdpUrl = requireCredentialFreeCdpUrl(
  process.env.SMOKE_BROWSER_B_CDP_URL,
  'SMOKE_BROWSER_B_CDP_URL',
);
requirePublicIpv4(process.env.SMOKE_WEBMEET_PUBLIC_IPV4, 'SMOKE_WEBMEET_PUBLIC_IPV4');
requirePublicIpv4(process.env.SMOKE_BROWSER_A_EXPECTED_EGRESS_IPV4, 'SMOKE_BROWSER_A_EXPECTED_EGRESS_IPV4');
requirePublicIpv4(process.env.SMOKE_BROWSER_B_EXPECTED_EGRESS_IPV4, 'SMOKE_BROWSER_B_EXPECTED_EGRESS_IPV4');
parseTurnEndpoint(process.env.SMOKE_EXTERNAL_TURN_UDP_URL, {
  name: 'SMOKE_EXTERNAL_TURN_UDP_URL',
  expectedScheme: 'turn',
  expectedTransport: 'udp',
});
parseTurnEndpoint(process.env.SMOKE_EXTERNAL_TURN_TLS_URL, {
  name: 'SMOKE_EXTERNAL_TURN_TLS_URL',
  expectedScheme: 'turns',
  expectedTransport: 'tcp',
});
if (process.env.SMOKE_BROWSER_A_NETWORK_ID === process.env.SMOKE_BROWSER_B_NETWORK_ID) {
  throw new Error('The two remote browsers must use distinct external network ids.');
}
if (process.env.SMOKE_BROWSER_A_EXPECTED_EGRESS_IPV4 === process.env.SMOKE_BROWSER_B_EXPECTED_EGRESS_IPV4) {
  throw new Error('The two remote browsers must have distinct expected external IPv4 addresses.');
}
const containerEngineOptions = Object.freeze({
  containerName: process.env.SMOKE_PLOINKY_BOX_CONTAINER,
  expectedImageId: process.env.SMOKE_EXPECT_BOX_IMAGE_ID,
  expectedImageRef: process.env.SMOKE_EXPECT_BOX_IMAGE_REF,
  baseURL: process.env.SMOKE_BASE_URL,
  publicIPv4: process.env.SMOKE_WEBMEET_PUBLIC_IPV4,
  tcpProbeRunId: process.env.SMOKE_EXTERNAL_TCP_PROBE_RUN_ID,
  networkEchoUrl: process.env.SMOKE_NETWORK_ECHO_URL,
  networkSources: [
    {
      networkId: process.env.SMOKE_BROWSER_A_NETWORK_ID,
      egressIPv4: process.env.SMOKE_BROWSER_A_EXPECTED_EGRESS_IPV4,
      sshTarget: process.env.SMOKE_EXTERNAL_SCANNER_A_SSH_TARGET,
      ...scannerAttestation({
        sshTarget: process.env.SMOKE_EXTERNAL_SCANNER_A_SSH_TARGET,
        expectedHostKeySha256: process.env.SMOKE_EXTERNAL_SCANNER_A_HOST_FINGERPRINT_SHA256,
      }),
    },
    {
      networkId: process.env.SMOKE_BROWSER_B_NETWORK_ID,
      egressIPv4: process.env.SMOKE_BROWSER_B_EXPECTED_EGRESS_IPV4,
      sshTarget: process.env.SMOKE_EXTERNAL_SCANNER_B_SSH_TARGET,
      ...scannerAttestation({
        sshTarget: process.env.SMOKE_EXTERNAL_SCANNER_B_SSH_TARGET,
        expectedHostKeySha256: process.env.SMOKE_EXTERNAL_SCANNER_B_HOST_FINGERPRINT_SHA256,
      }),
    },
  ],
});
if (containerEngineOptions.networkSources[0].scannerTargetSha256 === containerEngineOptions.networkSources[1].scannerTargetSha256) {
  throw new Error('The two external networks must use distinct pinned SSH scanner targets.');
}

for (const lane of ['direct-udp', 'turn-udp', 'turn-tls']) {
  const containerEngineEvidence = await collectContainerEngineEvidence(containerEngineOptions, { lane });
  const result = spawnSync(process.execPath, [
    './scripts/run-playwright.mjs',
    '--project=chromium',
    'specs/32-webmeet-network-matrix.spec.mjs',
  ], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      SMOKE_WEBMEET_NETWORK_MATRIX: '1',
      SMOKE_WEBMEET_NETWORK_LANE: lane,
      SMOKE_WEBMEET_MEDIA: '1',
      SMOKE_WEBMEET_REFRESH: lane === 'turn-tls' ? '1' : '0',
      SMOKE_BROWSER_A_CDP_URL: browserACdpUrl,
      SMOKE_BROWSER_B_CDP_URL: browserBCdpUrl,
      SMOKE_CONTAINER_ENGINE_EVIDENCE: JSON.stringify(containerEngineEvidence),
      SMOKE_EXTERNAL_SCANNER_SOURCE_SHA256: containerEngineOptions.networkSources[0].scannerSourceSha256,
      SMOKE_EXTERNAL_SCANNER_A_TARGET_SHA256: containerEngineOptions.networkSources[0].scannerTargetSha256,
      SMOKE_EXTERNAL_SCANNER_B_TARGET_SHA256: containerEngineOptions.networkSources[1].scannerTargetSha256,
      SMOKE_EXTERNAL_SCANNER_A_HOST_FINGERPRINT_SHA256: containerEngineOptions.networkSources[0].scannerHostKeySha256,
      SMOKE_EXTERNAL_SCANNER_B_HOST_FINGERPRINT_SHA256: containerEngineOptions.networkSources[1].scannerHostKeySha256,
      SMOKE_RUN_ID: `${process.env.SMOKE_RUN_ID || `network-${process.arch}`}-${lane}`,
    },
    stdio: 'inherit',
  });
  verifyNetworkLaneCompletion({
    lane,
    laneResult: result,
    beforeBox: containerEngineEvidence.box,
    collectAfter: () => collectContainerEngineAndBox(containerEngineOptions),
  });
}
