import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import {
  getStoredGitToken,
  putStoredGitToken,
  deleteStoredGitToken,
  resolveGitAuthScopeSuffix
} from './secret-store-client.mjs';

const GITHUB_DEVICE_CODE_URL = 'https://github.com/login/device/code';
const GITHUB_ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GITHUB_USER_URL = 'https://api.github.com/user';
const GITHUB_EMAILS_URL = 'https://api.github.com/user/emails';
const DEFAULT_CLIENT_ID = 'Ov23liRKJjJHqo3zOOI6';
const DEFAULT_SCOPE = 'repo workflow read:user user:email';
const STATE_DIR = path.join('.data', 'gitAgent', 'github-auth');
const STATE_FILE = 'git-agent-github-auth.json';
const STATE_FILE_PREFIX = 'git-agent-github-auth';

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function resolveWorkspaceRoot(workspaceRoot) {
  return path.resolve(workspaceRoot || process.cwd());
}

export function getGithubAuthStateFilePath(workspaceRoot, authInfo = null) {
  const suffix = resolveGitAuthScopeSuffix(authInfo);
  const fileName = suffix
    ? `${STATE_FILE_PREFIX}-${suffix.toLowerCase()}.json`
    : STATE_FILE;
  return path.join(resolveWorkspaceRoot(workspaceRoot), STATE_DIR, fileName);
}

function statePathPolicyError(message) {
  const error = new Error(`GitHub auth data policy violation: ${message}`);
  error.code = 'PLOINKY_AGENT_DATA_POLICY_VIOLATION';
  error.statusCode = 422;
  return error;
}

async function resolveStateFile(workspaceRoot, filePath, { createParent = false } = {}) {
  const root = resolveWorkspaceRoot(workspaceRoot);
  if (path.dirname(filePath) !== path.join(root, STATE_DIR)) {
    throw statePathPolicyError('state files must stay inside the managed auth directory.');
  }
  if (!(await fs.stat(root)).isDirectory()) {
    throw statePathPolicyError('the workspace root must be a directory.');
  }
  let canonicalParent = await fs.realpath(root);
  let currentPath = root;
  for (const segment of STATE_DIR.split(path.sep)) {
    currentPath = path.join(currentPath, segment);
    let stats;
    try {
      stats = await fs.lstat(currentPath);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      if (!createParent) return filePath;
      await fs.mkdir(currentPath, { mode: 0o700 }).catch((mkdirError) => {
        if (mkdirError?.code !== 'EEXIST') throw mkdirError;
      });
      stats = await fs.lstat(currentPath);
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw statePathPolicyError('managed directories must be non-symlink directories.');
    }
    const canonicalPath = await fs.realpath(currentPath);
    if (canonicalPath !== path.join(canonicalParent, segment)) {
      throw statePathPolicyError('a managed directory escapes its workspace boundary.');
    }
    canonicalParent = canonicalPath;
  }
  let stats;
  try {
    stats = await fs.lstat(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return filePath;
    throw error;
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw statePathPolicyError('state and temporary files must be non-symlink regular files.');
  }
  if (await fs.realpath(filePath) !== path.join(canonicalParent, path.basename(filePath))) {
    throw statePathPolicyError('a state file escapes its workspace boundary.');
  }
  return filePath;
}

async function readJsonFile(workspaceRoot, filePath, fallback) {
  await resolveStateFile(workspaceRoot, filePath);
  try {
    const raw = await fs.readFile(filePath, {
      encoding: 'utf8',
      flag: fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW
    });
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch (error) {
    if (error?.code === 'ELOOP') throw statePathPolicyError('state files must not be symbolic links.');
    if (error?.code === 'ENOENT' || error instanceof SyntaxError) return fallback;
    throw error;
  }
}

async function writeJsonFile(workspaceRoot, filePath, value) {
  await resolveStateFile(workspaceRoot, filePath, { createParent: true });
  const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await resolveStateFile(workspaceRoot, tempPath);
  try {
    await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      flag: fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      mode: 0o600
    });
  } catch (error) {
    if (error?.code === 'ELOOP' || error?.code === 'EEXIST') {
      throw statePathPolicyError('temporary files must be newly created, non-symlink files.');
    }
    throw error;
  }
  await resolveStateFile(workspaceRoot, filePath);
  await resolveStateFile(workspaceRoot, tempPath);
  await fs.rename(tempPath, filePath);
}

async function getGithubSetup() {
  return {
    configured: true,
    clientId: DEFAULT_CLIENT_ID,
    scope: DEFAULT_SCOPE
  };
}

function sanitizePending(pending) {
  if (!pending || typeof pending !== 'object') {
    return null;
  }
  if (!isNonEmptyString(pending.deviceCode) && !isNonEmptyString(pending.userCode)) {
    return null;
  }
  const expiresAt = Number.isFinite(Number(pending.expiresAt)) ? Number(pending.expiresAt) : 0;
  if (expiresAt && expiresAt <= Date.now()) {
    return null;
  }
  return {
    deviceCode: isNonEmptyString(pending.deviceCode) ? pending.deviceCode.trim() : '',
    userCode: isNonEmptyString(pending.userCode) ? pending.userCode.trim() : '',
    verificationUri: isNonEmptyString(pending.verificationUri) ? pending.verificationUri.trim() : 'https://github.com/login/device',
    verificationUriComplete: isNonEmptyString(pending.verificationUriComplete) ? pending.verificationUriComplete.trim() : '',
    interval: Math.max(5, Number.parseInt(String(pending.interval || '5'), 10) || 5),
    expiresAt,
    createdAt: Number.isFinite(Number(pending.createdAt)) ? Number(pending.createdAt) : Date.now()
  };
}

function sanitizeUser(user = {}) {
  return {
    id: Number.isFinite(Number(user.id)) ? Number(user.id) : null,
    login: isNonEmptyString(user.login) ? user.login.trim() : '',
    name: isNonEmptyString(user.name) ? user.name.trim() : '',
    email: isNonEmptyString(user.email) ? user.email.trim() : '',
    avatarUrl: isNonEmptyString(user.avatarUrl) ? user.avatarUrl.trim() : '',
    profileUrl: isNonEmptyString(user.profileUrl) ? user.profileUrl.trim() : ''
  };
}

function sanitizeConnection(connection) {
  if (!connection || typeof connection !== 'object') {
    return null;
  }
  return {
    provider: 'github',
    accessToken: '',
    tokenType: isNonEmptyString(connection.tokenType) ? connection.tokenType.trim() : 'bearer',
    scope: isNonEmptyString(connection.scope) ? connection.scope.trim() : '',
    source: isNonEmptyString(connection.source) ? connection.source.trim() : 'github',
    user: sanitizeUser(connection.user || {}),
    connectedAt: Number.isFinite(Number(connection.connectedAt)) ? Number(connection.connectedAt) : Date.now(),
    updatedAt: Number.isFinite(Number(connection.updatedAt)) ? Number(connection.updatedAt) : Date.now()
  };
}

function stripAccessToken(connection) {
  if (!connection) {
    return null;
  }
  const { accessToken, ...rest } = connection;
  return rest;
}

async function loadState(workspaceRoot, authInfo = null) {
  const state = await readJsonFile(workspaceRoot, getGithubAuthStateFilePath(workspaceRoot, authInfo), {});
  const pending = sanitizePending(state.pending);
  const connection = sanitizeConnection(state.connection);
  const nextState = {
    pending,
    connection
  };
  if (
    state?.pending !== nextState.pending
    || state?.connection !== nextState.connection
  ) {
    await saveState(workspaceRoot, nextState, authInfo);
  }
  return nextState;
}

async function saveState(workspaceRoot, state, authInfo = null) {
  await writeJsonFile(workspaceRoot, getGithubAuthStateFilePath(workspaceRoot, authInfo), {
    pending: sanitizePending(state?.pending),
    connection: sanitizeConnection(state?.connection)
  });
}

function buildStatusPayload(setup, state, extras = {}) {
  const pending = sanitizePending(state?.pending);
  const connection = sanitizeConnection(state?.connection);
  const tokenStored = Boolean(extras?.tokenStored);
  const hasProfile = Boolean(connection && (connection.user?.login || connection.user?.name || connection.scope || connection.source));
  const connected = tokenStored && hasProfile;

  return {
    ok: true,
    configured: Boolean(setup?.configured),
    connected,
    tokenStored,
    connection: stripAccessToken(connection),
    pending: pending
      ? {
          userCode: pending.userCode,
          verificationUri: pending.verificationUri,
          verificationUriComplete: pending.verificationUriComplete,
          interval: pending.interval,
          expiresAt: pending.expiresAt
        }
      : null,
    setup: {
      configured: Boolean(setup?.configured),
      scope: setup?.scope || DEFAULT_SCOPE
    },
    ...extras
  };
}

async function postGitHubForm(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams(body)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = payload?.error_description || payload?.error || `GitHub request failed (${response.status})`;
    throw new Error(String(detail));
  }
  return payload;
}

async function fetchGitHubJson(url, token) {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'ploinky-git-agent'
    }
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(text || `GitHub API request failed (${response.status})`);
  }
  return response.json();
}

export async function fetchGithubUserProfile(accessToken) {
  const [userPayload, emailsPayload] = await Promise.all([
    fetchGitHubJson(GITHUB_USER_URL, accessToken),
    fetchGitHubJson(GITHUB_EMAILS_URL, accessToken).catch(() => [])
  ]);
  const primaryEmail = Array.isArray(emailsPayload)
    ? emailsPayload.find((entry) => entry?.primary && entry?.verified)?.email
        || emailsPayload.find((entry) => entry?.verified)?.email
        || emailsPayload.find((entry) => entry?.email)?.email
        || ''
    : '';
  return sanitizeUser({
    id: userPayload?.id,
    login: userPayload?.login,
    name: userPayload?.name || userPayload?.login || '',
    email: userPayload?.email || primaryEmail || '',
    avatarUrl: userPayload?.avatar_url || '',
    profileUrl: userPayload?.html_url || ''
  });
}

export async function getGithubAuthStatus({ workspaceRoot, authInfo } = {}) {
  const setup = await getGithubSetup(workspaceRoot);
  const state = await loadState(workspaceRoot, authInfo);
  const storedToken = await getStoredGitToken({ workspaceRoot, authInfo });

  // Sync state: if we think we are connected but DPU has no token, clear the local profile.
  if (state.connection && !storedToken) {
    state.connection = null;
    await saveState(workspaceRoot, state, authInfo);
  }

  const nextState = state?.connection
    ? { ...state, connection: { ...state.connection, accessToken: storedToken } }
    : state;
  return buildStatusPayload(setup, nextState, { tokenStored: Boolean(storedToken) });
}

export async function beginGithubDeviceFlow({ workspaceRoot, authInfo } = {}) {
  const setup = await getGithubSetup(workspaceRoot);
  if (!setup.configured) {
    return {
      ok: false,
      message: 'GitHub device flow is not configured.'
    };
  }

  const state = await loadState(workspaceRoot, authInfo);
  const storedToken = await getStoredGitToken({ workspaceRoot, authInfo });
  const connectionSource = String(state?.connection?.source || '').trim().toLowerCase();
  const hasGithubConnection = Boolean(state.connection && connectionSource === 'github' && storedToken);
  if (hasGithubConnection) {
    return buildStatusPayload(setup, {
      ...state,
      connection: { ...state.connection, accessToken: storedToken }
    }, { tokenStored: Boolean(storedToken) });
  }

  const currentPending = sanitizePending(state.pending);
  if (currentPending) {
    return buildStatusPayload(setup, { ...state, pending: currentPending }, { tokenStored: Boolean(storedToken) });
  }

  const payload = await postGitHubForm(GITHUB_DEVICE_CODE_URL, {
    client_id: setup.clientId,
    scope: setup.scope
  });

  const nextState = {
    pending: sanitizePending({
      deviceCode: payload.device_code,
      userCode: payload.user_code,
      verificationUri: payload.verification_uri || 'https://github.com/login/device',
      verificationUriComplete: payload.verification_uri_complete || '',
      interval: payload.interval,
      expiresAt: Date.now() + (Number(payload.expires_in || 900) * 1000),
      createdAt: Date.now()
    }),
    connection: null
  };

  await saveState(workspaceRoot, nextState, authInfo);
  return buildStatusPayload(setup, nextState, { tokenStored: Boolean(storedToken) });
}

export async function pollGithubDeviceFlow({ workspaceRoot, authInfo } = {}) {
  const setup = await getGithubSetup(workspaceRoot);
  if (!setup.configured) {
    return {
      ok: false,
      message: 'GitHub device flow is not configured.'
    };
  }

  const state = await loadState(workspaceRoot, authInfo);
  const pending = sanitizePending(state.pending);
  const storedToken = await getStoredGitToken({ workspaceRoot, authInfo });

  if (state.connection && !pending && storedToken) {
    return buildStatusPayload(setup, {
      ...state,
      connection: { ...state.connection, accessToken: storedToken }
    }, { tokenStored: Boolean(storedToken) });
  }

  if (!pending) {
    return buildStatusPayload(setup, state, { tokenStored: Boolean(storedToken) });
  }

  const payload = await postGitHubForm(GITHUB_ACCESS_TOKEN_URL, {
    client_id: setup.clientId,
    device_code: pending.deviceCode,
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
  }).catch((error) => ({ error: error?.message || String(error) }));

  const rawError = String(payload?.error || '').trim();
  if (rawError) {
    if (rawError === 'authorization_pending') {
      return buildStatusPayload(setup, state, { tokenStored: Boolean(storedToken) });
    }
    if (rawError === 'slow_down') {
      const nextPending = {
        ...pending,
        interval: Math.max(
          pending.interval + 5,
          Number.parseInt(String(payload?.interval || '0'), 10) || 0
        )
      };
      const nextState = { ...state, pending: nextPending };
      await saveState(workspaceRoot, nextState, authInfo);
      return buildStatusPayload(setup, nextState, { tokenStored: Boolean(storedToken) });
    }
    if (rawError === 'expired_token' || rawError === 'access_denied' || rawError === 'incorrect_device_code') {
      const nextState = { pending: null, connection: null };
      await saveState(workspaceRoot, nextState, authInfo);
      return buildStatusPayload(setup, nextState, { tokenStored: false });
    }
    // No error_description means GitHub did not respond with a structured
    // OAuth error — almost certainly a transport-level failure (TypeError:
    // fetch failed, DNS, TLS, timeout). Treat it the same way the
    // expired_token / access_denied branch above does: reset to a clean
    // state and return a successful status payload. The FE's pollGithubAuth
    // success path will see no pending and auto-trigger a fresh
    // ensureGithubDeviceFlow. Returning ok:false here would have ensureSuccess
    // throw the message, the FE would catch it via applyGithubAuthError, set
    // pending:null AND error:<msg>, and stop polling — leaving "fetch failed"
    // pinned in the UI until manual intervention.
    if (!payload?.error_description) {
      const nextState = { pending: null, connection: null };
      await saveState(workspaceRoot, nextState, authInfo);
      return buildStatusPayload(setup, nextState, { tokenStored: false });
    }
    return {
      ok: false,
      message: payload?.error_description || rawError || 'GitHub device authorization failed.'
    };
  }

  const accessToken = String(payload?.access_token || '').trim();
  if (!accessToken) {
    return buildStatusPayload(setup, state);
  }

  const user = await fetchGithubUserProfile(accessToken);
  const now = Date.now();
  const nextState = {
    pending: null,
    connection: sanitizeConnection({
      provider: 'github',
      accessToken: '',
      tokenType: payload?.token_type || 'bearer',
      scope: payload?.scope || setup.scope,
      source: 'github',
      user,
      connectedAt: state.connection?.connectedAt || now,
      updatedAt: now
    })
  };

  await resolveStateFile(workspaceRoot, getGithubAuthStateFilePath(workspaceRoot, authInfo));
  await putStoredGitToken({ workspaceRoot, authInfo, token: accessToken });
  await saveState(workspaceRoot, nextState, authInfo);
  return buildStatusPayload(setup, nextState, { tokenStored: true });
}

export async function disconnectGithubAuth({ workspaceRoot, authInfo } = {}) {
  await resolveStateFile(workspaceRoot, getGithubAuthStateFilePath(workspaceRoot, authInfo));
  const setup = await getGithubSetup(workspaceRoot);
  const nextState = {
    pending: null,
    connection: null
  };
  await deleteStoredGitToken({ workspaceRoot, authInfo });
  await saveState(workspaceRoot, nextState, authInfo);
  return buildStatusPayload(setup, nextState, { tokenStored: false });
}

// Non-secret profile of the stored GitHub connection (login, name, email); null when there is none.
export async function getGithubConnectionUser({ workspaceRoot, authInfo } = {}) {
  const state = await readJsonFile(workspaceRoot, getGithubAuthStateFilePath(workspaceRoot, authInfo), {});
  const connection = sanitizeConnection(state.connection);
  return connection ? { source: connection.source, user: connection.user } : null;
}

export async function getGithubAuthAccessToken({ workspaceRoot, authInfo } = {}) {
  return getStoredGitToken({ workspaceRoot, authInfo });
}

export async function storeManualGitAuthToken({ workspaceRoot, authInfo, token } = {}) {
  const clean = String(token || '').trim();
  if (!clean) {
    throw new Error('Token is required.');
  }
  await resolveStateFile(workspaceRoot, getGithubAuthStateFilePath(workspaceRoot, authInfo));
  await putStoredGitToken({ workspaceRoot, authInfo, token: clean });
  const setup = await getGithubSetup(workspaceRoot);
  const state = await loadState(workspaceRoot, authInfo);
  const nextState = {
    ...state,
    pending: null,
    connection: sanitizeConnection({
      provider: 'github',
      accessToken: '',
      tokenType: 'bearer',
      scope: '',
      source: 'token',
      user: {},
      connectedAt: state.connection?.connectedAt || Date.now(),
      updatedAt: Date.now()
    })
  };
  await saveState(workspaceRoot, nextState, authInfo);
  return buildStatusPayload(setup, nextState, { tokenStored: true });
}
