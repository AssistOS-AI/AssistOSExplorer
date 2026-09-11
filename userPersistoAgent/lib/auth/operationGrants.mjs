import { createHash, randomBytes } from 'node:crypto';
import { getStore, commitStagedPersistence } from '../store.mjs';
import { serializePersisted } from '../serial.mjs';
import { recordAudit } from '../audit.mjs';
import { getAuthPolicy } from '../policy.mjs';
import { authGenerationOf, getUserById, hasVerifiedMailbox } from '../users.mjs';
import { sendAuthCode } from '../email-agent-client.mjs';
import { attemptError } from './emailAttempts.mjs';
import { cancelAccountCode, checkAccountCode, sendAccountCode } from './accountCodes.mjs';
import { administratorPasswordUsableFor, assertAdministratorPasswordProof, verifyAdministratorPassword } from './adminPassword.mjs';
import * as passkey from './passkey.mjs';
import * as totp from './totp.mjs';
import { getGoogleStatus, GOOGLE_ISSUER } from './google.mjs';
import { googleIdentityKey } from '../externalIdentities.mjs';

// Sensitive My Account operations need fresh, explicit re-authentication. A
// successful proof yields a single-use grant bound to the account, the one
// operation it authorizes and the account generation, valid for five minutes.
// An old session alone, or a grant for another operation, cannot enroll.
export const GRANT_OPERATIONS = new Set(['passkey.register', 'totp.enroll', 'contact.verify']);
const REAUTH_METHODS = ['emailCode', 'passkey', 'totp', 'adminPassword'];
const GRANT_TTL_MS = 5 * 60 * 1000;
const GRANT_TOKEN = /^[A-Za-z0-9_-]{43}$/;

function grantError(code, statusCode = 400) {
    const messages = {
        operation_grant_required: 'Confirm it is you before changing sign-in methods.',
        reauthentication_unavailable: 'That confirmation method is not available for this account.',
        verified_email_required: 'Verify a sign-in email first.',
        sign_in_email_exists: 'This account already has a verified sign-in email.',
        authentication_failed: 'Unable to confirm it is you.',
        invalid_operation: 'Unsupported account operation.',
    };
    return Object.assign(new Error(messages[code] || 'Unable to continue.'), { code, statusCode });
}

function grantKey(token) {
    return `grant:${createHash('sha256').update(`userpersisto:operation-grant:${token}`).digest('hex')}`;
}

function assertOperation(operation) {
    if (!GRANT_OPERATIONS.has(operation)) throw grantError('invalid_operation');
    return operation;
}

async function activeUser(userId) {
    const user = await getUserById(userId);
    if (!user || user.status !== 'active') throw Object.assign(new Error('Account is not active.'), { code: 'user_not_active', statusCode: 403 });
    return user;
}

// Passkey and authenticator sign-in are reached through the account's sign-in
// email, so they are enrolled only once a verified mailbox exists. Contact
// verification exists only for an account without one (no email replacement).
export function assertOperationAllowed(user, operation) {
    if ((operation === 'passkey.register' || operation === 'totp.enroll') && !hasVerifiedMailbox(user)) {
        throw grantError('verified_email_required', 409);
    }
    if (operation === 'contact.verify' && hasVerifiedMailbox(user)) throw grantError('sign_in_email_exists', 409);
}

export async function reauthenticationMethods(user) {
    const policy = await getAuthPolicy();
    const enabled = policy.enabledAuthMethods;
    const credentials = await (await getStore()).getAuthMethodsObjectsByUserId(user.id) || [];
    const methods = [];
    if (enabled.includes('emailCode') && hasVerifiedMailbox(user)) methods.push('emailCode');
    for (const type of ['passkey', 'totp']) {
        if (user.email && enabled.includes(type) && credentials.some((method) => method.enabled && method.type === type)) methods.push(type);
    }
    if ((await getGoogleStatus()).available) {
        const bindings = await (await getStore()).getExternalIdentitiesObjectsByUserId(user.id) || [];
        if (bindings.some((binding) => binding.issuer === GOOGLE_ISSUER && binding.subject)) methods.push('google');
    }
    if (await administratorPasswordUsableFor(user.id)) methods.push('adminPassword');
    return methods;
}

// Google confirmation is a separate authenticated transaction. The ordinary
// proof endpoint deliberately cannot issue a grant merely for method=google.
export async function googleReauthenticationAccount({ userId, operation, generation }) {
    assertOperation(operation);
    const user = await activeUser(userId);
    assertOperationAllowed(user, operation);
    if (!(await reauthenticationMethods(user)).includes('google')
        || (generation !== undefined && generation !== authGenerationOf(user))) {
        throw grantError('reauthentication_unavailable', 409);
    }
    return user;
}

export function completeGoogleReauthentication({ userId, operation, transaction, prepareCompletion }) {
    return serializePersisted('users', async () => {
        const { payload, expiresAt } = transaction;
        if (payload?.flow !== 'reauth' || payload.parent.userId !== userId || payload.parent.operation !== operation
            || expiresAt <= Date.now()) throw grantError('authentication_failed', 401);
        const user = await googleReauthenticationAccount({ userId, operation, generation: payload.parent.generation });
        const identity = payload.identity;
        if (identity?.issuer !== GOOGLE_ISSUER || !Number.isSafeInteger(identity.authenticatedAt)
            || identity.authenticatedAt < Date.now() - GRANT_TTL_MS || identity.authenticatedAt > Date.now() + 30_000) {
            throw Object.assign(grantError('authentication_failed', 401), { code: 'google_recent_authentication_required' });
        }
        const binding = await (await getStore()).getExternalIdentityByIdentityKey(googleIdentityKey(identity));
        if (!binding || binding.userId !== user.id || binding.issuer !== identity.issuer || binding.subject !== identity.subject) {
            throw Object.assign(grantError('authentication_failed', 401), { code: 'google_account_mismatch' });
        }
        const consumeTransaction = await prepareCompletion();
        return issueGrant(user, operation, 'google', consumeTransaction);
    });
}

async function assertMethod(user, method) {
    if (!REAUTH_METHODS.includes(method) || !(await reauthenticationMethods(user)).includes(method)) {
        throw grantError('reauthentication_unavailable', 409);
    }
}

// Starts re-authentication. Email codes go to the verified sign-in mailbox;
// passkeys receive a challenge scoped to this account and operation. TOTP and
// the administrator password need no start step.
export async function startReauthentication({ userId, operation, method, origin = '', rpId = '', resend = false, deliver = sendAuthCode }) {
    assertOperation(operation);
    const user = await activeUser(userId);
    assertOperationAllowed(user, operation);
    await assertMethod(user, method);
    if (method === 'emailCode') {
        const challenge = await sendAccountCode({ userId: user.id, purpose: 'reauth-code', email: user.email, operation,
            accountGeneration: authGenerationOf(user), resend, deliver });
        return { method, challenge };
    }
    if (method === 'passkey') {
        const options = await passkey.loginOptions({ email: user.email, origin, rpId, purpose: `reauth:${operation}` });
        if (!options.ok) throw grantError('reauthentication_unavailable', 409);
        return { method, challengeKey: options.challengeKey, publicKey: options.publicKey };
    }
    return { method };
}

function stageGrant(store, user, operation, method) {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + GRANT_TTL_MS;
    return {
        token,
        expiresAt,
        stage: async () => {
            await store.createAuthChallenge({
                challengeId: grantKey(token),
                subject: user.id,
                purpose: 'operation-grant',
                codeHash: '',
                expiresAt: new Date(expiresAt).toISOString(),
                attempts: 0,
                correlationId: JSON.stringify({ operation, method, generation: authGenerationOf(user) }),
            });
            await recordAudit({ actorId: user.id, action: 'auth.reauthenticate', target: user.id, result: 'ok', reason: `${method}:${operation}` }, { save: false });
        },
    };
}

async function issueGrant(user, operation, method, extraStage = null) {
    const store = await getStore();
    const grant = stageGrant(store, user, operation, method);
    // Unused grants expire; this account's expired ones are removed as new ones are issued.
    const now = Date.now();
    const expired = ((await store.select('authChallenge', { purpose: 'operation-grant', subject: user.id }, { start: 0, pageSize: 100 })).objects || [])
        .filter((record) => Date.parse(record.expiresAt) <= now);
    await commitStagedPersistence(async () => {
        if (extraStage) await extraStage();
        for (const record of expired) await store.deleteAuthChallenge(record.id);
        await grant.stage();
    });
    return { ok: true, grant: grant.token, operation, expiresAt: grant.expiresAt };
}

// Verifies the fresh proof and issues the grant. Every method rechecks that it
// is still available for this account at verification time.
export async function completeReauthentication({ userId, operation, method, code, token, assertion, challengeKey, origin = '', password, rateSource = '' }) {
    assertOperation(operation);
    const user = await activeUser(userId);
    assertOperationAllowed(user, operation);
    await assertMethod(user, method);
    let passwordProof = null;
    if (method === 'adminPassword') {
        passwordProof = await verifyAdministratorPassword({ password, rateSource });
    } else if (method === 'totp') {
        const result = await totp.reauthenticationVerify({ userId: user.id, token });
        if (!result.ok) {
            throw result.reason === 'account_locked'
                ? Object.assign(grantError('authentication_failed', 429), { code: 'rate_limited', retryAfter: 300 })
                : grantError('authentication_failed', 401);
        }
    } else if (method === 'passkey') {
        const result = await passkey.loginVerify({ email: user.email, assertion, challengeKey, origin, purpose: `reauth:${operation}` });
        if (!result.ok || result.user?.id !== user.id) throw grantError('authentication_failed', 401);
    }
    return serializePersisted('users', async () => {
        const current = await activeUser(userId);
        if (authGenerationOf(current) !== authGenerationOf(user) || !(await reauthenticationMethods(current)).includes(method)) {
            throw grantError('authentication_failed', 401);
        }
        // A configured-password rotation between verification and here voids the proof.
        if (passwordProof && !(await assertAdministratorPasswordProof(await getStore(), { userId: current.id, credentialVersion: passwordProof.credentialVersion }))) {
            throw grantError('authentication_failed', 401);
        }
        if (method !== 'emailCode') return issueGrant(current, operation, method);
        if (!hasVerifiedMailbox(current) || current.email !== user.email) throw grantError('authentication_failed', 401);
        const checked = await checkAccountCode({ userId: current.id, purpose: 'reauth-code', code, operation });
        if (checked.meta.email !== current.email || checked.meta.generation !== authGenerationOf(current)) {
            throw attemptError('attempt_invalid', 409);
        }
        return issueGrant(current, operation, method, checked.consume);
    });
}

export function cancelReauthentication({ userId }) {
    return cancelAccountCode({ userId, purpose: 'reauth-code' });
}

// Consumes a grant inside the caller's users lock and persistence scope. The
// account's own grant is deleted on any use, so it authorizes exactly one
// operation start; another account's grant is refused without touching it.
export async function stageGrantConsumption({ userId, operation, grant }) {
    assertOperation(operation);
    if (typeof grant !== 'string' || !GRANT_TOKEN.test(grant)) throw grantError('operation_grant_required', 403);
    const store = await getStore();
    const record = await store.getAuthChallengeByChallengeId(grantKey(grant));
    if (!record || record.purpose !== 'operation-grant' || record.subject !== userId) throw grantError('operation_grant_required', 403);
    let meta = {};
    try { meta = JSON.parse(record.correlationId || '{}') || {}; } catch { meta = {}; }
    const user = await getUserById(userId);
    const valid = record.subject === userId && meta.operation === operation && Date.parse(record.expiresAt) > Date.now()
        && user?.status === 'active' && meta.generation === authGenerationOf(user);
    return {
        valid,
        user,
        generation: meta.generation,
        consume: () => store.deleteAuthChallenge(record.id),
    };
}

// Consumes a grant and returns the account and generation it was issued for.
export function consumeOperationGrant({ userId, operation, grant }) {
    return serializePersisted('users', async () => {
        const staged = await stageGrantConsumption({ userId, operation, grant });
        await commitStagedPersistence(staged.consume);
        if (!staged.valid) throw grantError('operation_grant_required', 403);
        assertOperationAllowed(staged.user, operation);
        return { user: staged.user, generation: staged.generation };
    });
}
