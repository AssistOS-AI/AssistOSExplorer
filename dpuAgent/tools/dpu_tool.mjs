#!/usr/bin/env node
import {
  getAuditConfig,
  listAuditEntries,
  getAuditEntry,
  searchAuditEntries,
  appendAuditClientEvent,
  getWhoAmI,
  getWorkspaceRoots,
  listSecrets,
  getSecretByKey,
  putSecret,
  deleteSecret,
  grantSecret,
  revokeSecret,
  listConfidential,
  getConfidentialById,
  createConfidential,
  updateConfidential,
  deleteConfidential,
  addConfidentialComment,
  deleteConfidentialComment,
  grantConfidential,
  revokeConfidential,
  accessCheck,
  getAgentPolicyForPrincipal,
  setAgentPolicyAllowedRoles
} from '../lib/dpu-store.mjs';
import { DATA_TOOLS, executeWorkspaceDataTool } from '../lib/workspace-data.mjs';
import { executeDpuResearchTool, isDpuResearchTool } from '../lib/dpu-research-tools.mjs';

async function loadInvocationAuth() {
  const candidates = [
    process.env.PLOINKY_INVOCATION_AUTH_MODULE,
    '/Agent/lib/invocation-auth.mjs',
    '../../shared/invocation-auth.mjs'
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      return await import(candidate);
    } catch (_) {}
  }
  throw new Error('Unable to load invocation-auth helper.');
}

const { authInfoFromInvocation } = await loadInvocationAuth();

function safeParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function writeJson(value) {
  process.stdout.write(JSON.stringify(value));
}

async function readStdinFallback() {
  if (process.stdin.isTTY) {
    return '';
  }
  process.stdin.setEncoding('utf8');
  let data = '';
  for await (const chunk of process.stdin) {
    data += chunk;
  }
  return data;
}

function normalizeInput(envelope) {
  let current = envelope;
  for (let i = 0; i < 4; i += 1) {
    if (!current || typeof current !== 'object') break;
    if (current.input && typeof current.input === 'object') {
      current = current.input;
      continue;
    }
    if (current.arguments && typeof current.arguments === 'object') {
      current = current.arguments;
      continue;
    }
    if (current.params?.arguments && typeof current.params.arguments === 'object') {
      current = current.params.arguments;
      continue;
    }
    if (current.params?.input && typeof current.params.input === 'object') {
      current = current.params.input;
      continue;
    }
    break;
  }
  return current && typeof current === 'object' ? current : {};
}

function extractInvocationGrant(envelope) {
  const metadata = envelope && typeof envelope === 'object' ? envelope.metadata : null;
  const grant = metadata && typeof metadata === 'object' ? metadata.invocation : null;
  return grant && typeof grant === 'object' ? grant : null;
}

function normalizeArgs(toolName, args) {
  const input = args && typeof args === 'object' ? { ...args } : {};
  const requireString = (name) => {
    if (typeof input[name] !== 'string' || !input[name].trim()) {
      throw new Error(`${toolName} requires a "${name}" string.`);
    }
  };

  switch (toolName) {
    case 'dpu_whoami':
    case 'dpu_workspace_roots':
    case 'dpu_secret_list':
    case 'dpu_audit_config_get':
    case 'dpu_audit_list':
    case 'dpu_resource_list':
    case 'dpu_source_list':
    case 'dpu_job_list':
    case 'dpu_compute_backend_list':
      return input;
    case 'dpu_audit_event_append':
      requireString('eventType');
      return input;
    case 'dpu_audit_get':
      requireString('name');
      return input;
    case 'dpu_audit_search':
      requireString('query');
      return input;
    case 'dpu_secret_get':
    case 'dpu_secret_delete':
      requireString('key');
      return input;
    case 'dpu_secret_put':
      requireString('key');
      if (typeof input.value !== 'string') {
        throw new Error(`${toolName} requires a "value" string.`);
      }
      if (input.displayName !== undefined && typeof input.displayName !== 'string') {
        throw new Error(`${toolName} requires "displayName" to be a string when provided.`);
      }
      return input;
    case 'dpu_secret_grant':
      requireString('key');
      requireString('principal');
      requireString('role');
      return input;
    case 'dpu_secret_revoke':
      requireString('key');
      requireString('principal');
      return input;
    case 'dpu_confidential_list':
      if (input.scope !== undefined && !['my-space', 'shared'].includes(String(input.scope))) {
        throw new Error('dpu_confidential_list scope must be "my-space" or "shared".');
      }
      return input;
    case 'dpu_confidential_get':
    case 'dpu_confidential_delete':
      requireString('id');
      return input;
    case 'dpu_confidential_comment_add':
      requireString('id');
      requireString('message');
      return input;
    case 'dpu_confidential_comment_delete':
      requireString('id');
      requireString('commentId');
      return input;
    case 'dpu_confidential_create':
      requireString('type');
      requireString('name');
      return input;
    case 'dpu_confidential_update':
      requireString('id');
      return input;
    case 'dpu_confidential_grant':
      requireString('id');
      requireString('principal');
      requireString('role');
      return input;
    case 'dpu_confidential_revoke':
      requireString('id');
      requireString('principal');
      return input;
    case 'dpu_access_check':
      requireString('kind');
      requireString('permission');
      if (String(input.kind) === 'secret') {
        requireString('key');
      } else if (String(input.kind) === 'confidential') {
        requireString('id');
      }
      return input;
    case 'dpu_agent_policy_get':
      requireString('principalId');
      return input;
    case 'dpu_agent_policy_set':
      requireString('principalId');
      if (!Array.isArray(input.allowedRoles)) {
        throw new Error('dpu_agent_policy_set requires an "allowedRoles" array.');
      }
      return input;
    case 'dpu_resource_get':
    case 'dpu_resource_file_list':
    case 'dpu_resource_resolve_access':
    case 'dpu_resource_get_provenance':
    case 'dpu_source_get':
    case 'dpu_source_test':
    case 'dpu_source_remove':
    case 'dpu_job_get':
    case 'dpu_job_cancel':
    case 'dpu_action_get':
    case 'dpu_action_confirm':
    case 'dpu_action_reject':
    case 'dpu_compute_backend_test':
      requireString('id');
      return input;
    case 'dpu_compute_backend_upsert':
      requireString('type');
      return input;
    case 'dpu_compute_backend_set_enabled':
      requireString('id');
      if (typeof input.enabled !== 'boolean') throw new Error('dpu_compute_backend_set_enabled requires an "enabled" boolean.');
      return input;
    case 'dpu_federated_experiment_propose':
      for (const field of ['backendId', 'templateId', 'modelId', 'modelRevision', 'strategy']) requireString(field);
      if (!Array.isArray(input.participantResourceIds)) throw new Error('dpu_federated_experiment_propose requires a "participantResourceIds" array.');
      return input;
    case 'dpu_secure_execution_propose':
      for (const field of ['backendId', 'workloadId']) requireString(field);
      if (!Array.isArray(input.resourceIds)) throw new Error('dpu_secure_execution_propose requires a "resourceIds" array.');
      return input;
    case 'dpu_resource_file_stat':
    case 'dpu_resource_file_read':
      requireString('id');
      requireString('path');
      return input;
    case 'dpu_resource_register':
      requireString('provider');
      requireString('externalId');
      return input;
    case 'dpu_resource_update_use':
      requireString('id');
      return input;
    case 'dpu_resource_acquire':
      requireString('id');
      return input;
    case 'dpu_resource_share':
      requireString('id'); requireString('principal'); requireString('role');
      return input;
    case 'dpu_resource_revoke':
      requireString('id'); requireString('principal');
      return input;
    case 'dpu_resource_release_output':
      requireString('id'); requireString('destination');
      return input;
    case 'dpu_source_upsert':
      requireString('type');
      return input;
    case 'dpu_source_set_enabled':
      requireString('id');
      if (typeof input.enabled !== 'boolean') throw new Error('dpu_source_set_enabled requires an "enabled" boolean.');
      return input;
    case 'dpu_research_search':
      requireString('query');
      return input;
    case 'dpu_research_compare':
      if (!Array.isArray(input.ids)) throw new Error('dpu_research_compare requires an "ids" array.');
      return input;
    default:
      throw new Error(`Unsupported tool: ${toolName}`);
  }
}

async function main() {
  let raw = await readStdinFallback();
  if (!raw) {
    raw = '';
  }
  const envelope = raw && raw.trim() ? safeParseJson(raw) : null;
  const invocationGrant = extractInvocationGrant(envelope || {});
  const authInfo = invocationGrant
    ? authInfoFromInvocation(invocationGrant, { invocationToken: envelope?.metadata?.invocationToken || '' })
    : null;
  const toolName = process.env.TOOL_NAME;
  let args = normalizeInput(envelope || {});
  const isResearchTool = isDpuResearchTool(toolName);

  if (DATA_TOOLS.includes(toolName)) {
    writeJson(await executeWorkspaceDataTool(toolName, authInfo, args));
    return;
  }

  if (isResearchTool) {
    const researchResult = await executeDpuResearchTool(toolName, authInfo, args);
    writeJson(researchResult);
    return;
  }

  let result;
  try {
    args = normalizeArgs(toolName, args);
    switch (toolName) {
    case 'dpu_whoami':
      result = await getWhoAmI(authInfo);
      break;
    case 'dpu_audit_config_get':
      result = await getAuditConfig(authInfo);
      break;
    case 'dpu_audit_list':
      result = await listAuditEntries(authInfo, args);
      break;
    case 'dpu_audit_get':
      result = await getAuditEntry(authInfo, args);
      break;
    case 'dpu_audit_search':
      result = await searchAuditEntries(authInfo, args);
      break;
    case 'dpu_audit_event_append':
      result = await appendAuditClientEvent(authInfo, args);
      break;
    case 'dpu_workspace_roots':
      result = await getWorkspaceRoots(authInfo);
      break;
    case 'dpu_secret_list':
      result = await listSecrets(authInfo);
      break;
    case 'dpu_secret_get':
      result = await getSecretByKey(authInfo, args);
      break;
    case 'dpu_secret_put':
      result = await putSecret(authInfo, args);
      break;
    case 'dpu_secret_delete':
      result = await deleteSecret(authInfo, args);
      break;
    case 'dpu_secret_grant':
      result = await grantSecret(authInfo, args);
      break;
    case 'dpu_secret_revoke':
      result = await revokeSecret(authInfo, args);
      break;
    case 'dpu_confidential_list':
      result = await listConfidential(authInfo, args);
      break;
    case 'dpu_confidential_get':
      result = await getConfidentialById(authInfo, args);
      break;
    case 'dpu_confidential_create':
      result = await createConfidential(authInfo, args);
      break;
    case 'dpu_confidential_update':
      result = await updateConfidential(authInfo, args);
      break;
    case 'dpu_confidential_delete':
      result = await deleteConfidential(authInfo, args);
      break;
    case 'dpu_confidential_comment_add':
      result = await addConfidentialComment(authInfo, args);
      break;
    case 'dpu_confidential_comment_delete':
      result = await deleteConfidentialComment(authInfo, args);
      break;
    case 'dpu_confidential_grant':
      result = await grantConfidential(authInfo, args);
      break;
    case 'dpu_confidential_revoke':
      result = await revokeConfidential(authInfo, args);
      break;
    case 'dpu_access_check':
      result = await accessCheck(authInfo, args);
      break;
    case 'dpu_agent_policy_get':
      result = await getAgentPolicyForPrincipal(authInfo, args);
      break;
    case 'dpu_agent_policy_set':
      result = await setAgentPolicyAllowedRoles(authInfo, args);
      break;
      default:
        throw new Error(`Unsupported tool: ${toolName || '<missing>'}`);
    }
  } catch (error) {
    throw error;
  }

  writeJson(result);
}

main().catch((error) => {
  writeJson({
    ok: false,
    error: 'dpu_tool_failed',
    message: error?.message || String(error)
  });
  process.exitCode = 1;
});
