import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { resolveCanonicalEditorBrowserUrl } from './public-editor-url.mjs';

function asDate(value) {
  return value instanceof Date ? new Date(value.getTime()) : new Date(value || Date.now());
}

function toIso(value) {
  return asDate(value).toISOString();
}

function minDate(left, right) {
  return left.getTime() <= right.getTime() ? left : right;
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token || ''), 'utf8').digest('base64url');
}

function mintDocumentKey(sessions) {
  const existing = new Set(Array.from(sessions.values(), (record) => record.documentKey));
  let documentKey;
  do {
    documentKey = crypto.randomBytes(16).toString('hex');
  } while (existing.has(documentKey));
  return documentKey;
}

function canonicalActiveBrowserUrl(value) {
  try {
    const { browserUrl, prefix } = resolveCanonicalEditorBrowserUrl(value);
    return `${browserUrl.origin}${prefix}`;
  } catch (_) {
    throw stateError('OnlyOffice v5 session activeBrowserUrl is corrupt; recreate the agent state explicitly.');
  }
}

function activeBrowserBindingHash({ tokenHash, activeBrowserUrl }) {
  return crypto.createHash('sha256')
    .update(`${tokenHash}\0${activeBrowserUrl}`, 'utf8')
    .digest('base64url');
}

function assertActiveBrowserBinding(record) {
  const activeBrowserUrl = canonicalActiveBrowserUrl(record?.activeBrowserUrl);
  const expected = activeBrowserBindingHash({
    tokenHash: record?.tokenHash,
    activeBrowserUrl,
  });
  if (
    !/^[A-Za-z0-9_-]{43}$/.test(String(record?.activeBrowserBindingHash || ''))
    || record.activeBrowserBindingHash !== expected
  ) {
    throw stateError('OnlyOffice v5 session activeBrowserUrl binding is corrupt; recreate the agent state explicitly.');
  }
  return activeBrowserUrl;
}

function cloneRoles(input) {
  return Array.isArray(input) ? input.map((role) => String(role || '').trim()).filter(Boolean) : [];
}

function cloneAuthUser(user = {}) {
  return {
    id: String(user.id || '').trim(),
    username: String(user.username || '').trim(),
    roles: cloneRoles(user.roles),
  };
}

function sameAuthenticatedUser(left, right) {
  const first = cloneAuthUser(left);
  const second = cloneAuthUser(right);
  return Boolean(first.id && first.username)
    && first.id === second.id
    && first.username === second.username;
}

function sameReauthorizationDocument(record, input) {
  for (const field of [
    'requestedPath', 'path', 'storageKind', 'storageId', 'objectId',
    'fileName', 'mimeType',
  ]) {
    if (String(record?.[field] || '').trim() !== String(input?.[field] || '').trim()) {
      return false;
    }
  }
  return Boolean(record?.canWrite) === Boolean(input?.canWrite)
    && Boolean(record?.canComment) === Boolean(input?.canComment);
}

function cloneDelegations(delegations = {}) {
  const out = {};
  if (!delegations || typeof delegations !== 'object') {
    return out;
  }
  for (const [key, value] of Object.entries(delegations)) {
    if (!value || typeof value !== 'object') continue;
    const token = String(value.token || '').trim();
    const expiresAt = value.expiresAt ? toIso(value.expiresAt) : '';
    if (!token || !expiresAt) continue;
    out[key] = { token, expiresAt };
  }
  return out;
}

function earliestDelegationExpiry(delegations, fallbackDate) {
  const values = Object.values(cloneDelegations(delegations));
  if (!values.length) {
    return asDate(fallbackDate);
  }
  return values.reduce((best, entry) => minDate(best, asDate(entry.expiresAt)), asDate(fallbackDate));
}

function sanitizeStoredSession(record) {
  return {
    tokenHash: record.tokenHash,
    requestedPath: record.requestedPath,
    path: record.path,
    storageKind: record.storageKind,
    storageId: record.storageId,
    objectId: record.objectId,
    fileName: record.fileName,
    mimeType: record.mimeType,
    canWrite: Boolean(record.canWrite),
    canComment: Boolean(record.canComment),
    versionKey: record.versionKey,
    documentKey: record.documentKey,
    activeBrowserUrl: record.activeBrowserUrl,
    preview: clonePreview(record.preview),
    authUser: cloneAuthUser(record.authUser),
    delegations: cloneDelegations(record.delegations),
    createdAt: record.createdAt,
    documentAccessedAt: record.documentAccessedAt,
    drainAcknowledgedAt: record.drainAcknowledgedAt || null,
    idleExpiresAt: record.idleExpiresAt,
    absoluteExpiresAt: record.absoluteExpiresAt,
    callbackAcknowledgement: record.callbackAcknowledgement || null,
  };
}

function recordForPersistence(record) {
  const hadDelegation = Boolean(record.requiresReauthorization)
    || Object.keys(cloneDelegations(record.delegations)).length > 0;
  return {
    ...record,
    // Delegation bearers are generation-scoped capabilities, not durable
    // session metadata. A DPU-backed editor must obtain fresh authenticated
    // control material after recreate.
    delegations: {},
    requiresReauthorization: hadDelegation,
  };
}

function publicSummaryFromRecord(record, token = '') {
  return {
    ...(token ? { token } : {}),
    requestedPath: record.requestedPath,
    path: record.path,
    storageKind: record.storageKind,
    storageId: record.storageId,
    objectId: record.objectId,
    fileName: record.fileName,
    mimeType: record.mimeType,
    canWrite: Boolean(record.canWrite),
    canComment: Boolean(record.canComment),
    versionKey: record.versionKey,
    documentKey: record.documentKey,
    activeBrowserUrl: record.activeBrowserUrl,
    preview: clonePreview(record.preview),
    authUser: cloneAuthUser(record.authUser),
    createdAt: record.createdAt,
    documentAccessedAt: record.documentAccessedAt,
    drainAcknowledgedAt: record.drainAcknowledgedAt || null,
    idleExpiresAt: record.idleExpiresAt,
    absoluteExpiresAt: record.absoluteExpiresAt,
    callbackAcknowledgement: record.callbackAcknowledgement || null,
    publicSummary() {
      return {
        requestedPath: record.requestedPath,
        path: record.path,
        storageKind: record.storageKind,
        storageId: record.storageId,
        objectId: record.objectId,
        fileName: record.fileName,
        mimeType: record.mimeType,
        canWrite: Boolean(record.canWrite),
        canComment: Boolean(record.canComment),
        versionKey: record.versionKey,
        documentKey: record.documentKey,
        activeBrowserUrl: record.activeBrowserUrl,
        preview: clonePreview(record.preview),
        authUser: cloneAuthUser(record.authUser),
        createdAt: record.createdAt,
        documentAccessedAt: record.documentAccessedAt,
        drainAcknowledgedAt: record.drainAcknowledgedAt || null,
        idleExpiresAt: record.idleExpiresAt,
        absoluteExpiresAt: record.absoluteExpiresAt,
        callbackAcknowledgement: record.callbackAcknowledgement || null,
      };
    },
  };
}

function clonePreview(preview = null) {
  if (!preview || typeof preview !== 'object' || Array.isArray(preview)) {
    return null;
  }
  return {
    storageKind: String(preview.storageKind || '').trim(),
    requestedPath: String(preview.requestedPath || '').trim(),
    ...(preview.objectId ? { objectId: String(preview.objectId).trim() } : {}),
    canWrite: Boolean(preview.canWrite),
    canComment: Boolean(preview.canComment),
  };
}

function stateError(message = 'OnlyOffice v5 session state is corrupt.') {
  return new Error(message);
}

function lstatOrNull(file) {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function ensurePrivateStateDirectory(directory) {
  if (!path.isAbsolute(directory)) {
    throw stateError('OnlyOffice v5 session state path must be absolute.');
  }

  const missing = [];
  let cursor = directory;
  while (cursor !== path.parse(cursor).root) {
    const stat = lstatOrNull(cursor);
    if (stat) {
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw stateError(`OnlyOffice v5 session state directory is unsafe: ${cursor}`);
      }
    } else {
      missing.push(cursor);
    }
    cursor = path.dirname(cursor);
  }

  for (const item of missing.reverse()) {
    fs.mkdirSync(item, { mode: 0o700 });
    const stat = fs.lstatSync(item);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw stateError(`OnlyOffice v5 session state directory is unsafe: ${item}`);
    }
  }

  const parent = fs.lstatSync(directory);
  if (parent.isSymbolicLink() || !parent.isDirectory() || (parent.mode & 0o077) !== 0) {
    throw stateError(`OnlyOffice v5 session state directory must be a private regular directory: ${directory}`);
  }
}

function assertRegularPrivateStateFile(stat) {
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw stateError('OnlyOffice v5 session state must be a regular file, not a link or device.');
  }
  if ((stat.mode & 0o077) !== 0) {
    throw stateError('OnlyOffice v5 session state permissions must be 0600.');
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw stateError('OnlyOffice v5 session state has an unexpected owner.');
  }
}

function parseIsoDate(value, field) {
  if (typeof value !== 'string') throw stateError(`OnlyOffice v5 session ${field} is corrupt.`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw stateError(`OnlyOffice v5 session ${field} is corrupt.`);
  }
  return parsed;
}

function validateStoredRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw stateError();
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(String(record.tokenHash || ''))) {
    throw stateError('OnlyOffice v5 session token hash is corrupt.');
  }
  for (const field of [
    'requestedPath', 'path', 'storageKind', 'storageId', 'objectId',
    'fileName', 'mimeType', 'versionKey',
  ]) {
    if (typeof record[field] !== 'string') throw stateError(`OnlyOffice v5 session ${field} is corrupt.`);
  }
  if (!/^[0-9a-f]{32}$/.test(String(record.documentKey || ''))) {
    throw stateError('OnlyOffice v5 session documentKey is corrupt; recreate the agent state explicitly.');
  }
  if (
    typeof record.activeBrowserUrl !== 'string'
    || canonicalActiveBrowserUrl(record.activeBrowserUrl) !== record.activeBrowserUrl
  ) {
    throw stateError('OnlyOffice v5 session activeBrowserUrl is corrupt; recreate the agent state explicitly.');
  }
  assertActiveBrowserBinding(record);
  for (const field of ['canWrite', 'canComment']) {
    if (typeof record[field] !== 'boolean') throw stateError(`OnlyOffice v5 session ${field} is corrupt.`);
  }
  const createdAt = parseIsoDate(record.createdAt, 'createdAt');
  const documentAccessedAt = record.documentAccessedAt === null
    ? null
    : parseIsoDate(record.documentAccessedAt, 'document access timestamp');
  if (record.drainAcknowledgedAt != null) {
    const drainedAt = parseIsoDate(record.drainAcknowledgedAt, 'drain acknowledgement timestamp');
    if (!documentAccessedAt || drainedAt < documentAccessedAt) throw stateError('OnlyOffice v5 drain acknowledgement is corrupt.');
  }
  const idleExpiresAt = parseIsoDate(record.idleExpiresAt, 'idleExpiresAt');
  const absoluteExpiresAt = parseIsoDate(record.absoluteExpiresAt, 'absoluteExpiresAt');
  if (createdAt > idleExpiresAt || idleExpiresAt > absoluteExpiresAt) {
    throw stateError('OnlyOffice v5 session expiry ordering is corrupt.');
  }
  if (documentAccessedAt && (documentAccessedAt < createdAt || documentAccessedAt >= absoluteExpiresAt)) {
    throw stateError('OnlyOffice v5 session document access timestamp is corrupt.');
  }
  if (!record.authUser || typeof record.authUser !== 'object' || Array.isArray(record.authUser)) {
    throw stateError('OnlyOffice v5 session authUser is corrupt.');
  }
  if (!Array.isArray(record.authUser.roles) || record.authUser.roles.some((role) => typeof role !== 'string')) {
    throw stateError('OnlyOffice v5 session roles are corrupt.');
  }
  if (!record.delegations || typeof record.delegations !== 'object' || Array.isArray(record.delegations)) {
    throw stateError('OnlyOffice v5 session delegations are corrupt.');
  }
  if (Object.keys(record.delegations).length !== 0 || typeof record.requiresReauthorization !== 'boolean') {
    throw stateError('OnlyOffice v5 persisted session contains forbidden delegation material.');
  }
  if (record.callbackAcknowledgement !== null) {
    const acknowledgement = record.callbackAcknowledgement;
    if (!acknowledgement || typeof acknowledgement !== 'object'
      || !Number.isFinite(acknowledgement.status)
      || typeof acknowledgement.version !== 'string') {
      throw stateError('OnlyOffice v5 callback acknowledgement is corrupt.');
    }
    parseIsoDate(acknowledgement.acknowledgedAt, 'callback acknowledgement timestamp');
  }
  return record;
}

function readStateFile(stateFile) {
  const pathStat = fs.lstatSync(stateFile);
  assertRegularPrivateStateFile(pathStat);
  const noFollow = fs.constants.O_NOFOLLOW || 0;
  const descriptor = fs.openSync(stateFile, fs.constants.O_RDONLY | noFollow);
  try {
    assertRegularPrivateStateFile(fs.fstatSync(descriptor));
    return fs.readFileSync(descriptor, 'utf8');
  } finally {
    fs.closeSync(descriptor);
  }
}

export function createSessionStore({
  now = () => new Date(),
  idleTtlMs = 30 * 60 * 1000,
  absoluteTtlMs = 8 * 60 * 60 * 1000,
  stateFile = '',
} = {}) {
  const sessions = new Map();

  function persist() {
    if (!stateFile) return;
    const directory = path.dirname(stateFile);
    ensurePrivateStateDirectory(directory);
    const temporary = path.join(
      directory,
      `.${path.basename(stateFile)}.tmp-${process.pid}-${crypto.randomUUID()}`,
    );
    const bytes = `${JSON.stringify({
      schemaVersion: 5,
      sessions: Array.from(sessions.values(), recordForPersistence),
    })}\n`;
    let descriptor;
    try {
      descriptor = fs.openSync(
        temporary,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0),
        0o600,
      );
      fs.writeFileSync(descriptor, bytes, 'utf8');
      fs.fchmodSync(descriptor, 0o600);
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      assertRegularPrivateStateFile(fs.lstatSync(temporary));
      fs.renameSync(temporary, stateFile);
      const directoryDescriptor = fs.openSync(directory, fs.constants.O_RDONLY);
      try {
        fs.fsyncSync(directoryDescriptor);
      } finally {
        fs.closeSync(directoryDescriptor);
      }
    } catch (error) {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      try {
        fs.unlinkSync(temporary);
      } catch (unlinkError) {
        if (unlinkError?.code !== 'ENOENT') throw unlinkError;
      }
      throw error;
    }
  }

  if (stateFile) {
    if (!path.isAbsolute(stateFile)) {
      throw stateError('OnlyOffice v5 session state path must be absolute.');
    }
    const stateStat = lstatOrNull(stateFile);
    if (stateStat) {
      let parsed;
      try {
        parsed = JSON.parse(readStateFile(stateFile));
      } catch (error) {
        if (String(error?.message || '').startsWith('OnlyOffice v5')) throw error;
        throw stateError();
      }
      if (parsed?.schemaVersion !== 5 || !Array.isArray(parsed?.sessions)) {
        throw new Error('OnlyOffice session state is not runtime contract v5. Recreate the agent state explicitly.');
      }
      const documentKeys = new Set();
      for (const record of parsed.sessions) {
        validateStoredRecord(record);
        if (sessions.has(record.tokenHash)) {
          throw stateError('OnlyOffice v5 session state contains a duplicate token hash.');
        }
        if (documentKeys.has(record.documentKey)) {
          throw stateError('OnlyOffice v5 session state contains a duplicate documentKey.');
        }
        documentKeys.add(record.documentKey);
        sessions.set(String(record.tokenHash), record);
      }
    }
  }

  function resolveNow(value) {
    return asDate(value || now());
  }

  function readRecordByToken(token) {
    return sessions.get(hashToken(token)) || null;
  }

  function assertActive(record, valueNow) {
    const at = resolveNow(valueNow);
    if (!record) {
      throw new Error('Unknown or expired OnlyOffice session token.');
    }
    assertActiveBrowserBinding(record);
    if (at.getTime() >= asDate(record.absoluteExpiresAt).getTime()) {
      sessions.delete(record.tokenHash);
      persist();
      throw new Error('Unknown or expired OnlyOffice session token.');
    }
    if (at.getTime() >= asDate(record.idleExpiresAt).getTime()) {
      sessions.delete(record.tokenHash);
      persist();
      throw new Error('Unknown or expired OnlyOffice session token.');
    }
    if (record.requiresReauthorization) {
      throw new Error('OnlyOffice session requires fresh authenticated control material after recreate.');
    }
    return at;
  }

  return {
    createSession(input = {}) {
      const createdAt = resolveNow(input.createdAt);
      const activeBrowserUrl = canonicalActiveBrowserUrl(input.activeBrowserUrl);
      const idleCandidate = new Date(createdAt.getTime() + idleTtlMs);
      const absoluteCandidate = new Date(createdAt.getTime() + absoluteTtlMs);
      const absoluteExpiresAt = earliestDelegationExpiry(input.delegations, absoluteCandidate);
      const idleExpiresAt = minDate(idleCandidate, absoluteExpiresAt);
      const token = crypto.randomBytes(32).toString('base64url');
      const tokenHash = hashToken(token);
      const documentKey = mintDocumentKey(sessions);
      const record = {
        tokenHash,
        requestedPath: String(input.requestedPath || input.path || '').trim(),
        path: String(input.path || '').trim(),
        storageKind: String(input.storageKind || '').trim(),
        storageId: String(input.storageId || '').trim(),
        objectId: String(input.objectId || '').trim(),
        fileName: String(input.fileName || '').trim(),
        mimeType: String(input.mimeType || '').trim(),
        canWrite: Boolean(input.canWrite),
        canComment: Boolean(input.canComment),
        versionKey: String(input.versionKey || '').trim(),
        documentKey,
        activeBrowserUrl,
        activeBrowserBindingHash: activeBrowserBindingHash({
          tokenHash,
          activeBrowserUrl,
        }),
        preview: clonePreview(input.preview),
        authUser: cloneAuthUser(input.authUser),
        delegations: cloneDelegations(input.delegations),
        createdAt: createdAt.toISOString(),
        documentAccessedAt: null,
        drainAcknowledgedAt: null,
        idleExpiresAt: idleExpiresAt.toISOString(),
        absoluteExpiresAt: absoluteExpiresAt.toISOString(),
        callbackAcknowledgement: null,
        requiresReauthorization: false,
      };
      sessions.set(tokenHash, record);
      persist();
      return publicSummaryFromRecord(record, token);
    },

    reauthorizeLoadedSessions(input = {}) {
      const authorizedAt = resolveNow(input.authorizedAt);
      const activeBrowserUrl = canonicalActiveBrowserUrl(input.activeBrowserUrl);
      const authUser = cloneAuthUser(input.authUser);
      const delegations = cloneDelegations(input.delegations);
      if (
        !authUser.id
        || !authUser.username
        || Object.keys(delegations).length === 0
      ) {
        return 0;
      }

      const delegationExpiresAt = Object.values(delegations).reduce(
        (earliest, delegation) => earliest
          ? minDate(earliest, asDate(delegation.expiresAt))
          : asDate(delegation.expiresAt),
        null,
      );
      if (
        !Number.isFinite(delegationExpiresAt.getTime())
        || delegationExpiresAt.getTime() <= authorizedAt.getTime()
      ) {
        return 0;
      }

      let changed = false;
      let reauthorized = 0;
      for (const record of sessions.values()) {
        if (!record.requiresReauthorization || !record.documentAccessedAt) continue;
        assertActiveBrowserBinding(record);
        if (
          authorizedAt.getTime() >= asDate(record.absoluteExpiresAt).getTime()
          || authorizedAt.getTime() >= asDate(record.idleExpiresAt).getTime()
        ) {
          sessions.delete(record.tokenHash);
          changed = true;
          continue;
        }
        if (
          record.activeBrowserUrl !== activeBrowserUrl
          || !sameAuthenticatedUser(record.authUser, input.authUser)
          || !sameReauthorizationDocument(record, input)
        ) {
          continue;
        }

        const absoluteExpiresAt = minDate(
          asDate(record.absoluteExpiresAt),
          delegationExpiresAt,
        );
        if (absoluteExpiresAt.getTime() <= authorizedAt.getTime()) continue;
        record.versionKey = String(input.versionKey || '').trim();
        record.preview = clonePreview(input.preview);
        record.authUser = cloneAuthUser(authUser);
        record.delegations = cloneDelegations(delegations);
        record.idleExpiresAt = minDate(
          new Date(authorizedAt.getTime() + idleTtlMs),
          absoluteExpiresAt,
        ).toISOString();
        record.absoluteExpiresAt = absoluteExpiresAt.toISOString();
        record.requiresReauthorization = false;
        sessions.set(record.tokenHash, record);
        changed = true;
        reauthorized += 1;
      }
      if (changed) persist();
      return reauthorized;
    },

    touchSession(token, { now: valueNow, activeBrowserUrl } = {}) {
      const record = readRecordByToken(token);
      const touchedAt = assertActive(record, valueNow);
      if (
        activeBrowserUrl !== undefined
        && canonicalActiveBrowserUrl(activeBrowserUrl) !== record.activeBrowserUrl
      ) {
        throw new Error('OnlyOffice session activeBrowserUrl is immutable.');
      }
      const nextIdleExpiry = minDate(
        new Date(touchedAt.getTime() + idleTtlMs),
        asDate(record.absoluteExpiresAt)
      );
      record.idleExpiresAt = nextIdleExpiry.toISOString();
      sessions.set(record.tokenHash, record);
      persist();
      return publicSummaryFromRecord(record);
    },

    getForStorageRequest(token, { now: valueNow, markDocumentAccess = false } = {}) {
      const record = readRecordByToken(token);
      const at = assertActive(record, valueNow);
      const nextIdleExpiry = minDate(
        new Date(at.getTime() + idleTtlMs),
        asDate(record.absoluteExpiresAt)
      );
      if (markDocumentAccess && !record.documentAccessedAt) {
        record.documentAccessedAt = at.toISOString();
      }
      record.idleExpiresAt = nextIdleExpiry.toISOString();
      sessions.set(record.tokenHash, record);
      persist();
      return sanitizeStoredSession(record);
    },

    acknowledgeDrainedEditors() {
      // Called only after durable force-save and native socket closure both
      // succeed. Keep callback authorization available for late final saves,
      // but never force-save these retired DocumentServer keys on a later drain.
      const acknowledgedAt = toIso(now());
      let changed = false;
      for (const record of sessions.values()) {
        if (record.documentAccessedAt && !record.requiresReauthorization && !record.drainAcknowledgedAt) {
          record.drainAcknowledgedAt = acknowledgedAt;
          changed = true;
        }
      }
      if (changed) persist();
    },

    updateEditorStatus(token, status) {
      if (![1, 4].includes(status)) throw new Error('Unsupported OnlyOffice editor status.');
      const record = readRecordByToken(token);
      assertActive(record);
      if (status === 4) {
        record.callbackAcknowledgement = {
          status,
          version: record.documentKey,
          acknowledgedAt: toIso(now()),
        };
      } else if (record.drainAcknowledgedAt || [2, 4].includes(record.callbackAcknowledgement?.status)) {
        // A verified new editing cycle cannot inherit a previous close receipt.
        record.callbackAcknowledgement = null;
        record.drainAcknowledgedAt = null;
      } else {
        return;
      }
      sessions.set(record.tokenHash, record);
      persist();
    },

    acknowledgeCallback(token, acknowledgement = {}) {
      const record = readRecordByToken(token);
      assertActive(record);
      record.callbackAcknowledgement = {
        status: Number(acknowledgement.status || 0),
        version: String(acknowledgement.version || '').trim(),
        acknowledgedAt: toIso(acknowledgement.acknowledgedAt || now()),
      };
      sessions.set(record.tokenHash, record);
      persist();
      return { ...record.callbackAcknowledgement };
    },

    listActiveSessions({ now: valueNow } = {}) {
      const at = resolveNow(valueNow);
      const active = [];
      for (const record of sessions.values()) {
        if (
          at.getTime() < asDate(record.absoluteExpiresAt).getTime()
          && at.getTime() < asDate(record.idleExpiresAt).getTime()
          && !record.requiresReauthorization
        ) {
          active.push(publicSummaryFromRecord(record));
        }
      }
      return active;
    },
  };
}

export default { createSessionStore };
