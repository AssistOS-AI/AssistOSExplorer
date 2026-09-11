function routerBaseUrl(config = {}) {
    const explicit = String(config.routerBaseUrl || '').trim();
    if (explicit) {
        return explicit.replace(/\/+$/, '');
    }
    const port = String(process.env.PLOINKY_ROUTER_PORT || process.env.ROUTER_PORT || process.env.PORT || '8080').trim();
    return `http://localhost:${port}`;
}

function browserLoginUrl(loginPath, redirectUri) {
    const callback = new URL(redirectUri);
    if (!['http:', 'https:'].includes(callback.protocol) || callback.username || callback.password) {
        throw new Error('redirectUri must be an absolute http(s) URL without credentials.');
    }
    const login = new URL(loginPath, callback.origin);
    if (login.origin !== callback.origin || login.username || login.password) {
        throw new Error('The login path must stay on the callback origin.');
    }
    return login;
}

function relativeReturnTo(value) {
    const text = typeof value === 'string' ? value : '';
    return text.length <= 2048 && text.startsWith('/') && !text.startsWith('//') && !text.includes('\\') && !/[\u0000-\u001f]/.test(text) ? text : '';
}

function normalizeUser({ user, roles, capabilities }) {
    return {
        id: String(user.id),
        sub: String(user.id),
        username: String(user.username || ''),
        name: String(user.displayName || user.username || user.email || ''),
        email: String(user.email || ''),
        roles: Array.isArray(roles) ? roles : [],
        capabilities: Array.isArray(capabilities) ? capabilities : [],
        raw: { provider: 'userPersistoAgent', status: user.status }
    };
}

function normalizeAdminUser(user = {}) {
    return {
        id: String(user.id || ''),
        username: String(user.username || ''),
        email: String(user.email || ''),
        name: String(user.displayName || user.name || ''),
        displayName: String(user.displayName || user.name || ''),
        status: String(user.status || 'active'),
        roles: Array.isArray(user.roles) ? user.roles.map(String) : [],
    };
}

async function postRuntime(config, endpoint, payload = {}) {
    const base = routerBaseUrl(config);
    const runtimePath = String(config.runtimePath || '/base-agent-additional-server/userPersistoAgent/7000/service/runtime').replace(/\/+$/, '');
    const response = await fetch(new URL(`${runtimePath}/${endpoint}`, base), {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-UserPersisto-Runtime-Secret': config.runtimeSecret
        },
        body: JSON.stringify(payload)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data?.ok === false) {
        const code = String(data?.error || 'userpersisto_runtime_failed');
        throw Object.assign(new Error(code), {
            code,
            statusCode: response.status,
        });
    }
    return data;
}

export function resolveProviderConfig({ providerConfig = {}, readValue } = {}) {
    const runtimeSecretName = String(providerConfig.runtimeSecretName || 'USERPERSISTO_RUNTIME_SECRET').trim();
    const runtimeSecret = String((typeof readValue === 'function' ? readValue(runtimeSecretName) : '') || '').trim();
    if (!runtimeSecret) {
        throw new Error(`UserPersisto runtime secret is not configured (${runtimeSecretName}).`);
    }
    return {
        routerBaseUrl: routerBaseUrl(providerConfig),
        loginPath: String(providerConfig.loginPath || '/base-agent-additional-server/userPersistoAgent/7000/service/auth/').trim(),
        runtimePath: String(providerConfig.runtimePath || '/base-agent-additional-server/userPersistoAgent/7000/service/runtime').trim(),
        runtimeSecret,
        runtimeSecretName
    };
}

export function createProvider({ getConfig }) {
    return {
        name: 'AssistOSExplorer/userPersistoAgent',
        async sso_begin_login({ redirectUri, returnTo }) {
            const config = await getConfig();
            const loginUrl = browserLoginUrl(config.loginPath, redirectUri);
            const { request } = await postRuntime(config, 'sso-login-request', { redirectUri, clientId: 'explorer' });
            loginUrl.searchParams.set('requestId', request.providerState);
            loginUrl.searchParams.set('state', request.providerState);
            // Informational only: the wizard's Start again link sends it back to the
            // Router's /auth/login, which revalidates it as a safe relative target.
            const safeReturnTo = relativeReturnTo(returnTo);
            if (safeReturnTo) loginUrl.searchParams.set('returnTo', safeReturnTo);
            return {
                authorizationUrl: loginUrl.toString(),
                providerState: request.providerState,
                expiresAt: request.expiresAt
            };
        },
        async sso_handle_callback({ query, providerState }) {
            const config = await getConfig();
            const consumed = await postRuntime(config, 'sso-consume-code', { providerState, code: query?.code });
            return {
                user: normalizeUser(consumed),
                providerSession: {
                    provider: 'userPersistoAgent',
                    userId: consumed.user.id,
                    // Credential replacement/revocation advances the account generation;
                    // the next Router revalidation of an older session is refused.
                    generation: Number.isSafeInteger(consumed.generation) ? consumed.generation : 0,
                    expiresAt: Date.now() + 4 * 60 * 60 * 1000
                }
            };
        },
        async sso_refresh_session({ providerSession }) {
            const config = await getConfig();
            const generation = Number.isSafeInteger(providerSession?.generation) ? providerSession.generation : 0;
            const described = await postRuntime(config, 'sso-user', { userId: providerSession?.userId || '', generation });
            return {
                user: normalizeUser(described),
                providerSession: { ...providerSession, generation, expiresAt: Date.now() + 4 * 60 * 60 * 1000 }
            };
        },
        async sso_logout({ postLogoutRedirectUri }) {
            return { redirectUrl: postLogoutRedirectUri || '/' };
        },
        async sso_admin_list_users({ actorUserId, start = 0, pageSize = 500, search = '', excludeOnlyRole = '', includeRoleCounts = false }) {
            const config = await getConfig();
            const result = await postRuntime(config, 'sso-admin-users-list', { actorUserId, start, pageSize, search, excludeOnlyRole, includeRoleCounts });
            return {
                users: (result.users || []).map(normalizeAdminUser),
                totalCount: result.totalCount || 0,
                availableRoles: result.availableRoles || [],
                ...(result.singleRoleCounts ? { singleRoleCounts: result.singleRoleCounts } : {}),
            };
        },
        async sso_admin_create_user() {
            // Accounts are created only by completed sign-in; invitations are deferred.
            throw Object.assign(new Error('user_creation_unsupported'), { code: 'user_creation_unsupported', statusCode: 400 });
        },
        async sso_admin_update_user(input = {}) {
            const config = await getConfig();
            const result = await postRuntime(config, 'sso-admin-user-update', input);
            return normalizeAdminUser(result.user);
        },
        async sso_admin_delete_user(input = {}) {
            const config = await getConfig();
            const result = await postRuntime(config, 'sso-admin-user-delete', input);
            return normalizeAdminUser(result.user);
        },
        invalidateCaches() {}
    };
}
