import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

import {
  canonicalizePrincipal,
  isNonEmptyString,
  normalizeName,
  normalizePathSegment,
  normalizePrincipal,
  normalizeSecretKey,
  nowIso
} from './dpu-store-internal/common.mjs';
import {
  CONFIDENTIAL_ROLE_ORDER,
  SECRET_ROLE_ORDER,
  aclEntries,
  confidentialRoleAllows,
  normalizeCommentRecords,
  pickMaxRole,
  requireAuthenticatedActor,
  resolveActor,
  secretRoleAllows,
  serializeConfidentialComments
} from './dpu-store-internal/identity-acl.mjs';
import {
  appendAuditLine,
  deleteSecretsFileValue,
  decryptConfidentialContent,
  ensureFileParentExists,
  encryptConfidentialContent,
  fileExists,
  getConfidentialBlobPath,
  listAuditFiles as listAuditStorageFiles,
  loadState,
  loadPermissionsManifest,
  readAuditFile as readAuditStorageFile,
  readSecretsMap,
  removePathIfExists,
  saveState,
  savePermissionsManifest,
  upsertSecretsFileValue,
  withFileLock
} from './dpu-store-internal/storage.mjs';
import {
  deletePermissionEntry,
  extractIdentityHints,
  getAgentPolicy,
  getPermissionAcl,
  removePermissionRole,
  resolvePrincipalReference,
  setAgentAllowedRoles,
  setPermissionRole,
  upsertPrincipalIdentity
} from './dpu-store-internal/permissions-manifest.mjs';

export { resolveActor };

/**
 * Contract-level scope enforcement. When authInfo carries an `invocation.scope`
 * list, the operation must be covered by it. Supplements (not replaces) the
 * per-secret ACL checks below.
 */
const OPERATION_SCOPE_MAP = {
  dpu_secret_get: ['secret:read'],
  dpu_secret_put: ['secret:write'],
  dpu_secret_delete: ['secret:write'],
  dpu_secret_grant: ['secret:grant', 'secret:write'],
  dpu_secret_revoke: ['secret:revoke', 'secret:write'],
  dpu_secret_list: ['secret:access', 'secret:read'],
  dpu_whoami: ['secret:access', 'secret:read'],
  dpu_workspace_roots: ['secret:access', 'secret:read', 'dpu:confidential:read'],
  dpu_confidential_list: ['dpu:confidential:read'],
  dpu_confidential_get: ['dpu:confidential:read'],
  dpu_confidential_create: ['dpu:confidential:write'],
  dpu_confidential_update: ['dpu:confidential:write'],
  dpu_confidential_delete: ['dpu:confidential:write'],
  dpu_confidential_grant: ['dpu:confidential:write'],
  dpu_confidential_revoke: ['dpu:confidential:write'],
  dpu_confidential_comment_add: ['dpu:confidential:write'],
  dpu_confidential_comment_delete: ['dpu:confidential:write'],
  dpu_resource_list: ['dpu:research', 'dpu:research:read'],
  dpu_resource_get: ['dpu:research', 'dpu:research:read'],
  dpu_resource_file_list: ['dpu:research', 'dpu:research:files:read'],
  dpu_resource_file_stat: ['dpu:research', 'dpu:research:files:read'],
  dpu_resource_file_read: ['dpu:research', 'dpu:research:files:read'],
  dpu_resource_register: ['dpu:research', 'dpu:research:write'],
  dpu_resource_update_use: ['dpu:research', 'dpu:research:write'],
  dpu_resource_resolve_access: ['dpu:research', 'dpu:research:write'],
  dpu_resource_acquire: ['dpu:research', 'dpu:research:acquire'],
  dpu_resource_share: ['dpu:research', 'dpu:research:share'],
  dpu_resource_revoke: ['dpu:research', 'dpu:research:share'],
  dpu_resource_release_output: ['dpu:research', 'dpu:research:release'],
  dpu_resource_get_provenance: ['dpu:research', 'dpu:research:read'],
  dpu_source_list: ['dpu:sources', 'dpu:sources:admin'],
  dpu_source_get: ['dpu:sources', 'dpu:sources:admin'],
  dpu_source_upsert: ['dpu:sources', 'dpu:sources:admin'],
  dpu_source_test: ['dpu:sources', 'dpu:sources:admin'],
  dpu_source_set_enabled: ['dpu:sources', 'dpu:sources:admin'],
  dpu_source_remove: ['dpu:sources', 'dpu:sources:admin'],
  dpu_compute_backend_list: ['dpu:compute', 'dpu:compute:read'],
  dpu_compute_backend_upsert: ['dpu:compute:admin'],
  dpu_compute_backend_test: ['dpu:compute:admin'],
  dpu_compute_backend_set_enabled: ['dpu:compute:admin'],
  dpu_federated_experiment_propose: ['dpu:research', 'dpu:federation:submit'],
  dpu_secure_execution_propose: ['dpu:research', 'dpu:secure:submit'],
  dpu_research_search: ['dpu:research', 'dpu:research:read'],
  dpu_research_compare: ['dpu:research', 'dpu:research:read'],
  dpu_job_list: ['dpu:research', 'dpu:jobs:read'],
  dpu_job_get: ['dpu:research', 'dpu:jobs:read'],
  dpu_job_cancel: ['dpu:research', 'dpu:jobs:cancel'],
  dpu_action_get: ['dpu:research', 'dpu:actions:read'],
  dpu_action_confirm: ['dpu:research', 'dpu:actions:confirm'],
  dpu_action_reject: ['dpu:research', 'dpu:actions:confirm']
};

function extractInvocationScope(authInfo) {
  const invocation = authInfo && typeof authInfo === 'object' ? authInfo.invocation : null;
  if (!invocation || typeof invocation !== 'object') return null;
  const directScope = Array.isArray(invocation.scope) ? invocation.scope : [];
  const delegationScope = Array.isArray(invocation.delegation?.scope) ? invocation.delegation.scope : [];
  const scope = [...directScope, ...delegationScope];
  if (!scope.length) return null;
  const normalized = scope.map((v) => String(v || '').trim().toLowerCase()).filter(Boolean);
  if (!normalized.length) return null;
  return new Set(normalized);
}

export function assertInvocationScopeFor(operation, authInfo) {
  const scopes = extractInvocationScope(authInfo);
  if (!scopes) return; // unscoped first-party invocation; domain ACLs still apply
  const required = OPERATION_SCOPE_MAP[operation] || [];
  if (!required.length) return;
  const allowed = required.some((candidate) => scopes.has(candidate));
  if (!allowed) {
    throw new Error(`Invocation scope does not permit ${operation}. Required one of: ${required.join(', ')}.`);
  }
}

export async function appendToolAudit(authInfo, operation, args = {}, status = 'ok', error = '') {
  const permissionsManifest = await loadPermissionsManifest();
  const actor = requireAuthenticatedActor(authInfo, permissionsManifest);
  const target = {
    id: String(args?.id || '').trim(),
    resourceId: String(args?.resourceId || '').trim(),
    sourceId: String(args?.sourceId || '').trim()
  };
  return appendAuditRecord(createAuditRecord({
    actor,
    operation,
    target,
    status,
    error: error ? 'DPU research operation failed; details were withheld by audit redaction.' : ''
  }));
}

const AUDIT_VIEWER_ROLES = Object.freeze(['admin', 'security']);
const AUDIT_ROOT_PATH = '/Confidential/Audit';
const AUDIT_CAPTURE_POLICY = Object.freeze({
  dpuOperations: true,
  fileAccess: true,
  explorerActions: true,
  pluginUsage: true,
  aiActivity: false
});

async function writeEncryptedConfidentialFile(objectRecord, content) {
  const blobPath = getConfidentialBlobPath(objectRecord.id);
  await ensureFileParentExists(blobPath);
  const encrypted = encryptConfidentialContent(content);
  await fs.writeFile(blobPath, encrypted, 'utf8');
}

async function writeConfidentialFile(objectRecord, content) {
  await writeEncryptedConfidentialFile(objectRecord, String(content ?? ''));
}

async function readConfidentialFile(objectRecord) {
  const blobPath = getConfidentialBlobPath(objectRecord.id);
  if (!(await fileExists(blobPath))) {
    throw new Error(`Confidential file storage is missing for object ${objectRecord.id || ''}`.trim());
  }
  const raw = await fs.readFile(blobPath, 'utf8');

  const decrypted = decryptConfidentialContent(raw);
  if (decrypted !== null) {
    return decrypted;
  }
  throw new Error(`Confidential file storage is invalid for object ${objectRecord.id || ''}`.trim());
}

function getAuditSettings() {
  return {
    enabled: true,
    capture: { ...AUDIT_CAPTURE_POLICY }
  };
}

function hasAuditViewerRole(actor) {
  const roles = Array.isArray(actor?.roles) ? actor.roles : [];
  const hasRole = roles.some((role) => AUDIT_VIEWER_ROLES.includes(String(role || '').trim().toLowerCase()));
  if (hasRole) {
    return true;
  }
  const username = String(actor?.username || '').trim().toLowerCase();
  const userId = String(actor?.id || '').trim().toLowerCase();
  const principalId = String(actor?.principalId || '').trim().toLowerCase();
  return username === 'admin' || userId === 'local:admin' || principalId === 'user:local:admin';
}

function assertAuditViewer(actor) {
  if (!hasAuditViewerRole(actor)) {
    throw new Error('Access denied: audit logs require admin or security role.');
  }
}

function sanitizeAuditMetadata(value) {
  if (value === null || value === undefined) {
    return null;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeAuditMetadata(entry));
  }
  if (typeof value === 'object') {
    const output = {};
    for (const [key, entry] of Object.entries(value)) {
      const normalizedKey = String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
      if (/(content|value|draft|body|message|prompt|response|completion|input|output|transcript|instruction|query)$/.test(normalizedKey)) {
        continue;
      }
      output[key] = sanitizeAuditMetadata(entry);
    }
    return output;
  }
  return value;
}

function buildAuditActorPayload(actor) {
  return {
    principalId: actor?.principalId || '',
    email: actor?.email || '',
    username: actor?.username || '',
    id: actor?.id || '',
    roles: Array.isArray(actor?.roles) ? actor.roles : [],
    agentPrincipalId: actor?.agentPrincipalId || '',
    agentName: actor?.agentName || '',
    authenticated: Boolean(actor?.authenticated)
  };
}

function buildAuditFileEntry(fileName, content = null) {
  return {
    name: fileName,
    path: `${AUDIT_ROOT_PATH}/${fileName}`,
    type: 'file',
    scope: 'audit',
    content,
    updatedAt: fileName.replace(/\.jsonl$/i, ''),
    mimeType: 'application/x-ndjson'
  };
}

function createAuditRecord({ actor, operation, target = {}, metadata = {}, status = 'ok', error = '' }) {
  return {
    timestamp: nowIso(),
    operation: String(operation || '').trim(),
    status: String(status || 'ok').trim(),
    actor: buildAuditActorPayload(actor),
    target: sanitizeAuditMetadata(target),
    metadata: sanitizeAuditMetadata(metadata),
    error: error ? String(error) : ''
  };
}

async function appendAuditRecord(record) {
  const category = getAuditRecordCaptureCategory(record);
  if (category === 'aiActivity') {
    return false;
  }
  const timestamp = String(record?.timestamp || nowIso());
  const fileName = `${timestamp.slice(0, 10) || 'audit'}.jsonl`;
  await appendAuditLine(fileName, JSON.stringify(record));
  return true;
}

function getAuditRecordCaptureCategory(record) {
  if (record?.operation) {
    return 'dpuOperations';
  }
  const eventType = String(record?.eventType || '').trim().toLowerCase();
  const source = String(record?.source || '').trim().toLowerCase();
  const target = record?.target && typeof record.target === 'object' ? record.target : {};
  if (/^(ai|llm|copilot)[.:_-]/.test(eventType) || ['ai', 'llm', 'copilot'].includes(source)) {
    return 'aiActivity';
  }
  if (target.pluginKey || eventType.startsWith('plugin.') || eventType.includes('.plugin.')) {
    return 'pluginUsage';
  }
  if (eventType.startsWith('file.') || eventType.includes('.file.') || target.path || target.targetPath) {
    return 'fileAccess';
  }
  if (source === 'explorer' || eventType.startsWith('explorer.')) {
    return 'explorerActions';
  }
  return 'explorerActions';
}

async function runAuditedMutation(state, actor, { operation, target, metadata }, worker) {
  try {
    const result = await worker();
    await appendAuditRecord(createAuditRecord({
      actor,
      operation,
      target,
      metadata,
      status: 'ok'
    }));
    return result;
  } catch (error) {
    await appendAuditRecord(createAuditRecord({
      actor,
      operation,
      target,
      metadata,
      status: 'error',
      error: error?.message || String(error)
    }));
    throw error;
  }
}

function getSecret(state, key) {
  const normalizedKey = normalizeSecretKey(key);
  return state.secrets[normalizedKey] || null;
}

function getConfidentialObject(state, id) {
  const normalizedId = normalizeName(id, 'id');
  return state.confidentialObjects[normalizedId] || null;
}

function getConfidentialAncestors(state, objectRecord) {
  const chain = [];
  const seen = new Set();
  let current = objectRecord;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    chain.push(current);
    current = current.parentId ? state.confidentialObjects[current.parentId] || null : null;
  }
  return chain;
}

function getSecretAclMap(secret, permissionsManifest) {
  return getPermissionAcl(permissionsManifest, 'secret', secret?.key || '') || {};
}

function getConfidentialAclMap(objectRecord, permissionsManifest) {
  return getPermissionAcl(permissionsManifest, 'confidential', objectRecord?.id || '') || {};
}

function buildActorPrincipalCandidates(actorOrPrincipal) {
  const values = [];
  const pushValue = (value) => {
    const normalized = canonicalizePrincipal(value);
    if (normalized && !values.includes(normalized)) {
      values.push(normalized);
    }
  };

  if (actorOrPrincipal && typeof actorOrPrincipal === 'object') {
    pushValue(actorOrPrincipal.principalId);
    pushValue(actorOrPrincipal.agentPrincipalId);
    pushValue(actorOrPrincipal.email);
    pushValue(actorOrPrincipal.id);
    pushValue(actorOrPrincipal.username);
    if (isNonEmptyString(actorOrPrincipal.id)) {
      pushValue(`user:${actorOrPrincipal.id}`);
    }
    if (isNonEmptyString(actorOrPrincipal.username)) {
      pushValue(`user:${actorOrPrincipal.username}`);
    }
    if (isNonEmptyString(actorOrPrincipal.ssoSubject)) {
      pushValue(`sso:${actorOrPrincipal.ssoSubject}`);
    }
    return values;
  }

  pushValue(actorOrPrincipal);
  return values;
}

function buildPrincipalReferenceCandidates(principal, permissionsManifest) {
  const values = [];
  const pushValue = (value) => {
    const normalized = canonicalizePrincipal(value);
    if (normalized && !values.includes(normalized)) {
      values.push(normalized);
    }
  };

  const normalizedPrincipal = normalizePrincipal(principal, 'principal');
  pushValue(normalizedPrincipal);

  const resolvedPrincipal = resolvePrincipalReference(permissionsManifest, normalizedPrincipal);
  pushValue(resolvedPrincipal);

  for (const value of [...values]) {
    const localMatch = value.match(/^user:local:(.+)$/i);
    if (localMatch && isNonEmptyString(localMatch[1])) {
      pushValue(localMatch[1].trim());
    }
  }

  return values;
}

function getSecretRole(secret, actorOrPrincipal, permissionsManifest) {
  const normalizedPrincipalId = actorOrPrincipal && typeof actorOrPrincipal === 'object'
    ? canonicalizePrincipal(actorOrPrincipal.principalId)
    : canonicalizePrincipal(actorOrPrincipal);
  if (!secret || !normalizedPrincipalId) return null;
  const roleCandidates = [];
  if (secret.ownerId === normalizedPrincipalId) {
    roleCandidates.push('write-access');
  }
  const aclMap = getSecretAclMap(secret, permissionsManifest);
  const matchedRoles = buildActorPrincipalCandidates(actorOrPrincipal)
    .map((principal) => aclMap?.[principal])
    .filter((role) => isNonEmptyString(role));
  roleCandidates.push(...matchedRoles);
  return mergeSecretRoles(roleCandidates);
}

function mergeSecretRoles(roleCandidates = []) {
  const normalizedRoles = new Set(
    roleCandidates
      .map((role) => String(role || '').trim().toLowerCase())
      .filter((role) => SECRET_ROLE_ORDER.includes(role))
  );
  if (!normalizedRoles.size) {
    return null;
  }
  if (normalizedRoles.has('write')) {
    return 'write';
  }
  if (normalizedRoles.has('write-access') && normalizedRoles.has('read')) {
    // Owner-style write access combined with a delegated read grant yields
    // full read/write capability for the same actor.
    return 'write';
  }
  if (normalizedRoles.has('read')) {
    return 'read';
  }
  if (normalizedRoles.has('write-access')) {
    return 'write-access';
  }
  if (normalizedRoles.has('access')) {
    return 'access';
  }
  return null;
}

function getConfidentialRole(state, objectRecord, actorOrPrincipal, permissionsManifest) {
  const normalizedPrincipalId = actorOrPrincipal && typeof actorOrPrincipal === 'object'
    ? canonicalizePrincipal(actorOrPrincipal.principalId)
    : canonicalizePrincipal(actorOrPrincipal);
  if (!objectRecord || !normalizedPrincipalId) return null;
  const principalCandidates = buildActorPrincipalCandidates(actorOrPrincipal);
  const candidates = [];
  for (const current of getConfidentialAncestors(state, objectRecord)) {
    if (current.ownerId === normalizedPrincipalId) {
      candidates.push('write');
    }
    const aclMap = getConfidentialAclMap(current, permissionsManifest);
    for (const principal of principalCandidates) {
      if (isNonEmptyString(aclMap?.[principal])) {
        candidates.push(aclMap[principal]);
      }
    }
  }
  return pickMaxRole(candidates, CONFIDENTIAL_ROLE_ORDER);
}

function assertSecretPermission(secret, actor, permission, permissionsManifest) {
  const role = getSecretRole(secret, actor, permissionsManifest);
  if (!role || !secretRoleAllows(role, permission)) {
    throw new Error(`Access denied: missing ${permission} on secret ${secret?.key || ''}`.trim());
  }
  return role;
}

function assertAgentSecretGrantAllowed(permissionsManifest, principalId, role) {
  const normalizedPrincipalId = canonicalizePrincipal(principalId);
  if (!/^agent:/i.test(normalizedPrincipalId)) {
    return;
  }
  const policy = getAgentPolicy(permissionsManifest, normalizedPrincipalId);
  if (!policy) {
    throw new Error(`Agent secret grant is invalid: no DPU policy exists for ${normalizedPrincipalId}.`);
  }
  const allowedRoles = Array.isArray(policy?.secrets?.allowedRoles)
    ? policy.secrets.allowedRoles
    : [];
  const normalizedRole = String(role || '').trim().toLowerCase();
  if (!allowedRoles.includes(normalizedRole)) {
    throw new Error(`Agent ${normalizedPrincipalId} is not allowed to receive secret role ${normalizedRole}.`);
  }
}

function assertConfidentialPermission(state, objectRecord, actor, permission, permissionsManifest) {
  const role = getConfidentialRole(state, objectRecord, actor, permissionsManifest);
  if (!role || !confidentialRoleAllows(role, permission)) {
    throw new Error(`Access denied: missing ${permission} on confidential object ${objectRecord?.id || ''}`.trim());
  }
  return role;
}

function ensureUniqueSiblingName(state, parentId, name, excludedId = '') {
  const normalizedName = normalizePathSegment(name, 'name');
  const sibling = Object.values(state.confidentialObjects).find((entry) => (
    entry
    && entry.parentId === parentId
    && entry.id !== excludedId
    && String(entry.name || '') === normalizedName
  ));
  if (sibling) {
    throw new Error(`An object named "${normalizedName}" already exists in this folder.`);
  }
  return normalizedName;
}

function collectChildObjects(state, parentId) {
  return Object.values(state.confidentialObjects).filter((item) => item && item.parentId === parentId);
}

function collectSharedObjects(state, permissionsManifest, actor) {
  return Object.values(state.confidentialObjects).filter((item) => {
    if (!item || item.ownerId === actor.principalId) return false;
    const directRole = getConfidentialRole(state, item, actor, permissionsManifest);
    return Boolean(directRole && confidentialRoleAllows(directRole, 'access'));
  });
}

function sortByName(items) {
  return [...items].sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
}

function isSystemRootObject(objectRecord) {
  return objectRecord?.type === 'folder' && objectRecord?.parentId === null && objectRecord?.name === 'My Space';
}

async function deleteObjectRecursive(state, rootId) {
  const children = collectChildObjects(state, rootId);
  for (const child of children) {
    await deleteObjectRecursive(state, child.id);
  }
  const current = state.confidentialObjects[rootId];
  if (current?.type === 'file') {
    await removePathIfExists(getConfidentialBlobPath(current.id));
  }
  delete state.confidentialObjects[rootId];
}

async function ensureUserRecord(state, permissionsManifest, actor, ctx) {
  const principalId = actor.principalId;
  const existing = state.users[principalId] && typeof state.users[principalId] === 'object'
    ? state.users[principalId]
    : null;
  const timestamp = nowIso();
  const next = existing || {
    principalId,
    privateId: randomUUID(),
    createdAt: timestamp
  };
  if (!isNonEmptyString(next.privateId)) {
    next.privateId = randomUUID();
    ctx.dirty = true;
  }
  const desiredRootId = next.privateId;
  const previousRootId = isNonEmptyString(next.mySpaceRootId) ? next.mySpaceRootId : desiredRootId;
  if (previousRootId !== desiredRootId) {
    const previousRoot = state.confidentialObjects[previousRootId];
    if (previousRoot && typeof previousRoot === 'object') {
      state.confidentialObjects[desiredRootId] = {
        ...previousRoot,
        id: desiredRootId
      };
      delete state.confidentialObjects[previousRootId];
      for (const objectRecord of Object.values(state.confidentialObjects)) {
        if (objectRecord?.parentId === previousRootId) {
          objectRecord.parentId = desiredRootId;
        }
      }
    }
    ctx.dirty = true;
  }
  next.mySpaceRootId = desiredRootId;
  next.updatedAt = timestamp;
  next.username = actor.username || next.username || '';
  next.email = actor.email || next.email || '';
  next.ssoSubject = actor.ssoSubject || next.ssoSubject || '';

  const currentRoot = state.confidentialObjects[next.mySpaceRootId];
  if (!currentRoot || typeof currentRoot !== 'object') {
    state.confidentialObjects[next.mySpaceRootId] = {
      id: next.mySpaceRootId,
      type: 'folder',
      name: 'My Space',
      parentId: null,
      ownerId: principalId,
      acl: {},
      comments: [],
      mimeType: '',
      createdAt: timestamp,
      updatedAt: timestamp
    };
    ctx.dirty = true;
  } else {
    if (currentRoot.ownerId !== principalId) {
      currentRoot.ownerId = principalId;
      ctx.dirty = true;
    }
    if (!Array.isArray(currentRoot.comments)) {
      currentRoot.comments = [];
      ctx.dirty = true;
    }
  }

  if (!existing) {
    state.users[principalId] = next;
    ctx.dirty = true;
  } else {
    state.users[principalId] = next;
  }

  if (upsertPrincipalIdentity(permissionsManifest, principalId, extractIdentityHints({ user: {
    email: actor.email,
    username: actor.username,
    id: actor.id,
    sub: actor.ssoSubject,
    roles: actor.roles,
    claims: actor.claims
  }, issuer: actor.issuer }))) {
    ctx.permissionsDirty = true;
  }

  if (
    isNonEmptyString(actor.agentPrincipalId)
    && upsertPrincipalIdentity(permissionsManifest, actor.agentPrincipalId, {
      agentName: actor.agentName
    })
  ) {
    ctx.permissionsDirty = true;
  }

  return next;
}

async function withLockedState(worker) {
  return withFileLock(async () => {
    const state = await loadState();
    const permissionsManifest = await loadPermissionsManifest();
    const ctx = { dirty: false, permissionsDirty: false };
    const result = await worker(state, permissionsManifest, ctx);
    if (ctx.dirty) {
      await saveState(state);
    }
    if (ctx.permissionsDirty) {
      await savePermissionsManifest(permissionsManifest);
    }
    return result;
  });
}

async function serializeSecret(state, permissionsManifest, secret, actor, options = {}) {
  const includeValue = options.includeValue !== false;
  const role = getSecretRole(secret, actor, permissionsManifest);
  const canRead = Boolean(role && secretRoleAllows(role, 'read'));
  const canWrite = Boolean(role && secretRoleAllows(role, 'write'));
  const aclVisible = canWrite;
  let value = null;
  if (includeValue && canRead) {
    const secretsMap = typeof options.getSecretsMap === 'function'
      ? await options.getSecretsMap()
      : await readSecretsMap();
    value = Object.prototype.hasOwnProperty.call(secretsMap, secret.key)
      ? secretsMap[secret.key]
      : null;
  }
  return {
    id: secret.id,
    key: secret.key,
    displayName: secret.displayName || secret.key,
    ownerId: secret.ownerId,
    role,
    canRead,
    canWrite,
    valueVisible: includeValue && canRead,
    value,
    valueMasked: includeValue && !canRead,
    aclVisible,
    acl: aclVisible ? aclEntries(getSecretAclMap(secret, permissionsManifest)) : [],
    createdAt: secret.createdAt,
    updatedAt: secret.updatedAt
  };
}

function normalizeSecretDisplayName(value, fallbackKey) {
  const normalized = String(value ?? fallbackKey ?? '').trim();
  if (!normalized) {
    return fallbackKey;
  }
  if (normalized.includes('\0')) {
    throw new Error('displayName contains an invalid null byte.');
  }
  if (/[\\/]/.test(normalized)) {
    throw new Error('displayName cannot contain path separators.');
  }
  return normalized;
}

async function serializeConfidentialObject(state, permissionsManifest, objectRecord, actor, options = {}) {
  const includeContent = options.includeContent === true;
  const role = getConfidentialRole(state, objectRecord, actor, permissionsManifest);
  const canRead = Boolean(role && confidentialRoleAllows(role, 'read'));
  const canComment = Boolean(role && confidentialRoleAllows(role, 'comment'));
  const canWrite = Boolean(role && confidentialRoleAllows(role, 'write'));
  const aclVisible = canWrite;
  const commentsVisible = Boolean(includeContent && canRead);
  const comments = commentsVisible
    ? serializeConfidentialComments(objectRecord, actor, canWrite, nowIso)
    : [];
  let content = null;
  if (includeContent && objectRecord.type === 'file' && canRead) {
    content = await readConfidentialFile(objectRecord);
  }
  return {
    id: objectRecord.id,
    type: objectRecord.type,
    name: objectRecord.name,
    parentId: objectRecord.parentId || null,
    ownerId: objectRecord.ownerId,
    mimeType: objectRecord.mimeType || '',
    role,
    canRead,
    canComment,
    canWrite,
    contentVisible: includeContent && objectRecord.type === 'file' ? canRead : false,
    content,
    commentsVisible,
    commentCount: normalizeCommentRecords(objectRecord.comments, nowIso).length,
    comments,
    aclVisible,
    acl: aclVisible ? aclEntries(getConfidentialAclMap(objectRecord, permissionsManifest)) : [],
    createdAt: objectRecord.createdAt,
    updatedAt: objectRecord.updatedAt
  };
}

export async function getWhoAmI(authInfo = null) {
  return withLockedState(async (state, permissionsManifest, ctx) => {
    assertInvocationScopeFor('dpu_whoami', authInfo);
    const actor = resolveActor(authInfo, permissionsManifest);
    if (!actor.authenticated) {
      return {
        ok: true,
        authenticated: false,
        actor: {
          principalId: '',
          email: '',
          username: '',
          id: '',
          roles: []
        },
        userSpace: null
      };
    }
    const userSpace = await ensureUserRecord(state, permissionsManifest, actor, ctx);
    return {
      ok: true,
      authenticated: true,
      actor: {
        principalId: actor.principalId,
        email: actor.email,
        username: actor.username,
        id: actor.id,
        roles: actor.roles
      },
      userSpace: {
        privateId: userSpace.privateId,
        mySpaceRootId: userSpace.mySpaceRootId
      }
    };
  });
}

export async function getWorkspaceRoots(authInfo = null) {
  return withLockedState(async (state, permissionsManifest, ctx) => {
    assertInvocationScopeFor('dpu_workspace_roots', authInfo);
    const actor = requireAuthenticatedActor(authInfo, permissionsManifest);
    const userSpace = await ensureUserRecord(state, permissionsManifest, actor, ctx);
    const roots = {
      confidential: {
        path: '/Confidential',
        type: 'virtual-root'
      },
      mySpace: {
        id: userSpace.mySpaceRootId,
        path: '/Confidential/My Space',
        type: 'folder'
      },
      sharedFiles: {
        scope: 'shared',
        path: '/Confidential/Shared',
        type: 'virtual-list'
      },
      secrets: {
        scope: 'secrets',
        path: '/Confidential/Secrets',
        type: 'virtual-list'
      },
      researchData: {
        scope: 'resources',
        path: '/Confidential/Research Data',
        type: 'virtual-list'
      },
      jobs: {
        scope: 'jobs',
        path: '/Confidential/Jobs',
        type: 'virtual-list'
      }
    };
    if (hasAuditViewerRole(actor)) {
      roots.audit = {
        scope: 'audit',
        path: AUDIT_ROOT_PATH,
        type: 'virtual-list'
      };
    }
    return {
      ok: true,
      roots
    };
  });
}

export async function getAuditConfig(authInfo = null) {
  return withLockedState(async (state, permissionsManifest, ctx) => {
    const actor = requireAuthenticatedActor(authInfo, permissionsManifest);
    await ensureUserRecord(state, permissionsManifest, actor, ctx);
    const audit = getAuditSettings();
    return {
      ok: true,
      audit: {
        enabled: Boolean(audit.enabled),
        capture: { ...audit.capture },
        canManage: false,
        canViewFiles: hasAuditViewerRole(actor)
      }
    };
  });
}

export async function getAgentPolicyForPrincipal(authInfo = null, { principalId } = {}) {
  return withLockedState(async (state, permissionsManifest, ctx) => {
    const actor = requireAuthenticatedActor(authInfo, permissionsManifest);
    await ensureUserRecord(state, permissionsManifest, actor, ctx);
    assertAuditViewer(actor);
    const normalizedPrincipalId = normalizePrincipal(principalId, 'principalId');
    if (!/^agent:/i.test(normalizedPrincipalId)) {
      throw new Error('principalId must be an agent principal (agent:<repo>/<agent>).');
    }
    const policy = getAgentPolicy(permissionsManifest, normalizedPrincipalId);
    return {
      ok: true,
      principalId: normalizedPrincipalId,
      policy: policy
        ? {
            secrets: { allowedRoles: [...(policy.secrets?.allowedRoles || [])] },
            updatedAt: policy.updatedAt || ''
          }
        : null
    };
  });
}

export async function setAgentPolicyAllowedRoles(authInfo = null, { principalId, allowedRoles } = {}) {
  return withLockedState(async (state, permissionsManifest, ctx) => {
    const actor = requireAuthenticatedActor(authInfo, permissionsManifest);
    await ensureUserRecord(state, permissionsManifest, actor, ctx);
    assertAuditViewer(actor);
    const normalizedPrincipalId = normalizePrincipal(principalId, 'principalId');
    if (!/^agent:/i.test(normalizedPrincipalId)) {
      throw new Error('principalId must be an agent principal (agent:<repo>/<agent>).');
    }
    const rolesInput = Array.isArray(allowedRoles) ? allowedRoles : [];
    const changed = setAgentAllowedRoles(
      permissionsManifest,
      normalizedPrincipalId,
      rolesInput,
      { roleOrder: SECRET_ROLE_ORDER }
    );
    if (changed) {
      ctx.permissionsDirty = true;
    }
    const policy = getAgentPolicy(permissionsManifest, normalizedPrincipalId);
    return {
      ok: true,
      principalId: normalizedPrincipalId,
      policy: {
        secrets: { allowedRoles: [...(policy?.secrets?.allowedRoles || [])] },
        updatedAt: policy?.updatedAt || ''
      }
    };
  });
}

export async function listAuditEntries(authInfo = null) {
  return withLockedState(async (state, permissionsManifest, ctx) => {
    const actor = requireAuthenticatedActor(authInfo, permissionsManifest);
    await ensureUserRecord(state, permissionsManifest, actor, ctx);
    assertAuditViewer(actor);
    const files = await listAuditStorageFiles();
    return {
      ok: true,
      items: files.map((fileName) => buildAuditFileEntry(fileName))
    };
  });
}

export async function getAuditEntry(authInfo = null, { name, maxBytes = 0 }) {
  return withLockedState(async (state, permissionsManifest, ctx) => {
    const actor = requireAuthenticatedActor(authInfo, permissionsManifest);
    await ensureUserRecord(state, permissionsManifest, actor, ctx);
    assertAuditViewer(actor);
    const normalizedName = normalizePathSegment(name, 'name');
    if (!normalizedName.endsWith('.jsonl')) {
      throw new Error('Audit file name must end with .jsonl.');
    }
    const availableFiles = await listAuditStorageFiles();
    if (!availableFiles.includes(normalizedName)) {
      return { ok: false, error: `Audit file not found: ${normalizedName}` };
    }
    const content = await readAuditStorageFile(normalizedName, { maxBytes });
    return {
      ok: true,
      item: buildAuditFileEntry(normalizedName, content)
    };
  });
}

export async function searchAuditEntries(authInfo = null, { query, limit = 500 } = {}) {
  return withLockedState(async (state, permissionsManifest, ctx) => {
    const actor = requireAuthenticatedActor(authInfo, permissionsManifest);
    await ensureUserRecord(state, permissionsManifest, actor, ctx);
    assertAuditViewer(actor);
    const needle = String(query || '').trim().toLocaleLowerCase();
    if (!needle) throw new Error('Audit search query is required.');
    const boundedLimit = Math.max(1, Math.min(500, Number.parseInt(String(limit), 10) || 500));
    const files = await listAuditStorageFiles();
    const matches = [];
    let truncated = false;
    for (const fileName of files) {
      const content = await readAuditStorageFile(fileName);
      const lines = content.split('\n').filter(Boolean);
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index];
        if (!line.toLocaleLowerCase().includes(needle)) continue;
        if (matches.length >= boundedLimit) {
          truncated = true;
          break;
        }
        let record = null;
        try { record = JSON.parse(line); } catch (_) {}
        const rawTimestamp = record?.timestamp || record?.ts;
        matches.push({
          file: fileName,
          lineNumber: index + 1,
          timestamp: Number.isFinite(Date.parse(rawTimestamp)) ? new Date(rawTimestamp).toISOString() : null,
          line
        });
      }
      if (truncated) break;
    }
    return { ok: true, query: String(query), matches, truncated };
  });
}

export async function appendAuditClientEvent(authInfo = null, payload = {}) {
  return withLockedState(async (state, permissionsManifest, ctx) => {
    const actor = requireAuthenticatedActor(authInfo, permissionsManifest);
    await ensureUserRecord(state, permissionsManifest, actor, ctx);
    const eventType = normalizeName(payload.eventType, 'eventType');
    const source = String(payload.source || 'explorer').trim() || 'explorer';
    if (/^(ai|llm|copilot)[.:_-]/i.test(eventType) || ['ai', 'llm', 'copilot'].includes(source.toLowerCase())) {
      return { ok: true, appended: false };
    }
    const target = {
      path: String(payload.path || '').trim(),
      targetPath: String(payload.targetPath || '').trim(),
      pluginKey: String(payload.pluginKey || '').trim()
    };
    const metadata = {
      action: String(payload.action || '').trim(),
      language: String(payload.language || '').trim(),
      slot: String(payload.slot || '').trim(),
      currentPath: String(payload.currentPath || '').trim(),
      selectedPath: String(payload.selectedPath || '').trim()
    };
    const appended = await appendAuditRecord({
      timestamp: nowIso(),
      eventType,
      source,
      actor: buildAuditActorPayload(actor),
      target: sanitizeAuditMetadata(target),
      metadata: sanitizeAuditMetadata(metadata)
    });
    return { ok: true, appended };
  });
}

export async function listSecrets(authInfo = null) {
  assertInvocationScopeFor('dpu_secret_list', authInfo);
  return withLockedState(async (state, permissionsManifest, ctx) => {
    const actor = requireAuthenticatedActor(authInfo, permissionsManifest);
    await ensureUserRecord(state, permissionsManifest, actor, ctx);
    return runAuditedMutation(state, actor, {
      operation: 'dpu.secret.list',
      target: { path: '/Confidential/Secrets' },
      metadata: {}
    }, async () => {
      const secrets = [];
      // Request-local: the map is read and decrypted at most once per list call.
      let secretsMapPromise = null;
      const getSecretsMap = () => {
        secretsMapPromise ??= readSecretsMap();
        return secretsMapPromise;
      };
      for (const secret of Object.values(state.secrets)) {
        const role = getSecretRole(secret, actor, permissionsManifest);
        if (!role || !secretRoleAllows(role, 'access')) {
          continue;
        }
        secrets.push(await serializeSecret(state, permissionsManifest, secret, actor, { getSecretsMap }));
      }
      secrets.sort((a, b) => a.key.localeCompare(b.key));
      return { ok: true, secrets };
    });
  });
}

export async function getSecretByKey(authInfo = null, { key }) {
  assertInvocationScopeFor('dpu_secret_get', authInfo);
  return withLockedState(async (state, permissionsManifest, ctx) => {
    const actor = requireAuthenticatedActor(authInfo, permissionsManifest);
    await ensureUserRecord(state, permissionsManifest, actor, ctx);
    return runAuditedMutation(state, actor, {
      operation: 'dpu.secret.get',
      target: { path: `/Confidential/Secrets/${normalizeSecretKey(key)}`, key: normalizeSecretKey(key) },
      metadata: {}
    }, async () => {
      const secret = getSecret(state, key);
      if (!secret) {
        return { ok: false, error: `Secret not found: ${key}` };
      }
      assertSecretPermission(secret, actor, 'access', permissionsManifest);
      return { ok: true, secret: await serializeSecret(state, permissionsManifest, secret, actor) };
    });
  });
}

export async function putSecret(authInfo = null, { key, value, displayName }) {
  assertInvocationScopeFor('dpu_secret_put', authInfo);
  return withLockedState(async (state, permissionsManifest, ctx) => {
    const actor = requireAuthenticatedActor(authInfo, permissionsManifest);
    await ensureUserRecord(state, permissionsManifest, actor, ctx);
    return runAuditedMutation(state, actor, {
      operation: 'dpu.secret.put',
      target: { path: `/Confidential/Secrets/${normalizeSecretKey(key)}`, key: normalizeSecretKey(key) },
      metadata: {}
    }, async () => {
      const normalizedKey = normalizeSecretKey(key);
      const normalizedValue = String(value ?? '');
      const normalizedDisplayName = displayName === undefined
        ? null
        : normalizeSecretDisplayName(displayName, normalizedKey);
      let secret = getSecret(state, normalizedKey);
      if (secret) {
        assertSecretPermission(secret, actor, 'write', permissionsManifest);
        if (normalizedDisplayName !== null) {
          secret.displayName = normalizedDisplayName;
        }
        secret.updatedAt = nowIso();
      } else {
        secret = {
          id: randomUUID(),
          key: normalizedKey,
          displayName: normalizedDisplayName || normalizedKey,
          ownerId: actor.principalId,
          acl: {},
          createdAt: nowIso(),
          updatedAt: nowIso()
        };
        state.secrets[normalizedKey] = secret;
        ctx.dirty = true;
      }
      // Owners are represented as `write-access` by default; explicitly grant
      // `read` so the owner can retrieve secret values in follow-up calls.
      if (setPermissionRole(permissionsManifest, 'secret', normalizedKey, actor.principalId, 'read')) {
        ctx.permissionsDirty = true;
      }
      await upsertSecretsFileValue(normalizedKey, normalizedValue);
      secret.updatedAt = nowIso();
      ctx.dirty = true;
      return { ok: true, secret: await serializeSecret(state, permissionsManifest, secret, actor) };
    });
  });
}

export async function deleteSecret(authInfo = null, { key }) {
  assertInvocationScopeFor('dpu_secret_delete', authInfo);
  return withLockedState(async (state, permissionsManifest, ctx) => {
    const actor = requireAuthenticatedActor(authInfo, permissionsManifest);
    await ensureUserRecord(state, permissionsManifest, actor, ctx);
    return runAuditedMutation(state, actor, {
      operation: 'dpu.secret.delete',
      target: { path: `/Confidential/Secrets/${normalizeSecretKey(key)}`, key: normalizeSecretKey(key) },
      metadata: {}
    }, async () => {
      const secret = getSecret(state, key);
      if (!secret) {
        return { ok: false, error: `Secret not found: ${key}` };
      }
      assertSecretPermission(secret, actor, 'write', permissionsManifest);
      delete state.secrets[secret.key];
      if (deletePermissionEntry(permissionsManifest, 'secret', secret.key)) {
        ctx.permissionsDirty = true;
      }
      await deleteSecretsFileValue(secret.key);
      ctx.dirty = true;
      return { ok: true, deleted: true, key: secret.key };
    });
  });
}

export async function grantSecret(authInfo = null, { key, principal, role }) {
  assertInvocationScopeFor('dpu_secret_grant', authInfo);
  return withLockedState(async (state, permissionsManifest, ctx) => {
    const actor = requireAuthenticatedActor(authInfo, permissionsManifest);
    await ensureUserRecord(state, permissionsManifest, actor, ctx);
    return runAuditedMutation(state, actor, {
      operation: 'dpu.secret.grant',
      target: { path: `/Confidential/Secrets/${normalizeSecretKey(key)}`, key: normalizeSecretKey(key) },
      metadata: { principal, role }
    }, async () => {
      const secret = getSecret(state, key);
      if (!secret) {
        return { ok: false, error: `Secret not found: ${key}` };
      }
      if (secret.ownerId !== actor.principalId) {
        throw new Error('Only the secret owner can manage ACL.');
      }
      const normalizedRole = normalizeName(role, 'role').toLowerCase();
      if (!SECRET_ROLE_ORDER.includes(normalizedRole)) {
        throw new Error('Invalid secret role.');
      }
      const normalizedPrincipal = resolvePrincipalReference(
        permissionsManifest,
        normalizePrincipal(principal, 'principal')
      );
      await assertAgentSecretGrantAllowed(permissionsManifest, normalizedPrincipal, normalizedRole);
      if (normalizedPrincipal !== secret.ownerId) {
        setPermissionRole(permissionsManifest, 'secret', secret.key, normalizedPrincipal, normalizedRole);
        secret.updatedAt = nowIso();
        ctx.dirty = true;
        ctx.permissionsDirty = true;
      }
      return { ok: true, secret: await serializeSecret(state, permissionsManifest, secret, actor) };
    });
  });
}

export async function revokeSecret(authInfo = null, { key, principal }) {
  assertInvocationScopeFor('dpu_secret_revoke', authInfo);
  return withLockedState(async (state, permissionsManifest, ctx) => {
    const actor = requireAuthenticatedActor(authInfo, permissionsManifest);
    await ensureUserRecord(state, permissionsManifest, actor, ctx);
    return runAuditedMutation(state, actor, {
      operation: 'dpu.secret.revoke',
      target: { path: `/Confidential/Secrets/${normalizeSecretKey(key)}`, key: normalizeSecretKey(key) },
      metadata: { principal }
    }, async () => {
      const secret = getSecret(state, key);
      if (!secret) {
        return { ok: false, error: `Secret not found: ${key}` };
      }
      if (secret.ownerId !== actor.principalId) {
        throw new Error('Only the secret owner can manage ACL.');
      }
      const principalCandidates = buildPrincipalReferenceCandidates(principal, permissionsManifest);
      const changed = principalCandidates.reduce((didChange, candidate) => {
        return removePermissionRole(permissionsManifest, 'secret', secret.key, candidate) || didChange;
      }, false);
      if (changed) {
        secret.updatedAt = nowIso();
        ctx.dirty = true;
        ctx.permissionsDirty = true;
      }
      return { ok: true, secret: await serializeSecret(state, permissionsManifest, secret, actor) };
    });
  });
}

export async function listConfidential(authInfo = null, { scope = 'my-space', parentId = '' } = {}) {
  assertInvocationScopeFor('dpu_confidential_list', authInfo);
  return withLockedState(async (state, permissionsManifest, ctx) => {
    const actor = requireAuthenticatedActor(authInfo, permissionsManifest);
    const userSpace = await ensureUserRecord(state, permissionsManifest, actor, ctx);
    return runAuditedMutation(state, actor, {
      operation: 'dpu.confidential.list',
      target: {
        path: scope === 'shared' ? '/Confidential/Shared' : '/Confidential/My Space',
        scope,
        parentId: parentId || userSpace.mySpaceRootId
      },
      metadata: {}
    }, async () => {
      if (scope === 'shared') {
        const items = [];
        for (const item of sortByName(collectSharedObjects(state, permissionsManifest, actor))) {
          items.push(await serializeConfidentialObject(state, permissionsManifest, item, actor, { includeContent: false }));
        }
        return { ok: true, scope: 'shared', items };
      }

      const resolvedParentId = isNonEmptyString(parentId) ? parentId.trim() : userSpace.mySpaceRootId;
      const parent = getConfidentialObject(state, resolvedParentId);
      if (!parent) {
        return { ok: false, error: `Confidential object not found: ${resolvedParentId}` };
      }
      assertConfidentialPermission(state, parent, actor, 'access', permissionsManifest);
      const items = [];
      for (const item of sortByName(collectChildObjects(state, resolvedParentId))) {
        const role = getConfidentialRole(state, item, actor, permissionsManifest);
        if (!role || !confidentialRoleAllows(role, 'access')) {
          continue;
        }
        items.push(await serializeConfidentialObject(state, permissionsManifest, item, actor, { includeContent: false }));
      }
      return {
        ok: true,
        scope: 'my-space',
        parent: await serializeConfidentialObject(state, permissionsManifest, parent, actor, { includeContent: false }),
        items
      };
    });
  });
}

export async function getConfidentialById(authInfo = null, { id }) {
  assertInvocationScopeFor('dpu_confidential_get', authInfo);
  return withLockedState(async (state, permissionsManifest, ctx) => {
    const actor = requireAuthenticatedActor(authInfo, permissionsManifest);
    await ensureUserRecord(state, permissionsManifest, actor, ctx);
    return runAuditedMutation(state, actor, {
      operation: 'dpu.confidential.get',
      target: { id },
      metadata: {}
    }, async () => {
      const objectRecord = getConfidentialObject(state, id);
      if (!objectRecord) {
        return { ok: false, error: `Confidential object not found: ${id}` };
      }
      assertConfidentialPermission(state, objectRecord, actor, 'access', permissionsManifest);
      return {
        ok: true,
        object: await serializeConfidentialObject(state, permissionsManifest, objectRecord, actor, { includeContent: true })
      };
    });
  });
}

export async function createConfidential(authInfo = null, payload = {}) {
  assertInvocationScopeFor('dpu_confidential_create', authInfo);
  return withLockedState(async (state, permissionsManifest, ctx) => {
    const actor = requireAuthenticatedActor(authInfo, permissionsManifest);
    const userSpace = await ensureUserRecord(state, permissionsManifest, actor, ctx);
    return runAuditedMutation(state, actor, {
      operation: 'dpu.confidential.create',
      target: {
        parentId: payload.parentId || userSpace.mySpaceRootId,
        type: payload.type,
        name: payload.name
      },
      metadata: {}
    }, async () => {
      const type = normalizeName(payload.type, 'type').toLowerCase();
      if (!['file', 'folder'].includes(type)) {
        throw new Error('type must be "file" or "folder".');
      }
      const parentId = isNonEmptyString(payload.parentId) ? payload.parentId.trim() : userSpace.mySpaceRootId;
      const parent = getConfidentialObject(state, parentId);
      if (!parent) {
        return { ok: false, error: `Parent object not found: ${parentId}` };
      }
      if (parent.type !== 'folder') {
        throw new Error('Parent must be a folder.');
      }
      assertConfidentialPermission(state, parent, actor, 'write', permissionsManifest);
      const name = ensureUniqueSiblingName(state, parent.id, payload.name);

      const objectRecord = {
        id: randomUUID(),
        type,
        name,
        parentId: parent.id,
        ownerId: parent.ownerId,
        acl: {},
        comments: [],
        mimeType: type === 'file' ? String(payload.mimeType || '').trim() : '',
        createdAt: nowIso(),
        updatedAt: nowIso()
      };
      state.confidentialObjects[objectRecord.id] = objectRecord;

      if (type === 'file') {
        await writeConfidentialFile(objectRecord, payload.content || '');
      }
      ctx.dirty = true;
      return {
        ok: true,
        object: await serializeConfidentialObject(state, permissionsManifest, objectRecord, actor, { includeContent: true })
      };
    });
  });
}

export async function updateConfidential(authInfo = null, payload = {}) {
  assertInvocationScopeFor('dpu_confidential_update', authInfo);
  return withLockedState(async (state, permissionsManifest, ctx) => {
    const actor = requireAuthenticatedActor(authInfo, permissionsManifest);
    await ensureUserRecord(state, permissionsManifest, actor, ctx);
    return runAuditedMutation(state, actor, {
      operation: 'dpu.confidential.update',
      target: { id: payload.id },
      metadata: {
        rename: Object.prototype.hasOwnProperty.call(payload, 'name'),
        contentUpdated: Object.prototype.hasOwnProperty.call(payload, 'content'),
        mimeTypeUpdated: Object.prototype.hasOwnProperty.call(payload, 'mimeType')
      }
    }, async () => {
      const objectRecord = getConfidentialObject(state, payload.id);
      if (!objectRecord) {
        return { ok: false, error: `Confidential object not found: ${payload.id}` };
      }
      if (isSystemRootObject(objectRecord)) {
        throw new Error('My Space root cannot be renamed or edited directly.');
      }
      assertConfidentialPermission(state, objectRecord, actor, 'write', permissionsManifest);

      if (Object.prototype.hasOwnProperty.call(payload, 'name') && isNonEmptyString(payload.name)) {
        const nextName = ensureUniqueSiblingName(state, objectRecord.parentId || null, payload.name, objectRecord.id);
        if (nextName !== objectRecord.name) {
          objectRecord.name = nextName;
          ctx.dirty = true;
        }
      }

      if (objectRecord.type === 'file') {
        if (Object.prototype.hasOwnProperty.call(payload, 'content')) {
          await writeConfidentialFile(objectRecord, payload.content ?? '');
        }
        if (Object.prototype.hasOwnProperty.call(payload, 'mimeType')) {
          objectRecord.mimeType = String(payload.mimeType || '').trim();
          ctx.dirty = true;
        }
      }

      objectRecord.updatedAt = nowIso();
      ctx.dirty = true;
      return {
        ok: true,
        object: await serializeConfidentialObject(state, permissionsManifest, objectRecord, actor, { includeContent: true })
      };
    });
  });
}

export async function deleteConfidential(authInfo = null, { id }) {
  assertInvocationScopeFor('dpu_confidential_delete', authInfo);
  return withLockedState(async (state, permissionsManifest, ctx) => {
    const actor = requireAuthenticatedActor(authInfo, permissionsManifest);
    await ensureUserRecord(state, permissionsManifest, actor, ctx);
    return runAuditedMutation(state, actor, {
      operation: 'dpu.confidential.delete',
      target: { id },
      metadata: {}
    }, async () => {
      const objectRecord = getConfidentialObject(state, id);
      if (!objectRecord) {
        return { ok: false, error: `Confidential object not found: ${id}` };
      }
      if (isSystemRootObject(objectRecord)) {
        throw new Error('My Space root cannot be deleted.');
      }
      assertConfidentialPermission(state, objectRecord, actor, 'write', permissionsManifest);
      await deleteObjectRecursive(state, objectRecord.id);
      if (deletePermissionEntry(permissionsManifest, 'confidential', objectRecord.id)) {
        ctx.permissionsDirty = true;
      }
      ctx.dirty = true;
      return { ok: true, deleted: true, id: objectRecord.id };
    });
  });
}

export async function grantConfidential(authInfo = null, { id, principal, role }) {
  assertInvocationScopeFor('dpu_confidential_grant', authInfo);
  return withLockedState(async (state, permissionsManifest, ctx) => {
    const actor = requireAuthenticatedActor(authInfo, permissionsManifest);
    await ensureUserRecord(state, permissionsManifest, actor, ctx);
    return runAuditedMutation(state, actor, {
      operation: 'dpu.confidential.grant',
      target: { id },
      metadata: { principal, role }
    }, async () => {
      const objectRecord = getConfidentialObject(state, id);
      if (!objectRecord) {
        return { ok: false, error: `Confidential object not found: ${id}` };
      }
      if (isSystemRootObject(objectRecord)) {
        throw new Error('My Space root cannot be shared directly.');
      }
      if (objectRecord.ownerId !== actor.principalId) {
        throw new Error('Only the object owner can manage ACL.');
      }
      const normalizedRole = normalizeName(role, 'role').toLowerCase();
      if (!CONFIDENTIAL_ROLE_ORDER.includes(normalizedRole)) {
        throw new Error('Invalid confidential role.');
      }
      const normalizedPrincipal = resolvePrincipalReference(
        permissionsManifest,
        normalizePrincipal(principal, 'principal')
      );
      if (normalizedPrincipal !== objectRecord.ownerId) {
        setPermissionRole(permissionsManifest, 'confidential', objectRecord.id, normalizedPrincipal, normalizedRole);
        objectRecord.updatedAt = nowIso();
        ctx.dirty = true;
        ctx.permissionsDirty = true;
      }
      return {
        ok: true,
        object: await serializeConfidentialObject(state, permissionsManifest, objectRecord, actor, { includeContent: false })
      };
    });
  });
}

export async function revokeConfidential(authInfo = null, { id, principal }) {
  assertInvocationScopeFor('dpu_confidential_revoke', authInfo);
  return withLockedState(async (state, permissionsManifest, ctx) => {
    const actor = requireAuthenticatedActor(authInfo, permissionsManifest);
    await ensureUserRecord(state, permissionsManifest, actor, ctx);
    return runAuditedMutation(state, actor, {
      operation: 'dpu.confidential.revoke',
      target: { id },
      metadata: { principal }
    }, async () => {
      const objectRecord = getConfidentialObject(state, id);
      if (!objectRecord) {
        return { ok: false, error: `Confidential object not found: ${id}` };
      }
      if (isSystemRootObject(objectRecord)) {
        throw new Error('My Space root cannot be shared directly.');
      }
      if (objectRecord.ownerId !== actor.principalId) {
        throw new Error('Only the object owner can manage ACL.');
      }
      const principalCandidates = buildPrincipalReferenceCandidates(principal, permissionsManifest);
      const changed = principalCandidates.reduce((didChange, candidate) => {
        return removePermissionRole(permissionsManifest, 'confidential', objectRecord.id, candidate) || didChange;
      }, false);
      if (changed) {
        objectRecord.updatedAt = nowIso();
        ctx.dirty = true;
        ctx.permissionsDirty = true;
      }
      return {
        ok: true,
        object: await serializeConfidentialObject(state, permissionsManifest, objectRecord, actor, { includeContent: false })
      };
    });
  });
}

export async function addConfidentialComment(authInfo = null, { id, message }) {
  assertInvocationScopeFor('dpu_confidential_comment_add', authInfo);
  return withLockedState(async (state, permissionsManifest, ctx) => {
    const actor = requireAuthenticatedActor(authInfo, permissionsManifest);
    await ensureUserRecord(state, permissionsManifest, actor, ctx);
    return runAuditedMutation(state, actor, {
      operation: 'dpu.confidential.comment.add',
      target: { id },
      metadata: {}
    }, async () => {
      const objectRecord = getConfidentialObject(state, id);
      if (!objectRecord) {
        return { ok: false, error: `Confidential object not found: ${id}` };
      }
      assertConfidentialPermission(state, objectRecord, actor, 'comment', permissionsManifest);
      const normalizedMessage = normalizeName(message, 'comment message');
      objectRecord.comments = normalizeCommentRecords(objectRecord.comments, nowIso);
      const comment = {
        id: randomUUID(),
        authorPrincipal: actor.principalId,
        userEmail: actor.email || actor.principalId,
        message: normalizedMessage,
        createdAt: nowIso(),
        updatedAt: nowIso()
      };
      objectRecord.comments.push(comment);
      objectRecord.updatedAt = nowIso();
      ctx.dirty = true;
      return {
        ok: true,
        comment: serializeConfidentialComments({ comments: [comment] }, actor, true, nowIso)[0],
        object: await serializeConfidentialObject(state, permissionsManifest, objectRecord, actor, { includeContent: false })
      };
    });
  });
}

export async function deleteConfidentialComment(authInfo = null, { id, commentId }) {
  assertInvocationScopeFor('dpu_confidential_comment_delete', authInfo);
  return withLockedState(async (state, permissionsManifest, ctx) => {
    const actor = requireAuthenticatedActor(authInfo, permissionsManifest);
    await ensureUserRecord(state, permissionsManifest, actor, ctx);
    return runAuditedMutation(state, actor, {
      operation: 'dpu.confidential.comment.delete',
      target: { id, commentId },
      metadata: {}
    }, async () => {
      const objectRecord = getConfidentialObject(state, id);
      if (!objectRecord) {
        return { ok: false, error: `Confidential object not found: ${id}` };
      }
      const role = assertConfidentialPermission(state, objectRecord, actor, 'comment', permissionsManifest);
      const normalizedCommentId = normalizeName(commentId, 'comment id');
      const comments = normalizeCommentRecords(objectRecord.comments, nowIso);
      const commentIndex = comments.findIndex((entry) => entry.id === normalizedCommentId);
      if (commentIndex < 0) {
        return { ok: false, error: `Confidential comment not found: ${commentId}` };
      }
      const canDeleteAnyComments = confidentialRoleAllows(role, 'write');
      if (!canDeleteAnyComments && comments[commentIndex].authorPrincipal !== actor.principalId) {
        throw new Error('Only the comment author or an editor can delete this comment.');
      }
      comments.splice(commentIndex, 1);
      objectRecord.comments = comments;
      objectRecord.updatedAt = nowIso();
      ctx.dirty = true;
      return {
        ok: true,
        deleted: true,
        commentId: normalizedCommentId,
        object: await serializeConfidentialObject(state, permissionsManifest, objectRecord, actor, { includeContent: false })
      };
    });
  });
}

export async function accessCheck(authInfo = null, { kind, key, id, permission }) {
  return withLockedState(async (state, permissionsManifest, ctx) => {
    const actor = requireAuthenticatedActor(authInfo, permissionsManifest);
    await ensureUserRecord(state, permissionsManifest, actor, ctx);
    const normalizedKind = normalizeName(kind, 'kind').toLowerCase();
    const normalizedPermission = normalizeName(permission, 'permission').toLowerCase();

    if (normalizedKind === 'secret') {
      const secret = getSecret(state, key);
      if (!secret) {
        return { ok: false, error: `Secret not found: ${key}` };
      }
      const role = getSecretRole(secret, actor, permissionsManifest);
      const allowed = Boolean(role && secretRoleAllows(role, normalizedPermission));
      return {
        ok: true,
        kind: 'secret',
        allowed,
        effectiveRole: role,
        permission: normalizedPermission,
        resource: { key: secret.key, id: secret.id }
      };
    }

    if (normalizedKind === 'confidential') {
      const objectRecord = getConfidentialObject(state, id);
      if (!objectRecord) {
        return { ok: false, error: `Confidential object not found: ${id}` };
      }
      const role = getConfidentialRole(state, objectRecord, actor, permissionsManifest);
      const allowed = Boolean(role && confidentialRoleAllows(role, normalizedPermission));
      return {
        ok: true,
        kind: 'confidential',
        allowed,
        effectiveRole: role,
        permission: normalizedPermission,
        resource: { id: objectRecord.id, type: objectRecord.type, name: objectRecord.name }
      };
    }

    throw new Error('kind must be "secret" or "confidential".');
  });
}
