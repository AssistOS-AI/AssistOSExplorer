import crypto from 'node:crypto';

/**
 * secret-store-client.mjs
 *
 * DPU-aware secret client used by gitAgent. It:
 *
 *   - routes every call through the router to the configured DPU route
 *   - signs each delegated DPU call with this agent's Ploinky agent assertion
 *   - calls the canonical DPU secret operations
 *
 * Runtime contract (set by AgentServer/ploinky start scripts):
 *
 *   AgentMcpClient descriptor     - verifies and owns Router transport configuration
 *   PLOINKY_AGENT_PRINCIPAL       - e.g. agent:<repo>/gitAgent
 *   PLOINKY_DPU_ROUTE             - optional explicit DPU MCP route name
 */

const DEFAULT_DPU_ROUTE = 'dpuAgent';
const DEFAULT_DPU_SECRET_DELEGATION_KEY = 'dpuGitSecrets';
const MISSING_DELEGATION_MESSAGE = 'secret-store-client: missing DPU user delegation for GitHub token secret.';

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

export function isMissingDelegationError(error) {
  return /missing DPU user delegation/i.test(String(error?.message || error || ''));
}

function isSecretMissingError(error) {
  return /secret not found/i.test(String(error?.message || error || ''));
}

function isSecretAccessDeniedError(error) {
  return /access denied/i.test(String(error?.message || error || ''));
}

function isGuestAuthInfo(authInfo) {
  const roles = Array.isArray(authInfo?.user?.roles) ? authInfo.user.roles : [];
  return roles.some((role) => String(role || '').trim().toLowerCase() === 'guest');
}

function extractUserDelegationToken(authInfo, key = DEFAULT_DPU_SECRET_DELEGATION_KEY) {
  if (!authInfo || typeof authInfo !== 'object') return '';
  const configuredKey = String(process.env.PLOINKY_DPU_SECRET_DELEGATION_KEY || key || '').trim()
    || DEFAULT_DPU_SECRET_DELEGATION_KEY;
  const direct = authInfo.delegations?.[configuredKey]?.token;
  if (isNonEmptyString(direct)) return direct.trim();
  for (const entry of Object.values(authInfo.delegations || {})) {
    const token = entry?.token;
    const target = String(entry?.targetAgentId || '').trim();
    if (isNonEmptyString(token) && /\/dpuAgent$/i.test(target)) return token.trim();
  }
  return '';
}

function resolveDpuRouteName(explicitRouteName = '') {
  const explicit = String(explicitRouteName || process.env.PLOINKY_DPU_ROUTE || '').trim();
  return explicit || DEFAULT_DPU_ROUTE;
}

function resolveConsumerPrincipal() {
  const principal = String(process.env.PLOINKY_AGENT_PRINCIPAL || '').trim();
  if (principal) return principal;
  throw new Error('PLOINKY_AGENT_PRINCIPAL is required and must use canonical agent:<repo>/<agent> form.');
}

export async function loadCreateAgentClient() {
  const agentLibDir = String(process.env.PLOINKY_AGENT_LIB_DIR || '/Agent').replace(/\/+$/, '');
  const candidates = [
    `${agentLibDir}/client/AgentMcpClient.mjs`,
    new URL('../../../ploinky/Agent/client/AgentMcpClient.mjs', import.meta.url).href
  ];
  for (const candidate of candidates) {
    try {
      const mod = await import(candidate);
      if (typeof mod.createAgentClient === 'function') {
        return mod.createAgentClient;
      }
    } catch (_) {}
  }
  throw new Error('secret-store-client: unable to load Ploinky agent-to-agent client.');
}

function extractInvocationToken(authInfo) {
  if (!authInfo || typeof authInfo !== 'object') return '';
  const token = authInfo.invocationToken || authInfo.rawToken || '';
  return isNonEmptyString(token) ? token.trim() : '';
}

function safeParseJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function unwrapToolPayload(name, result) {
  const blocks = Array.isArray(result?.content) ? result.content : [];
  const jsonBlock = blocks.find((b) => b?.type === 'json');
  if (jsonBlock?.json && typeof jsonBlock.json === 'object') {
    const payload = jsonBlock.json;
    if (payload?.ok === false) throw new Error(String(payload?.message || payload?.error || `${name} failed.`));
    return payload;
  }
  const textBlock = blocks.find((b) => b?.type === 'text' && typeof b.text === 'string');
  if (textBlock?.text) {
    const parsed = safeParseJson(textBlock.text);
    if (parsed && typeof parsed === 'object') {
      if (parsed?.ok === false) throw new Error(String(parsed?.message || parsed?.error || `${name} failed.`));
      return parsed;
    }
    throw new Error(String(textBlock.text));
  }
  if (result?.structuredContent && typeof result.structuredContent === 'object') {
    if (result.structuredContent.ok === false) {
      throw new Error(String(result.structuredContent?.message || result.structuredContent?.error || `${name} failed.`));
    }
    return result.structuredContent;
  }
  throw new Error(`Invalid response for ${name}.`);
}

export function createSecretStoreClient({
  providerRouteName,
  authInfo = null,
  invocationToken = '',
  requireUserDelegation = false,
  delegationKey = DEFAULT_DPU_SECRET_DELEGATION_KEY
} = {}) {
  const dpuRouteName = resolveDpuRouteName(providerRouteName);

  async function callContractOperation(operation, args = {}) {
    const userDelegationToken = extractUserDelegationToken(authInfo, delegationKey);
    if (requireUserDelegation && !userDelegationToken) {
      throw new Error(MISSING_DELEGATION_MESSAGE);
    }
    const forwardedInvocationToken = isNonEmptyString(invocationToken)
      ? invocationToken.trim()
      : extractInvocationToken(authInfo) || undefined;
    if (!forwardedInvocationToken) {
      throw new Error('secret-store-client: missing invocation token for delegated DPU call.');
    }
    const createAgentClient = await loadCreateAgentClient();
    const client = await createAgentClient(dpuRouteName, { userDelegationToken });
    try {
      const result = await client.callTool(operation, args);
      if (result?.ok === false) {
        throw new Error(String(result?.message || result?.error || `${operation} failed.`));
      }
      if (result?.content || result?.structuredContent) {
        return unwrapToolPayload(operation, result);
      }
      return result;
    } finally {
      await client.close();
    }
  }

  return {
    get(key) {
      return callContractOperation('dpu_secret_get', { key });
    },
    put(key, value) {
      return callContractOperation('dpu_secret_put', { key, value });
    },
    delete(key) {
      return callContractOperation('dpu_secret_delete', { key });
    },
    grant(key, principal, role) {
      return callContractOperation('dpu_secret_grant', { key, principal, role });
    },
    revoke(key, principal) {
      return callContractOperation('dpu_secret_revoke', { key, principal });
    },
    list() {
      return callContractOperation('dpu_secret_list', {});
    }
  };
}

/**
 * Minimal per-call helper used by github-auth.mjs. Always creates a fresh
 * client; callers do not manage lifecycle.
 */
export async function withSecretStoreClient(fn, options = {}) {
  const client = createSecretStoreClient(options);
  return fn(client);
}

export const GIT_GITHUB_TOKEN_SECRET_KEY = 'GIT_GITHUB_TOKEN';

function normalizePrincipalPart(value) {
  const normalized = String(value || '').trim();
  return normalized || '';
}

export function resolveGitAuthPrincipal(authInfo = null) {
  if (!authInfo || typeof authInfo !== 'object') {
    return '';
  }
  const user = authInfo.user && typeof authInfo.user === 'object' ? authInfo.user : {};
  const userId = normalizePrincipalPart(user.id);
  if (userId) {
    return `user:${userId}`;
  }
  const username = normalizePrincipalPart(user.username);
  if (username) {
    return `user:${username}`;
  }
  const email = normalizePrincipalPart(user.email).toLowerCase();
  if (email && email.includes('@')) {
    return email;
  }
  const subject = normalizePrincipalPart(authInfo.invocation?.subject);
  if (subject && !/^agent:/i.test(subject)) {
    return subject;
  }
  const agentPrincipal = normalizePrincipalPart(authInfo.agent?.principalId);
  return agentPrincipal || '';
}

export function resolveGitAuthScopeSuffix(authInfo = null) {
  const principal = resolveGitAuthPrincipal(authInfo);
  if (!principal) {
    return '';
  }
  return crypto
    .createHash('sha256')
    .update(principal)
    .digest('hex')
    .slice(0, 16)
    .toUpperCase();
}

export function resolveGitTokenSecretKey({ key = GIT_GITHUB_TOKEN_SECRET_KEY, authInfo = null } = {}) {
  const normalizedKey = String(key || '').trim() || GIT_GITHUB_TOKEN_SECRET_KEY;
  if (normalizedKey !== GIT_GITHUB_TOKEN_SECRET_KEY) {
    return normalizedKey;
  }
  const suffix = resolveGitAuthScopeSuffix(authInfo);
  return suffix ? `${GIT_GITHUB_TOKEN_SECRET_KEY}_${suffix}` : GIT_GITHUB_TOKEN_SECRET_KEY;
}

function resolveTokenHelperMode(authInfo) {
  if (isGuestAuthInfo(authInfo)) return 'guest';
  const principal = resolveGitAuthPrincipal(authInfo);
  return principal && /^user:/i.test(principal) ? 'user' : 'agent';
}

/**
 * GitHub-token helpers built on the direct Git -> DPU secret client.
 */
export async function getStoredGitToken({ key = GIT_GITHUB_TOKEN_SECRET_KEY, authInfo = null } = {}) {
  const mode = resolveTokenHelperMode(authInfo);
  if (mode === 'guest') return '';
  const client = createSecretStoreClient({ authInfo, requireUserDelegation: mode === 'user' });
  try {
    const payload = await client.get(resolveGitTokenSecretKey({ key, authInfo }));
    return String(payload?.secret?.value || payload?.value || '').trim();
  } catch (error) {
    if (isMissingDelegationError(error)) throw error;
    if (isSecretMissingError(error) || isSecretAccessDeniedError(error)) return '';
    throw error;
  }
}

export async function putStoredGitToken({ token, key = GIT_GITHUB_TOKEN_SECRET_KEY, authInfo = null } = {}) {
  const value = String(token || '').trim();
  if (!value) throw new Error('Token is required.');
  if (isGuestAuthInfo(authInfo)) {
    throw new Error('GitHub token storage requires a signed-in workspace user.');
  }
  const mode = resolveTokenHelperMode(authInfo);
  const client = createSecretStoreClient({ authInfo, requireUserDelegation: mode === 'user' });
  const resolvedKey = resolveGitTokenSecretKey({ key, authInfo });
  const payload = await client.put(resolvedKey, value);
  await client.grant(resolvedKey, resolveConsumerPrincipal(), 'read');
  return payload;
}

export async function deleteStoredGitToken({ key = GIT_GITHUB_TOKEN_SECRET_KEY, authInfo = null } = {}) {
  if (isGuestAuthInfo(authInfo)) {
    throw new Error('GitHub token removal requires a signed-in workspace user.');
  }
  const mode = resolveTokenHelperMode(authInfo);
  const client = createSecretStoreClient({ authInfo, requireUserDelegation: mode === 'user' });
  const resolvedKey = resolveGitTokenSecretKey({ key, authInfo });
  try {
    return await client.delete(resolvedKey);
  } catch (error) {
    if (isMissingDelegationError(error)) throw error;
    if (isSecretMissingError(error)) return { ok: true, deleted: false };
    throw error;
  }
}

export async function grantStoredGitTokenAccess({ key = GIT_GITHUB_TOKEN_SECRET_KEY, principal, role = 'read', authInfo = null } = {}) {
  if (isGuestAuthInfo(authInfo)) {
    throw new Error('GitHub token grants require a signed-in workspace user.');
  }
  const mode = resolveTokenHelperMode(authInfo);
  const client = createSecretStoreClient({ authInfo, requireUserDelegation: mode === 'user' });
  const target = principal || resolveConsumerPrincipal();
  return client.grant(resolveGitTokenSecretKey({ key, authInfo }), target, role);
}
