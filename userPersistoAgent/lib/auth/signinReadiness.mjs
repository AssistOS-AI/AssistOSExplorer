import { getStore } from '../store.mjs';
import { getAuthPolicy } from '../policy.mjs';
import { hasVerifiedMailbox } from '../users.mjs';
import { getEmailAuthCodeStatus } from '../email-agent-client.mjs';
import { GOOGLE_ISSUER, googleIdentityKey } from '../externalIdentities.mjs';
import { getGoogleStatus } from './google.mjs';
import { readPasswordCredential } from './userPassword.mjs';

// Read-only sign-in readiness for one browser origin. An active account is at
// risk when it has no usable non-passkey sign-in method on that origin: passkeys
// are bound to the origin that registered them and are deliberately excluded.
// The result carries counts and opaque account IDs only, never emails,
// credential material, Google identities or provider configuration.
const PAGE_SIZE = 100;
const MAX_ORIGIN_LENGTH = 2048;

function readinessError(code, statusCode, message) {
    return Object.assign(new Error(message), { code, statusCode });
}

export function normalizeReadinessOrigin(origin) {
    const value = typeof origin === 'string' ? origin : '';
    let parsed = null;
    try { parsed = value && value.length <= MAX_ORIGIN_LENGTH ? new URL(value) : null; } catch { parsed = null; }
    if (!parsed || !['https:', 'http:'].includes(parsed.protocol) || parsed.origin !== value) {
        throw readinessError('invalid_origin', 400, 'origin must be an exact http(s) origin such as https://example.com.');
    }
    return value;
}

function callbackOrigin(redirectUri) {
    try { return redirectUri ? new URL(redirectUri).origin : ''; } catch { return ''; }
}

// Same identity checks a Google sign-in applies to an existing binding: one
// Google binding per account whose stored key matches its issuer and subject.
function hasValidGoogleBinding(user, bindings) {
    const google = bindings.filter((binding) => binding?.issuer === GOOGLE_ISSUER);
    if (google.length !== 1) return false;
    const [binding] = google;
    if (binding.userId !== user.id || typeof binding.subject !== 'string' || !binding.subject) return false;
    try { return binding.identityKey === googleIdentityKey({ issuer: binding.issuer, subject: binding.subject }); } catch { return false; }
}

async function hasUsableMethod(store, user, environment) {
    const { enabled, emailDeliveryAvailable, googleUsable } = environment;
    // Password: the same usability test password reset applies.
    if (enabled.has('password') && user.email && (await readPasswordCredential(store, user.id))?.usable) return true;
    if (enabled.has('totp') && user.email) {
        const totp = await store.getAuthMethodByKey(`${user.id}:totp`);
        if (totp?.userId === user.id && totp.type === 'totp' && totp.enabled === true) return true;
    }
    if (enabled.has('emailCode') && emailDeliveryAvailable && hasVerifiedMailbox(user)) return true;
    if (googleUsable && hasValidGoogleBinding(user, await store.getExternalIdentitiesObjectsByUserId(user.id) || [])) return true;
    return false;
}

export async function getSignInReadiness({ origin } = {}, { emailStatus = getEmailAuthCodeStatus } = {}) {
    const readinessOrigin = normalizeReadinessOrigin(origin);
    const store = await getStore();
    const policy = await getAuthPolicy();
    // Provider-level facts are resolved once, before enumerating accounts.
    const google = await getGoogleStatus();
    const environment = {
        enabled: new Set(policy.enabledAuthMethods),
        emailDeliveryAvailable: (await emailStatus()).available === true,
        googleUsable: google.available === true && callbackOrigin(google.redirectUri) === readinessOrigin,
    };
    let activeUsers = 0;
    let passkeyUsers = 0;
    const atRiskUserIds = [];
    for (let start = 0; ; start += PAGE_SIZE) {
        const page = await store.select('user', { status: 'active' }, { start, pageSize: PAGE_SIZE });
        for (const user of page.objects) {
            if (user?.status !== 'active') continue;
            activeUsers += 1;
            const methods = await store.getAuthMethodsObjectsByUserId(user.id) || [];
            if (methods.some((method) => method.type === 'passkey' && method.enabled === true)) passkeyUsers += 1;
            if (!(await hasUsableMethod(store, user, environment))) atRiskUserIds.push(user.id);
        }
        if (page.objects.length < PAGE_SIZE) break;
    }
    atRiskUserIds.sort();
    return {
        origin: readinessOrigin,
        activeUsers,
        atRisk: atRiskUserIds.length,
        atRiskUserIds,
        passkeyUsers,
        emailDeliveryAvailable: environment.emailDeliveryAvailable,
    };
}
