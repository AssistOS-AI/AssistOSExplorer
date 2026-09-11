import { getStore } from './store.mjs';
import { getUserById, getUserRoles, hasVerifiedMailbox } from './users.mjs';
import { getEnabledAuthMethods } from './auth/methods.mjs';
import { GOOGLE_ISSUER } from './externalIdentities.mjs';
import { administratorPasswordUsableFor } from './auth/adminPassword.mjs';

export async function getUserCapabilities(userId) {
    const store = await getStore();
    const roleNames = await getUserRoles(userId);
    const caps = new Set();
    for (const name of roleNames) {
        const role = await store.getRoleByName(name);
        if (!role) {
            continue;
        }
        const links = await store.getRolePermsObjectsByRoleId(role.id) || [];
        for (const link of links) {
            const perm = await store.getPermission(link.permissionId);
            if (perm) {
                caps.add(perm.capability);
            }
        }
    }
    return [...caps].sort();
}

export async function authorizeCapability({ userId, capability, resource = '' }) {
    const user = await getUserById(userId);
    if (!user) {
        return { allowed: false, reason: 'unknown_user' };
    }
    if (user.status !== 'active') {
        return { allowed: false, reason: `user_${user.status}` };
    }
    const caps = await getUserCapabilities(userId);
    if (!caps.includes(String(capability))) {
        return { allowed: false, reason: 'capability_not_granted' };
    }
    return { allowed: true, reason: resource ? `capability_granted:${resource}` : 'capability_granted' };
}

export async function requireActiveActor(userId, capability = '') {
    const normalizedUserId = String(userId || '').trim();
    if (!normalizedUserId) {
        throw Object.assign(new Error('Authenticated user is required.'), { code: 'authentication_required', statusCode: 401 });
    }
    const user = await getUserById(normalizedUserId);
    if (!user || user.status !== 'active') {
        throw Object.assign(new Error('Authentication required.'), { code: 'invalid_session', statusCode: 401 });
    }
    if (capability) {
        const decision = await authorizeCapability({ userId: normalizedUserId, capability });
        if (!decision.allowed) {
            throw Object.assign(new Error('Admin access is required.'), { code: 'admin_required', statusCode: 403 });
        }
    }
    return user;
}

export async function getProfile(userId) {
    const store = await getStore();
    const user = await getUserById(userId);
    if (!user) {
        throw new Error(`Unknown user: ${userId}`);
    }
    const roles = await getUserRoles(userId);
    const capabilities = await getUserCapabilities(userId);
    const account = await store.getCreditAccountByUserId(userId) || null;
    const subs = await store.getSubscriptionsObjectsByUserId(userId) || [];
    const active = subs.find((subscription) => subscription.status === 'active') || null;
    const methods = await store.getAuthMethodsObjectsByUserId(userId) || [];
    const enabledMethods = methods.filter((method) => method.enabled);
    const passkeyCount = enabledMethods.filter((method) => method.type === 'passkey').length;
    const totpConfigured = enabledMethods.some((method) => method.type === 'totp');
    const totpSetup = await store.getAuthChallengeByChallengeId(`totp-setup:${userId}`);
    const totpPending = totpSetup?.subject === userId
        && totpSetup.purpose === 'totp-setup'
        && Date.parse(totpSetup.expiresAt) > Date.now();
    const authMethods = [];
    if (hasVerifiedMailbox(user)) authMethods.push({ type: 'emailCode', name: 'Email code' });
    if (passkeyCount) authMethods.push({ type: 'passkey', name: 'Passkey' });
    if (totpConfigured) authMethods.push({ type: 'totp', name: 'Authenticator app' });
    const externalIdentities = await store.getExternalIdentitiesObjectsByUserId(userId) || [];
    if (externalIdentities.some((identity) => identity.issuer === GOOGLE_ISSUER)) {
        authMethods.push({ type: 'google', name: 'Google' });
    }
    if (await administratorPasswordUsableFor(userId)) authMethods.push({ type: 'adminPassword', name: 'Administrator password' });
    const { passwordHash, loginAttempts, lastLoginAttempt, ...safeUser } = user;
    const { reauthenticationMethods } = await import('./auth/operationGrants.mjs');
    const contactChallenge = await store.getAuthChallengeByChallengeId(`contact-verify:${userId}`);
    return {
        user: safeUser,
        roles,
        capabilities,
        emailVerified: hasVerifiedMailbox(user),
        authMethods,
        allowedAuthMethods: await getEnabledAuthMethods(),
        // Methods that can confirm a sensitive My Account operation right now.
        reauthenticationMethods: user.status === 'active' ? await reauthenticationMethods(user) : [],
        enrollments: {
            passkey: { configured: passkeyCount > 0, count: passkeyCount },
            totp: { configured: totpConfigured, pending: Boolean(totpPending) },
        },
        contact: {
            email: String(user.contactEmail || ''),
            verified: hasVerifiedMailbox(user),
            pending: Boolean(contactChallenge && Date.parse(contactChallenge.expiresAt) > Date.now()),
        },
        credits: { balance: account?.balance ?? 0, reservedBalance: account?.reservedBalance ?? 0 },
        subscription: active
    };
}
