import { createHash } from 'node:crypto';
import { getStore, commitStagedPersistence } from './store.mjs';
import { serializePersisted } from './serial.mjs';
import { getUserByEmail, getUserById, getUserRoles, sanitizeUser, stageUser } from './users.mjs';
import { assertRegistrationRoleAllowed, getAuthPolicy } from './policy.mjs';
import { recordAudit } from './audit.mjs';
import { credentialVersion } from './auth/credentialVersion.mjs';

export const GOOGLE_ISSUER = 'https://accounts.google.com';
export const GOOGLE_LOCAL_PROOF_TTL_MS = 2 * 60 * 1000;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LINK_METHODS = new Set(['password', 'passkey', 'totp']);

function identityError(code, statusCode = 403) {
    return Object.assign(new Error('Google sign-in cannot continue. Use an existing sign-in method or start again.'), { code, statusCode });
}

function normalizeIdentity(identity) {
    if (!identity || identity.issuer !== GOOGLE_ISSUER
        || typeof identity.subject !== 'string' || identity.subject.length < 1 || identity.subject.length > 255
        || /[\u0000-\u0020\u007f]/.test(identity.subject)) throw identityError('google_identity_invalid', 400);
    const email = typeof identity.email === 'string' ? identity.email.trim().toLowerCase() : '';
    return {
        issuer: GOOGLE_ISSUER,
        subject: identity.subject,
        email: email.length <= 254 && EMAIL_PATTERN.test(email) ? email : '',
        emailVerified: identity.emailVerified === true,
        hostedDomain: typeof identity.hostedDomain === 'string' ? identity.hostedDomain.trim().toLowerCase() : '',
    };
}

export function googleIdentityKey(identity) {
    const normalized = normalizeIdentity(identity);
    return createHash('sha256').update(JSON.stringify([normalized.issuer, normalized.subject])).digest('hex');
}

export function googleRegistrationNeedsMailboxProof(identity) {
    const normalized = normalizeIdentity(identity);
    const domain = normalized.email.split('@')[1];
    return domain !== 'gmail.com'
        && (!normalized.hostedDomain || normalized.hostedDomain !== domain);
}

async function existingIdentity(store, identity) {
    const binding = await store.getExternalIdentityByIdentityKey(googleIdentityKey(identity));
    if (binding && (binding.issuer !== identity.issuer || binding.subject !== identity.subject || !binding.userId)) {
        throw identityError('google_identity_invalid', 503);
    }
    return binding;
}

async function eligibleMethods(store, user, policy) {
    const methods = [];
    if (policy.enabledAuthMethods.includes('password') && typeof user.passwordHash === 'string' && user.passwordHash.startsWith('scrypt$')) methods.push('password');
    const enrolled = await store.getAuthMethodsObjectsByUserId(user.id) || [];
    for (const type of ['passkey', 'totp']) {
        if (policy.enabledAuthMethods.includes(type) && enrolled.some((method) => method.type === type && method.enabled === true)) methods.push(type);
    }
    return methods;
}

export async function getGoogleLinkMethods(userId) {
    const store = await getStore();
    const user = await getUserById(userId);
    if (!user || user.status !== 'active') return [];
    return eligibleMethods(store, user, await getAuthPolicy());
}

async function assertGoogleEnabled(store) {
    const policy = await getAuthPolicy();
    if (!policy.enabledAuthMethods.includes('google')) throw identityError('auth_method_disabled');
    const existing = await store.select('user', {}, { start: 0, pageSize: 1 });
    if (!existing.objects.length) throw identityError('initial_setup_required');
    return policy;
}

async function assertNoOtherBinding(store, userId, identity) {
    const bindings = await store.getExternalIdentitiesObjectsByUserId(userId) || [];
    if (bindings.some((binding) => binding.issuer === GOOGLE_ISSUER
        && (binding.identityKey !== googleIdentityKey(identity) || binding.subject !== identity.subject))) {
        throw identityError('google_identity_already_linked');
    }
}

async function resolveInternal(identity) {
    const store = await getStore();
    const policy = await assertGoogleEnabled(store);
    const binding = await existingIdentity(store, identity);
    if (binding) {
        const user = await getUserById(binding.userId);
        if (!user || user.status !== 'active') throw identityError('user_blocked');
        await assertNoOtherBinding(store, user.id, identity);
        return { kind: 'linked', user: sanitizeUser(user), roles: await getUserRoles(user.id), binding };
    }
    if (!identity.email || !identity.emailVerified) throw identityError('google_verified_email_required');
    const collision = await getUserByEmail(identity.email);
    if (collision) {
        if (collision.status !== 'active') throw identityError('user_blocked');
        await assertNoOtherBinding(store, collision.id, identity);
        return { kind: 'collision', userId: collision.id, email: collision.email, eligibleMethods: await eligibleMethods(store, collision, policy) };
    }
    if (!policy.selfRegistrationEnabled) throw identityError('registration_disabled');
    await assertRegistrationRoleAllowed('selfRegistered', store);
    return { kind: 'registration', email: identity.email, mailboxProofRequired: googleRegistrationNeedsMailboxProof(identity) };
}

async function assertCollisionTarget(identity, target) {
    if (!target) return;
    const user = await getUserById(target.userId);
    if (!user || user.status !== 'active' || target.email !== identity.email || user.email !== target.email) {
        throw identityError('google_collision_changed');
    }
}

export function inspectGoogleIdentity(identity, { collisionTarget } = {}) {
    const normalized = normalizeIdentity(identity);
    return serializePersisted('users', async () => {
        await assertCollisionTarget(normalized, collisionTarget);
        const { binding, ...result } = await resolveInternal(normalized);
        return result;
    });
}

function freshTimestamp(value, now) {
    return Number.isSafeInteger(value) && value <= now && value > now - GOOGLE_LOCAL_PROOF_TTL_MS;
}

async function assertLinkProof(store, resolved, proof, transactionId) {
    const now = Date.now();
    if (!transactionId || proof?.transactionId !== transactionId
        || proof.userId !== resolved.userId || proof.email !== resolved.email
        || !LINK_METHODS.has(proof.method) || !resolved.eligibleMethods.includes(proof.method)
        || !freshTimestamp(proof.authenticatedAt, now) || !freshTimestamp(proof.confirmedAt, now)
        || proof.confirmedAt < proof.authenticatedAt) throw identityError('google_link_authentication_required');
    let currentVersion;
    if (proof.method === 'password') {
        currentVersion = credentialVersion('password', (await getUserById(resolved.userId)).passwordHash);
    } else {
        if (typeof proof.credentialKey !== 'string' || !proof.credentialKey) throw identityError('google_link_authentication_required');
        const credential = await store.getAuthMethodByKey(proof.credentialKey);
        if (!credential || credential.userId !== resolved.userId || credential.type !== proof.method || credential.enabled !== true) {
            throw identityError('google_link_authentication_required');
        }
        currentVersion = credentialVersion(proof.method, credential.credential);
    }
    if (proof.credentialVersion !== currentVersion) throw identityError('google_link_authentication_required');
}

// Trusted protocol callers pass only server-verified claims and proof retained in
// their encrypted, browser-bound transaction. Request bodies cannot choose these.
// Lock order: parent/orchestration -> users -> persistence. validateParent must
// be a locked read; prepareCompletion validates before staging and returns a
// function that only stages local records without another validation or save.
export function completeGoogleIdentity({ identity, transactionId, collisionTarget, linkProof, mailboxProof, validateParent, prepareCompletion }) {
    const normalized = normalizeIdentity(identity);
    return serializePersisted('users', async () => {
        const store = await getStore();
        await assertCollisionTarget(normalized, collisionTarget || linkProof);
        const resolved = await resolveInternal(normalized);
        if (validateParent) await validateParent();
        if (resolved.kind === 'collision') await assertLinkProof(store, resolved, linkProof, transactionId);
        if (resolved.kind === 'registration' && resolved.mailboxProofRequired) {
            if (!transactionId || mailboxProof?.transactionId !== transactionId
                || mailboxProof.email !== normalized.email || !freshTimestamp(mailboxProof.verifiedAt, Date.now())) {
                throw identityError('google_mailbox_proof_required');
            }
        }
        const preparedCompletion = prepareCompletion ? await prepareCompletion() : undefined;
        // All predictable policy, ownership, role and proof errors precede the
        // first mutation. Any later failure invalidates cached state until restart.
        return commitStagedPersistence(async () => {
            let user;
            const created = resolved.kind === 'registration';
            if (created) {
                user = await stageUser({
                    email: normalized.email,
                    source: 'google-self-registration',
                    roles: ['selfRegistered'],
                    actorId: 'google-self-registration',
                    emailVerified: true,
                });
            } else {
                user = resolved.kind === 'linked' ? resolved.user : sanitizeUser(await getUserById(resolved.userId));
            }
            const timestamp = new Date().toISOString();
            if (resolved.binding) {
                await store.updateExternalIdentity(resolved.binding.id, { lastUsedAt: timestamp });
            } else {
                await store.createExternalIdentity({
                    identityKey: googleIdentityKey(normalized),
                    issuer: normalized.issuer,
                    subject: normalized.subject,
                    userId: user.id,
                    createdAt: timestamp,
                    lastUsedAt: timestamp,
                });
            }
            await recordAudit({ actorId: user.id, action: resolved.binding ? 'auth.google.login' : 'auth.google.link', target: user.id }, { save: false });
            const result = { user, roles: await getUserRoles(user.id), created, linked: !resolved.binding };
            if (preparedCompletion) await preparedCompletion(result);
            return result;
        });
    });
}
