import { getStoredGitToken, loadCreateAgentClient } from './secret-store-client.mjs';
import { getGithubConnectionUser, fetchGithubUserProfile } from './github-auth.mjs';

/**
 * robot-credentials.mjs
 *
 * Proxies the RoboTeam robot git credential tools for the calling workspace user:
 *
 *   git_robot_credentials_targets -> robot_git_credentials_targets
 *   git_robot_credentials_save    -> robot_git_credentials_save (token read here from DPU)
 *   git_robot_credentials_delete  -> robot_git_credentials_delete
 *
 * RoboTeam owns the ownership/administrator rules. This module only forwards the verified user's
 * delegation, reads the user's own GitHub token from DPU for a save, and maps every outcome to a
 * structured `{ ok, code, message }` result. The token is passed once to RoboTeam and never returned,
 * logged or placed in a message.
 */

const DEFAULT_ROBOTEAM_ROUTE = 'roboTeamAgent';
export const ROBOTEAM_DELEGATION_KEY = 'roboTeamGitCredentials';

export const ROBOT_CREDENTIAL_CODES = Object.freeze({
    occupied: 'ROBOT_CREDENTIALS_OCCUPIED',
    forbidden: 'ROBOT_CREDENTIALS_FORBIDDEN',
    invalid: 'ROBOT_CREDENTIALS_INVALID',
    notFound: 'ROBOT_NOT_FOUND',
    unavailable: 'ROBOTEAM_UNAVAILABLE',
    signInRequired: 'GIT_SIGN_IN_REQUIRED',
    tokenMissing: 'GIT_TOKEN_MISSING',
    githubLoginUnknown: 'GITHUB_LOGIN_UNKNOWN',
    failed: 'ROBOT_CREDENTIALS_FAILED'
});

const KNOWN_ROBOTEAM_CODES = new Set([
    ROBOT_CREDENTIAL_CODES.occupied,
    ROBOT_CREDENTIAL_CODES.forbidden,
    ROBOT_CREDENTIAL_CODES.invalid,
    ROBOT_CREDENTIAL_CODES.notFound
]);

const UNAVAILABLE_MESSAGE = 'RoboTeam is not available, so git credentials cannot be saved to a robot right now.';

function text(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function isGuest(authInfo) {
    const roles = Array.isArray(authInfo?.user?.roles) ? authInfo.user.roles : [];
    return roles.some((role) => String(role || '').trim().toLowerCase() === 'guest');
}

function hasWorkspaceUser(authInfo) {
    return Boolean(text(authInfo?.user?.id) || text(authInfo?.user?.username)) && !isGuest(authInfo);
}

export function extractRoboTeamDelegationToken(authInfo, key = ROBOTEAM_DELEGATION_KEY) {
    const delegations = authInfo?.delegations && typeof authInfo.delegations === 'object' ? authInfo.delegations : {};
    const direct = text(delegations[key]?.token);
    if (direct) return direct;
    for (const entry of Object.values(delegations)) {
        const target = text(entry?.targetAgentId);
        const token = text(entry?.token);
        if (token && /\/roboTeamAgent$/i.test(target)) return token;
    }
    return '';
}

function resolveRoboTeamRoute() {
    return text(process.env.PLOINKY_ROBOTEAM_ROUTE) || DEFAULT_ROBOTEAM_ROUTE;
}

function failure(code, message, extra = {}) {
    return { ok: false, code, message, ...extra };
}

// Removes every occurrence of the secret from a message, in case a downstream error echoed it.
function redact(message, secret) {
    const value = String(message || '');
    return secret ? value.split(secret).join('[redacted]') : value;
}

function safeParseJson(raw) {
    try { return JSON.parse(raw); } catch { return null; }
}

// Reads the JSON payload of an MCP tool result in any of the shapes AgentServer produces.
export function readToolPayload(result) {
    if (!result || typeof result !== 'object') return null;
    const blocks = Array.isArray(result.content) ? result.content : [];
    const jsonBlock = blocks.find((block) => block?.type === 'json' && block.json && typeof block.json === 'object');
    if (jsonBlock) return { payload: jsonBlock.json, isError: Boolean(result.isError) };
    if (result.structuredContent && typeof result.structuredContent === 'object') {
        return { payload: result.structuredContent, isError: Boolean(result.isError) };
    }
    const textBlock = blocks.find((block) => block?.type === 'text' && typeof block.text === 'string');
    if (textBlock) {
        const parsed = safeParseJson(textBlock.text);
        if (parsed && typeof parsed === 'object') return { payload: parsed, isError: Boolean(result.isError) };
        return { payload: { ok: !result.isError, message: textBlock.text }, isError: Boolean(result.isError) };
    }
    if (!Array.isArray(result.content)) return { payload: result, isError: Boolean(result.isError) };
    return null;
}

function codeFromText(message) {
    for (const code of KNOWN_ROBOTEAM_CODES) {
        if (message.includes(code)) return code;
    }
    if (/already holds git credentials/i.test(message)) return ROBOT_CREDENTIAL_CODES.occupied;
    if (/^robot .+ was not found$/i.test(message)) return ROBOT_CREDENTIAL_CODES.notFound;
    return '';
}

// Maps a RoboTeam error payload or thrown error to a structured failure.
// AgentServer turns a failed RoboTeam tool into an MCP error whose message is the tool's stderr envelope,
// e.g. `MCP error -32603: {"ok":false,"code":"ROBOT_CREDENTIALS_OCCUPIED",...}`; recover that envelope.
function embeddedFailureEnvelope(source) {
    if (!(source instanceof Error)) return null;
    const message = String(source.message || '');
    const start = message.indexOf('{');
    const end = message.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    const parsed = safeParseJson(message.slice(start, end + 1));
    return parsed && typeof parsed === 'object' && parsed.ok === false ? parsed : null;
}

export function mapRoboTeamFailure(source, secret = '') {
    const embedded = embeddedFailureEnvelope(source);
    if (embedded) return mapRoboTeamFailure(embedded, secret);
    const payload = source && typeof source === 'object' ? source : {};
    const nested = payload.error && typeof payload.error === 'object' ? payload.error : null;
    const rawMessage = text(nested?.message) || text(typeof payload.error === 'string' ? payload.error : '')
        || text(payload.message) || text(String(source instanceof Error ? source.message : ''));
    const message = redact(rawMessage, secret);
    const declaredCode = text(nested?.code) || text(payload.code) || text(payload.data?.code);
    const statusCode = Number(payload.statusCode || nested?.statusCode || 0);
    let code = KNOWN_ROBOTEAM_CODES.has(declaredCode) ? declaredCode : codeFromText(message);
    if (!code) {
        const unavailable = declaredCode === 'TARGET_INACTIVE'
            || declaredCode === 'ROBOWORK_UNAVAILABLE'
            || statusCode === 502 || statusCode === 503 || statusCode === 504 || statusCode === 404
            || /ECONNREFUSED|fetch failed|inactive|not installed|unable to load ploinky agent-to-agent client|no route/i.test(message);
        if (unavailable) return failure(ROBOT_CREDENTIAL_CODES.unavailable, UNAVAILABLE_MESSAGE, { available: false });
        if (statusCode === 409) code = ROBOT_CREDENTIAL_CODES.occupied;
        else if (statusCode === 403) code = ROBOT_CREDENTIAL_CODES.forbidden;
    }
    return failure(code || ROBOT_CREDENTIAL_CODES.failed, message || 'The robot credential request failed.');
}

async function callRoboTeam(toolName, args, { authInfo, createAgentClient, secret = '' }) {
    const userDelegationToken = extractRoboTeamDelegationToken(authInfo);
    if (!userDelegationToken) {
        return failure(ROBOT_CREDENTIAL_CODES.unavailable, UNAVAILABLE_MESSAGE, { available: false });
    }
    let client = null;
    try {
        const factory = createAgentClient || await loadCreateAgentClient();
        client = await factory(resolveRoboTeamRoute(), { userDelegationToken });
        const read = readToolPayload(await client.callTool(toolName, args));
        if (!read) return failure(ROBOT_CREDENTIAL_CODES.failed, 'RoboTeam returned an invalid response.');
        if (read.isError || read.payload?.ok === false) return mapRoboTeamFailure(read.payload, secret);
        return { ok: true, payload: read.payload };
    } catch (error) {
        return mapRoboTeamFailure(error, secret);
    } finally {
        if (client && typeof client.close === 'function') {
            await client.close().catch(() => {});
        }
    }
}

function normalizeSavedBy(value) {
    const savedBy = value && typeof value === 'object' ? value : {};
    return { id: text(String(savedBy.id ?? '')), username: text(savedBy.username) };
}

function normalizeCredentials(value) {
    const credentials = value && typeof value === 'object' ? value : {};
    if (credentials.configured !== true) return { configured: false };
    return {
        configured: true,
        readable: credentials.readable !== false,
        githubLogin: text(credentials.githubLogin),
        savedBy: normalizeSavedBy(credentials.savedBy),
        savedAt: text(credentials.savedAt)
    };
}

function normalizeRobotReference(value) {
    const robot = value && typeof value === 'object' ? value : {};
    return { id: text(String(robot.id ?? '')), name: text(robot.name), isDefault: robot.isDefault === true };
}

// Only the documented non-secret fields leave this module.
function normalizeMetadata(value) {
    if (!value || typeof value !== 'object') return null;
    return {
        host: text(value.host) || 'github.com',
        githubLogin: text(value.githubLogin),
        name: text(value.name),
        email: text(value.email),
        savedBy: normalizeSavedBy(value.savedBy),
        savedAt: text(value.savedAt)
    };
}

export async function listRobotCredentialTargets({ authInfo, createAgentClient } = {}) {
    if (!hasWorkspaceUser(authInfo)) {
        return failure(ROBOT_CREDENTIAL_CODES.signInRequired, 'Saving git credentials to a robot requires a signed-in workspace user.', { available: false });
    }
    const response = await callRoboTeam('robot_git_credentials_targets', {}, { authInfo, createAgentClient });
    if (!response.ok) return response;
    const payload = response.payload || {};
    const robots = (Array.isArray(payload.robots) ? payload.robots : [])
        .map((robot) => ({ ...normalizeRobotReference(robot), credentials: normalizeCredentials(robot?.credentials) }))
        .filter((robot) => robot.name);
    return {
        ok: true,
        available: true,
        robots,
        canAdmin: payload.canAdmin === true,
        userId: text(String(payload.userId ?? ''))
    };
}

async function resolveGithubIdentity({ workspaceRoot, authInfo, token, name, email, getConnectionUser, fetchProfile }) {
    const connection = await getConnectionUser({ workspaceRoot, authInfo }).catch(() => null);
    let user = connection?.user || {};
    if (!text(user.login)) {
        // A manual token has no stored profile; ask GitHub which account the token belongs to.
        user = await fetchProfile(token).catch(() => ({}));
    }
    return {
        githubLogin: text(user.login),
        name: text(name) || text(user.name) || text(user.login),
        email: text(email) || text(user.email)
    };
}

export async function saveRobotCredentials({
    authInfo,
    workspaceRoot,
    robotName,
    name = '',
    email = '',
    createAgentClient,
    readStoredToken = getStoredGitToken,
    getConnectionUser = getGithubConnectionUser,
    fetchProfile = fetchGithubUserProfile
} = {}) {
    const robot = text(robotName);
    if (!robot) return failure(ROBOT_CREDENTIAL_CODES.invalid, 'Choose a robot.');
    if (!hasWorkspaceUser(authInfo)) {
        return failure(ROBOT_CREDENTIAL_CODES.signInRequired, 'Saving git credentials to a robot requires a signed-in workspace user.');
    }
    let token = '';
    try {
        token = text(await readStoredToken({ authInfo }));
    } catch {
        return failure(ROBOT_CREDENTIAL_CODES.tokenMissing, 'Your GitHub token could not be read from secure storage. Sign in to GitHub again.');
    }
    if (!token) {
        return failure(ROBOT_CREDENTIAL_CODES.tokenMissing, 'No GitHub token is stored for you. Sign in to GitHub or save a token first.');
    }
    const identity = await resolveGithubIdentity({ workspaceRoot, authInfo, token, name, email, getConnectionUser, fetchProfile });
    if (!identity.githubLogin) {
        return failure(ROBOT_CREDENTIAL_CODES.githubLoginUnknown, 'GitHub did not confirm which account the stored token belongs to. Check that the token is valid.');
    }
    const response = await callRoboTeam('robot_git_credentials_save', {
        robotName: robot,
        token,
        githubLogin: identity.githubLogin,
        name: identity.name,
        email: identity.email
    }, { authInfo, createAgentClient, secret: token });
    if (!response.ok) return response;
    const payload = response.payload || {};
    return {
        ok: true,
        robot: normalizeRobotReference(payload.robot || { name: robot }),
        metadata: normalizeMetadata(payload.metadata)
    };
}

export async function deleteRobotCredentials({ authInfo, robotName, createAgentClient } = {}) {
    const robot = text(robotName);
    if (!robot) return failure(ROBOT_CREDENTIAL_CODES.invalid, 'Choose a robot.');
    if (!hasWorkspaceUser(authInfo)) {
        return failure(ROBOT_CREDENTIAL_CODES.signInRequired, 'Removing robot git credentials requires a signed-in workspace user.');
    }
    const response = await callRoboTeam('robot_git_credentials_delete', { robotName: robot }, { authInfo, createAgentClient });
    if (!response.ok) return response;
    const payload = response.payload || {};
    return {
        ok: true,
        robot: normalizeRobotReference(payload.robot || { name: robot }),
        deleted: payload.deleted !== false
    };
}
