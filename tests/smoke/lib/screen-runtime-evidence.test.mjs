import assert from 'node:assert/strict';
import test from 'node:test';

import {
  collectHostLocalScreenEvidence,
  sameScreenRuntimeGeneration,
  screenRuntimeEvidenceProvesUdpMux,
  validateBoxScreenEvidence,
  validateHostLocalScreenEvidence,
} from './screen-runtime-evidence.mjs';

const NOW = Date.parse('2026-07-27T12:00:00.000Z');
const LIVEKIT_ID = 'a'.repeat(64);
const BOX_ID = 'b'.repeat(64);
const IMAGE_ID = `sha256:${'c'.repeat(64)}`;
const BASE_URL = 'http://127.0.0.1:8080';
const LISTENER_LINE = 'UNCONN 0 0 0.0.0.0:7882 0.0.0.0:*';

function localCommand(commandName, args, options = {}) {
  assert.equal(commandName, 'podman');
  if (args[0] === 'container' && args[1] === 'ls') return `${LIVEKIT_ID}\n`;
  if (args[0] === 'container' && args[1] === 'inspect') {
    assert.deepEqual(args, ['container', 'inspect', LIVEKIT_ID]);
    assert.equal(options.json, true);
    return [{
      Id: LIVEKIT_ID,
      Name: '/ploinky_AchillesIDE_liveKitServerAgent_fresh_12345678',
      State: {
        Running: true,
        StartedAt: '2026-07-27T11:59:00.000Z',
      },
      Config: {
        Labels: {
          'io.assistos.ploinky.managed': '1',
        },
      },
      HostConfig: {
        NetworkMode: 'host',
        PortBindings: {},
      },
    }];
  }
  assert.deepEqual(args, [
    'exec', LIVEKIT_ID, 'ss', '-H', '-lun', 'sport = :7882',
  ]);
  assert.equal(options.json, undefined);
  return `${LISTENER_LINE}\n`;
}

function localEvidence() {
  return {
    deployment: 'local',
    capturedAt: '2026-07-27T12:00:00.000Z',
    baseURL: BASE_URL,
    outerBoxCount: 0,
    liveKit: {
      containerName: 'ploinky_AchillesIDE_liveKitServerAgent_fresh_12345678',
      containerId: LIVEKIT_ID,
      startedAt: '2026-07-27T11:59:00.000Z',
      networkMode: 'host',
      portBindings: {},
      udpListener: {
        namespace: 'host-local-livekit',
        outerContainerId: '',
        command: ['ss', '-H', '-lun', 'sport = :7882'],
        lines: [LISTENER_LINE],
      },
    },
  };
}

function boxEvidence() {
  return {
    deployment: 'box',
    capturedAt: '2026-07-27T12:00:00.000Z',
    baseURL: BASE_URL,
    box: {
      capturedAt: '2026-07-27T12:00:00.000Z',
      imageCreatedAt: '2026-07-27T11:00:00.000Z',
      generationMaxAgeMs: 1_800_000,
      imageMaxAgeMs: 14_400_000,
      box: {
        containerName: 'ploinky-box-screen',
        containerId: BOX_ID,
        startedAt: '2026-07-27T11:58:00.000Z',
        running: true,
        semanticLabels: {
          role: 'box',
          pathHash: 'd'.repeat(12),
          imageRef: 'docker.io/assistos/ploinky-box:runtime',
          routerHostPort: '8080',
          mediaHostPort: '7882',
          seccompFingerprint: 'd'.repeat(64),
          dependenciesFingerprint: 'e'.repeat(64),
          imagesFingerprint: 'f'.repeat(64),
          agentLibMode: 'managed',
          agentLibSourceIdHash: '1'.repeat(64),
          agentLibFingerprint: '2'.repeat(64),
          agentLibSourceRelativePath: `.ploinky/agentlib/generations/${'3'.repeat(40)}-${'2'.repeat(12)}`,
          agentLibCommit: '3'.repeat(40),
        },
        imageRef: 'docker.io/assistos/ploinky-box:runtime',
        imageId: IMAGE_ID,
        baseURL: BASE_URL,
        publicIPv4: '',
        selectedRouterHostPort: '8080',
        normalizedPortBindings: {
          '7882/udp': [{ HostIp: '0.0.0.0', HostPort: '7882' }],
          '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '8080' }],
        },
        securityOptions: [
          'label=disable',
          'seccomp=/verified/ploinky/ploinky-box/seccomp/podman-nested-pid-fallback.json',
          'unmask=all',
        ],
      },
    },
    liveKit: {
      containerName: 'ploinky_AchillesIDE_liveKitServerAgent_fresh_12345678',
      containerId: LIVEKIT_ID,
      startedAt: '2026-07-27T11:59:00.000Z',
      networkMode: 'host',
      portBindings: {},
      udpListener: {
        namespace: 'box-nested-livekit',
        outerContainerId: BOX_ID,
        command: ['ss', '-H', '-lun', 'sport = :7882'],
        lines: [LISTENER_LINE],
      },
    },
  };
}

test('host-local screen evidence binds the LiveKit generation and a real UDP 7882 listener without a Box', () => {
  const evidence = collectHostLocalScreenEvidence({
    baseURL: BASE_URL,
    nowMs: NOW,
    command: localCommand,
  });
  assert.deepEqual(evidence, localEvidence());
  assert.equal(screenRuntimeEvidenceProvesUdpMux(evidence), true);
  assert.equal(sameScreenRuntimeGeneration(evidence, evidence), true);
});

test('host-local screen evidence rejects Box overlap, inner bindings, and missing or wrong listeners', () => {
  const base = localEvidence();
  assert.throws(
    () => validateHostLocalScreenEvidence({ ...base, outerBoxCount: 1 }, {
      baseURL: BASE_URL,
      nowMs: NOW,
    }),
    /must not include an outer Ploinky Box/,
  );
  assert.throws(
    () => validateHostLocalScreenEvidence({
      ...base,
      liveKit: { ...base.liveKit, portBindings: { '7882/udp': [] } },
    }, {
      baseURL: BASE_URL,
      nowMs: NOW,
    }),
    /zero inner PortBindings/,
  );
  for (const lines of [[], ['UNCONN 0 0 0.0.0.0:7881 0.0.0.0:*']]) {
    const invalid = structuredClone(base);
    invalid.liveKit.udpListener.lines = lines;
    assert.throws(
      () => validateHostLocalScreenEvidence(invalid, { baseURL: BASE_URL, nowMs: NOW }),
      /real UDP listener|must bind UDP 7882/,
    );
    assert.equal(screenRuntimeEvidenceProvesUdpMux(invalid), false);
  }
  for (const field of ['containerId', 'startedAt']) {
    const invalid = structuredClone(base);
    delete invalid.liveKit[field];
    assert.equal(screenRuntimeEvidenceProvesUdpMux(invalid), false);
  }
});

test('Box screen evidence binds the nested LiveKit listener to the exact outer generation and publications', () => {
  const evidence = validateBoxScreenEvidence(boxEvidence(), {
    baseURL: BASE_URL,
    nowMs: NOW,
  });
  assert.equal(screenRuntimeEvidenceProvesUdpMux(evidence), true);
  assert.equal(sameScreenRuntimeGeneration(evidence, structuredClone(evidence)), true);

  const changedLiveKit = structuredClone(evidence);
  changedLiveKit.liveKit.containerId = 'e'.repeat(64);
  assert.equal(sameScreenRuntimeGeneration(evidence, changedLiveKit), false);

  const wrongOuter = boxEvidence();
  wrongOuter.liveKit.udpListener.outerContainerId = 'f'.repeat(64);
  assert.throws(
    () => validateBoxScreenEvidence(wrongOuter, { baseURL: BASE_URL, nowMs: NOW }),
    /not bound to the exact outer Box generation/,
  );
  assert.equal(screenRuntimeEvidenceProvesUdpMux(wrongOuter), false);

  const unboundCapture = boxEvidence();
  unboundCapture.box.capturedAt = '2026-07-27T11:59:59.000Z';
  assert.throws(
    () => validateBoxScreenEvidence(unboundCapture, { baseURL: BASE_URL, nowMs: NOW }),
    /capture is not bound/,
  );
  assert.equal(screenRuntimeEvidenceProvesUdpMux(unboundCapture), false);
});
