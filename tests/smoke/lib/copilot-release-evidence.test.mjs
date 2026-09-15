import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  collectCopilotReleaseEvidence,
  sameCopilotReleaseGeneration,
} from './copilot-release-evidence.mjs';

const DIGEST = `sha256:${'a'.repeat(64)}`;
const PLOINKY_SOURCE = '/candidate/ploinky';
const AGENTLIB_COMMIT = '3'.repeat(40);

function liveBox(overrides = {}) {
  return {
    capturedAt: '2026-07-31T10:00:00.000Z',
    box: {
      containerName: 'ploinky-box-exact',
      containerId: 'b'.repeat(64),
      startedAt: '2026-07-31T09:59:00.000Z',
      imageId: DIGEST,
      imageRef: 'localhost/ploinky-box:test',
      baseURL: 'http://127.0.0.1:8080',
      normalizedPortBindings: {
        '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '8080' }],
        '7882/udp': [{ HostIp: '0.0.0.0', HostPort: '7882' }],
      },
      securityOptions: [
        'label=disable',
        'seccomp=/verified/ploinky/ploinky-box/seccomp/podman-nested-pid-fallback.json',
        'unmask=all',
      ],
      semanticLabels: {
        seccompFingerprint: 'd'.repeat(64),
        agentLibMode: 'managed',
        agentLibSourceIdHash: '4'.repeat(64),
        agentLibFingerprint: '5'.repeat(64),
        agentLibSourceRelativePath: `.ploinky/agentlib/generations/${AGENTLIB_COMMIT}-${'5'.repeat(12)}`,
        agentLibCommit: AGENTLIB_COMMIT,
      },
      ...overrides,
    },
    ploinkySourceMount: {
      type: 'bind',
      source: PLOINKY_SOURCE,
      destination: '/opt/ploinky',
      readWrite: false,
    },
  };
}

test('ordinary Copilot release evidence binds the verified manifest digest to the live Box', async () => {
  const calls = [];
  const result = await collectCopilotReleaseEvidence({
    manifestPath: '/candidate/release.json',
    verifierPath: '/candidate/verifier.mjs',
    baseURL: 'https://explorer-qa.axiologic.dev',
    boxBaseURL: 'http://127.0.0.1:8080',
    loadVerifier: async (filePath) => {
      calls.push(['load', filePath]);
      return {
        verifyManifestFile(manifestPath) {
          calls.push(['verify', manifestPath]);
          return {
            imageDigest: DIGEST,
            repositories: {
              explorer: { commit: '1'.repeat(40) },
              ploinky: { commit: '2'.repeat(40), repositoryPath: PLOINKY_SOURCE },
              achillesAgentLib: { commit: AGENTLIB_COMMIT },
            },
          };
        },
      };
    },
    collectLiveBox(options) {
      calls.push(['box', options]);
      return liveBox();
    },
    realpathSync: (value) => value,
  });
  assert.equal(result.imageDigest, DIGEST);
  assert.equal(result.applicationBaseURL, 'https://explorer-qa.axiologic.dev');
  assert.equal(result.boxBaseURL, 'http://127.0.0.1:8080');
  assert.equal(result.liveBox.box.imageId, DIGEST);
  assert.deepEqual(calls.slice(0, 2), [
    ['load', '/candidate/verifier.mjs'],
    ['verify', '/candidate/release.json'],
  ]);
  assert.equal(calls[2][1].expectedImageId, DIGEST);
  assert.equal(calls[2][1].baseURL, 'http://127.0.0.1:8080');
  assert.equal(calls[2][1].expectedPloinkySource, PLOINKY_SOURCE);
  assert.equal(calls[2][1].requireFreshImage, false);
  assert.equal(result.ploinkySource.path, PLOINKY_SOURCE);
  assert.deepEqual(result.agentLib, {
    mode: 'managed',
    sourceIdHash: '4'.repeat(64),
    fingerprint: '5'.repeat(64),
    sourceRelativePath: `.ploinky/agentlib/generations/${AGENTLIB_COMMIT}-${'5'.repeat(12)}`,
    commit: AGENTLIB_COMMIT,
  });
});

test('ordinary Copilot release evidence rejects missing manifest binding and wrong live image', async () => {
  await assert.rejects(
    () => collectCopilotReleaseEvidence({
      manifestPath: 'relative.json',
      verifierPath: '/candidate/verifier.mjs',
    }),
    /SMOKE_RELEASE_MANIFEST must be an absolute path/,
  );
  await assert.rejects(
    () => collectCopilotReleaseEvidence({
      manifestPath: '/candidate/release.json',
      verifierPath: '/candidate/verifier.mjs',
      loadVerifier: async () => ({
        verifyManifestFile: () => ({
          imageDigest: DIGEST,
          repositories: {
            ploinky: { commit: '2'.repeat(40), repositoryPath: PLOINKY_SOURCE },
            achillesAgentLib: { commit: AGENTLIB_COMMIT },
          },
        }),
      }),
      collectLiveBox: () => liveBox({ imageId: `sha256:${'c'.repeat(64)}` }),
      realpathSync: (value) => value,
    }),
    /running Box image does not match/,
  );
});

test('ordinary Copilot release evidence rejects a Box without the verified read-only source mount', async () => {
  await assert.rejects(
    () => collectCopilotReleaseEvidence({
      manifestPath: '/candidate/release.json',
      verifierPath: '/candidate/verifier.mjs',
      loadVerifier: async () => ({
        verifyManifestFile: () => ({
          imageDigest: DIGEST,
          repositories: {
            ploinky: { commit: '2'.repeat(40), repositoryPath: PLOINKY_SOURCE },
            achillesAgentLib: { commit: AGENTLIB_COMMIT },
          },
        }),
      }),
      collectLiveBox: () => ({ ...liveBox(), ploinkySourceMount: undefined }),
      realpathSync: (value) => value,
    }),
    /not bound read-only/,
  );
});

test('ordinary Copilot release evidence rejects a missing or mismatched AgentLib manifest binding', async () => {
  const collect = (achillesAgentLib, box = liveBox()) => collectCopilotReleaseEvidence({
    manifestPath: '/candidate/release.json',
    verifierPath: '/candidate/verifier.mjs',
    loadVerifier: async () => ({
      verifyManifestFile: () => ({
        imageDigest: DIGEST,
        repositories: {
          ploinky: { commit: '2'.repeat(40), repositoryPath: PLOINKY_SOURCE },
          ...(achillesAgentLib ? { achillesAgentLib } : {}),
        },
      }),
    }),
    collectLiveBox: () => box,
    realpathSync: (value) => value,
  });
  await assert.rejects(() => collect(undefined), /did not return the verified achillesAgentLib commit/);
  await assert.rejects(
    () => collect({ commit: '6'.repeat(40) }),
    /AgentLib commit does not match SMOKE_RELEASE_MANIFEST/,
  );
});

test('ordinary Copilot evidence requires the same immutable Box generation after the gate', () => {
  const before = {
    applicationBaseURL: 'https://explorer-qa.axiologic.dev',
    boxBaseURL: 'http://127.0.0.1:8080',
    imageDigest: DIGEST,
    ploinkySource: { path: PLOINKY_SOURCE, commit: '2'.repeat(40) },
    agentLib: {
      mode: 'managed',
      sourceIdHash: '4'.repeat(64),
      fingerprint: '5'.repeat(64),
      sourceRelativePath: `.ploinky/agentlib/generations/${AGENTLIB_COMMIT}-${'5'.repeat(12)}`,
      commit: AGENTLIB_COMMIT,
    },
    liveBox: liveBox(),
  };
  assert.equal(sameCopilotReleaseGeneration(before, structuredClone(before)), true);
  const replacement = structuredClone(before);
  replacement.liveBox.box.containerId = 'd'.repeat(64);
  assert.equal(sameCopilotReleaseGeneration(before, replacement), false);
  const wrongPublicApplication = structuredClone(before);
  wrongPublicApplication.applicationBaseURL = 'https://wrong-app.example';
  assert.equal(sameCopilotReleaseGeneration(before, wrongPublicApplication), false);
  const wrongLoopbackInspector = structuredClone(before);
  wrongLoopbackInspector.boxBaseURL = 'http://127.0.0.1:18080';
  assert.equal(sameCopilotReleaseGeneration(before, wrongLoopbackInspector), false);
  const wrongAgentLib = structuredClone(before);
  wrongAgentLib.agentLib.fingerprint = '6'.repeat(64);
  assert.equal(sameCopilotReleaseGeneration(before, wrongAgentLib), false);
});

test('canonical runner consumes SMOKE_RELEASE_MANIFEST and passes bound evidence to the spec', () => {
  const runner = fs.readFileSync(
    path.resolve(import.meta.dirname, '../scripts/run-playwright.mjs'),
    'utf8',
  );
  const spec = fs.readFileSync(
    path.resolve(import.meta.dirname, '../specs/05-copilot-folder-launch.spec.mjs'),
    'utf8',
  );
  assert.match(runner, /SMOKE_RELEASE_MANIFEST/);
  assert.match(runner, /SMOKE_BOX_BASE_URL/);
  assert.match(runner, /collectCopilotReleaseEvidence/);
  assert.match(runner, /sameCopilotReleaseGeneration/);
  assert.match(spec, /SMOKE_COPILOT_RELEASE_EVIDENCE/);
  assert.match(spec, /routerResponses\.every\(\(entry\) => entry\.status >= 200 && entry\.status < 300\)/);
  assert.match(spec, /completionToken = `COPILOT_CHAT_OK_\$\{correlation\}`/);
  assert.match(spec, /completed\.at\(-1\)\.text\)\.toContain\(completionToken\)/);
  assert.match(spec, /const COMPLETION_FAILURE = \/\\\[input error\\\]\|/);
  assert.match(spec, /response\.status\(\) === 204 \? '' : response\.text\(\)/);
});

test('local snapshot mode is explicit, loopback-only, and binds source digests across the run', async () => {
  const source = {
    verificationMode: 'local-snapshot',
    imageDigest: DIGEST,
    repositories: {
      ploinky: { commit: '2'.repeat(40), repositoryPath: PLOINKY_SOURCE, treeSha256: '7'.repeat(64) },
      achillesAgentLib: { commit: AGENTLIB_COMMIT, treeSha256: '8'.repeat(64) },
      explorer: { commit: '1'.repeat(40), treeSha256: '9'.repeat(64) },
    },
  };
  const options = {
    manifestPath: '/candidate/snapshot.json',
    verifierPath: '/candidate/verifyLocalSnapshotBundle.mjs',
    verificationMode: 'local-snapshot',
    baseURL: 'http://127.0.0.1:8080',
    collectSnapshotBindings: ({ repositories }) => ({
      explorer: { active: true, containerId: 'e'.repeat(64), treeSha256: repositories.explorer.treeSha256 },
      ploinkyAgent: { source: '/candidate/ploinky/Agent', runtimeSource: '/Agent', treeSha256: 'a'.repeat(64) },
      achillesCLI: { active: true, source: '/candidate/AchillesCLI/achilles-cli', runtimeSource: '/workspace/.ploinky/repos/AchillesCLI/achilles-cli', treeSha256: 'b'.repeat(64), containerId: 'c'.repeat(64), codeRoot: '/candidate/runtime/old' },
    }),
    loadVerifier: async () => ({ verifyManifestFile: () => structuredClone(source) }),
    collectLiveBox: () => liveBox(),
    realpathSync: value => value,
  };
  const before = await collectCopilotReleaseEvidence(options);
  assert.equal(before.verificationMode, 'local-snapshot');
  assert.equal(sameCopilotReleaseGeneration(before, structuredClone(before)), true);
  const after = structuredClone(before);
  after.repositories.explorer.treeSha256 = '0'.repeat(64);
  assert.equal(sameCopilotReleaseGeneration(before, after), false);
  const launchedCLI = structuredClone(before);
  launchedCLI.sourceBindings.achillesCLI.containerId = 'f'.repeat(64);
  launchedCLI.sourceBindings.achillesCLI.codeRoot = '/candidate/runtime/new';
  assert.equal(sameCopilotReleaseGeneration(before, launchedCLI), true);
  const initiallyInactive = structuredClone(before);
  initiallyInactive.sourceBindings.achillesCLI.active = false;
  delete initiallyInactive.sourceBindings.achillesCLI.containerId;
  delete initiallyInactive.sourceBindings.achillesCLI.codeRoot;
  assert.equal(sameCopilotReleaseGeneration(initiallyInactive, launchedCLI), true);
  assert.equal(sameCopilotReleaseGeneration(before, initiallyInactive), false);
  for (const key of ['source', 'runtimeSource', 'treeSha256']) {
    const changed = structuredClone(launchedCLI);
    changed.sourceBindings.achillesCLI[key] = 'changed';
    assert.equal(sameCopilotReleaseGeneration(before, changed), false, key);
  }
  const replacedExplorer = structuredClone(before);
  replacedExplorer.sourceBindings.explorer.containerId = 'f'.repeat(64);
  assert.equal(sameCopilotReleaseGeneration(before, replacedExplorer), false);
  const changedAgentRuntime = structuredClone(before);
  changedAgentRuntime.sourceBindings.ploinkyAgent.treeSha256 = 'f'.repeat(64);
  assert.equal(sameCopilotReleaseGeneration(before, changedAgentRuntime), false);
  const lifecycleCalls = [];
  for (const requireActiveAchillesCLI of [false, true]) {
    await collectCopilotReleaseEvidence({
      ...options,
      requireActiveAchillesCLI,
      collectSnapshotBindings: args => {
        lifecycleCalls.push(args.requireActiveAchillesCLI);
        return options.collectSnapshotBindings(args);
      },
    });
  }
  assert.deepEqual(lifecycleCalls, [false, true]);
  await assert.rejects(() => collectCopilotReleaseEvidence({ ...options, baseURL: 'https://explorer-qa.axiologic.dev' }), /requires loopback|same origin/);
  await assert.rejects(() => collectCopilotReleaseEvidence({ ...options, boxBaseURL: 'http://remote.example' }), /requires loopback|same origin/);
  await assert.rejects(() => collectCopilotReleaseEvidence({ ...options, boxBaseURL: 'http://127.0.0.1:9090' }), /same origin/);
  await assert.rejects(() => collectCopilotReleaseEvidence({ ...options, verificationMode: 'release' }), /does not match/);
  await assert.rejects(() => collectCopilotReleaseEvidence({ ...options, verificationMode: 'skip' }), /must be release or local-snapshot/);
});
