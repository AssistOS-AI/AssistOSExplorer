import { createHash, randomBytes } from 'node:crypto';
import { commitStagedPersistence, getStore } from '../store.mjs';
import { serializePersisted } from '../serial.mjs';
import { withPersistenceScope } from '../persistence-scope.mjs';
import { getAuthPolicy } from '../policy.mjs';
import { authGenerationOf, getUserByEmail, getUserById, hasVerifiedMailbox, normalizeEmail } from '../users.mjs';
import { recordAudit } from '../audit.mjs';
import { sendPasswordResetEmail } from '../email-agent-client.mjs';
import { consumeMemoryBudget, rateSourceKey, spendSendBudgets } from './emailAttempts.mjs';
import { credentialVersion } from './credentialVersion.mjs';
import { hashSecret } from './password.mjs';
import { stageCredentialGenerationAdvance } from './generation.mjs';
import { PASSWORD_POLICY, readPasswordCredential, stagePasswordCredential, stagePasswordFailureClear, validateNewPassword } from './userPassword.mjs';

// Emailed password reset. The bearer token exists only in the message: the
// challenge record stores its digest and is bound to the account, its
// generation, its password credential version and its address. One live token
// per account; use, expiry, a newer request, a generation or credential change
// or a different address invalidates it. Completing a reset verifies the
// mailbox, replaces the credential and advances the generation in one commit.
export const RESET_TOKEN_TTL_MS = 30 * 60 * 1000;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const PURPOSE = 'password-reset';
const STATUS_PER_SOURCE = 20;
const STATUS_SHARED = 300;
const KDF_PER_SOURCE = 10;
const KDF_SHARED = 100;

function resetError(code, statusCode = 400) {
    const messages = {
        invalid_email: 'Enter a valid email address.',
        auth_method_disabled: 'This sign-in method is not available.',
        password_reset_unavailable: 'Password reset is not available.',
        delivery_failed: 'We could not send the email. Try again later.',
        reset_link_invalid: 'This reset link is invalid or has expired. Request a new one from the sign-in page.',
    };
    return Object.assign(new Error(messages[code] || 'Unable to continue.'), { code, statusCode });
}

function resetKey(token) {
    return `reset:${createHash('sha256').update(`userpersisto:password-reset:${token}`).digest('hex')}`;
}

function emailDigest(email) {
    return createHash('sha256').update(String(email || '')).digest('base64url');
}

function spendStatusBudget(rateSource) {
    const source = rateSourceKey(rateSource);
    consumeMemoryBudget('password-reset-status-source', source, source === 'shared' ? STATUS_SHARED : STATUS_PER_SOURCE);
}

function spendResetKdfBudget(rateSource) {
    const source = rateSourceKey(rateSource);
    consumeMemoryBudget('password-reset-kdf-source', source, source === 'shared' ? KDF_SHARED : KDF_PER_SOURCE);
}

// Caller holds the persistence scope. The token is looked up by digest; the
// stored record never contains the token itself. A blocked account or a
// disabled password method refuses without deleting; a deletion, expiry or
// binding mismatch is stale and may be cleaned up by the caller.
async function loadResetToken(store, token) {
    const record = await store.getAuthChallengeByChallengeId(resetKey(token));
    if (!record || record.purpose !== PURPOSE || typeof record.subject !== 'string' || !record.subject) {
        return { record: null, meta: {}, user: null, credential: null, status: 'missing' };
    }
    let meta = {};
    try { meta = JSON.parse(record.correlationId || '{}') || {}; } catch { meta = {}; }
    const user = await getUserById(record.subject);
    if (!user) return { record, meta, user: null, credential: null, status: 'stale' };
    if (user.status !== 'active' || !(await getAuthPolicy()).enabledAuthMethods.includes('password')) {
        return { record, meta, user, credential: null, status: 'refused' };
    }
    const credential = await readPasswordCredential(store, user.id);
    if (!credential?.usable) return { record, meta, user, credential: null, status: 'refused' };
    const bound = meta.email === user.email && meta.generation === authGenerationOf(user)
        && meta.credentialVersion === credentialVersion('password', credential.record.credential);
    if (!bound || Date.parse(record.expiresAt) <= Date.now()) return { record, meta, user, credential, status: 'stale' };
    return { record, meta, user, credential, status: 'valid' };
}

// Idempotent: another request may already have removed the record. Reading and
// deleting inside one persistence scope is atomic against every other store
// access, so a missing record is a no-op and never a failed commit.
function deleteResetRecord(token) {
    return withPersistenceScope(async () => {
        const store = await getStore();
        const record = await store.getAuthChallengeByChallengeId(resetKey(token));
        if (!record || record.purpose !== PURPOSE) return;
        await commitStagedPersistence(() => store.deleteAuthChallenge(record.id));
    });
}

// Provider acceptance, a known failure and an unknown outcome stay distinct,
// exactly as for delivered codes.
async function deliverReset(deliver, { to, resetUrl, correlationId }) {
    try {
        const result = await deliver({ to, resetUrl, correlationId, expiresInMinutes: RESET_TOKEN_TTL_MS / 60_000 });
        if (result?.delivered === true) return { delivery: 'accepted', providerMessageId: result.providerMessageId || '' };
        return { delivery: 'failed', providerMessageId: '' };
    } catch {
        return { delivery: 'unknown', providerMessageId: '' };
    }
}

function developmentLogFallback({ to, resetUrl, delivery }) {
    // Explicit development-only escape hatch; never a production method.
    if (delivery === 'accepted' || process.env.USERPERSISTO_DEV_BOOTSTRAP !== 'true') return delivery;
    console.warn(`[userPersisto] DEVELOPMENT password reset link for ${to}: ${resetUrl}`);
    return 'development-log';
}

// Diagnostic row, committed like recordDelivery's. A failure to write it must
// not turn the delivery outcome into an error for the user.
async function writeEmailLog({ store, email, providerMessageId, delivery, correlationId }) {
    try {
        await commitStagedPersistence(() => store.createEmailLog({
            logId: createHash('sha256').update(`${email}:${Date.now()}:${Math.random()}`).digest('hex').slice(0, 32),
            providerMessageId: String(providerMessageId || ''),
            toEmailHash: emailDigest(email),
            template: PURPOSE,
            result: delivery,
            correlationId: String(correlationId || ''),
            createdAt: new Date().toISOString(),
        }));
    } catch {
        console.warn('[userPersisto] password reset email log could not be written');
    }
}

// Ready-to-reset account: active, owns a usable password credential and the
// reset offer is enabled. Caller holds the persistence scope.
async function eligibleAccount(store, email) {
    const user = await getUserByEmail(email);
    if (!user || user.status !== 'active') return null;
    const credential = await readPasswordCredential(store, user.id);
    return credential?.usable ? { user, credential } : null;
}

// Request a reset link. Every request spends the send budgets, eligible or
// not, so a probe costs exactly what a send costs. Ineligible addresses get
// the uniform success answer and no mail.
export async function requestPasswordReset({ parent, email, rateSource = '', emailAvailable = false, validateParent, resetBaseUrl, deliver = sendPasswordResetEmail }) {
    let normalizedEmail;
    try { normalizedEmail = normalizeEmail(email); } catch { throw resetError('invalid_email', 400); }
    if (validateParent) await validateParent();
    if (!(await getAuthPolicy()).enabledAuthMethods.includes('password')) throw resetError('auth_method_disabled', 404);
    if (!emailAvailable || !/^https?:\/\//.test(String(resetBaseUrl || ''))) throw resetError('password_reset_unavailable', 409);
    spendSendBudgets(normalizedEmail, rateSource);
    const store = await getStore();
    const eligible = await withPersistenceScope(() => eligibleAccount(store, normalizedEmail));
    if (!eligible) return { ok: true };

    const token = randomBytes(32).toString('base64url');
    const correlationId = `password-reset:${eligible.user.id.slice(0, 16)}`;
    const issued = await serializePersisted('users', async () => {
        const current = await withPersistenceScope(() => eligibleAccount(store, normalizedEmail));
        if (!current) return null;
        const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS).toISOString();
        await commitStagedPersistence(async () => {
            // One live token per account: a new request supersedes earlier ones.
            for (const record of (await store.select('authChallenge', { purpose: PURPOSE, subject: current.user.id })).objects || []) {
                await store.deleteAuthChallenge(record.id);
            }
            await store.createAuthChallenge({
                challengeId: resetKey(token),
                subject: current.user.id,
                purpose: PURPOSE,
                codeHash: '',
                expiresAt,
                attempts: 0,
                correlationId: JSON.stringify({
                    email: current.user.email,
                    generation: authGenerationOf(current.user),
                    credentialVersion: credentialVersion('password', current.credential.record.credential),
                    flow: parent.flow,
                }),
            });
            await recordAudit({ actorId: current.user.id, action: 'auth.password.reset.request', target: current.user.id, reason: parent.flow }, { save: false });
        });
        return { record: await store.getAuthChallengeByChallengeId(resetKey(token)), email: current.user.email };
    });
    if (!issued) return { ok: true };

    const resetUrl = `${resetBaseUrl}#token=${token}`;
    const outcome = await deliverReset(deliver, { to: issued.email, resetUrl, correlationId });
    const delivery = developmentLogFallback({ to: issued.email, resetUrl, delivery: outcome.delivery });
    await writeEmailLog({ store, email: issued.email, providerMessageId: outcome.providerMessageId, delivery, correlationId });
    if (delivery === 'failed') {
        await deleteResetRecord(token);
        throw resetError('delivery_failed', 502);
    }
    return { ok: true };
}

// Read-only inspection for the reset page. Spends the per-source look-up
// budget and consumes nothing: even a stale record stays for completion's
// cleanup.
export async function inspectPasswordReset({ token, rateSource = '' }) {
    spendStatusBudget(rateSource);
    if (typeof token !== 'string' || !TOKEN.test(token)) throw resetError('reset_link_invalid', 400);
    return withPersistenceScope(async () => {
        const checked = await loadResetToken(await getStore(), token);
        if (checked.status !== 'valid') throw resetError('reset_link_invalid', 400);
        return {
            email: checked.user.email,
            expiresAt: Date.parse(checked.record.expiresAt),
            passwordPolicy: {
                minLength: PASSWORD_POLICY.minLength,
                maxLength: PASSWORD_POLICY.maxLength,
                maxRawLength: PASSWORD_POLICY.maxRawLength,
                normalization: PASSWORD_POLICY.normalization,
            },
        };
    });
}

// Complete the reset. Input refusals never touch the token; the link stays
// usable for a corrected submission. The final commit replaces the credential,
// verifies the mailbox when it was unverified, advances the generation, clears
// the address's failure throttle and deletes every reset record of the account.
export async function completePasswordReset({ token, password, passwordConfirmation, rateSource = '' }) {
    if (typeof token !== 'string' || !TOKEN.test(token)) throw resetError('reset_link_invalid', 400);
    spendStatusBudget(rateSource);
    const inspect = () => withPersistenceScope(async () => loadResetToken(await getStore(), token));
    const observed = await inspect();
    if (observed.status !== 'valid') {
        if (observed.status === 'stale') await deleteResetRecord(token);
        throw resetError('reset_link_invalid', 400);
    }
    const { normalized } = validateNewPassword({ password, passwordConfirmation, email: observed.user.email });
    const validateAdmission = async () => {
        const checked = await inspect();
        if (checked.status !== 'valid') {
            if (checked.status === 'stale') await deleteResetRecord(token);
            throw resetError('reset_link_invalid', 400);
        }
    };
    spendResetKdfBudget(rateSource);
    const verifier = await hashSecret(normalized, { validateAdmission });
    return serializePersisted('users', async () => {
        await validateAdmission();
        const store = await getStore();
        const checked = await loadResetToken(store, token);
        if (checked.status !== 'valid') throw resetError('reset_link_invalid', 400);
        const user = checked.user;
        const now = new Date().toISOString();
        await commitStagedPersistence(async () => {
            for (const record of (await store.select('authChallenge', { purpose: PURPOSE, subject: user.id })).objects || []) {
                await store.deleteAuthChallenge(record.id);
            }
            await stagePasswordCredential(store, { userId: user.id, verifier });
            if (!hasVerifiedMailbox(user)) {
                if (user.email !== checked.meta.email) await store.setEmailForUser(user.id, checked.meta.email);
                await store.updateUser(user.id, { emailVerifiedAt: now, contactEmail: checked.meta.email || user.email, updatedAt: now });
            }
            await stageCredentialGenerationAdvance(user.id);
            await (await stagePasswordFailureClear(store, user.email))();
            await recordAudit({ actorId: user.id, action: 'auth.password.reset', target: user.id }, { save: false });
        });
        return { ok: true };
    });
}
