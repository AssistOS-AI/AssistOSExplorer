import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  collectLiveBoxEvidence,
  sameLiveBoxGeneration,
} from './live-box.mjs';
import { collectLocalSnapshotSourceBindings } from './local-snapshot-bindings.mjs';

const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/;
const GIT_COMMIT = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;

// The current release verifier's versioned result. A result without this exact
// version and kind, such as the legacy 421 verifier's, is never accepted in
// release mode.
export const RELEASE_BUNDLE_SCHEMA_VERSION = 1;
export const RELEASE_BUNDLE_KIND = 'explorer-release-bundle';
const RELEASE_CORE_REPOSITORIES = Object.freeze(['achillesAgentLib', 'explorer', 'ploinky']);
const RELEASE_REPOSITORY_ROLES = Object.freeze(['deployed-source', 'provenance-reference']);

// The build-time record of the achillesAgentLib copy a Box image packages.
// An image-mode Box carries no AgentLib commit label, so this record is the
// only statement of which AgentLib commit the running image supplies.
export const IMAGE_AGENTLIB_PROVENANCE_PATH = '/usr/local/share/ploinky/agentlib/runtime-contract.json';

export function parseImageAgentLibProvenance(text) {
  let record;
  try {
    record = JSON.parse(String(text || ''));
  } catch (error) {
    throw new Error(`The Box image AgentLib provenance is not valid JSON: ${error.message}`);
  }
  if (record?.schema !== 'ploinky.box.library/v1'
    || record?.library !== 'achillesAgentLib'
    || !GIT_COMMIT.test(String(record?.commit || ''))) {
    throw new Error('The Box image does not record an exact achillesAgentLib commit in its library provenance.');
  }
  return Object.freeze({
    commit: record.commit,
    repository: String(record.repository || ''),
    packageVersion: String(record.packageVersion || ''),
  });
}

// Reads the provenance from the verified immutable image itself, not from the
// running container, in a throwaway container with no network and no pull.
export function readImageAgentLibProvenance(imageId, { spawn = spawnSync } = {}) {
  if (!IMAGE_DIGEST.test(String(imageId || ''))) {
    throw new Error('Reading Box image AgentLib provenance requires an immutable sha256 image ID.');
  }
  const result = spawn('podman', [
    'run', '--rm', '--network=none', '--pull=never', '--entrypoint', '/bin/cat', imageId, IMAGE_AGENTLIB_PROVENANCE_PATH,
  ], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    timeout: 60_000,
    killSignal: 'SIGKILL',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Reading the Box image AgentLib provenance failed with exit ${result.status ?? 'unknown'}: ${String(result.stderr || '').trim()}`);
  }
  return parseImageAgentLibProvenance(result.stdout);
}

function requireCurrentReleaseVersion(verified) {
  if (verified?.schemaVersion !== RELEASE_BUNDLE_SCHEMA_VERSION || verified?.kind !== RELEASE_BUNDLE_KIND) {
    throw new Error(`The release verifier did not return the current versioned ${RELEASE_BUNDLE_KIND} result (schemaVersion ${RELEASE_BUNDLE_SCHEMA_VERSION}).`);
  }
  if (!SHA256.test(String(verified.sourceInventorySha256 || ''))) {
    throw new Error('The release verifier did not return the SHA-256 of the frozen source inventory.');
  }
  return Object.freeze({
    schemaVersion: verified.schemaVersion,
    kind: verified.kind,
    sourceInventorySha256: verified.sourceInventorySha256,
  });
}

// Every verified source entry is kept: the complete map is what the native
// evidence and the generation comparison bind, so nothing is filtered here.
function requireCompleteReleaseSources(repositories) {
  if (!repositories || typeof repositories !== 'object' || Array.isArray(repositories)) {
    throw new Error('The release verifier did not return the verified source repositories.');
  }
  for (const name of RELEASE_CORE_REPOSITORIES) {
    if (!Object.hasOwn(repositories, name)) {
      throw new Error(`The release verifier did not return the required ${name} source.`);
    }
  }
  for (const [name, entry] of Object.entries(repositories)) {
    if (entry?.name !== name
      || !GIT_COMMIT.test(String(entry.commit || ''))
      || !path.isAbsolute(String(entry.repositoryPath || ''))
      || !RELEASE_REPOSITORY_ROLES.includes(entry.role)) {
      throw new Error(`The release verifier returned an incomplete source entry for ${name}.`);
    }
  }
}

export async function collectCopilotReleaseEvidence({
  manifestPath,
  verificationMode = 'release',
  requireActiveRoboTeamAgent = true,
  verifierPath,
  baseURL,
  boxBaseURL = baseURL,
  expectedContainerName = '',
  expectedImageRef = '',
  generationMaxAgeMs,
  imageMaxAgeMs,
  loadVerifier = async (filePath) => import(pathToFileURL(filePath).href),
  collectLiveBox = collectLiveBoxEvidence,
  collectSnapshotBindings = collectLocalSnapshotSourceBindings,
  readImageAgentLib = readImageAgentLibProvenance,
  realpathSync = fs.realpathSync,
} = {}) {
  if (!['release', 'local-snapshot'].includes(verificationMode)) {
    throw new Error('SMOKE_SOURCE_VERIFICATION must be release or local-snapshot.');
  }
  if (verificationMode === 'local-snapshot') {
    if (new URL(baseURL).origin !== new URL(boxBaseURL).origin) {
      throw new Error('Local snapshot application and inspected Box must use the same origin.');
    }
    for (const origin of [baseURL, boxBaseURL]) {
      const url = new URL(origin);
      if (!['http:', 'https:'].includes(url.protocol)
        || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
        || url.username || url.password) {
        throw new Error('Local snapshot verification requires loopback application and Box URLs.');
      }
    }
  }
  if (!manifestPath || !path.isAbsolute(manifestPath)) {
    throw new Error('SMOKE_RELEASE_MANIFEST must be an absolute path for the ordinary Copilot gate.');
  }
  if (!verifierPath || !path.isAbsolute(verifierPath)) {
    throw new Error('The ordinary Copilot gate requires an absolute release verifier path.');
  }
  const verifier = await loadVerifier(verifierPath);
  if (typeof verifier?.verifyManifestFile !== 'function') {
    throw new Error('The Copilot release verifier does not export verifyManifestFile.');
  }
  const verified = verifier.verifyManifestFile(manifestPath);
  if ((verified.verificationMode || 'release') !== verificationMode) {
    throw new Error('The source verifier does not match the explicitly selected verification mode.');
  }
  const releaseBundle = verificationMode === 'release' ? requireCurrentReleaseVersion(verified) : null;
  if (!IMAGE_DIGEST.test(String(verified?.imageDigest || ''))) {
    throw new Error('The Copilot release verifier did not return an immutable Box image digest.');
  }
  const verifiedPloinky = verified?.repositories?.ploinky;
  if (!verifiedPloinky || !path.isAbsolute(String(verifiedPloinky.repositoryPath || ''))) {
    throw new Error('The Copilot release verifier did not return the verified Ploinky checkout path.');
  }
  const verifiedAgentLib = verified?.repositories?.achillesAgentLib;
  if (!verifiedAgentLib || !GIT_COMMIT.test(String(verifiedAgentLib.commit || ''))) {
    throw new Error('The Copilot release verifier did not return the verified achillesAgentLib commit.');
  }
  if (releaseBundle) requireCompleteReleaseSources(verified.repositories);
  const verifiedPloinkySource = realpathSync(verifiedPloinky.repositoryPath);
  const liveBox = collectLiveBox({
    baseURL: boxBaseURL,
    expectedContainerName,
    expectedImageId: verified.imageDigest,
    expectedImageRef,
    generationMaxAgeMs,
    imageMaxAgeMs,
    requireFreshImage: false,
    expectedPloinkySource: verifiedPloinkySource,
    ...(verificationMode === 'local-snapshot' ? { expectedWorkspaceSource: path.dirname(verifiedPloinkySource) } : {}),
    realpathSync,
  });
  if (liveBox?.box?.imageId !== verified.imageDigest) {
    throw new Error('The running Box image does not match SMOKE_RELEASE_MANIFEST.');
  }
  if (liveBox?.ploinkySourceMount?.source !== verifiedPloinkySource) {
    throw new Error('The running Box is not bound read-only to the verified Ploinky checkout.');
  }
  const liveAgentLib = liveBox?.box?.semanticLabels;
  const imageMode = liveAgentLib?.agentLibMode === 'image';
  // A local or managed Box labels its AgentLib commit. An image-mode Box has no
  // commit label; its source identity is bound to the verified image ID by the
  // live Box evidence, and that image records the commit it packaged.
  const agentLibCommit = imageMode
    ? readImageAgentLib(liveBox.box.imageId).commit
    : liveAgentLib?.agentLibCommit;
  // The clean Git counterpart of an image-supplied AgentLib is provenance for
  // the packaged commit, not a deployed source; a local AgentLib is the deployed source.
  if (releaseBundle) {
    const role = verifiedAgentLib.role;
    if (imageMode && role !== 'provenance-reference') {
      throw new Error('An image-mode Box requires the achillesAgentLib source to be labeled provenance-reference.');
    }
    if (liveAgentLib?.agentLibMode === 'local' && role !== 'deployed-source') {
      throw new Error('A local-AgentLib Box requires the achillesAgentLib source to be labeled deployed-source.');
    }
  }
  if (agentLibCommit !== verifiedAgentLib.commit) {
    throw new Error(imageMode
      ? 'The running Box image records an AgentLib commit that does not match SMOKE_RELEASE_MANIFEST.'
      : 'The running Box AgentLib commit does not match SMOKE_RELEASE_MANIFEST.');
  }
  const agentLib = Object.freeze({
    mode: liveAgentLib.agentLibMode,
    sourceIdHash: liveAgentLib.agentLibSourceIdHash,
    ...(liveAgentLib.agentLibFingerprint ? { fingerprint: liveAgentLib.agentLibFingerprint } : {}),
    sourceRelativePath: liveAgentLib.agentLibSourceRelativePath,
    commit: agentLibCommit,
    commitEvidence: imageMode ? 'image-provenance' : 'box-label',
  });
  const sourceBindings = verificationMode === 'local-snapshot'
    ? collectSnapshotBindings({ liveBox, repositories: verified.repositories, requireActiveRoboTeamAgent })
    : null;
  return Object.freeze({
    verificationMode,
    ...(sourceBindings ? { sourceBindings } : {}),
    applicationBaseURL: baseURL,
    boxBaseURL,
    imageDigest: verified.imageDigest,
    ...(releaseBundle ? { releaseBundle } : {}),
    repositories: verified.repositories,
    ploinkySource: Object.freeze({
      path: verifiedPloinkySource,
      commit: verifiedPloinky.commit,
    }),
    agentLib,
    liveBox,
  });
}

function sameSnapshotBindings(before, after) {
  if (!before || !after || after.roboTeamAgent?.active !== true) return false;
  const { roboTeamAgent: priorRoboTeam, ...priorBindings } = before;
  const { roboTeamAgent: currentRoboTeam, ...currentBindings } = after;
  if (!priorRoboTeam || !currentRoboTeam) return false;
  // Folder launch may activate or replace RoboTeam, while its source stays pinned.
  return ['source', 'runtimeSource', 'treeSha256'].every(key => (
    typeof priorRoboTeam[key] === 'string' && priorRoboTeam[key].length > 0 && priorRoboTeam[key] === currentRoboTeam[key]
  )) && JSON.stringify(priorBindings) === JSON.stringify(currentBindings);
}

export function sameCopilotReleaseGeneration(before, after) {
  return Boolean(
    before?.applicationBaseURL
    && before.applicationBaseURL === after?.applicationBaseURL
    && before?.boxBaseURL
    && before.boxBaseURL === after?.boxBaseURL
    && before?.imageDigest
    && before?.verificationMode === after?.verificationMode
    && JSON.stringify(before?.repositories) === JSON.stringify(after?.repositories)
    && JSON.stringify(before?.releaseBundle) === JSON.stringify(after?.releaseBundle)
    && (before?.verificationMode !== 'release' || SHA256.test(String(before?.releaseBundle?.sourceInventorySha256 || '')))
    && (before?.verificationMode === 'local-snapshot'
      ? sameSnapshotBindings(before.sourceBindings, after.sourceBindings)
      : JSON.stringify(before?.sourceBindings) === JSON.stringify(after?.sourceBindings))
    && before.imageDigest === after?.imageDigest
    && before.imageDigest === before?.liveBox?.box?.imageId
    && after.imageDigest === after?.liveBox?.box?.imageId
    && before?.ploinkySource?.path === after?.ploinkySource?.path
    && before?.ploinkySource?.commit === after?.ploinkySource?.commit
    && before?.agentLib?.commit
    && JSON.stringify(before?.agentLib) === JSON.stringify(after?.agentLib)
    && sameLiveBoxGeneration(before.liveBox, after.liveBox)
  );
}
