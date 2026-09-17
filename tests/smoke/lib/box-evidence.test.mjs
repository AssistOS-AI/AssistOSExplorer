import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildBoxEvidence,
  normalizeOuterPortBindings,
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
// Cross-checked against Ploinky imageSourceId + sourceIdHash for IMAGE_ID and 2*64.
const IMAGE_AGENTLIB_SOURCE_ID = 'f1b3a1c480fffb60894cb1f24c0b137725c9180a2ef1148467c18d79a9985a85';

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

function imageAgentLibInspect() {
    const inspected = containerInspect();
    inspected[0].Config.Labels['io.assistos.ploinky-box.agentlib-mode'] = 'image';
    inspected[0].Config.Labels['io.assistos.ploinky-box.agentlib-source-path'] = 'image';
    inspected[0].Config.Labels['io.assistos.ploinky-box.agentlib-source-id'] = IMAGE_AGENTLIB_SOURCE_ID;
    inspected[0].Mounts = [
        { Type: 'bind', Source: '/verified/ploinky', Destination: '/opt/ploinky', RW: false },
        { Type: 'bind', Source: WORKSPACE_ROOT, Destination: WORKSPACE_ROOT, RW: true },
    ];
    return inspected;
}

test('image AgentLib evidence binds immutable image identity, content fingerprint, revision, and fixed source sentinel', () => {
    const evidence = buildBoxEvidence({ containerInspect: imageAgentLibInspect(), imageInspect: imageInspect(), ...expected() });
    assert.equal(evidence.semanticLabels.agentLibMode, 'image');
    assert.equal(evidence.semanticLabels.agentLibSourceRelativePath, 'image');
    assert.equal(evidence.semanticLabels.agentLibCommit, AGENTLIB_COMMIT);
    assert.equal(evidence.semanticLabels.agentLibSourceIdHash, IMAGE_AGENTLIB_SOURCE_ID);
    assert.equal(evidence.imageId, IMAGE_ID);
    assert.deepEqual(validateBoxEvidence(JSON.parse(JSON.stringify(evidence)), expected()), evidence);
    for (const [field, value] of [
        ['agentLibSourceIdHash', 'b'.repeat(64)],
        ['agentLibFingerprint', '3'.repeat(64)],
        ['agentLibSourceRelativePath', 'achillesAgentLib'],
        ['agentLibCommit', ''],
    ]) {
        const changed = structuredClone(evidence);
        changed.semanticLabels[field] = value;
        assert.throws(() => validateBoxEvidence(changed, expected()), /Image AgentLib/);
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

test('image AgentLib rejects substituted source identity, fingerprint, missing commit, and nonexact labels', () => {
    for (const [label, value] of [
        ['agentlib-source-id', '1'.repeat(64)], ['agentlib-fingerprint', '3'.repeat(64)],
        ['agentlib-source-id', IMAGE_AGENTLIB_SOURCE_ID.toUpperCase()],
        ['agentlib-fingerprint', ' 2'.repeat(64)], ['agentlib-mode', 'image '],
        ['agentlib-source-path', ' image '], ['agentlib-source-path', 'achillesAgentLib'],
        ['agentlib-commit', ''], ['agentlib-commit', null], ['agentlib-commit', 'short'],
    ]) {
        const inspected = imageAgentLibInspect();
        inspected[0].Config.Labels[`io.assistos.ploinky-box.${label}`] = value;
        assert.throws(() => buildBoxEvidence({ containerInspect: inspected, imageInspect: imageInspect(), ...expected() }), /AgentLib/);
    }
    const copied = imageAgentLibInspect();
    copied[0].Image = 'b'.repeat(64);
    const otherImage = imageInspect();
    otherImage[0].Id = 'b'.repeat(64);
    assert.throws(() => buildBoxEvidence({
        containerInspect: copied, imageInspect: otherImage, ...expected(), expectedImageId: `sha256:${'b'.repeat(64)}`,
    }), /source identity must bind the exact image ID/);
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
