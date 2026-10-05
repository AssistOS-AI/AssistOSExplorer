import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildBoxEvidence,
  GPU_GRANT_LABEL,
  imageAgentLibSourceIdHash,
  HARDWARE_LIMITS_LABEL,
  readExpectedHardwareLimits,
  normalizeOuterPortBindings,
  readExpectedGpuGrant,
  validateExternalTcpNegativeEvidence,
  validateBoxEvidence,
} from './box-evidence.mjs';
import { collectLiveBoxEvidence } from './live-box.mjs';
import { ROUTER_BIND_ADDRESS_LABEL } from './router-bind-address.mjs';

const IMAGE_ID = `sha256:${'a'.repeat(64)}`;
const CONTAINER_ID = 'c'.repeat(64);
const IMAGE_REF = 'docker.io/assistos/ploinky-box:runtime';
const CONTAINER = 'ploinky-box-release-audit';
const STARTED_AT = '2026-07-16T10:00:00.000Z';
const HOST_KEY_A = `SHA256:${'A'.repeat(43)}`;
const HOST_KEY_B = `SHA256:${'B'.repeat(43)}`;
const AGENTLIB_COMMIT = '1'.repeat(40);
const WORKSPACE_ROOT = '/verified/work space ăîș';
// Cross-checked against Ploinky imageSourceIdHash(imageSourceIdentity(IMAGE_ID)): the
// image-supplied AchillesAgentLib is identified by the outer image and library only.
const IMAGE_AGENTLIB_SOURCE_ID = '9e98b703aa33138e2b98d84df0d29533c208f3bb6caa2f293dcb688565cc381a';

function containerInspect(bindings = {
  '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '18080' }],
  '7882/udp': [{ HostIp: '', HostPort: '7882' }],
}) {
  return [{
    Id: CONTAINER_ID,
    Name: `/${CONTAINER}`,
    Image: IMAGE_ID.slice('sha256:'.length),
    State: { Running: true, StartedAt: STARTED_AT },
    Config: {
      WorkingDir: WORKSPACE_ROOT,
      Env: [`PLOINKY_WORKSPACE_ROOT=${WORKSPACE_ROOT}`],
      Labels: {
        'io.assistos.ploinky-box.role': 'box',
        'io.assistos.ploinky-box.path-hash': 'd'.repeat(12),
        'io.assistos.ploinky-box.image-ref': IMAGE_REF,
        'io.assistos.ploinky-box.router-host-port': '18080',
        'io.assistos.ploinky-box.media-host-port': '7882',
        'io.assistos.ploinky-box.seccomp-fingerprint': 'd'.repeat(64),
        'io.assistos.ploinky-box.dependencies-fingerprint': 'e'.repeat(64),
        'io.assistos.ploinky-box.images-fingerprint': 'f'.repeat(64),
        'io.assistos.ploinky-box.agentlib-mode': 'managed',
        'io.assistos.ploinky-box.agentlib-source-id': '1'.repeat(64),
        'io.assistos.ploinky-box.agentlib-fingerprint': '2'.repeat(64),
        'io.assistos.ploinky-box.agentlib-source-path': `.ploinky/agentlib/generations/${AGENTLIB_COMMIT}-${'2'.repeat(12)}`,
        'io.assistos.ploinky-box.agentlib-commit': AGENTLIB_COMMIT,
      },
    },
    Mounts: [{ Type: 'bind', Source: WORKSPACE_ROOT, Destination: WORKSPACE_ROOT, RW: true }],
    HostConfig: {
      PortBindings: bindings,
      SecurityOpt: [
        'label=disable',
        'seccomp=/verified/ploinky/ploinky-box/seccomp/podman-nested-pid-fallback.json',
        'unmask=all',
      ],
    },
  }];
}

function imageInspect() {
  return [{
    Id: IMAGE_ID.slice('sha256:'.length),
    Config: {
      Labels: {},
      User: 'podman',
      WorkingDir: '/',
      Entrypoint: ['/usr/local/bin/ploinky-box-entrypoint'],
    },
  }];
}

const HARDWARE_FINGERPRINT = '7'.repeat(64);
const HARDWARE_EXPECTED = {
  fingerprint: HARDWARE_FINGERPRINT,
  markerSource: `/verified/home/.ploinky-box/hardware-limits/ploinky-box-release-audit/${HARDWARE_FINGERPRINT}/marker.json`,
  storeSource: '/verified/home/.ploinky-box/hardware-limits/ploinky-box-release-audit/store',
};

function hardwareInspect() {
  const inspected = containerInspect();
  inspected[0].Config.Labels[HARDWARE_LIMITS_LABEL] = HARDWARE_FINGERPRINT;
  inspected[0].Mounts.push(
    { Type: 'bind', Source: HARDWARE_EXPECTED.markerSource, Destination: '/etc/ploinky-box-hardware-limits.json', RW: false },
    { Type: 'bind', Source: HARDWARE_EXPECTED.storeSource, Destination: '/run/ploinky/hardware-limits', RW: true },
  );
  return inspected;
}

test('X.store-rw-marker-ro', () => {
  const options = { ...expected(), expectedHardwareLimits: HARDWARE_EXPECTED };
  const build = (inspection) => buildBoxEvidence({ containerInspect: inspection, imageInspect: imageInspect(), ...options });
  const evidence = build(hardwareInspect());
  assert.equal(evidence.semanticLabels.hardwareLimits, HARDWARE_FINGERPRINT);
  assert.deepEqual(evidence.hardwareWiring, HARDWARE_EXPECTED);
  assert.deepEqual(validateBoxEvidence(JSON.parse(JSON.stringify(evidence)), options), evidence);
  for (const change of [
    (mounts) => { mounts[1].RW = true; },
    (mounts) => { mounts[2].RW = false; },
    (mounts) => { mounts[1].Source = `/foreign/${HARDWARE_FINGERPRINT}/marker.json`; },
    (mounts) => { mounts[2].Source = '/foreign/store'; },
    (mounts) => { mounts[1].Type = 'volume'; },
    (mounts) => { mounts.push({ ...mounts[2] }); },
    (mounts) => { mounts.push({ Type: 'bind', Source: '/foreign', Destination: '/run/ploinky', RW: true }); },
    (mounts) => { mounts.push({ Type: 'bind', Source: HARDWARE_EXPECTED.storeSource, Destination: '/workspace/leak', RW: true }); },
    (mounts) => { mounts.pop(); },
  ]) { const inspection = hardwareInspect(); change(inspection[0].Mounts); assert.throws(() => build(inspection), /Hardware|hardware/); }
  const changed = structuredClone(evidence);
  changed.hardwareWiring.storeSource = '/foreign/store';
  assert.throws(() => validateBoxEvidence(changed, options), /exact inspected sources/);
});

test('X.hardware-unexpected-bind-rejected', () => {
  assert.throws(() => buildBoxEvidence({ containerInspect: hardwareInspect(), imageInspect: imageInspect(), ...expected() }), /explicit expectation/);
  const noLabel = hardwareInspect();
  delete noLabel[0].Config.Labels[HARDWARE_LIMITS_LABEL];
  assert.throws(() => buildBoxEvidence({ containerInspect: noLabel, imageInspect: imageInspect(), ...expected() }), /Hardware binds require/);
  assert.throws(() => readExpectedHardwareLimits({ SMOKE_BOX_HARDWARE_LIMITS: HARDWARE_FINGERPRINT }), /marker source/);
  assert.deepEqual(readExpectedHardwareLimits({ SMOKE_BOX_HARDWARE_LIMITS: HARDWARE_FINGERPRINT, SMOKE_BOX_HARDWARE_MARKER_SOURCE: HARDWARE_EXPECTED.markerSource, SMOKE_BOX_HARDWARE_STORE_SOURCE: HARDWARE_EXPECTED.storeSource }), HARDWARE_EXPECTED);
  assert.equal(readExpectedHardwareLimits({}), null);
});

test('X.tool-binds-ro', () => {
  const gpu = '8'.repeat(64);
  const tools = { controlSource: '/usr/bin/nvidia-cuda-mps-control', serverSource: '/usr/bin/nvidia-cuda-mps-server' };
  const inspected = containerInspect();
  inspected[0].Config.Labels[GPU_GRANT_LABEL] = gpu;
  inspected[0].Mounts.push({ Type: 'bind', Source: `/verified/gpu/${gpu}/marker.json`, Destination: '/etc/ploinky-box-gpu-grant.json', RW: false });
  inspected[0].Mounts.push({ Type: 'bind', Source: `/verified/gpu/${gpu}/box.json`, Destination: '/etc/cdi/ploinky-gpu.json', RW: false });
  inspected[0].Mounts.push(...Object.entries(tools).map(([key, source]) => ({ Type: 'bind', Source: source, Destination: `/usr/local/nvidia/bin/nvidia-cuda-mps-${key === 'controlSource' ? 'control' : 'server'}`, RW: false })));
  const options = { ...expected(), expectedGpuGrant: gpu, expectedMpsTools: tools };
  const observedGpuMarker = { fingerprint: gpu, state: 'active', mps: {
    control: { source: tools.controlSource, destination: '/usr/local/nvidia/bin/nvidia-cuda-mps-control' },
    server: { source: tools.serverSource, destination: '/usr/local/nvidia/bin/nvidia-cuda-mps-server' },
  } };
  const build = (inspection) => buildBoxEvidence({ containerInspect: inspection, imageInspect: imageInspect(), ...options, observedGpuMarker });
  assert.deepEqual(build(inspected).mpsTools, tools);
  assert.throws(() => buildBoxEvidence({ containerInspect: inspected, imageInspect: imageInspect(), ...options }), /actual active GPU marker/);
  assert.throws(() => buildBoxEvidence({ containerInspect: inspected, imageInspect: imageInspect(), ...expected(), expectedGpuGrant: gpu }), /explicit MPS expectation/);
  for (const mutate of [
    (mounts) => { mounts[3].RW = true; },
    (mounts) => { mounts[4].Source = '/substituted/server'; },
    (mounts) => { mounts.pop(); },
  ]) { const changed = structuredClone(inspected); mutate(changed[0].Mounts); assert.throws(() => build(changed), /Hardware wiring requires/); }
});

function imageAgentLibInspect() {
    const inspected = containerInspect();
    inspected[0].Config.Labels['io.assistos.ploinky-box.agentlib-mode'] = 'image';
    inspected[0].Config.Labels['io.assistos.ploinky-box.agentlib-source-path'] = 'image';
    inspected[0].Config.Labels['io.assistos.ploinky-box.agentlib-source-id'] = IMAGE_AGENTLIB_SOURCE_ID;
    // An image selection carries no content fingerprint or Git commit label.
    delete inspected[0].Config.Labels['io.assistos.ploinky-box.agentlib-fingerprint'];
    delete inspected[0].Config.Labels['io.assistos.ploinky-box.agentlib-commit'];
    inspected[0].Mounts = [
        { Type: 'bind', Source: '/verified/ploinky', Destination: '/opt/ploinky', RW: false },
        { Type: 'bind', Source: WORKSPACE_ROOT, Destination: WORKSPACE_ROOT, RW: true },
    ];
    return inspected;
}

test('image AgentLib evidence binds the immutable outer image identity and the fixed source sentinel', () => {
    const evidence = buildBoxEvidence({ containerInspect: imageAgentLibInspect(), imageInspect: imageInspect(), ...expected() });
    assert.equal(evidence.semanticLabels.agentLibMode, 'image');
    assert.equal(evidence.semanticLabels.agentLibSourceRelativePath, 'image');
    assert.equal(evidence.semanticLabels.agentLibSourceIdHash, IMAGE_AGENTLIB_SOURCE_ID);
    assert.equal(imageAgentLibSourceIdHash(IMAGE_ID), IMAGE_AGENTLIB_SOURCE_ID);
    assert.equal(Object.hasOwn(evidence.semanticLabels, 'agentLibFingerprint'), false);
    assert.equal(Object.hasOwn(evidence.semanticLabels, 'agentLibCommit'), false);
    assert.equal(evidence.imageId, IMAGE_ID);
    assert.deepEqual(validateBoxEvidence(JSON.parse(JSON.stringify(evidence)), expected()), evidence);
    for (const [field, value, pattern] of [
        ['agentLibSourceIdHash', 'b'.repeat(64), /Image AgentLib source identity must bind/],
        ['agentLibSourceRelativePath', 'achillesAgentLib', /Image AgentLib evidence requires source-path image/],
        // An image selection that claims a content fingerprint or commit is not the current contract.
        ['agentLibFingerprint', '3'.repeat(64), /labels must be exactly/],
        ['agentLibCommit', AGENTLIB_COMMIT, /labels must be exactly/],
    ]) {
        const changed = structuredClone(evidence);
        changed.semanticLabels[field] = value;
        assert.throws(() => validateBoxEvidence(changed, expected()), pattern, field);
    }
});

test('Box evidence requires a workspace-free image and one exact runtime workspace', () => {
  for (const mutate of [
    (image) => { image.Config.WorkingDir = '/workspace'; },
    (image) => { image.Config.Env = ['PLOINKY_WORKSPACE_ROOT=/workspace']; },
    (image) => { image.Config.Env = ['PLOINKY_WORKSPACE_ROOT=']; },
  ]) {
    const image = imageInspect();
    mutate(image[0]);
    assert.throws(() => buildBoxEvidence({ containerInspect: containerInspect(), imageInspect: image, ...expected() }), /image workdir|workspace root default/);
  }
  for (const mutate of [
    (container) => { container.Config.WorkingDir = '/workspace'; },
    (container) => { container.Config.Env = []; },
    (container) => { container.Config.Env.push(`PLOINKY_WORKSPACE_ROOT=${WORKSPACE_ROOT}`); },
    (container) => { container.Mounts[0].Destination = '/workspace'; },
    (container) => { container.Mounts[0].Source = '/other/workspace'; },
  ]) {
    const container = containerInspect();
    mutate(container[0]);
    assert.throws(() => buildBoxEvidence({ containerInspect: container, imageInspect: imageInspect(), ...expected() }), /workspace|WORKSPACE_ROOT|source mount/);
  }
});

test('image AgentLib rejects substituted source identity, fingerprint or commit labels, and nonexact labels', () => {
    for (const [label, value, pattern] of [
        ['agentlib-source-id', '1'.repeat(64), /Image AgentLib source identity must bind/],
        ['agentlib-source-id', IMAGE_AGENTLIB_SOURCE_ID.toUpperCase(), /Image AgentLib labels require exact image mode/],
        // Earlier contracts put a content fingerprint and commit on an image Box; the current one does not.
        ['agentlib-fingerprint', '3'.repeat(64), /labels must be exactly/],
        ['agentlib-commit', AGENTLIB_COMMIT, /labels must be exactly/],
        ['agentlib-commit', '', /labels must be exactly/],
        ['agentlib-mode', 'image ', /labels must be exactly/],
        ['agentlib-source-path', ' image ', /Image AgentLib evidence requires source-path image/],
        ['agentlib-source-path', 'achillesAgentLib', /Image AgentLib evidence requires source-path image/],
    ]) {
        const inspected = imageAgentLibInspect();
        inspected[0].Config.Labels[`io.assistos.ploinky-box.${label}`] = value;
        assert.throws(() => buildBoxEvidence({ containerInspect: inspected, imageInspect: imageInspect(), ...expected() }), pattern, `${label}=${value}`);
    }
    // The pre-change image source identity (image ID plus content fingerprint) is not accepted.
    const previous = imageAgentLibInspect();
    previous[0].Config.Labels['io.assistos.ploinky-box.agentlib-source-id'] = 'f1b3a1c480fffb60894cb1f24c0b137725c9180a2ef1148467c18d79a9985a85';
    assert.throws(() => buildBoxEvidence({ containerInspect: previous, imageInspect: imageInspect(), ...expected() }),
        /Image AgentLib source identity must bind the exact outer image ID and the library/);
    const copied = imageAgentLibInspect();
    copied[0].Image = 'b'.repeat(64);
    const otherImage = imageInspect();
    otherImage[0].Id = 'b'.repeat(64);
    assert.throws(() => buildBoxEvidence({
        containerInspect: copied, imageInspect: otherImage, ...expected(), expectedImageId: `sha256:${'b'.repeat(64)}`,
    }), /source identity must bind the exact outer image ID/);
    assert.throws(() => buildBoxEvidence({
        containerInspect: imageAgentLibInspect(), imageInspect: imageInspect(), ...expected(), expectedImageId: `sha256:${'b'.repeat(64)}`,
    }), /image ID/);
});

test('image AgentLib requires observed mounts and rejects sources shadowing any bundled path', () => {
    for (const destination of ['/opt/ploinky-agentlib', '/opt/ploinky-agentlib/lib', '/opt', '/opt/', '/', '/opt/ploinky/../ploinky-agentlib']) {
        const inspected = imageAgentLibInspect();
        inspected[0].Mounts.push({ Type: 'bind', Source: '/unrelated/source', Destination: destination, RW: false });
        assert.throws(() => buildBoxEvidence({ containerInspect: inspected, imageInspect: imageInspect(), ...expected() }), /must not be shadowed/);
    }
    for (const mounts of [undefined, null, {}, [{ Destination: 'relative' }], [{ Destination: '/opt\\ploinky-agentlib' }]]) {
        const inspected = imageAgentLibInspect();
        inspected[0].Mounts = mounts;
        assert.throws(() => buildBoxEvidence({ containerInspect: inspected, imageInspect: imageInspect(), ...expected() }), /mount inventory/);
    }
});

test('local and managed AgentLib evidence retains its existing source and optional revision contract', () => {
    for (const mode of ['local', 'managed']) {
        const inspected = containerInspect();
        inspected[0].Config.Labels['io.assistos.ploinky-box.agentlib-mode'] = mode;
        inspected[0].Config.Labels['io.assistos.ploinky-box.agentlib-commit'] = '';
        const evidence = buildBoxEvidence({ containerInspect: inspected, imageInspect: imageInspect(), ...expected() });
        assert.equal(evidence.semanticLabels.agentLibMode, mode);
        assert.equal(evidence.semanticLabels.agentLibCommit, '');
    }
});

function expected() {
  return {
    expectedContainerName: CONTAINER,
    expectedImageId: IMAGE_ID,
    expectedImageRef: IMAGE_REF,
    baseURL: 'https://explorer.test.example',
    publicIPv4: '8.8.8.8',
  };
}

test('explicit bound Box evidence requires matching publication and binding label without widening other ports', () => {
  for (const address of ['0.0.0.0', '192.168.1.50']) {
    const inspection = containerInspect();
    inspection[0].HostConfig.PortBindings['8080/tcp'][0].HostIp = address;
    inspection[0].Config.Labels[ROUTER_BIND_ADDRESS_LABEL] = address;
    const options = { ...expected(), expectedRouterBindAddress: address };
    const build = (value = inspection, overrides = {}) => buildBoxEvidence({
      containerInspect: value, imageInspect: imageInspect(), ...options, ...overrides,
    });
    const verified = build();
    assert.equal(verified.semanticLabels.routerBindAddress, address);
    assert.equal(verified.normalizedPortBindings['8080/tcp'][0].HostIp, address);
    assert.deepEqual(validateBoxEvidence(verified, options), verified);
    assert.throws(() => build(inspection, { expectedRouterBindAddress: '127.0.0.1' }), /must equal/);
    assert.throws(() => validateBoxEvidence(verified, expected()), /must equal/);

    for (const mutate of [
      (value) => { delete value.Config.Labels[ROUTER_BIND_ADDRESS_LABEL]; },
      (value) => { value.Config.Labels[ROUTER_BIND_ADDRESS_LABEL] = '192.168.1.51'; },
      (value) => { value.HostConfig.PortBindings['8080/tcp'][0].HostIp = '127.0.0.1'; },
      (value) => { value.HostConfig.PortBindings['8081/tcp'] = [{ HostIp: '0.0.0.0', HostPort: '8081' }]; },
      (value) => { value.HostConfig.PortBindings['8080/tcp'].push({ HostIp: address, HostPort: '18081' }); },
      (value) => { value.HostConfig.PortBindings['7882/udp'][0].HostIp = '127.0.0.1'; },
      (value) => { value.Config.Labels['unexpected-label'] = 'unexpected'; },
    ]) {
      const altered = structuredClone(inspection);
      mutate(altered[0]);
      assert.throws(() => build(altered), /must equal|must contain exactly one|router-bind-address label|labels must be exactly/);
    }
  }
});

test('live collection carries an explicit wildcard expectation through discovery and evidence validation', () => {
  const prior = process.env.SMOKE_BOX_ROUTER_BIND_ADDRESS;
  process.env.SMOKE_BOX_ROUTER_BIND_ADDRESS = '0.0.0.0';
  try {
    const inspection = containerInspect();
    inspection[0].Config.Labels[ROUTER_BIND_ADDRESS_LABEL] = '0.0.0.0';
    inspection[0].HostConfig.PortBindings['8080/tcp'][0].HostIp = '0.0.0.0';
    const image = imageInspect();
    image[0].Created = STARTED_AT;
    const command = (_executable, args) => {
      if (args[0] === 'container' && args[1] === 'ls') return CONTAINER_ID;
      if (args[0] === 'container' && args[1] === 'inspect') return inspection;
      if (args[0] === 'image' && args[1] === 'inspect') return image;
      throw new Error('Unexpected inspection command');
    };
    const options = { baseURL: 'http://127.0.0.1:18080', nowMs: Date.parse(STARTED_AT) + 1000, command };
    const live = collectLiveBoxEvidence(options);
    assert.equal(live.box.normalizedPortBindings['8080/tcp'][0].HostIp, '0.0.0.0');
    assert.equal(live.box.semanticLabels.routerBindAddress, '0.0.0.0');
    assert.equal(live.workspaceSourceMount.source, WORKSPACE_ROOT);
    inspection[0].Mounts.push({ Type: 'bind', Source: '/other/workspace', Destination: '/other/workspace', RW: true });
    assert.throws(() => collectLiveBoxEvidence({
      ...options, expectedWorkspaceSource: '/other/workspace', realpathSync: (value) => value,
    }), /runtime workspace does not equal/);
    assert.throws(() => collectLiveBoxEvidence({ ...options, expectedRouterBindAddress: '127.0.0.1' }), /found 0/);
  } finally {
    if (prior === undefined) delete process.env.SMOKE_BOX_ROUTER_BIND_ADDRESS;
    else process.env.SMOKE_BOX_ROUTER_BIND_ADDRESS = prior;
  }
});

const GPU_GRANT = '9'.repeat(64);
const GPU_GRANT_DIRECTORY = `/home/operator/.ploinky-box/gpu-grants/${CONTAINER}/${GPU_GRANT}`;

function gpuContainerInspect(grant = GPU_GRANT) {
  const inspection = containerInspect();
  inspection[0].Config.Labels[GPU_GRANT_LABEL] = grant;
  inspection[0].Mounts.push(
    { Type: 'bind', Source: '/usr/lib/x86_64-linux-gnu/libcuda.so.1', Destination: '/usr/local/nvidia/lib64/libcuda.so.1', RW: false },
    { Type: 'bind', Source: `${GPU_GRANT_DIRECTORY}/box.json`, Destination: '/etc/cdi/ploinky-gpu.json', RW: false },
    { Type: 'bind', Source: `${GPU_GRANT_DIRECTORY}/marker.json`, Destination: '/etc/ploinky-box-gpu-grant.json', RW: false },
  );
  return inspection;
}

test('GPU-wired Box evidence requires the exact expected grant label and its read-only grant mounts', () => {
  const options = { ...expected(), expectedGpuGrant: GPU_GRANT };
  const build = (value = gpuContainerInspect(), overrides = {}) => buildBoxEvidence({
    containerInspect: value, imageInspect: imageInspect(), ...options, ...overrides,
  });
  const verified = build();
  assert.equal(verified.semanticLabels.gpuGrant, GPU_GRANT);
  assert.deepEqual(validateBoxEvidence(JSON.parse(JSON.stringify(verified)), options), verified);
  assert.throws(() => build(gpuContainerInspect(), { expectedGpuGrant: null }), /requires an explicit SMOKE_BOX_GPU_GRANT/);
  assert.throws(() => build(gpuContainerInspect(), { expectedGpuGrant: '8'.repeat(64) }), /gpu-grant label must equal/);
  assert.throws(() => build(gpuContainerInspect(), { expectedGpuGrant: 'A'.repeat(64) }), /64 lowercase hexadecimal/);
  assert.throws(() => validateBoxEvidence(verified, expected()), /requires an explicit SMOKE_BOX_GPU_GRANT/);
  assert.throws(() => build(containerInspect()), /gpu-grant label must equal/);

  const find = (value, destination) => value.Mounts.find((mount) => mount.Destination === destination);
  for (const [mutate, message] of [
    [(value) => { value.Mounts = value.Mounts.filter((mount) => mount.Destination !== '/etc/ploinky-box-gpu-grant.json'); }, /read-only marker\.json bind/],
    [(value) => { find(value, '/etc/cdi/ploinky-gpu.json').RW = true; }, /read-only box\.json bind/],
    [(value) => { find(value, '/etc/ploinky-box-gpu-grant.json').Source = `/tmp/${'8'.repeat(64)}/marker.json`; }, /read-only marker\.json bind/],
    [(value) => { find(value, '/etc/ploinky-box-gpu-grant.json').Source = `${GPU_GRANT_DIRECTORY}/../${GPU_GRANT}/marker.json`; }, /read-only marker\.json bind/],
    [(value) => { value.Mounts.push({ ...find(value, '/etc/ploinky-box-gpu-grant.json') }); }, /read-only marker\.json bind/],
    [(value) => { find(value, '/etc/cdi/ploinky-gpu.json').Source = `/tmp/${GPU_GRANT}/box.json`; }, /same grant directory/],
    // Without the CDI spec the grant is stale or revoked, which carries no driver files.
    [(value) => { value.Mounts = value.Mounts.filter((mount) => mount.Destination !== '/etc/cdi/ploinky-gpu.json'); }, /must not bind GPU driver files/],
  ]) {
    const altered = structuredClone(gpuContainerInspect());
    mutate(altered[0]);
    assert.throws(() => build(altered), message);
  }

  // Stale or revoked wiring: Ploinky keeps the label and only the marker bind.
  const markerOnly = gpuContainerInspect();
  markerOnly[0].Mounts = markerOnly[0].Mounts.filter((mount) => !mount.Destination.startsWith('/usr/local/nvidia/')
    && mount.Destination !== '/etc/cdi/ploinky-gpu.json');
  assert.equal(build(markerOnly).semanticLabels.gpuGrant, GPU_GRANT);

  const unlabelled = gpuContainerInspect();
  delete unlabelled[0].Config.Labels[GPU_GRANT_LABEL];
  assert.throws(() => build(unlabelled, { expectedGpuGrant: null }), /mounts require the Box gpu-grant label/);
  const driversOnly = containerInspect();
  driversOnly[0].Mounts.push({ ...gpuContainerInspect()[0].Mounts.find((mount) => mount.Destination.startsWith('/usr/local/nvidia/')) });
  assert.throws(() => build(driversOnly, { expectedGpuGrant: null }), /driver mounts require the Box gpu-grant label/);
  const unexpected = gpuContainerInspect();
  unexpected[0].Config.Labels['unexpected-label'] = 'unexpected';
  assert.throws(() => build(unexpected), /labels must be exactly/);
});

test('live collection reads the GPU grant expectation from SMOKE_BOX_GPU_GRANT', () => {
  const prior = process.env.SMOKE_BOX_GPU_GRANT;
  try {
    const inspection = gpuContainerInspect();
    const image = imageInspect();
    image[0].Created = STARTED_AT;
    const command = (_executable, args) => {
      if (args[0] === 'container' && args[1] === 'ls') return CONTAINER_ID;
      if (args[0] === 'container' && args[1] === 'inspect') return inspection;
      if (args[0] === 'image' && args[1] === 'inspect') return image;
      throw new Error('Unexpected inspection command');
    };
    const options = { baseURL: 'http://127.0.0.1:18080', nowMs: Date.parse(STARTED_AT) + 1000, command };
    delete process.env.SMOKE_BOX_GPU_GRANT;
    assert.equal(readExpectedGpuGrant(), null);
    assert.throws(() => collectLiveBoxEvidence(options), /requires an explicit SMOKE_BOX_GPU_GRANT/);
    process.env.SMOKE_BOX_GPU_GRANT = GPU_GRANT;
    assert.equal(collectLiveBoxEvidence(options).box.semanticLabels.gpuGrant, GPU_GRANT);
    process.env.SMOKE_BOX_GPU_GRANT = 'not-a-fingerprint';
    assert.throws(() => readExpectedGpuGrant(), /SMOKE_BOX_GPU_GRANT must be exactly 64 lowercase hexadecimal/);
  } finally {
    if (prior === undefined) delete process.env.SMOKE_BOX_GPU_GRANT;
    else process.env.SMOKE_BOX_GPU_GRANT = prior;
  }
});

function isolatedContainerInspect(mediaPort = '27882') {
  const inspection = containerInspect({
    '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '28080' }],
    '7882/udp': [{ HostIp: '0.0.0.0', HostPort: mediaPort }],
  });
  inspection[0].Config.Labels['io.assistos.ploinky-box.router-host-port'] = '28080';
  inspection[0].Config.Labels['io.assistos.ploinky-box.media-host-port'] = mediaPort;
  return inspection;
}

test('box evidence accepts a distinct labeled media host port while retaining the fixed UDP target', () => {
  for (const mediaPort of ['1', '27882', '65535']) {
    const evidence = buildBoxEvidence({
      containerInspect: isolatedContainerInspect(mediaPort),
      imageInspect: imageInspect(),
      ...expected(),
    });
    assert.equal(evidence.selectedRouterHostPort, '28080');
    assert.equal(evidence.semanticLabels.mediaHostPort, mediaPort);
    assert.deepEqual(evidence.normalizedPortBindings, normalizeOuterPortBindings({
      '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '28080' }],
      '7882/udp': [{ HostIp: '0.0.0.0', HostPort: mediaPort }],
    }));
    assert.deepEqual(validateBoxEvidence(evidence, expected()), evidence);

    for (const mutation of [
      (value) => { value.semanticLabels.mediaHostPort = '7882'; },
      (value) => { value.normalizedPortBindings['7882/udp'][0].HostPort = '7882'; },
      (value) => { value.semanticLabels.routerHostPort = '18080'; },
      (value) => { value.selectedRouterHostPort = '18080'; },
    ]) {
      const changed = structuredClone(evidence);
      mutation(changed);
      assert.throws(() => validateBoxEvidence(changed, expected()), /label does not match|exact two-publication/);
    }
  }
});

test('alternate media ports require canonical port values and the exact semantic label schema', () => {
  for (const mediaPort of ['', '0', '-1', '65536', '027882', '27882.5', ' 27882 ', '1e4', '27882/udp', null]) {
    assert.throws(() => buildBoxEvidence({
      containerInspect: isolatedContainerInspect(mediaPort),
      imageInspect: imageInspect(),
      ...expected(),
    }), /exact TCP\/UDP port/);
  }
  for (const change of [
    (labels) => { delete labels['io.assistos.ploinky-box.media-host-port']; },
    (labels) => { labels['unexpected-label'] = '27882'; },
    (labels) => { labels['io.assistos.ploinky-box.agentlib-commit'] = 'bad'; },
    (labels) => { labels['io.assistos.ploinky-box.media-host-port'] = '27883'; },
    (labels) => { labels['io.assistos.ploinky-box.media-host-port'] = ' 27882 '; },
  ]) {
    const inspection = isolatedContainerInspect();
    change(inspection[0].Config.Labels);
    assert.throws(() => buildBoxEvidence({
      containerInspect: inspection,
      imageInspect: imageInspect(),
      ...expected(),
    }), /Box labels must be exactly|40 lowercase hexadecimal|media-host-port label/);
  }
});

test('alternate media port evidence rejects extra mappings, wrong protocols and targets, and widened listener boundaries', () => {
  for (const mutate of [
    (bindings) => { bindings['8081/tcp'] = [{ HostIp: '127.0.0.1', HostPort: '28081' }]; },
    (bindings) => { bindings['7882/udp'].push({ HostIp: '0.0.0.0', HostPort: '37882' }); },
    (bindings) => { bindings['8080/tcp'].push({ HostIp: '127.0.0.1', HostPort: '38080' }); },
    (bindings) => { bindings['7882/tcp'] = bindings['7882/udp']; delete bindings['7882/udp']; },
    (bindings) => { bindings['7881/udp'] = bindings['7882/udp']; delete bindings['7882/udp']; },
    (bindings) => { bindings['8080/tcp'][0].HostIp = '0.0.0.0'; },
    (bindings) => { bindings['7882/udp'][0].HostIp = '127.0.0.1'; },
    (bindings) => { bindings['7882/udp'][0].HostIp = '::'; },
  ]) {
    const inspection = isolatedContainerInspect();
    mutate(inspection[0].HostConfig.PortBindings);
    assert.throws(() => buildBoxEvidence({
      containerInspect: inspection,
      imageInspect: imageInspect(),
      ...expected(),
    }), /must contain exactly one|must equal/);
  }
});

test('box evidence binds the exact running semantic image and normalizes only empty wildcard HostIp', () => {
  const evidence = buildBoxEvidence({
    containerInspect: containerInspect(),
    imageInspect: imageInspect(),
    ...expected(),
  });
  assert.deepEqual(evidence.normalizedPortBindings, normalizeOuterPortBindings({
    '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '18080' }],
    '7882/udp': [{ HostIp: '0.0.0.0', HostPort: '7882' }],
  }));
  const validated = validateBoxEvidence(evidence, expected());
  assert.equal(validated.imageId, IMAGE_ID);
  assert.equal(validated.semanticLabels.mediaHostPort, '7882');
  assert.equal(validated.semanticLabels.seccompFingerprint, 'd'.repeat(64));
  assert.equal(validated.semanticLabels.dependenciesFingerprint, 'e'.repeat(64));
  assert.equal(validated.semanticLabels.imagesFingerprint, 'f'.repeat(64));
  assert.equal(validated.semanticLabels.agentLibMode, 'managed');
  assert.equal(validated.semanticLabels.agentLibSourceIdHash, '1'.repeat(64));
  assert.equal(validated.semanticLabels.agentLibFingerprint, '2'.repeat(64));
  assert.equal(validated.semanticLabels.agentLibCommit, AGENTLIB_COMMIT);
  assert.deepEqual(validated.securityOptions, [
    'label=disable',
    'seccomp=/verified/ploinky/ploinky-box/seccomp/podman-nested-pid-fallback.json',
    'unmask=all',
  ]);
});

test('box evidence requires the exact 12-character lowercase path-hash contract', () => {
  for (const invalidPathHash of [
    'd'.repeat(11),
    'd'.repeat(13),
    'd'.repeat(64),
    'ABCDEF123456',
    '123456789abg',
  ]) {
    const invalidOwnership = containerInspect();
    invalidOwnership[0].Config.Labels['io.assistos.ploinky-box.path-hash'] = invalidPathHash;
    assert.throws(() => buildBoxEvidence({
      containerInspect: invalidOwnership,
      imageInspect: imageInspect(),
      ...expected(),
    }), /exactly 12 lowercase hexadecimal characters/);
  }
});

test('box evidence rejects a third publication, wrong semantic ownership, and wrong image id', () => {
  assert.throws(() => buildBoxEvidence({
    containerInspect: containerInspect({
      '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '18080' }],
      '7882/udp': [{ HostIp: '0.0.0.0', HostPort: '7882' }],
      '8081/tcp': [{ HostIp: '127.0.0.1', HostPort: '8081' }],
    }),
    imageInspect: imageInspect(),
    ...expected(),
  }), /exact two-publication|must equal/);

  const wrongOwnership = containerInspect();
  wrongOwnership[0].Config.Labels['io.assistos.ploinky-box.role'] = 'workspace';
  assert.throws(() => buildBoxEvidence({
    containerInspect: wrongOwnership,
    imageInspect: imageInspect(),
    ...expected(),
  }), /role label/);

  const unexpectedLabel = containerInspect();
  unexpectedLabel[0].Config.Labels['io.podman.compose.project'] = 'unexpected';
  assert.throws(() => buildBoxEvidence({
    containerInspect: unexpectedLabel,
    imageInspect: imageInspect(),
    ...expected(),
  }), /Box labels must be exactly/);

  const invalidFingerprint = containerInspect();
  invalidFingerprint[0].Config.Labels['io.assistos.ploinky-box.dependencies-fingerprint'] = 'not-a-digest';
  assert.throws(() => buildBoxEvidence({
    containerInspect: invalidFingerprint,
    imageInspect: imageInspect(),
    ...expected(),
  }), /dependencies-fingerprint label must be a SHA-256 digest/);

  const invalidSeccompFingerprint = containerInspect();
  invalidSeccompFingerprint[0].Config.Labels['io.assistos.ploinky-box.seccomp-fingerprint'] = 'not-a-digest';
  assert.throws(() => buildBoxEvidence({
    containerInspect: invalidSeccompFingerprint,
    imageInspect: imageInspect(),
    ...expected(),
  }), /seccomp-fingerprint label must be a SHA-256 digest/);

  const unconfinedSeccomp = containerInspect();
  unconfinedSeccomp[0].HostConfig.SecurityOpt = ['label=disable', 'seccomp=unconfined', 'unmask=all'];
  assert.throws(() => buildBoxEvidence({
    containerInspect: unconfinedSeccomp,
    imageInspect: imageInspect(),
    ...expected(),
  }), /absolute profile path/);

  for (const [label, value, message] of [
    ['io.assistos.ploinky-box.agentlib-mode', 'default', /AgentLib mode label must be local, managed, or image/],
    ['io.assistos.ploinky-box.agentlib-source-id', 'not-a-digest', /AgentLib source-id label must be a SHA-256 digest/],
    ['io.assistos.ploinky-box.agentlib-fingerprint', 'not-a-digest', /AgentLib fingerprint label must be a SHA-256 digest/],
    ['io.assistos.ploinky-box.agentlib-source-path', '../achillesAgentLib', /workspace-relative path without/],
    ['io.assistos.ploinky-box.agentlib-commit', 'A'.repeat(40), /40 lowercase hexadecimal/],
  ]) {
    const invalidAgentLib = containerInspect();
    invalidAgentLib[0].Config.Labels[label] = value;
    assert.throws(() => buildBoxEvidence({
      containerInspect: invalidAgentLib,
      imageInspect: imageInspect(),
      ...expected(),
    }), message);
  }

  const wrongMediaPort = containerInspect();
  wrongMediaPort[0].Config.Labels['io.assistos.ploinky-box.media-host-port'] = '7881';
  assert.throws(() => buildBoxEvidence({
    containerInspect: wrongMediaPort,
    imageInspect: imageInspect(),
    ...expected(),
  }), /media-host-port label does not match/);

  assert.throws(() => buildBoxEvidence({
    containerInspect: containerInspect(),
    imageInspect: imageInspect(),
    ...expected(),
    expectedImageId: `sha256:${'b'.repeat(64)}`,
  }), /image ID/);

  assert.throws(() => buildBoxEvidence({
    containerInspect: containerInspect({
      '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '18080' }],
      '7882/udp': [{ HostIp: '::', HostPort: '7882' }],
    }),
    imageInspect: imageInspect(),
    ...expected(),
  }), /must equal/);
});

function tcpEvidence(overrides = {}) {
  return {
    runId: 'tcp-scan-123',
    containerName: CONTAINER,
    containerId: CONTAINER_ID,
    containerStartedAt: STARTED_AT,
    imageId: IMAGE_ID,
    targetPublicIPv4: '8.8.8.8',
    observedAt: '2026-07-16T10:05:00.000Z',
    sources: [
      {
        networkId: 'net-a', egressIPv4: '1.1.1.1', protocol: 'tcp',
        targetPublicIPv4: '8.8.8.8', scanStart: 1, scanEnd: 65_535,
        openPorts: [], startedAt: '2026-07-16T10:03:30.000Z', observedAt: '2026-07-16T10:04:30.000Z',
        scanner: 'ploinky-external-boundary', scanId: 'scan-a', scannerTransport: 'ssh-pinned-host',
        scannerSourceSha256: '1'.repeat(64), scannerTargetSha256: 'a'.repeat(64), rawResultSha256: 'c'.repeat(64),
        scannerHostKeySha256: HOST_KEY_A,
        invalidIceProbe: {
          protocol: 'udp', targetPort: 7882, requestHadMessageIntegrity: false,
          outcome: 'timeout', successResponse: false, responseType: null,
        },
      },
      {
        networkId: 'net-b', egressIPv4: '9.9.9.9', protocol: 'tcp',
        targetPublicIPv4: '8.8.8.8', scanStart: 1, scanEnd: 65_535,
        openPorts: [], startedAt: '2026-07-16T10:03:45.000Z', observedAt: '2026-07-16T10:04:45.000Z',
        scanner: 'ploinky-external-boundary', scanId: 'scan-b', scannerTransport: 'ssh-pinned-host',
        scannerSourceSha256: '1'.repeat(64), scannerTargetSha256: 'b'.repeat(64), rawResultSha256: 'd'.repeat(64),
        scannerHostKeySha256: HOST_KEY_B,
        invalidIceProbe: {
          protocol: 'udp', targetPort: 7882, requestHadMessageIntegrity: false,
          outcome: 'error-response', successResponse: false, responseType: 273,
        },
      },
    ],
    ...overrides,
  };
}

function tcpContext() {
  return {
    runId: 'tcp-scan-123',
    boxEvidence: buildBoxEvidence({
      containerInspect: containerInspect(),
      imageInspect: imageInspect(),
      ...expected(),
    }),
    networkSources: [
      {
        networkId: 'net-a', egressIPv4: '1.1.1.1', scannerSourceSha256: '1'.repeat(64),
        scannerTargetSha256: 'a'.repeat(64), scannerHostKeySha256: HOST_KEY_A,
      },
      {
        networkId: 'net-b', egressIPv4: '9.9.9.9', scannerSourceSha256: '1'.repeat(64),
        scannerTargetSha256: 'b'.repeat(64), scannerHostKeySha256: HOST_KEY_B,
      },
    ],
    nowMs: Date.parse('2026-07-16T10:06:00.000Z'),
  };
}

test('external TCP-negative evidence is generation-, nonce-, target-, and two-network-bound', () => {
  const validated = validateExternalTcpNegativeEvidence(tcpEvidence(), tcpContext());
  assert.equal(validated.sources.length, 2);
  assert.deepEqual(validated.sources.flatMap((source) => source.openPorts), []);

  assert.throws(() => validateExternalTcpNegativeEvidence(tcpEvidence({ runId: 'old-run' }), tcpContext()), /runId/);
  assert.throws(() => validateExternalTcpNegativeEvidence(tcpEvidence({ containerId: 'd'.repeat(64) }), tcpContext()), /container ID/);
  assert.throws(() => validateExternalTcpNegativeEvidence(tcpEvidence({ containerStartedAt: '2026-07-16T09:00:00.000Z' }), tcpContext()), /container start/);
  assert.throws(() => validateExternalTcpNegativeEvidence(tcpEvidence({ observedAt: '2026-07-16T09:59:59.000Z' }), tcpContext()), /predates/);
  const openPort = tcpEvidence();
  openPort.sources[1].openPorts = [443];
  assert.throws(() => validateExternalTcpNegativeEvidence(openPort, tcpContext()), /found an inbound TCP port/);
  const partialScan = tcpEvidence();
  partialScan.sources[0].scanEnd = 65_534;
  assert.throws(() => validateExternalTcpNegativeEvidence(partialScan, tcpContext()), /every TCP port/);
  const oldSource = tcpEvidence();
  oldSource.sources[0].startedAt = '2026-07-16T09:59:58.000Z';
  oldSource.sources[0].observedAt = '2026-07-16T09:59:59.000Z';
  assert.throws(() => validateExternalTcpNegativeEvidence(oldSource, tcpContext()), /source net-a scan predates/);
  const duplicateScan = tcpEvidence();
  duplicateScan.sources[1].scanId = 'scan-a';
  assert.throws(() => validateExternalTcpNegativeEvidence(duplicateScan, tcpContext()), /scan ids must be distinct/);
  const successfulInvalidIce = tcpEvidence();
  successfulInvalidIce.sources[0].invalidIceProbe.outcome = 'success-response';
  successfulInvalidIce.sources[0].invalidIceProbe.successResponse = true;
  assert.throws(() => validateExternalTcpNegativeEvidence(successfulInvalidIce, tcpContext()), /invalid ICE fails/);
});

test('external scanner evidence cannot certify a Box with an alternate media host port', () => {
  const context = tcpContext();
  context.boxEvidence = buildBoxEvidence({
    containerInspect: isolatedContainerInspect(),
    imageInspect: imageInspect(),
    ...expected(),
  });
  assert.throws(() => validateExternalTcpNegativeEvidence(tcpEvidence(), context), /fixed UDP host port 7882/);
  const changedProbe = tcpEvidence();
  changedProbe.sources[0].invalidIceProbe.targetPort = 27882;
  assert.throws(() => validateExternalTcpNegativeEvidence(changedProbe, tcpContext()), /invalid ICE fails on UDP 7882/);
});
