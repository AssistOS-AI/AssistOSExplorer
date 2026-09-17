import { createHash } from 'node:crypto';
import { getStore, commitStagedPersistence } from './store.mjs';
import { serializePersisted } from './serial.mjs';
import { getUserByEmail, getUserById, getUserRoles, sanitizeUser, hasVerifiedMailbox } from './users.mjs';
import { assertRegistrationRoleAllowed, getAuthPolicy, REGISTRATION_ROLE } from './policy.mjs';
import { readInstallationSetup, prepareNewAccount } from './setup.mjs';
import { recordAudit } from './audit.mjs';
import { credentialVersion } from './auth/credentialVersion.mjs';
import { administratorPasswordUsableFor, assertAdministratorPasswordProof } from './auth/adminPassword.mjs';

export const GOOGLE_ISSUER = 'https://accounts.google.com';
export const GOOGLE_LOCAL_PROOF_TTL_MS = 2 * 60 * 1000;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// `googleAuthoritative` is the narrow shortcut: explicit consent after Google
// verified an address it is authoritative for, matching the current verified,
// enabled local mailbox. Every other method proves the existing account afresh.
const LINK_METHODS = new Set(['emailCode', 'passkey', 'totp', 'adminPassword', 'googleAuthoritative']);

function identityError(code, statusCode = 403) {
    return Object.assign(new Error('Google sign-in cannot continue. Use an existing sign-in method or start again.'), { code, statusCode });
}

function normalizeIdentity(identity) {
    if (!identity || identity.issuer !== GOOGLE_ISSUER
        || typeof identity.subject !== 'string' || identity.subject.length < 1 || identity.subject.length > 255
        || /[\u0000- \u007f]/.test(identity.subject)) throw identityError('google_identity_invalid', 400);
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

function googleIsAuthoritativeFor(identity, email) {
    return identity.emailVerified && !!identity.email && identity.email === email && !googleRegistrationNeedsMailboxProof(identity);
}

async function existingIdentity(store, identity) {
    const binding = await store.getExternalIdentityByIdentityKey(googleIdentityKey(identity));
    if (binding && (binding.issuer !== identity.issuer || binding.subject !== identity.subject || !binding.userId)) {
        throw identityError('google_identity_invalid', 503);
    }
    return binding;
}

async function eligibleMethods(store, user, policy, identity) {
    const methods = [];
    if (policy.enabledAuthMethods.includes('emailCode') && hasVerifiedMailbox(user)) {
        methods.push('emailCode');
        if (identity && googleIsAuthoritativeFor(identity, user.email)) methods.push('googleAuthoritative');
    }
    const enrolled = await store.getAuthMethodsObjectsByUserId(user.id) || [];
    for (const type of ['passkey', 'totp']) {
        if (policy.enabledAuthMethods.includes(type) && enrolled.some((method) => method.type === type && method.enabled === true)) methods.push(type);
    }
    if (await administratorPasswordUsableFor(user.id)) methods.push('adminPassword');
    return methods;
}

export async function getGoogleLinkMethods(userId, identity = null) {
    const store = await getStore();
    const user = await getUserById(userId);
    if (!user || user.status !== 'active') return [];
    return eligibleMethods(store, user, await getAuthPolicy(), identity ? normalizeIdentity(identity) : null);
}

async function assertGoogleEnabled() {
    const policy = await getAuthPolicy();
    if (!policy.enabledAuthMethods.includes('google')) throw identityError('auth_method_disabled');
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
    const policy = await assertGoogleEnabled();
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
        return { kind: 'collision', userId: collision.id, email: collision.email, eligibleMethods: await eligibleMethods(store, collision, policy, identity) };
    }
    // The unclaimed installation admits its first completed sign-in; afterwards
    // registration policy governs, rechecked again inside the staged commit.
    const setup = await readInstallationSetup(store);
    if (setup.complete) {
        if (!policy.selfRegistrationEnabled) throw identityError('registration_disabled');
        await assertRegistrationRoleAllowed(REGISTRATION_ROLE, store);
    }
    return { kind: 'registration', email: identity.email, mailboxProofRequired: googleRegistrationNeedsMailboxProof(identity), initialAdministrator: !setup.complete };
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

// The mailbox version a link-specific code or the authoritative shortcut binds
// to. Proof is stale after an address, verification or generation change.
export function mailboxVersion(user) {
    return credentialVersion('mailbox', user);
}

async function assertLinkProof(store, resolved, proof, transactionId, identity) {
    const now = Date.now();
    if (!transactionId || proof?.transactionId !== transactionId
        || proof.userId !== resolved.userId || proof.email !== resolved.email
        || !LINK_METHODS.has(proof.method) || !resolved.eligibleMethods.includes(proof.method)
        || !freshTimestamp(proof.authenticatedAt, now) || !freshTimestamp(proof.confirmedAt, now)
        || proof.confirmedAt < proof.authenticatedAt) throw identityError('google_link_authentication_required');
    const user = await getUserById(resolved.userId);
    let valid = false;
    if (proof.method === 'emailCode' || proof.method === 'googleAuthoritative') {
        valid = hasVerifiedMailbox(user) && user.email === resolved.email && proof.credentialVersion === mailboxVersion(user)
            && (proof.method === 'emailCode' || googleIsAuthoritativeFor(identity, user.email));
    } else if (proof.method === 'adminPassword') {
        valid = await assertAdministratorPasswordProof(store, { userId: resolved.userId, credentialVersion: proof.credentialVersion });
    } else if (typeof proof.credentialKey === 'string' && proof.credentialKey) {
        const credential = await store.getAuthMethodByKey(proof.credentialKey);
        valid = !!credential && credential.userId === resolved.userId && credential.type === proof.method && credential.enabled === true
            && proof.credentialVersion === credentialVersion(proof.method, credential.credential);
    }
    if (!valid) throw identityError('google_link_authentication_required');
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
        if (resolved.kind === 'collision') await assertLinkProof(store, resolved, linkProof, transactionId, normalized);
        if (resolved.kind === 'registration' && resolved.mailboxProofRequired) {
            if (!transactionId || mailboxProof?.transactionId !== transactionId
                || mailboxProof.email !== normalized.email || !freshTimestamp(mailboxProof.verifiedAt, Date.now())) {
                throw identityError('google_mailbox_proof_required');
            }
        }
        const stageAccount = resolved.kind === 'registration'
            ? await prepareNewAccount({ email: normalized.email, emailVerified: true, method: 'google' }).catch((error) => {
                throw error?.code === 'registration_disabled' ? identityError('registration_disabled') : error;
            })
            : null;
        const preparedCompletion = prepareCompletion ? await prepareCompletion() : undefined;
        // All predictable policy, ownership, role and proof errors precede the
        // first mutation. Any later failure invalidates cached state until restart.
        return commitStagedPersistence(async () => {
            let user;
            let initialAdministrator = false;
            const created = resolved.kind === 'registration';
            if (created) {
                const account = await stageAccount();
                user = account.user;
                initialAdministrator = account.initialAdministrator;
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
            await recordAudit({ actorId: user.id, action: resolved.binding ? 'auth.google.login' : 'auth.google.link', target: user.id,
                reason: resolved.kind === 'collision' ? linkProof.method : '' }, { save: false });
            const result = { user, roles: await getUserRoles(user.id), created, linked: !resolved.binding, initialAdministrator };
            if (preparedCompletion) await preparedCompletion(result);
            return result;
        });
    });
}
