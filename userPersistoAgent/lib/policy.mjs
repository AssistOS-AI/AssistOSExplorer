import { getStore, flush } from './store.mjs';
import { serialize } from './serial.mjs';
import { withPersistenceScope } from './persistence-scope.mjs';

const AUTH_METHODS = new Set(['password', 'emailCode', 'passkey', 'totp', 'google']);
const DEFAULT_POLICY = Object.freeze({
    enabledAuthMethods: ['password'],
    selfRegistrationEnabled: true,
    defaultRegistrationRole: 'selfRegistered',
    allowedRedirectOrigins: [],
});

function policyError(code, message) {
    return Object.assign(new Error(message), { code, statusCode: 400 });
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
    const defaultRegistrationRole = String(input.defaultRegistrationRole || 'selfRegistered').trim();
    if (!defaultRegistrationRole) {
        throw policyError('registration_role_required', 'defaultRegistrationRole is required.');
    }
    return {
        enabledAuthMethods: methods,
        selfRegistrationEnabled: input.selfRegistrationEnabled !== false,
        defaultRegistrationRole,
        allowedRedirectOrigins: normalizeOrigins(input.allowedRedirectOrigins || []),
    };
}

export async function assertRegistrationRoleAllowed(roleName, store = null) {
    const persisto = store || await getStore();
    const normalizedRole = String(roleName || '').trim();
    const role = normalizedRole ? await persisto.getRoleByName(normalizedRole) : null;
    if (!role) throw policyError('unknown_role', `Unknown default registration role: ${normalizedRole}`);
    const links = await persisto.getRolePermsObjectsByRoleId(role.id) || [];
    for (const link of links) {
        const permission = await persisto.getPermission(link.permissionId);
        if (String(permission?.capability || '').startsWith('admin.')) {
            throw policyError(
                'registration_role_must_be_non_admin',
                'The default registration role must not grant administrative capabilities.',
            );
        }
    }
    return role;
}

async function readStoredPolicy(store) {
    const record = await store.getSystemSettingByKey('auth.policy');
    return record?.value && typeof record.value === 'object' ? record.value : null;
}

export async function getAuthPolicy() {
    const store = await getStore();
    const stored = await readStoredPolicy(store);
    const merged = { ...DEFAULT_POLICY, ...(stored || {}) };
    const configuredMethods = envList('USERPERSISTO_AUTH_METHODS');
    const configuredOrigins = envList('USERPERSISTO_ALLOWED_REDIRECT_ORIGINS');
    if (configuredMethods) merged.enabledAuthMethods = configuredMethods;
    if (configuredOrigins) merged.allowedRedirectOrigins = configuredOrigins;
    if (String(process.env.USERPERSISTO_DEFAULT_REGISTRATION_ROLE || '').trim()) {
        merged.defaultRegistrationRole = String(process.env.USERPERSISTO_DEFAULT_REGISTRATION_ROLE).trim();
    }
    if (String(process.env.USERPERSISTO_SELF_REGISTRATION_ENABLED || '').trim()) {
        merged.selfRegistrationEnabled = String(process.env.USERPERSISTO_SELF_REGISTRATION_ENABLED).trim().toLowerCase() === 'true';
    }
    return normalizePolicy(merged);
}

export async function updateAuthPolicy(patch = {}, { actorId = 'system' } = {}) {
    return serialize('auth.policy', () => withPersistenceScope(async () => {
        const store = await getStore();
        const current = await getAuthPolicy();
        const next = normalizePolicy({ ...current, ...patch });
        await assertRegistrationRoleAllowed(next.defaultRegistrationRole, store);
        if (next.enabledAuthMethods.includes('google')) await assertAdministratorMethodRemains(store, next);
        const existing = await store.getSystemSettingByKey('auth.policy');
        const record = {
            key: 'auth.policy',
            value: next,
            updatedAt: new Date().toISOString(),
            updatedBy: String(actorId || 'system'),
        };
        if (existing) {
            await store.updateSystemSetting(existing.id, record);
        } else {
            await store.createSystemSetting(record);
        }
        await flush();
        return next;
    }));
}

async function assertAdministratorMethodRemains(store, policy) {
    const { getGoogleStatus } = await import('./auth/google.mjs');
    const googleConfigured = (await getGoogleStatus()).configured;
    let hasAdministrator = false;
    for (let start = 0; ; start += 100) {
        const page = await store.select('user', { status: 'active' }, { start, pageSize: 100 });
        for (const user of page.objects) {
            const roles = await store.getUserRolesObjectsByUserId(user.id) || [];
            let administrator = false;
            for (const link of roles) {
                const role = await store.getRole(link.roleId);
                const permissions = role ? await store.getRolePermsObjectsByRoleId(role.id) || [] : [];
                for (const permission of permissions) {
                    if ((await store.getPermission(permission.permissionId))?.capability === 'admin.agentSettings.manage') administrator = true;
                }
            }
            if (!administrator) continue;
            hasAdministrator = true;
            if (policy.enabledAuthMethods.includes('password') && user.passwordHash) return;
            if (policy.enabledAuthMethods.includes('emailCode')) return;
            const methods = await store.getAuthMethodsObjectsByUserId(user.id) || [];
            if (methods.some((method) => method.enabled && ['passkey', 'totp'].includes(method.type) && policy.enabledAuthMethods.includes(method.type))) return;
            if (googleConfigured && (await store.getExternalIdentitiesObjectsByUserId(user.id) || []).some((binding) => binding.issuer === 'https://accounts.google.com')) return;
        }
        if (page.objects.length < 100) break;
    }
    if (hasAdministrator) throw policyError('administrator_auth_method_required', 'Keep an enrolled administrator sign-in method enabled before saving this policy.');
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

export async function assertBrowserOriginAllowed(origin) {
    let url;
    try {
        url = new URL(String(origin || ''));
    } catch {
        throw policyError('invalid_browser_origin', 'Browser origin must be an absolute http(s) origin.');
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
        throw policyError('invalid_browser_origin', 'Browser origin must be a bare http(s) origin without credentials.');
    }
    const policy = await getAuthPolicy();
    if (!isLoopbackOrigin(url.origin) && !policy.allowedRedirectOrigins.includes(url.origin)) {
        throw policyError('browser_origin_not_allowed', 'Browser origin is not allowed.');
    }
    return url.origin;
}

export async function assertRedirectUriAllowed(redirectUri) {
    let url;
    try {
        url = new URL(String(redirectUri || ''));
    } catch {
        throw new Error('redirectUri must be an absolute http(s) URL');
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
        throw new Error('redirectUri must be an absolute http(s) URL without credentials');
    }
    const policy = await getAuthPolicy();
    if (!isLoopbackOrigin(url.origin) && !policy.allowedRedirectOrigins.includes(url.origin)) {
        throw new Error('redirectUri origin is not allowed');
    }
    return url.toString();
}

export { DEFAULT_POLICY };
