import { randomBytes } from 'node:crypto';
import { getStore, commitStagedPersistence } from '../store.mjs';
import { serializePersisted } from '../serial.mjs';
import { withPersistenceScope } from '../persistence-scope.mjs';
import { getAuthPolicy } from '../policy.mjs';
import { authGenerationOf, getUserByEmail, getUserById, normalizeEmail, sanitizeUser } from '../users.mjs';
import { recordAudit } from '../audit.mjs';
import { encryptOidcPayload, decryptOidcPayload } from '../oidc/secrets.mjs';
import { credentialVersion } from './credentialVersion.mjs';
import { parseVerifier, verifySecret } from './password.mjs';
import { readThrottle, stageThrottleClear, stageThrottleFailure, throttleKey, throttleRetryAfter } from './throttle.mjs';
import { consumeMemoryBudget, emailSubject, rateSourceKey, refundMemoryBudget } from './emailAttempts.mjs';
import { withLoginAttemptLock } from './login-attempts.mjs';

// Each account owns at most one password credential: an `authMethod` record
// keyed `<userId>:password` whose scrypt verifier is encrypted under the
// retained settings key with an owner-bound context. A password exists in
// memory only for the request that carries it and is never logged or returned.
export const PASSWORD_POLICY = Object.freeze({
    minLength: 1,
    maxLength: 128,
    maxRawLength: 1024,
    maxPresentedBytes: 4096,
    normalization: 'NFKC',
});
const CONTROL_CHARACTERS = /\p{Cc}/u;
const FAILURE_LIMIT = 10;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const SOURCE_LIMIT = 20;
const SHARED_SOURCE_LIMIT = 300;
const WAITERS_PER_EMAIL = 4;
const WAITERS_TOTAL = 64;
const WAITER_RETRY_AFTER = 5;
const SHARED_SOURCE = 'shared';
const waiters = new Map();
let totalWaiters = 0;

function passwordError(code, statusCode, extra = {}) {
    const messages = {
        invalid_password: 'Choose a password that meets the requirements.',
        password_mismatch: 'The passwords do not match.',
        authentication_failed: 'Unable to sign in.',
        auth_method_disabled: 'This sign-in method is not available.',
        rate_limited: 'Too many attempts. Wait and try again.',
    };
    return Object.assign(new Error(messages[code] || 'Unable to continue.'), { code, statusCode, ...extra });
}

const authenticationFailed = () => passwordError('authentication_failed', 401);

// Shared by creation and presentation: a string of at most 1024 UTF-16 code
// units that is well-formed, normalized with NFKC. Nothing is ever truncated.
// Well-formedness is an encoding requirement at both ends: Node encodes a lone
// surrogate as U+FFFD, which could otherwise match a password containing it.
export function normalizeSecret(raw) {
    if (typeof raw !== 'string' || !raw.length) throw passwordError('invalid_password', 400, { reason: 'too_short' });
    if (raw.length > PASSWORD_POLICY.maxRawLength) throw passwordError('invalid_password', 400, { reason: 'too_long' });
    if (!raw.isWellFormed()) throw passwordError('invalid_password', 400, { reason: 'invalid_characters' });
    return raw.normalize('NFKC');
}

// Creation rules for a new password. Order: the bounded, well-formed raw input,
// then confirmation equality after normalization, then the bounds measured in
// Unicode code points. There is no strength rule: any non-empty password within
// the bounds is accepted. Returns the normalized secret for the KDF.
export function validateNewPassword({ password, passwordConfirmation }) {
    const normalized = normalizeSecret(password);
    if (typeof passwordConfirmation !== 'string' || passwordConfirmation.length > PASSWORD_POLICY.maxRawLength
        || passwordConfirmation.normalize('NFKC') !== normalized) {
        throw passwordError('password_mismatch', 400);
    }
    if (CONTROL_CHARACTERS.test(normalized)) throw passwordError('invalid_password', 400, { reason: 'invalid_characters' });
    const codePoints = [...normalized];
    if (codePoints.length < PASSWORD_POLICY.minLength) throw passwordError('invalid_password', 400, { reason: 'too_short' });
    if (codePoints.length > PASSWORD_POLICY.maxLength) throw passwordError('invalid_password', 400, { reason: 'too_long' });
    return { normalized };
}

// Presentation enforces only transport and resource bounds and well-formed
// encoding, never creation strength, so a later policy change cannot lock out
// a password that was valid when chosen.
function presentedSecret(raw) {
    if (typeof raw !== 'string' || !raw.length || raw.length > PASSWORD_POLICY.maxRawLength || !raw.isWellFormed()) return null;
    const normalized = raw.normalize('NFKC');
    return Buffer.byteLength(normalized, 'utf8') > PASSWORD_POLICY.maxPresentedBytes ? null : normalized;
}

export function passwordCredentialKey(userId) {
    return `${userId}:password`;
}

function credentialContext(userId) {
    return `userpersisto:password:v1:${userId}`;
}

// Caller holds the users lock and persistence scope and runs this inside its
// staged commit after validating the verifier. The version rotates on every write.
export async function stagePasswordCredential(store, { userId, verifier }) {
    const key = passwordCredentialKey(userId);
    const payload = {
        userId,
        type: 'password',
        enabled: true,
        credential: {
            hashEncrypted: encryptOidcPayload({ hash: verifier }, credentialContext(userId)),
            version: randomBytes(16).toString('hex'),
            setAt: new Date().toISOString(),
        },
    };
    const existing = await store.getAuthMethodByKey(key);
    return existing ? store.updateAuthMethod(existing.id, payload) : store.createAuthMethod({ key, ...payload });
}

// Read-only. A verifier that does not decrypt under its owner's context is
// unusable; a missing settings key still fails loudly.
export async function readPasswordCredential(store, userId) {
    const record = await store.getAuthMethodByKey(passwordCredentialKey(userId));
    if (!record || record.userId !== userId || record.type !== 'password') return null;
    let hash = '';
    try {
        const decrypted = decryptOidcPayload(record.credential?.hashEncrypted, credentialContext(userId));
        hash = typeof decrypted?.hash === 'string' ? decrypted.hash : '';
    } catch (error) {
        if (error?.code !== 'oidc_storage_decryption_failed') throw error;
    }
    return { record, hash, enabled: record.enabled === true, usable: record.enabled === true && Boolean(parseVerifier(hash)) };
}

function admitWaiter(subject) {
    const current = waiters.get(subject) || 0;
    if (current >= WAITERS_PER_EMAIL || totalWaiters >= WAITERS_TOTAL) {
        throw passwordError('rate_limited', 429, { retryAfter: WAITER_RETRY_AFTER });
    }
    waiters.set(subject, current + 1);
    totalWaiters += 1;
    return () => {
        const remaining = (waiters.get(subject) || 1) - 1;
        if (remaining > 0) waiters.set(subject, remaining);
        else waiters.delete(subject);
        totalWaiters = Math.max(0, totalWaiters - 1);
    };
}

function failureKey(subject) {
    return throttleKey('userpersisto:throttle:password-login', subject);
}

// A successful password reset proves mailbox control and clears the address's
// failed-attempt throttle in the same commit as the new credential.
export async function stagePasswordFailureClear(store, email) {
    const throttle = await readThrottle(store, failureKey(email), Date.now(), FAILURE_WINDOW_MS);
    return stageThrottleClear(store, throttle);
}

// One implementation for password login, My Account re-authentication and the
// Google link proof. Lock order: parent (caller), per-email login lock, users,
// persistence scope. Parent, policy and the failure budget are rechecked inside
// the per-email lock immediately before the KDF, and failures are recorded in
// that same serialization boundary, so a burst never obtains more evaluations
// than the budget allows.
async function verifyPassword({ subject, resolveUser, password, rateSource, validateParent, action, reason = '', includeCredentialProof = false }) {
    const secret = presentedSecret(password);
    if (!secret) throw authenticationFailed();
    const source = rateSourceKey(rateSource);
    consumeMemoryBudget('password-source', source, source === SHARED_SOURCE ? SHARED_SOURCE_LIMIT : SOURCE_LIMIT);
    const leave = admitWaiter(subject);
    try {
        return await withLoginAttemptLock(subject, async () => {
            if (validateParent) await validateParent();
            const observed = await withPersistenceScope(async () => {
                if (!(await getAuthPolicy()).enabledAuthMethods.includes('password')) throw passwordError('auth_method_disabled', 404);
                const store = await getStore();
                const now = Date.now();
                const user = await resolveUser();
                if (!user) {
                    // An attempt for an address without an account is necessarily a failure.
                    consumeMemoryBudget('password-failure', emailSubject(subject), FAILURE_LIMIT, now);
                    return { user: null, credential: null };
                }
                const throttle = await readThrottle(store, failureKey(subject), now, FAILURE_WINDOW_MS);
                if (throttle.count >= FAILURE_LIMIT) {
                    throw passwordError('rate_limited', 429, { retryAfter: throttleRetryAfter(throttle, now) });
                }
                return { user, credential: await readPasswordCredential(store, user.id) };
            });
            const eligible = observed.user?.status === 'active' && observed.credential?.usable;
            const validateAdmission = async () => {
                if (validateParent) await validateParent();
                await withPersistenceScope(async () => {
                    if (!(await getAuthPolicy()).enabledAuthMethods.includes('password')) throw passwordError('auth_method_disabled', 404);
                    if (!observed.user) return;
                    const now = Date.now();
                    const throttle = await readThrottle(await getStore(), failureKey(subject), now, FAILURE_WINDOW_MS);
                    if (throttle.count >= FAILURE_LIMIT) {
                        throw passwordError('rate_limited', 429, { retryAfter: throttleRetryAfter(throttle, now) });
                    }
                });
            };
            let matched;
            try {
                matched = await verifySecret(secret, eligible ? observed.credential.hash : '', { validateAdmission });
            } catch (error) {
                if (!observed.user) refundMemoryBudget('password-failure', emailSubject(subject));
                throw error;
            }
            return serializePersisted('users', async () => {
                if (validateParent) await validateParent();
                if (!(await getAuthPolicy()).enabledAuthMethods.includes('password')) throw passwordError('auth_method_disabled', 404);
                const store = await getStore();
                const now = Date.now();
                const user = observed.user ? await resolveUser() : null;
                const credential = user ? await readPasswordCredential(store, user.id) : null;
                const valid = matched && eligible && user?.id === observed.user.id && user.status === 'active'
                    && authGenerationOf(user) === authGenerationOf(observed.user) && credential?.usable
                    && credential.record.credential?.version === observed.credential.record.credential?.version;
                if (!valid) {
                    if (user) {
                        const throttle = await readThrottle(store, failureKey(subject), now, FAILURE_WINDOW_MS);
                        await commitStagedPersistence(async () => {
                            await stageThrottleFailure(store, throttle)();
                            await recordAudit({ actorId: user.id, action, target: user.id, result: 'denied', reason: 'invalid_credentials' }, { save: false });
                        });
                    }
                    throw authenticationFailed();
                }
                const throttle = await readThrottle(store, failureKey(subject), now, FAILURE_WINDOW_MS);
                await commitStagedPersistence(async () => {
                    await stageThrottleClear(store, throttle)();
                    await recordAudit({ actorId: user.id, action, target: user.id, result: 'ok', reason }, { save: false });
                });
                return {
                    ok: true,
                    user: sanitizeUser(user),
                    generation: authGenerationOf(user),
                    ...(includeCredentialProof ? {
                        credentialKey: credential.record.key,
                        credentialVersion: credentialVersion('password', credential.record.credential),
                    } : {}),
                };
            });
        });
    } finally {
        leave();
    }
}

// Signs an existing account in with its own password. Every refusal of the
// credential itself is the neutral `authentication_failed`, identical for an
// unknown address, a blocked account and an account without a password.
export function loginWithUserPassword({ parent = null, email, password, rateSource = '', validateParent }) {
    let normalized;
    try {
        normalized = normalizeEmail(email);
    } catch {
        return Promise.reject(authenticationFailed());
    }
    return verifyPassword({ subject: normalized, resolveUser: () => getUserByEmail(normalized), password, rateSource, validateParent,
        action: 'auth.password.login', reason: parent?.flow || '' });
}

// Fresh proof of an already known account: My Account re-authentication and
// the Google collision link proof. Same lock, budgets and KDF gate as login.
export async function verifyAccountPassword({ userId, password, rateSource = '', validateParent }, { includeCredentialProof = false } = {}) {
    const account = await getUserById(userId);
    const subject = account?.email || `user:${userId}`;
    return verifyPassword({ subject, resolveUser: () => getUserById(userId), password, rateSource, validateParent,
        action: 'auth.password.reauthenticate', includeCredentialProof });
}

// Rechecks, under the caller's persistence scope, that a proof obtained earlier
// still matches the current credential, generation and policy.
export async function assertPasswordProof(store, { userId, credentialVersion: expected, generation }) {
    const user = await getUserById(userId);
    if (!user || user.status !== 'active' || (generation !== undefined && generation !== authGenerationOf(user))) return false;
    if (!(await getAuthPolicy()).enabledAuthMethods.includes('password')) return false;
    const credential = await readPasswordCredential(store, userId);
    return Boolean(credential?.usable && typeof expected === 'string'
        && expected === credentialVersion('password', credential.record.credential));
}

export function resetPasswordLimitsForTests() {
    waiters.clear();
    totalWaiters = 0;
}
