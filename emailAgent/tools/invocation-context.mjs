async function loadInvocationAuth() {
    const candidates = [
        process.env.PLOINKY_INVOCATION_AUTH_MODULE,
        '/Agent/lib/invocation-auth.mjs',
        '../../shared/invocation-auth.mjs',
    ].filter(Boolean);
    for (const candidate of candidates) {
        try {
            return await import(candidate);
        } catch (_) {}
    }
    throw new Error('Unable to load the verified invocation-auth helper.');
}

export async function authInfoFromEnvelope(envelope = {}) {
    const grant = envelope?.metadata?.invocation;
    if (grant && typeof grant === 'object') {
        const { authInfoFromInvocation } = await loadInvocationAuth();
        return authInfoFromInvocation(grant, {
            invocationToken: envelope?.metadata?.invocationToken || '',
        });
    }
    return {};
}

export function assertEmailToolAuthorized(toolName, authInfo = {}) {
    const adminTools = new Set([
        'email_config_get',
        'email_config_set',
        'email_provider_status',
        'email_send_test',
    ]);
    const internalTools = new Set([
        'email_auth_code_status',
        'email_send_text',
        'email_send_template',
        'email_send_auth_code',
    ]);
    if (adminTools.has(toolName)) {
        const roles = Array.isArray(authInfo?.user?.roles) ? authInfo.user.roles.map(String) : [];
        if (!roles.includes('admin')) {
            throw Object.assign(new Error('Admin access is required.'), {
                code: 'admin_required',
                statusCode: 403,
            });
        }
    }
    if (internalTools.has(toolName)) {
        const principal = String(authInfo?.agent?.principalId || authInfo?.invocation?.caller?.id || '');
        if (!principal.startsWith('agent:')) {
            throw Object.assign(new Error('Agent invocation is required.'), {
                code: 'agent_invocation_required',
                statusCode: 403,
            });
        }
    }
}
