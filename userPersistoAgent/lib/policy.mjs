import { getStore, flush } from './store.mjs';
import { serialize } from './serial.mjs';
import { withPersistenceScope } from './persistence-scope.mjs';
import { getEmailAuthCodeStatus } from './email-agent-client.mjs';
import { describeManagedRouterOrigins, resolveManagedRouterOrigins } from './auth/managedRouterOrigins.mjs';

// Ordinary accounts are passwordless. The installation administrator password
// is a separate, single-account exception and never a policy method.
const AUTH_METHODS = new Set(['emailCode', 'passkey', 'totp', 'google']);
export const REGISTRATION_ROLE = 'selfRegistered';
const POLICY_FIELDS = new Set(['enabledAuthMethods', 'selfRegistrationEnabled', 'allowedRedirectOrigins']);
// Returned with the policy for administrators; generated or derived, never saved.
const READ_ONLY_POLICY_FIELDS = new Set([
    'registrationRole',
    'environmentOverrides',
    'allowedRedirectOriginsSource',
    'loopbackOriginsAllowed',
    'managedOriginTrustEnabled',
    'managedOriginStatus',
    'managedOriginGeneration',
    'managedRedirectOrigins',
    'effectiveRedirectOrigins',
]);
const DEFAULT_POLICY = Object.freeze({
    enabledAuthMethods: ['emailCode', 'passkey', 'totp', 'google'],
    selfRegistrationEnabled: true,
    allowedRedirectOrigins: [],
});
const warnedEnvironmentMethods = new Set();
// Not a method name, so it cannot collide with one in the warned-once set.
const EMPTY_OVERRIDE = Symbol('empty-auth-method-override');

function policyError(code, message, statusCode = 400) {
    return Object.assign(new Error(message), { code, statusCode });
}

function uniqueStrings(value) {
    return [...new Set((Array.isArray(value) ? value : [])
        .map((entry) => String(entry || '').trim())
        .filter(Boolean))];
}

function envList(name) {
    const raw = String(process.env[name] || '').trim();
    return raw ? uniqueStrings(raw.split(',')) : null;
}

// An environment override naming a retired method (for example `password`)
// must not re-enable it or take the whole sign-in surface down.
function environmentMethods() {
    const configured = envList('USERPERSISTO_AUTH_METHODS');
    if (!configured) return null;
    const supported = configured.filter((method) => AUTH_METHODS.has(method));
    for (const method of configured.filter((entry) => !AUTH_METHODS.has(entry))) {
        if (warnedEnvironmentMethods.has(method)) continue;
        warnedEnvironmentMethods.add(method);
        console.warn(`[userPersisto] USERPERSISTO_AUTH_METHODS ignores unsupported method "${method.slice(0, 32).replace(/[^A-Za-z0-9_-]/g, '')}".`);
    }
    // An override that names only retired methods filters down to nothing, and
    // an empty list would fail every policy read. Ignore it instead, so the
    // override can never be the reason nobody can sign in.
    if (!supported.length) {
        if (!warnedEnvironmentMethods.has(EMPTY_OVERRIDE)) {
            warnedEnvironmentMethods.add(EMPTY_OVERRIDE);
            console.warn('[userPersisto] USERPERSISTO_AUTH_METHODS names no supported method and is ignored.');
        }
        return null;
    }
    return supported;
}

function normalizeOrigins(value) {
    return uniqueStrings(value).map((entry) => {
        let url;
        try {
            url = new URL(entry);
        } catch {
            throw policyError('invalid_redirect_origin', `Invalid redirect origin: ${entry}`);
        }
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
            throw policyError('invalid_redirect_origin', `Redirect allow-list entries must be bare http(s) origins: ${entry}`);
        }
        return url.origin;
    });
}

function normalizePolicy(input = {}) {
    const requestedMethods = uniqueStrings(input.enabledAuthMethods);
    const unsupportedMethod = requestedMethods.find((method) => !AUTH_METHODS.has(method));
    if (unsupportedMethod) {
        throw policyError('invalid_auth_method', `Unsupported authentication method: ${unsupportedMethod}`);
    }
    const methods = requestedMethods.filter((method) => AUTH_METHODS.has(method));
    if (!methods.length) {
        throw policyError('auth_method_required', 'At least one supported authentication method must be enabled.');
    }
    return {
        enabledAuthMethods: methods,
        selfRegistrationEnabled: input.selfRegistrationEnabled !== false,
        allowedRedirectOrigins: normalizeOrigins(input.allowedRedirectOrigins || []),
    };
}

// Public signup always receives exactly `selfRegistered`. This fails closed if
// that role was ever changed to grant administration or Explorer access.
export async function assertRegistrationRoleAllowed(roleName = REGISTRATION_ROLE, store = null) {
    const persisto = store || await getStore();
    const normalizedRole = String(roleName || '').trim();
    const role = normalizedRole === REGISTRATION_ROLE ? await persisto.getRoleByName(normalizedRole) : null;
    if (!role) throw policyError('unknown_role', `Unknown registration role: ${normalizedRole}`);
    const links = await persisto.getRolePermsObjectsByRoleId(role.id) || [];
    for (const link of links) {
        const capability = String((await persisto.getPermission(link.permissionId))?.capability || '');
        if (capability.startsWith('admin.') || capability === 'explorer.access') {
            throw Object.assign(policyError(
                'registration_role_must_be_restricted',
                'The registration role must not grant administrative or Explorer access.',
            ), { statusCode: 503 });
        }
    }
    return role;
}

async function readStoredPolicy(store) {
    const record = await store.getSystemSettingByKey('auth.policy');
    return record?.value && typeof record.value === 'object' ? record.value : null;
}

function storedFields(value) {
    return Object.fromEntries(Object.entries(value || {}).filter(([key]) => POLICY_FIELDS.has(key)));
}

function applyEnvironment(policy) {
    const merged = { ...policy };
    const configuredMethods = environmentMethods();
    const configuredOrigins = envList('USERPERSISTO_ALLOWED_REDIRECT_ORIGINS');
    if (configuredMethods) merged.enabledAuthMethods = configuredMethods;
    if (configuredOrigins) merged.allowedRedirectOrigins = configuredOrigins;
    if (String(process.env.USERPERSISTO_SELF_REGISTRATION_ENABLED || '').trim()) {
        merged.selfRegistrationEnabled = String(process.env.USERPERSISTO_SELF_REGISTRATION_ENABLED).trim().toLowerCase() === 'true';
    }
    return merged;
}

export function environmentPolicyOverrides() {
    return ['USERPERSISTO_AUTH_METHODS', 'USERPERSISTO_ALLOWED_REDIRECT_ORIGINS', 'USERPERSISTO_SELF_REGISTRATION_ENABLED']
        .filter((name) => String(process.env[name] || '').trim());
}

export async function getAuthPolicy() {
    const store = await getStore();
    const stored = await readStoredPolicy(store);
    return normalizePolicy(applyEnvironment({ ...DEFAULT_POLICY, ...storedFields(stored) }));
}

// Administrative metadata such as managed Router origins must never become
// stored policy through a read-modify-save round trip.
export function assertWritablePolicyFields(patch = {}) {
    const readOnly = Object.keys(patch || {}).find((key) => READ_ONLY_POLICY_FIELDS.has(key));
    if (readOnly) throw policyError('read_only_policy_field', `Policy field is read-only: ${readOnly}`);
}

export async function updateAuthPolicy(patch = {}, { actorId = 'system', emailStatus = getEmailAuthCodeStatus } = {}) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw policyError('invalid_policy', 'Policy must be an object.');
    assertWritablePolicyFields(patch);
    const unknown = Object.keys(patch).find((key) => !POLICY_FIELDS.has(key));
    if (unknown) throw policyError('invalid_policy_field', `Unsupported policy field: ${unknown.slice(0, 64)}`);
    // Resolve provider readiness once, outside the durable-write scope. Do not
    // hold the store lock over agent network calls or probe again per account.
    const emailAvailable = (await emailStatus()).available === true;
    return serialize('auth.policy', () => withPersistenceScope(async () => {
        const store = await getStore();
        const stored = normalizePolicy({ ...DEFAULT_POLICY, ...storedFields(await readStoredPolicy(store)), ...patch });
        // Environment overrides win at read time, so check the policy that will
        // actually apply after this save rather than only the stored value.
        const effective = normalizePolicy(applyEnvironment(stored));
        await assertAdministratorMethodRemains(store, effective, emailAvailable);
        const existing = await store.getSystemSettingByKey('auth.policy');
        const record = {
            key: 'auth.policy',
            value: stored,
            updatedAt: new Date().toISOString(),
            updatedBy: String(actorId || 'system'),
        };
        if (existing) {
            await store.updateSystemSetting(existing.id, record);
        } else {
            await store.createSystemSetting(record);
        }
        await flush();
        return effective;
    }));
}

// Deliberate policy saves must leave every active administrator at least one
// usable sign-in method. Optional passkey/TOTP enrollment is never required.
async function assertAdministratorMethodRemains(store, policy, emailAvailable) {
    let stranded = false;
    for (let start = 0; ; start += 100) {
        const page = await store.select('user', { status: 'active' }, { start, pageSize: 100 });
        for (const user of page.objects) {
            if (!(await hasCapability(store, user.id, 'admin.agentSettings.manage'))) continue;
            if ((await usableSignInMethods(user, { store, policy, emailAvailable })).length) continue;
            stranded = true;
        }
        if (page.objects.length < 100) break;
    }
    if (stranded) throw policyError('administrator_auth_method_required', 'Keep a usable administrator sign-in method enabled before saving this policy.');
}

async function hasCapability(store, userId, capability) {
    for (const link of await store.getUserRolesObjectsByUserId(userId) || []) {
        const role = await store.getRole(link.roleId);
        for (const permission of role ? await store.getRolePermsObjectsByRoleId(role.id) || [] : []) {
            if ((await store.getPermission(permission.permissionId))?.capability === capability) return true;
        }
    }
    return false;
}

// Sign-in methods an account can actually use under the effective policy and
// configuration: administrator password only for its designated account, email
// code only with a verified mailbox, passkey/TOTP when enrolled and reachable
// through that mailbox, Google when configured and bound. Read-only; safe inside
// the persistence scope.
export async function usableSignInMethods(user, { store = null, policy = null, includeAdministratorPassword = true, emailAvailable = false } = {}) {
    if (!user || user.status !== 'active') return [];
    const persisto = store || await getStore();
    const effective = policy || await getAuthPolicy();
    const enabled = effective.enabledAuthMethods;
    const methods = [];
    if (includeAdministratorPassword) {
        const { administratorPasswordUsableFor } = await import('./auth/adminPassword.mjs');
        if (await administratorPasswordUsableFor(user.id)) methods.push('adminPassword');
    }
    if (emailAvailable && enabled.includes('emailCode') && user.email && user.emailVerifiedAt) methods.push('emailCode');
    const credentials = await persisto.getAuthMethodsObjectsByUserId(user.id) || [];
    for (const type of ['passkey', 'totp']) {
        if (user.email && enabled.includes(type) && credentials.some((method) => method.enabled && method.type === type)) methods.push(type);
    }
    if (enabled.includes('google')) {
        const { getGoogleStatus } = await import('./auth/google.mjs');
        const bound = (await persisto.getExternalIdentitiesObjectsByUserId(user.id) || []).some((binding) => binding.issuer === 'https://accounts.google.com');
        if (bound && (await getGoogleStatus()).configured) methods.push('google');
    }
    return methods;
}

export async function isAuthMethodEnabled(method) {
    return (await getAuthPolicy()).enabledAuthMethods.includes(String(method || ''));
}

export function isLoopbackOrigin(origin) {
    try {
        const hostname = new URL(origin).hostname.toLowerCase();
        return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
    } catch {
        return false;
    }
}

/**
 * One authentication decision. Its validation steps may share a single fresh
 * managed-origin read; a new decision always reads again.
 */
export function createOriginDecision() {
    let managed = null;
    return Object.freeze({
        managedRouterOrigins() {
            managed ||= resolveManagedRouterOrigins();
            return managed;
        },
    });
}

// Effective membership shared by redirect and browser-origin checks:
// implicit loopback, then the configured explicit list, then (only when
// needed) the freshly verified managed Router origins.
async function isAuthenticationOriginAllowed(origin, decision) {
    if (isLoopbackOrigin(origin)) return true;
    if ((await getAuthPolicy()).allowedRedirectOrigins.includes(origin)) return true;
    const managed = await (decision || createOriginDecision()).managedRouterOrigins();
    return managed.state === 'verified' && managed.origins.includes(origin);
}

export async function assertBrowserOriginAllowed(origin, { decision } = {}) {
    let url;
    try {
        url = new URL(String(origin || ''));
    } catch {
        throw policyError('invalid_browser_origin', 'Browser origin must be an absolute http(s) origin.');
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
        throw policyError('invalid_browser_origin', 'Browser origin must be a bare http(s) origin without credentials.');
    }
    if (!(await isAuthenticationOriginAllowed(url.origin, decision))) {
        throw policyError('browser_origin_not_allowed', 'This address is not enabled for authentication.', 403);
    }
    return url.origin;
}

export async function assertRedirectUriAllowed(redirectUri, { decision } = {}) {
    let url;
    try {
        url = new URL(String(redirectUri || ''));
    } catch {
        throw policyError('invalid_redirect_uri', 'The sign-in callback address is invalid.');
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
        throw policyError('invalid_redirect_uri', 'The sign-in callback address is invalid.');
    }
    if (!(await isAuthenticationOriginAllowed(url.origin, decision))) {
        throw policyError(
            'redirect_origin_not_allowed',
            'Sign-in is not enabled for this address. Use a configured workspace address or contact the workspace administrator.',
            403,
        );
    }
    return url.toString();
}

/**
 * Read-only origin provenance for administrators. Managed origins come from a
 * fresh read and are reported beside, never inside, the writable explicit list.
 */
export async function describeOriginPolicy(policy = null) {
    const effective = policy || await getAuthPolicy();
    const managed = await describeManagedRouterOrigins();
    return {
        allowedRedirectOriginsSource: envList('USERPERSISTO_ALLOWED_REDIRECT_ORIGINS') ? 'environment' : 'policy',
        loopbackOriginsAllowed: true,
        managedOriginTrustEnabled: managed.enabled,
        managedOriginStatus: managed.status,
        managedOriginGeneration: managed.generation,
        managedRedirectOrigins: managed.origins,
        effectiveRedirectOrigins: [...new Set([...effective.allowedRedirectOrigins, ...managed.origins])].sort(),
    };
}

export { DEFAULT_POLICY };
