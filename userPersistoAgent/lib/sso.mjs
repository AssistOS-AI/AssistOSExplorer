import { randomUUID } from 'node:crypto';
import { getStore, flush, commitStagedPersistence } from './store.mjs';
import { withPersistenceScope } from './persistence-scope.mjs';
import { getUserById, getUserRoles } from './users.mjs';
import { getUserCapabilities } from './authorization.mjs';
import { recordAudit } from './audit.mjs';
import { assertRedirectUriAllowed } from './policy.mjs';
import { serialize } from './serial.mjs';

const REQUEST_TTL_MS = 5 * 60 * 1000;
const CODE_TTL_MS = 2 * 60 * 1000;

// Caller-supplied login requests and handoff codes that are unknown, expired,
// mismatched, or already consumed are client errors, never internal failures.
function ssoError(code, message, statusCode = 400) {
    return Object.assign(new Error(message), { code, statusCode });
}

export async function createLoginRequest({ redirectUri, clientId = 'explorer' }) {
    const allowedRedirectUri = await assertRedirectUriAllowed(redirectUri);
    const store = await getStore();
    const providerState = randomUUID();
    const expiresAt = new Date(Date.now() + REQUEST_TTL_MS).toISOString();
    await store.createSsoLoginRequest({
        providerState,
        redirectUri: allowedRedirectUri,
        clientId: String(clientId || 'explorer'),
        expiresAt
    });
    await flush();
    return { providerState, expiresAt };
}

export function issueAuthCode({ providerState, userId = '', resolveUserId = null }) {
    const normalizedState = String(providerState || '');
    return serialize(`sso-request:${normalizedState}`, () => issueAuthCodeLocked({ providerState: normalizedState, userId, resolveUserId }));
}

export async function getLoginRequest(providerState) {
    const store = await getStore();
    const request = await store.getSsoLoginRequestByProviderState(String(providerState || ''));
    if (!request) throw ssoError('login_request_invalid', 'Unknown or expired login request');
    if (Date.parse(request.expiresAt) <= Date.now()) throw ssoError('login_request_expired', 'Login request expired');
    await assertRedirectUriAllowed(request.redirectUri);
    return request;
}

// Trusted domain callers must hold sso-request:<providerState> before entering.
export async function issueAuthCodeLocked({ providerState, userId = '', resolveUserId = null }) {
    const normalizedState = String(providerState || '');
    await getLoginRequest(normalizedState);
    const resolvedUserId = typeof resolveUserId === 'function' ? await resolveUserId() : userId;
    return withPersistenceScope(async () => {
        const store = await getStore();
        const request = await getLoginRequest(normalizedState);
        await describeUser(resolvedUserId);
        return commitStagedPersistence(async () => {
            const code = randomUUID();
            await store.createSsoAuthCode({
                code,
                providerState: normalizedState,
                userId: resolvedUserId,
                expiresAt: new Date(Date.now() + CODE_TTL_MS).toISOString(),
                consumedAt: ''
            });
            await store.deleteSsoLoginRequest(request.id);
            return { code, redirectUri: request.redirectUri };
        });
    });
}

async function describeUser(userId) {
    const user = await getUserById(userId);
    if (!user) {
        throw ssoError('user_not_found', 'Unknown user', 404);
    }
    if (user.status !== 'active') {
        throw ssoError('user_not_active', 'User is not active', 403);
    }
    const roles = await getUserRoles(userId);
    const capabilities = await getUserCapabilities(userId);
    const { passwordHash, loginAttempts, lastLoginAttempt, ...safeUser } = user;
    return { user: safeUser, roles, capabilities };
}

export async function consumeAuthCode({ providerState, code }) {
    return serialize(`sso-code:${String(code || '')}`, async () => {
        const store = await getStore();
        const normalizedCode = String(code || '');
        if (!(await store.hasSsoAuthCode(normalizedCode))) throw ssoError('auth_code_invalid', 'Invalid auth code');
        const record = await store.getSsoAuthCodeByCode(normalizedCode);
        if (record.providerState !== providerState) throw ssoError('auth_code_invalid', 'Invalid auth code');
        if (record.consumedAt) throw ssoError('auth_code_consumed', 'Auth code already consumed');
        if (new Date(record.expiresAt).getTime() < Date.now()) throw ssoError('auth_code_expired', 'Auth code expired');
        await store.updateSsoAuthCode(record.id, { consumedAt: new Date().toISOString() });
        await flush();
        const described = await describeUser(record.userId);
        await recordAudit({ actorId: record.userId, action: 'auth.sso.consume', target: providerState, result: 'ok' });
        await flush();
        return described;
    });
}

export async function getSsoUser(userId) {
    return describeUser(userId);
}
