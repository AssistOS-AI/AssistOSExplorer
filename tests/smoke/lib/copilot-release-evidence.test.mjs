import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  IMAGE_AGENTLIB_PROVENANCE_PATH,
  collectCopilotReleaseEvidence,
  parseImageAgentLibProvenance,
  readImageAgentLibProvenance,
  sameCopilotReleaseGeneration,
} from './copilot-release-evidence.mjs';
import { validateBoxFreshness } from './live-box.mjs';

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

function imageModeLiveBox() {
  const box = liveBox();
  box.box.semanticLabels = {
    seccompFingerprint: 'd'.repeat(64),
    agentLibMode: 'image',
    agentLibSourceIdHash: '4'.repeat(64),
    agentLibSourceRelativePath: 'image',
  };
  return box;
}

const INVENTORY_SHA256 = '7'.repeat(64);

function sourceEntry(name, commit, role = 'deployed-source') {
  return { name, repositoryPath: `/verified/${name}`, commit, role };
}

// The current release verifier's versioned result, with the complete source map
// (core repositories plus actual dependencies), in the verifier's sorted order.
function currentRelease({ agentLibCommit = AGENTLIB_COMMIT, agentLibRole = 'provenance-reference', mutate } = {}) {
  const result = {
    schemaVersion: 1,
    kind: 'explorer-release-bundle',
    sourceInventorySha256: INVENTORY_SHA256,
    imageDigest: DIGEST,
    repositories: {
      OnlyOfficeAgent: sourceEntry('OnlyOfficeAgent', '8'.repeat(40)),
      achillesAgentLib: sourceEntry('achillesAgentLib', agentLibCommit, agentLibRole),
      explorer: sourceEntry('explorer', '1'.repeat(40)),
      ploinky: { ...sourceEntry('ploinky', '2'.repeat(40)), repositoryPath: PLOINKY_SOURCE },
      webmeet: sourceEntry('webmeet', '9'.repeat(40)),
    },
  };
  if (mutate) mutate(result);
  return result;
}

function releaseVerifier(achillesAgentLibCommit = AGENTLIB_COMMIT, options = {}) {
  return async () => ({
    verifyManifestFile: () => currentRelease({ agentLibCommit: achillesAgentLibCommit, ...options }),
  });
}

const PROVENANCE_TEXT = JSON.stringify({
  schema: 'ploinky.box.library/v1',
  library: 'achillesAgentLib',
  packageName: 'ploinky-agent-lib',
  packageVersion: '0.1.0',
  repository: 'https://github.com/AssistOS-AI/AchillesAgentLib.git',
  branch: null,
  commit: AGENTLIB_COMMIT,
});

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
          return currentRelease();
        },
      };
    },
    collectLiveBox(options) {
      calls.push(['box', options]);
      return liveBox();
    },
    readImageAgentLib(imageId) {
      calls.push(['image-provenance', imageId]);
      throw new Error('a Box with an AgentLib commit label must not read image provenance');
    },
    realpathSync: (value) => value,
  });
  assert.equal(calls.some(([kind]) => kind === 'image-provenance'), false);
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
    commitEvidence: 'box-label',
  });
});

test('ordinary Copilot release evidence binds an image-mode Box through the AgentLib commit its image records', async () => {
  const reads = [];
  const result = await collectCopilotReleaseEvidence({
    manifestPath: '/candidate/release.json',
    verifierPath: '/candidate/verifier.mjs',
    baseURL: 'http://127.0.0.1:8080',
    loadVerifier: releaseVerifier(),
    collectLiveBox: () => imageModeLiveBox(),
    readImageAgentLib(imageId) {
      reads.push(imageId);
      return parseImageAgentLibProvenance(PROVENANCE_TEXT);
    },
    realpathSync: (value) => value,
  });
  assert.deepEqual(reads, [DIGEST], 'the provenance is read from the verified image, once');
  assert.deepEqual(result.agentLib, {
    mode: 'image',
    sourceIdHash: '4'.repeat(64),
    sourceRelativePath: 'image',
    commit: AGENTLIB_COMMIT,
    commitEvidence: 'image-provenance',
  });
  assert.equal(sameCopilotReleaseGeneration(result, structuredClone(result)), true);
  const otherCommit = structuredClone(result);
  otherCommit.agentLib.commit = '6'.repeat(40);
  assert.equal(sameCopilotReleaseGeneration(result, otherCommit), false);
});

test('ordinary Copilot release evidence rejects an image-mode Box whose image records another AgentLib commit', async () => {
  const collect = (readImageAgentLib) => collectCopilotReleaseEvidence({
    manifestPath: '/candidate/release.json',
    verifierPath: '/candidate/verifier.mjs',
    baseURL: 'http://127.0.0.1:8080',
    loadVerifier: releaseVerifier(),
    collectLiveBox: () => imageModeLiveBox(),
    readImageAgentLib,
    realpathSync: (value) => value,
  });
  await assert.rejects(
    () => collect(() => ({ commit: '6'.repeat(40) })),
    /image records an AgentLib commit that does not match SMOKE_RELEASE_MANIFEST/,
  );
  await assert.rejects(
    () => collect(() => { throw new Error('Reading the Box image AgentLib provenance failed with exit 125'); }),
    /provenance failed with exit 125/,
  );
});

test('image AgentLib provenance must be the exact library record with a full commit', () => {
  assert.deepEqual(parseImageAgentLibProvenance(PROVENANCE_TEXT), {
    commit: AGENTLIB_COMMIT,
    repository: 'https://github.com/AssistOS-AI/AchillesAgentLib.git',
    packageVersion: '0.1.0',
  });
  const record = JSON.parse(PROVENANCE_TEXT);
  assert.throws(() => parseImageAgentLibProvenance('{'), /not valid JSON/);
  for (const broken of [
    { ...record, schema: 'ploinky.box.library/v2' },
    { ...record, library: 'mcp-sdk' },
    { ...record, commit: 'ef515b2d' },
    { ...record, commit: null },
  ]) {
    assert.throws(() => parseImageAgentLibProvenance(JSON.stringify(broken)), /does not record an exact achillesAgentLib commit/);
  }
});

test('image AgentLib provenance is read from the immutable image without network, pulls or a lasting container', () => {
  const calls = [];
  const spawn = (command, args) => {
    calls.push([command, args]);
    return { status: 0, stdout: PROVENANCE_TEXT, stderr: '' };
  };
  assert.equal(readImageAgentLibProvenance(DIGEST, { spawn }).commit, AGENTLIB_COMMIT);
  assert.deepEqual(calls, [[
    'podman',
    ['run', '--rm', '--network=none', '--pull=never', '--entrypoint', '/bin/cat', DIGEST, IMAGE_AGENTLIB_PROVENANCE_PATH],
  ]]);
  assert.equal(IMAGE_AGENTLIB_PROVENANCE_PATH, '/usr/local/share/ploinky/agentlib/runtime-contract.json');
  assert.throws(
    () => readImageAgentLibProvenance(DIGEST, { spawn: () => ({ status: 125, stdout: '', stderr: 'no such image' }) }),
    /provenance failed with exit 125: no such image/,
  );
  assert.throws(() => readImageAgentLibProvenance('latest', { spawn }), /immutable sha256 image ID/);
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
      loadVerifier: releaseVerifier(),
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
      loadVerifier: releaseVerifier(),
      collectLiveBox: () => ({ ...liveBox(), ploinkySourceMount: undefined }),
      realpathSync: (value) => value,
    }),
    /not bound read-only/,
  );
});

test('ordinary Copilot release evidence rejects a missing or mismatched AgentLib manifest binding', async () => {
  const collect = (mutate, box = liveBox()) => collectCopilotReleaseEvidence({
    manifestPath: '/candidate/release.json',
    verifierPath: '/candidate/verifier.mjs',
    loadVerifier: async () => ({ verifyManifestFile: () => currentRelease({ mutate }) }),
    collectLiveBox: () => box,
    realpathSync: (value) => value,
  });
  await assert.rejects(() => collect((result) => { delete result.repositories.achillesAgentLib; }), /did not return the verified achillesAgentLib commit/);
  await assert.rejects(
    () => collect((result) => { result.repositories.achillesAgentLib.commit = '6'.repeat(40); }),
    /AgentLib commit does not match SMOKE_RELEASE_MANIFEST/,
  );
});

test('ordinary Copilot evidence requires the same immutable Box generation after the gate', () => {
  const before = {
    applicationBaseURL: 'https://explorer-qa.axiologic.dev',
    boxBaseURL: 'http://127.0.0.1:8080',
    imageDigest: DIGEST,
    verificationMode: 'release',
    releaseBundle: { schemaVersion: 1, kind: 'explorer-release-bundle', sourceInventorySha256: INVENTORY_SHA256 },
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
  assert.match(runner, /requireActiveRoboTeamAgent: false/);
  assert.match(runner, /requireActiveRoboTeamAgent: true/);
  assert.doesNotMatch(runner, /requireActiveAchillesCLI/);
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
      roboTeamAgent: { active: true, source: '/candidate/AssistOSExplorer/roboTeamAgent', runtimeSource: '/candidate/AssistOSExplorer/roboTeamAgent', treeSha256: repositories.explorer.treeSha256, containerId: 'c'.repeat(64), codeRoot: '/candidate/runtime/old' },
    }),
    loadVerifier: async () => ({ verifyManifestFile: () => structuredClone(source) }),
    collectLiveBox: () => liveBox(),
    realpathSync: value => value,
  };
  const before = await collectCopilotReleaseEvidence(options);
  assert.equal(before.verificationMode, 'local-snapshot');
  assert.equal(before.sourceBindings.roboTeamAgent.treeSha256, before.repositories.explorer.treeSha256);
  assert.equal('roboTeamAgent' in before.repositories, false);
  assert.equal('achillesCLI' in before.sourceBindings, false);
  assert.equal(sameCopilotReleaseGeneration(before, structuredClone(before)), true);
  const retired = structuredClone(before);
  retired.sourceBindings.achillesCLI = retired.sourceBindings.roboTeamAgent;
  delete retired.sourceBindings.roboTeamAgent;
  assert.equal(sameCopilotReleaseGeneration(retired, structuredClone(retired)), false);
  assert.equal(sameCopilotReleaseGeneration(before, retired), false);
  assert.equal(sameCopilotReleaseGeneration(retired, before), false);
  const after = structuredClone(before);
  after.repositories.explorer.treeSha256 = '0'.repeat(64);
  assert.equal(sameCopilotReleaseGeneration(before, after), false);
  const launchedRoboTeam = structuredClone(before);
  launchedRoboTeam.sourceBindings.roboTeamAgent.containerId = 'f'.repeat(64);
  launchedRoboTeam.sourceBindings.roboTeamAgent.codeRoot = '/candidate/runtime/new';
  assert.equal(sameCopilotReleaseGeneration(before, launchedRoboTeam), true);
  const initiallyInactive = structuredClone(before);
  initiallyInactive.sourceBindings.roboTeamAgent.active = false;
  delete initiallyInactive.sourceBindings.roboTeamAgent.containerId;
  delete initiallyInactive.sourceBindings.roboTeamAgent.codeRoot;
  assert.equal(sameCopilotReleaseGeneration(initiallyInactive, launchedRoboTeam), true);
  assert.equal(sameCopilotReleaseGeneration(before, initiallyInactive), false);
  for (const key of ['source', 'runtimeSource', 'treeSha256']) {
    const changed = structuredClone(launchedRoboTeam);
    changed.sourceBindings.roboTeamAgent[key] = 'changed';
    assert.equal(sameCopilotReleaseGeneration(before, changed), false, key);
  }
  const replacedExplorer = structuredClone(before);
  replacedExplorer.sourceBindings.explorer.containerId = 'f'.repeat(64);
  assert.equal(sameCopilotReleaseGeneration(before, replacedExplorer), false);
  const changedAgentRuntime = structuredClone(before);
  changedAgentRuntime.sourceBindings.ploinkyAgent.treeSha256 = 'f'.repeat(64);
  assert.equal(sameCopilotReleaseGeneration(before, changedAgentRuntime), false);
  const lifecycleCalls = [];
  for (const requireActiveRoboTeamAgent of [false, true]) {
    await collectCopilotReleaseEvidence({
      ...options,
      requireActiveRoboTeamAgent,
      collectSnapshotBindings: args => {
        lifecycleCalls.push(args.requireActiveRoboTeamAgent);
        assert.equal('requireActiveAchillesCLI' in args, false);
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

test('image-mode release evidence and local-snapshot source evidence never substitute for one another', async () => {
  const snapshotVerified = {
    verificationMode: 'local-snapshot',
    imageDigest: DIGEST,
    repositories: {
      ploinky: { commit: '2'.repeat(40), repositoryPath: PLOINKY_SOURCE, treeSha256: '7'.repeat(64) },
      achillesAgentLib: { commit: AGENTLIB_COMMIT, treeSha256: '8'.repeat(64) },
      explorer: { commit: '1'.repeat(40), treeSha256: '9'.repeat(64) },
    },
  };
  const boxCalls = [];
  let snapshotCollections = 0;
  const common = {
    verifierPath: '/candidate/verifier.mjs',
    baseURL: 'http://127.0.0.1:8080',
    boxBaseURL: 'http://127.0.0.1:8080',
    collectLiveBox(options) { boxCalls.push(options); return imageModeLiveBox(); },
    readImageAgentLib: () => ({ commit: AGENTLIB_COMMIT }),
    collectSnapshotBindings: () => {
      snapshotCollections += 1;
      return { explorer: { active: true, treeSha256: '9'.repeat(64) },
        roboTeamAgent: { active: true, source: '/candidate/AssistOSExplorer/roboTeamAgent', runtimeSource: '/candidate/AssistOSExplorer/roboTeamAgent', treeSha256: '9'.repeat(64) },
        ploinkyAgent: { treeSha256: 'a'.repeat(64) } };
    },
    realpathSync: value => value,
  };
  const release = await collectCopilotReleaseEvidence({ ...common, manifestPath: '/candidate/release.json', loadVerifier: releaseVerifier() });
  assert.equal(release.verificationMode, 'release');
  assert.equal('sourceBindings' in release, false, 'Image-mode evidence carries no source bindings.');
  assert.equal(snapshotCollections, 0, 'Release mode must never run the local-snapshot collector.');
  assert.equal('expectedWorkspaceSource' in boxCalls[0], false, 'Release mode takes its workspace pin from the selected host workspace.');
  const snapshot = await collectCopilotReleaseEvidence({ ...common, manifestPath: '/candidate/snapshot.json', verificationMode: 'local-snapshot',
    loadVerifier: async () => ({ verifyManifestFile: () => structuredClone(snapshotVerified) }) });
  assert.equal(snapshot.verificationMode, 'local-snapshot');
  assert.equal(snapshotCollections, 1);
  assert.equal(boxCalls[1].expectedWorkspaceSource, path.dirname(PLOINKY_SOURCE));
  assert.equal(sameCopilotReleaseGeneration(release, snapshot), false);
  assert.equal(sameCopilotReleaseGeneration(snapshot, release), false);
  // Relabelling one mode as the other does not make it the same generation.
  assert.equal(sameCopilotReleaseGeneration(release, { ...structuredClone(snapshot), verificationMode: 'release' }), false);
  assert.equal(sameCopilotReleaseGeneration({ ...structuredClone(release), verificationMode: 'local-snapshot' }, snapshot), false);
  assert.equal(sameCopilotReleaseGeneration(release, structuredClone(release)), true);
  assert.equal(sameCopilotReleaseGeneration(snapshot, structuredClone(snapshot)), true);
});

const releaseOptions = (overrides = {}) => ({
  manifestPath: '/candidate/release.json',
  verifierPath: '/candidate/verifyExplorerReleaseBundle.mjs',
  baseURL: 'http://127.0.0.1:8080',
  loadVerifier: releaseVerifier(),
  collectLiveBox: () => imageModeLiveBox(),
  readImageAgentLib: () => ({ commit: AGENTLIB_COMMIT }),
  realpathSync: (value) => value,
  ...overrides,
});

test('release mode accepts only the current versioned verifier result and never falls back to the legacy shape', async () => {
  const legacyShaped = () => ({
    imageDigest: DIGEST,
    repositories: {
      explorer: { commit: '1'.repeat(40), repositoryPath: '/verified/explorer' },
      ploinky: { commit: '2'.repeat(40), repositoryPath: PLOINKY_SOURCE },
      achillesAgentLib: { commit: AGENTLIB_COMMIT, repositoryPath: '/verified/achillesAgentLib' },
      achillesCLI: { commit: '3'.repeat(40), repositoryPath: '/verified/achillesCLI' },
    },
  });
  const rejected = [
    ['legacy unversioned result', legacyShaped, /current versioned explorer-release-bundle result/],
    ['unknown version', () => currentRelease({ mutate: (result) => { result.schemaVersion = 2; } }), /current versioned explorer-release-bundle result/],
    ['string version', () => currentRelease({ mutate: (result) => { result.schemaVersion = '1'; } }), /current versioned explorer-release-bundle result/],
    ['foreign kind', () => currentRelease({ mutate: (result) => { result.kind = 'local-snapshot-v1'; } }), /current versioned explorer-release-bundle result/],
    ['missing inventory hash', () => currentRelease({ mutate: (result) => { delete result.sourceInventorySha256; } }), /SHA-256 of the frozen source inventory/],
    ['malformed inventory hash', () => currentRelease({ mutate: (result) => { result.sourceInventorySha256 = 'A'.repeat(64); } }), /SHA-256 of the frozen source inventory/],
  ];
  for (const [label, verified, expected] of rejected) {
    const calls = [];
    await assert.rejects(() => collectCopilotReleaseEvidence(releaseOptions({
      loadVerifier: async () => ({ verifyManifestFile: verified }),
      collectLiveBox: (...args) => { calls.push(args); return imageModeLiveBox(); },
    })), expected, label);
    assert.equal(calls.length, 0, `${label} must fail before the Box is observed`);
  }
});

test('release evidence retains the complete verified source map and binds the inventory hash across the run', async () => {
  const result = await collectCopilotReleaseEvidence(releaseOptions());
  const expected = currentRelease();
  assert.deepEqual(result.repositories, expected.repositories);
  assert.deepEqual(Object.keys(result.repositories), ['OnlyOfficeAgent', 'achillesAgentLib', 'explorer', 'ploinky', 'webmeet']);
  assert.deepEqual(result.releaseBundle, { schemaVersion: 1, kind: 'explorer-release-bundle', sourceInventorySha256: INVENTORY_SHA256 });
  assert.equal('achillesCLI' in result.repositories, false);
  assert.equal(sameCopilotReleaseGeneration(result, structuredClone(result)), true);
  for (const [label, change] of [
    ['dependency commit', (value) => { value.repositories.webmeet.commit = 'a'.repeat(40); }],
    ['dependency removed', (value) => { delete value.repositories.OnlyOfficeAgent; }],
    ['dependency role', (value) => { value.repositories.webmeet.role = 'provenance-reference'; }],
    ['inventory hash', (value) => { value.releaseBundle.sourceInventorySha256 = '6'.repeat(64); }],
    ['bundle removed', (value) => { delete value.releaseBundle; }],
  ]) {
    const after = structuredClone(result);
    change(after);
    assert.equal(sameCopilotReleaseGeneration(result, after), false, label);
  }
  const bare = structuredClone(result);
  delete bare.releaseBundle;
  assert.equal(sameCopilotReleaseGeneration(bare, structuredClone(bare)), false, 'release evidence without a bundle binding never settles');
});

test('release mode rejects incomplete verified source maps after the existing manifest checks', async () => {
  const collect = (mutate) => collectCopilotReleaseEvidence(releaseOptions({
    loadVerifier: async () => ({ verifyManifestFile: () => currentRelease({ mutate }) }),
  }));
  await assert.rejects(() => collect((result) => { delete result.repositories.explorer; }), /did not return the required explorer source/);
  await assert.rejects(() => collect((result) => { delete result.repositories.webmeet.role; }), /incomplete source entry for webmeet/);
  await assert.rejects(() => collect((result) => { result.repositories.webmeet.role = 'latest'; }), /incomplete source entry for webmeet/);
  await assert.rejects(() => collect((result) => { result.repositories.webmeet.repositoryPath = 'relative/webmeet'; }), /incomplete source entry for webmeet/);
  await assert.rejects(() => collect((result) => { result.repositories.webmeet.commit = 'master'; }), /incomplete source entry for webmeet/);
  await assert.rejects(() => collect((result) => { result.repositories.webmeet.name = 'other'; }), /incomplete source entry for webmeet/);
});

test('the AgentLib source role must match the actual AgentLib mode of the running Box', async () => {
  // Image mode: the clean Git counterpart is provenance for the packaged commit, never a deployed source.
  await assert.rejects(() => collectCopilotReleaseEvidence(releaseOptions({
    loadVerifier: releaseVerifier(AGENTLIB_COMMIT, { agentLibRole: 'deployed-source' }),
  })), /image-mode Box requires the achillesAgentLib source to be labeled provenance-reference/);
  const image = await collectCopilotReleaseEvidence(releaseOptions());
  assert.equal(image.repositories.achillesAgentLib.role, 'provenance-reference');
  assert.equal(image.agentLib.commitEvidence, 'image-provenance');
  // The packaged-commit comparison still applies to a correctly labeled reference.
  await assert.rejects(() => collectCopilotReleaseEvidence(releaseOptions({
    loadVerifier: releaseVerifier('6'.repeat(40)),
  })), /image records an AgentLib commit that does not match SMOKE_RELEASE_MANIFEST/);
  // Local mode: the real checkout is the deployed source, and its label commit is still compared.
  const localBox = () => {
    const box = liveBox();
    box.box.semanticLabels = { ...box.box.semanticLabels, agentLibMode: 'local' };
    return box;
  };
  await assert.rejects(() => collectCopilotReleaseEvidence(releaseOptions({
    collectLiveBox: localBox,
    loadVerifier: releaseVerifier(AGENTLIB_COMMIT, { agentLibRole: 'provenance-reference' }),
  })), /local-AgentLib Box requires the achillesAgentLib source to be labeled deployed-source/);
  const local = await collectCopilotReleaseEvidence(releaseOptions({
    collectLiveBox: localBox,
    loadVerifier: releaseVerifier(AGENTLIB_COMMIT, { agentLibRole: 'deployed-source' }),
  }));
  assert.equal(local.agentLib.mode, 'local');
  assert.equal(local.agentLib.commitEvidence, 'box-label');
  await assert.rejects(() => collectCopilotReleaseEvidence(releaseOptions({
    collectLiveBox: localBox,
    loadVerifier: releaseVerifier('6'.repeat(40), { agentLibRole: 'deployed-source' }),
  })), /running Box AgentLib commit does not match SMOKE_RELEASE_MANIFEST/);
});

test('the exact absolute verifier path is loaded and relative or missing paths are refused before any load', async () => {
  const loaded = [];
  const loadVerifier = async (filePath) => { loaded.push(filePath); return releaseVerifier()(); };
  await collectCopilotReleaseEvidence(releaseOptions({ loadVerifier, verifierPath: '/pinned/ploinky/tests/release/verifyExplorerReleaseBundle.mjs' }));
  assert.deepEqual(loaded, ['/pinned/ploinky/tests/release/verifyExplorerReleaseBundle.mjs']);
  for (const verifierPath of ['relative/verifier.mjs', '', undefined]) {
    await assert.rejects(() => collectCopilotReleaseEvidence(releaseOptions({ loadVerifier, verifierPath })), /requires an absolute release verifier path/);
  }
  assert.equal(loaded.length, 1, 'no refused path reached the loader');
  await assert.rejects(() => collectCopilotReleaseEvidence(releaseOptions({ loadVerifier: async () => ({}) })), /does not export verifyManifestFile/);
});

test('canonical runner selects the current release verifier and hands that exact path to every child', () => {
  const runner = fs.readFileSync(path.resolve(import.meta.dirname, '../scripts/run-playwright.mjs'), 'utf8');
  const orchestration = fs.readFileSync(path.resolve(import.meta.dirname, 'live-sessions-orchestration.mjs'), 'utf8');
  assert.match(runner, /\? '\.\.\/\.\.\/\.\.\/ploinky\/tests\/release\/verifyLocalSnapshotBundle\.mjs'\n\s+: '\.\.\/\.\.\/\.\.\/ploinky\/tests\/release\/verifyExplorerReleaseBundle\.mjs'\);/);
  assert.match(runner, /if \(verificationMode === 'release'\) childEnv\.SMOKE_COPILOT_RELEASE_VERIFIER = sourceVerifierPath;/);
  assert.doesNotMatch(runner, /verifyCopilot421Bundle/);
  assert.doesNotMatch(orchestration, /verifyCopilot421Bundle/);
  assert.match(orchestration, /verifyExplorerReleaseBundle\.mjs/);
  // Every consumer of the runner's verifier resolves its default from the same current file.
  assert.equal((runner.match(/verifierPath: sourceVerifierPath/g) || []).length >= 4, true);
});

test('an expired Box generation is refused by the real freshness check under the caller age limit, with no evidence returned', async () => {
  const NOW = Date.parse('2026-07-31T10:00:00.000Z');
  const seen = [];
  const collect = (startedAt) => collectCopilotReleaseEvidence(releaseOptions({
    generationMaxAgeMs: 30 * 60_000,
    collectLiveBox(options) {
      seen.push({ generationMaxAgeMs: options.generationMaxAgeMs, requireFreshImage: options.requireFreshImage });
      const evidence = imageModeLiveBox();
      evidence.box.startedAt = startedAt;
      validateBoxFreshness({
        capturedAt: '2026-07-31T10:00:00.000Z',
        imageCreatedAt: '2026-07-30T10:00:00.000Z',
        box: evidence.box,
        generationMaxAgeMs: options.generationMaxAgeMs,
        requireFreshImage: options.requireFreshImage,
      }, { nowMs: NOW });
      return evidence;
    },
  }));
  const fresh = await collect('2026-07-31T09:45:00.000Z');
  assert.equal(fresh.repositories.explorer.commit, '1'.repeat(40));
  await assert.rejects(() => collect('2026-07-31T09:20:00.000Z'), /outer container generation is not fresh enough/);
  await assert.rejects(() => collect('2026-07-31T09:20:00.000Z'), (error) => !('liveBox' in error));
  assert.deepEqual(seen, Array(3).fill({ generationMaxAgeMs: 30 * 60_000, requireFreshImage: false }));
});
