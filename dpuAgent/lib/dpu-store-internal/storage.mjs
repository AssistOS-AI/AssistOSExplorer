import fs from 'node:fs/promises';
import path from 'node:path';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

import {
  isNonEmptyString,
  sleep
} from './common.mjs';
import {
  defaultPermissionsManifest,
  normalizePermissionsManifest
} from './permissions-manifest.mjs';
import { applyFreshDefaultAgentPolicies } from './default-agent-policies.mjs';

const STATE_FILENAME = 'state.json';
const PERMISSIONS_MANIFEST_FILENAME = 'permissions.manifest.json';
const LOCK_DIRNAME = '.lock';
const LOCK_OWNER_FILENAME = 'owner.json';
const BLOBS_DIRNAME = 'blobs';
const AUDIT_DIRNAME = 'audit';
const PROVENANCE_DIRNAME = 'provenance';
const MATERIALIZATIONS_DIRNAME = 'materializations';
const SECRETS_FILENAME = 'secrets.json';
const PLOINKY_REPOS_DIRNAME = '.ploinky/repos';
const CONFIDENTIAL_FILE_PREFIX = 'DPUENC1';
const SECRET_MAP_FILE_PREFIX = 'DPUSECS1';
const CONFIDENTIAL_CONTEXT = 'dpu:confidential:';
const SECRET_MAP_CONTEXT = 'dpu:secret-map:';
const DEFAULT_AUDIT_RETENTION_DAYS = 90;
const AUDIT_RETENTION_MARKER_FILENAME = '.retention-day';
const auditRetentionChecks = new Map();
const DPU_RECORD_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

function requireDpuRecordId(value, label = 'DPU record') {
  const id = String(value || '').trim();
  if (!DPU_RECORD_ID_PATTERN.test(id)) {
    throw new Error(`${label} id must be a DPU UUID.`);
  }
  return id;
}

export function getWorkspaceRoot() {
  const candidates = [
    process.env.DPU_WORKSPACE_ROOT,
    process.env.ASSISTOS_FS_ROOT,
    process.env.WORKSPACE_ROOT
  ].filter(isNonEmptyString);
  return path.resolve(candidates[0] || process.cwd());
}

export function getDpuDataRoot() {
  const configured = [
    process.env.DPU_DATA_ROOT
  ].find(isNonEmptyString);
  if (!configured) {
    throw new Error('DPU_DATA_ROOT is required and must identify the mounted DPU data root.');
  }
  return path.resolve(configured);
}

export function getPloinkyReposRoot() {
  return path.join(getWorkspaceRoot(), PLOINKY_REPOS_DIRNAME);
}

export function getStateFilePath() {
  return path.join(getDpuDataRoot(), STATE_FILENAME);
}

export function getLockDirPath() {
  return path.join(getDpuDataRoot(), LOCK_DIRNAME);
}

export function getPermissionsManifestPath() {
  return path.join(getDpuDataRoot(), PERMISSIONS_MANIFEST_FILENAME);
}

export function getSecretsFilePath() {
  return path.join(getDpuDataRoot(), SECRETS_FILENAME);
}

export function getConfidentialBlobsRoot() {
  return path.join(getDpuDataRoot(), BLOBS_DIRNAME);
}

export function getAuditRoot() {
  return path.join(getDpuDataRoot(), AUDIT_DIRNAME);
}

export function getProvenanceRoot() {
  return path.join(getDpuDataRoot(), PROVENANCE_DIRNAME);
}

export function getMaterializationsRoot() {
  return path.join(getDpuDataRoot(), MATERIALIZATIONS_DIRNAME);
}

export function getResourceMaterializationRoot(resourceId) {
  return path.join(getMaterializationsRoot(), requireDpuRecordId(resourceId, 'Research resource'));
}

export function getConfidentialBlobPath(objectId) {
  return path.join(getConfidentialBlobsRoot(), objectId);
}

export function getAuditFilePath(fileName) {
  return path.join(getAuditRoot(), fileName);
}

function getConfiguredMasterKey() {
  const configured = [
    process.env.DPU_MASTER_KEY
  ].find((value) => String(value || '').trim());
  if (!configured) {
    throw new Error('DPU master key is not configured.');
  }
  return String(configured).trim();
}

function deriveMasterKey(namespace) {
  const configured = getConfiguredMasterKey();
  return createHash('sha256')
    .update(`${namespace}${configured}`, 'utf8')
    .digest();
}

export function getConfidentialMasterKey() {
  return deriveMasterKey(CONFIDENTIAL_CONTEXT);
}

export async function ensureParentDir(filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

export async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function readJsonFile(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

export async function writeJsonFile(filePath, value) {
  await ensureParentDir(filePath);
  const tempPath = `${filePath}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(tempPath, filePath);
}

export async function withFileLock(task) {
  const lockDir = getLockDirPath();
  await ensureParentDir(lockDir);
  const timeoutMs = 8000;
  const startedAt = Date.now();
  while (true) {
    try {
      await fs.mkdir(lockDir);
      await writeJsonFile(path.join(lockDir, LOCK_OWNER_FILENAME), {
        pid: process.pid,
        acquiredAt: new Date().toISOString()
      });
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        throw error;
      }
      const owner = await readJsonFile(path.join(lockDir, LOCK_OWNER_FILENAME), null);
      const ownerPid = Number(owner?.pid);
      if (!owner) {
        const lockStat = await fs.stat(lockDir).catch(() => null);
        if (lockStat && Date.now() - lockStat.mtimeMs < 1000) {
          await sleep(50);
          continue;
        }
      }
      let ownerAlive = Number.isInteger(ownerPid) && ownerPid > 0;
      if (ownerAlive) {
        try { process.kill(ownerPid, 0); } catch { ownerAlive = false; }
      }
      if (!ownerAlive) {
        await fs.rm(lockDir, { recursive: true, force: true }).catch(() => {});
        continue;
      }
      if (Date.now() - startedAt > timeoutMs) {
        throw new Error('DPU store lock timeout.');
      }
      await sleep(50);
    }
  }
  try {
    return await task();
  } finally {
    await fs.rm(lockDir, { recursive: true, force: true }).catch(() => {});
  }
}

export function defaultState() {
  return {
    schema: 'dpu-research-v1',
    version: 1,
    users: {},
    secrets: {},
    confidentialObjects: {},
    resources: {},
    sources: {},
    computeBackends: {},
    jobs: {},
    actionProposals: {},
    provenanceIndex: {},
    settings: {}
  };
}

export async function loadState() {
  const statePath = getStateFilePath();
  if (!(await fileExists(statePath))) {
    return defaultState();
  }
  const state = await readJsonFile(statePath, null);
  if (!state || state.schema !== 'dpu-research-v1' || Number(state.version) !== 1) {
    throw new Error('DPU data root uses an unsupported schema. Start the research-data release with an empty DPU data root.');
  }
  const loadedSettings = state.settings && typeof state.settings === 'object' && !Array.isArray(state.settings)
    ? state.settings
    : {};
  const { audit: _retiredAuditSettings, ...settings } = loadedSettings;
  const normalized = {
    schema: 'dpu-research-v1',
    version: 1,
    users: state.users && typeof state.users === 'object' ? state.users : {},
    secrets: state.secrets && typeof state.secrets === 'object' ? state.secrets : {},
    confidentialObjects: state.confidentialObjects && typeof state.confidentialObjects === 'object' ? state.confidentialObjects : {},
    resources: state.resources && typeof state.resources === 'object' ? state.resources : {},
    sources: state.sources && typeof state.sources === 'object' ? state.sources : {},
    computeBackends: state.computeBackends && typeof state.computeBackends === 'object' ? state.computeBackends : {},
    jobs: state.jobs && typeof state.jobs === 'object' ? state.jobs : {},
    actionProposals: state.actionProposals && typeof state.actionProposals === 'object' ? state.actionProposals : {},
    provenanceIndex: state.provenanceIndex && typeof state.provenanceIndex === 'object' ? state.provenanceIndex : {},
    settings
  };
  return normalized;
}

export async function saveState(state) {
  state.schema = 'dpu-research-v1';
  state.version = 1;
  await writeJsonFile(getStateFilePath(), state);
}

export async function appendProvenanceEvent(resourceId, event) {
  const normalizedResourceId = requireDpuRecordId(resourceId, 'Provenance resource');
  const targetPath = path.join(getProvenanceRoot(), `${normalizedResourceId}.jsonl`);
  await ensureFileParentExists(targetPath);
  await fs.appendFile(targetPath, `${JSON.stringify(event)}\n`, 'utf8');
}

export async function readProvenanceEvents(resourceId) {
  const normalizedResourceId = requireDpuRecordId(resourceId, 'Provenance resource');
  const targetPath = path.join(getProvenanceRoot(), `${normalizedResourceId}.jsonl`);
  if (!(await fileExists(targetPath))) return [];
  const raw = await fs.readFile(targetPath, 'utf8');
  return raw.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

export async function listAuditFiles() {
  const auditRoot = getAuditRoot();
  if (!(await fileExists(auditRoot))) {
    return [];
  }
  let entries = [];
  try {
    entries = await fs.readdir(auditRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry?.isFile?.() && entry.name.endsWith('.jsonl'))
    .map((entry) => entry.name)
    .sort((left, right) => right.localeCompare(left));
}

export async function readAuditFile(fileName, { maxBytes = 0 } = {}) {
  const targetPath = getAuditFilePath(fileName);
  const requestedBytes = Number(maxBytes);
  if (!Number.isFinite(requestedBytes) || requestedBytes <= 0) {
    return fs.readFile(targetPath, 'utf8');
  }
  const stat = await fs.stat(targetPath);
  const length = Math.min(stat.size, Math.floor(requestedBytes));
  const offset = Math.max(0, stat.size - length);
  const handle = await fs.open(targetPath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    let content = buffer.subarray(0, bytesRead).toString('utf8');
    if (offset > 0) {
      const previousByte = Buffer.alloc(1);
      const { bytesRead: previousBytesRead } = await handle.read(previousByte, 0, 1, offset - 1);
      if (previousBytesRead !== 1 || previousByte[0] !== 0x0a) {
        const firstLineEnd = content.indexOf('\n');
        content = firstLineEnd === -1 ? '' : content.slice(firstLineEnd + 1);
      }
    }
    return content;
  } finally {
    await handle.close();
  }
}

function auditRetentionDays() {
  const configured = Number.parseInt(String(process.env.DPU_AUDIT_RETENTION_DAYS || ''), 10);
  return Number.isFinite(configured) && configured > 0 ? Math.min(configured, 3650) : DEFAULT_AUDIT_RETENTION_DAYS;
}

// The retention marker lets separate processes (each Ploinky call may spawn a fresh
// one) share the once-per-day retention check. Marker I/O is best-effort: an
// unreadable or corrupt marker counts as absent, and no marker error may fail an
// audit append.
async function readAuditRetentionMarker(auditRoot) {
  try {
    return (await fs.readFile(path.join(auditRoot, AUDIT_RETENTION_MARKER_FILENAME), 'utf8')).trim();
  } catch {
    return '';
  }
}

async function writeAuditRetentionMarker(auditRoot, dayKey) {
  const markerPath = path.join(auditRoot, AUDIT_RETENTION_MARKER_FILENAME);
  const tempPath = `${markerPath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await fs.mkdir(auditRoot, { recursive: true });
    await fs.writeFile(tempPath, `${dayKey}\n`, 'utf8');
    await fs.rename(tempPath, markerPath);
  } catch (error) {
    await fs.unlink(tempPath).catch(() => {});
    console.warn(`[dpu] Could not persist the audit retention marker (${error?.code || 'error'}); retention will re-run on the next process.`);
  }
}

export async function pruneExpiredAuditFiles(now = new Date()) {
  const auditRoot = getAuditRoot();
  const dayKey = now.toISOString().slice(0, 10);
  if (auditRetentionChecks.get(auditRoot) === dayKey) return;
  if (await readAuditRetentionMarker(auditRoot) === dayKey) {
    auditRetentionChecks.set(auditRoot, dayKey);
    return;
  }
  const cutoff = new Date(now.getTime() - auditRetentionDays() * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const files = await listAuditFiles();
  await Promise.all(files.map(async (fileName) => {
    const match = /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(fileName);
    if (match && match[1] < cutoff) await fs.unlink(getAuditFilePath(fileName)).catch(() => {});
  }));
  auditRetentionChecks.set(auditRoot, dayKey);
  await writeAuditRetentionMarker(auditRoot, dayKey);
}

export async function appendAuditLine(fileName, line) {
  await pruneExpiredAuditFiles();
  const targetPath = getAuditFilePath(fileName);
  await ensureFileParentExists(targetPath);
  await fs.appendFile(targetPath, `${String(line || '')}\n`, 'utf8');
}

export async function loadPermissionsManifest() {
  const manifestPath = getPermissionsManifestPath();
  const manifest = await fileExists(manifestPath)
    ? await readJsonFile(manifestPath, null)
    : defaultPermissionsManifest();
  const seeded = applyFreshDefaultAgentPolicies(manifest);
  return normalizePermissionsManifest(seeded);
}

export async function savePermissionsManifest(manifest) {
  await writeJsonFile(getPermissionsManifestPath(), normalizePermissionsManifest(manifest));
}

export async function readSecretsMap() {
  const filePath = getSecretsFilePath();
  if (!(await fileExists(filePath))) {
    return {};
  }
  const raw = await fs.readFile(filePath, 'utf8').catch(() => '');
  if (!raw.trim()) {
    return {};
  }
  const encrypted = parseEncryptedSecretMap(raw);
  if (!encrypted) {
    throw new Error('DPU secret storage is invalid.');
  }
  return encrypted;
}

export async function upsertSecretsFileValue(name, value) {
  const secrets = await readSecretsMap();
  secrets[name] = String(value ?? '');
  await writeEncryptedSecretMap(secrets);
}

export async function deleteSecretsFileValue(name) {
  const secrets = await readSecretsMap();
  if (!Object.prototype.hasOwnProperty.call(secrets, name)) {
    return;
  }
  delete secrets[name];
  await writeEncryptedSecretMap(secrets);
}

export async function removePathIfExists(targetPath) {
  if (await fileExists(targetPath)) {
    await fs.rm(targetPath, { recursive: true, force: true });
  }
}

export async function ensureFileParentExists(filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

export async function findAgentManifestPath(agentName) {
  const normalizedAgentName = String(agentName || '').trim();
  if (!normalizedAgentName) {
    return '';
  }
  const reposRoot = getPloinkyReposRoot();
  if (!(await fileExists(reposRoot))) {
    return '';
  }
  let bundles = [];
  try {
    bundles = await fs.readdir(reposRoot, { withFileTypes: true });
  } catch {
    return '';
  }
  for (const entry of bundles) {
    if (!entry?.isDirectory?.()) {
      continue;
    }
    const candidate = path.join(reposRoot, entry.name, normalizedAgentName, 'manifest.json');
    if (await fileExists(candidate)) {
      return candidate;
    }
  }
  return '';
}

export async function loadAgentManifest(agentName) {
  const manifestPath = await findAgentManifestPath(agentName);
  if (!manifestPath) {
    return null;
  }
  return readJsonFile(manifestPath, null);
}

export function serializeEncryptedConfidentialPayload(iv, authTag, ciphertext) {
  return `${CONFIDENTIAL_FILE_PREFIX}:${iv.toString('base64')}:${authTag.toString('base64')}:${ciphertext.toString('base64')}`;
}

export function parseEncryptedConfidentialPayload(raw) {
  if (!isNonEmptyString(raw) || !raw.startsWith(`${CONFIDENTIAL_FILE_PREFIX}:`)) {
    return null;
  }
  const parts = raw.split(':');
  if (parts.length !== 4) {
    throw new Error('Confidential file payload is malformed.');
  }
  return {
    iv: Buffer.from(parts[1], 'base64'),
    authTag: Buffer.from(parts[2], 'base64'),
    ciphertext: Buffer.from(parts[3], 'base64')
  };
}

export function encryptConfidentialContent(content) {
  const key = getConfidentialMasterKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(String(content ?? ''), 'utf8'),
    cipher.final()
  ]);
  const authTag = cipher.getAuthTag();
  return serializeEncryptedConfidentialPayload(iv, authTag, ciphertext);
}

export function decryptConfidentialContent(raw) {
  const payload = parseEncryptedConfidentialPayload(raw);
  if (!payload) {
    return null;
  }
  const key = deriveMasterKey(CONFIDENTIAL_CONTEXT);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, payload.iv);
    decipher.setAuthTag(payload.authTag);
    const plaintext = Buffer.concat([
      decipher.update(payload.ciphertext),
      decipher.final()
    ]);
    return plaintext.toString('utf8');
  } catch {
    return null;
  }
}

function serializeEncryptedSecretMap(iv, authTag, ciphertext) {
  return `${SECRET_MAP_FILE_PREFIX}:${iv.toString('base64')}:${authTag.toString('base64')}:${ciphertext.toString('base64')}`;
}

function parseEncryptedSecretPayload(raw) {
  if (!isNonEmptyString(raw) || !raw.startsWith(`${SECRET_MAP_FILE_PREFIX}:`)) {
    return null;
  }
  const parts = raw.split(':');
  if (parts.length !== 4) {
    throw new Error('Encrypted DPU secrets payload is malformed.');
  }
  return {
    iv: Buffer.from(parts[1], 'base64'),
    authTag: Buffer.from(parts[2], 'base64'),
    ciphertext: Buffer.from(parts[3], 'base64')
  };
}

function encryptSecretMap(secretMap) {
  const key = deriveMasterKey(SECRET_MAP_CONTEXT);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(secretMap || {}), 'utf8'),
    cipher.final()
  ]);
  const authTag = cipher.getAuthTag();
  return serializeEncryptedSecretMap(iv, authTag, ciphertext);
}

function parseEncryptedSecretMap(raw) {
  const payload = parseEncryptedSecretPayload(raw);
  if (!payload) {
    return null;
  }
  const key = deriveMasterKey(SECRET_MAP_CONTEXT);
  const decipher = createDecipheriv('aes-256-gcm', key, payload.iv);
  decipher.setAuthTag(payload.authTag);
  const plaintext = Buffer.concat([
    decipher.update(payload.ciphertext),
    decipher.final()
  ]).toString('utf8');
  const parsed = JSON.parse(plaintext);
  return parsed && typeof parsed === 'object' ? parsed : {};
}

async function writeEncryptedSecretMap(secretMap) {
  const filePath = getSecretsFilePath();
  await ensureParentDir(filePath);
  await fs.writeFile(filePath, encryptSecretMap(secretMap), 'utf8');
}
