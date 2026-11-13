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
    if (grant) {
        const { authInfoFromInvocation } = await loadInvocationAuth();
        return authInfoFromInvocation(grant, {
            invocationToken: envelope?.metadata?.invocationToken || '',
        });
    }
    return {};
}

export function actorContext(authInfo = {}) {
    const userId = authInfo?.user?.id
        || authInfo?.user?.sub
        || authInfo?.sub
        || authInfo?.actor?.id
        || '';
    const roles = Array.isArray(authInfo?.user?.roles)
        ? authInfo.user.roles
        : (Array.isArray(authInfo?.actor?.roles)
            ? authInfo.actor.roles
            : (Array.isArray(authInfo?.roles) ? authInfo.roles : []));
    const invocation = authInfo.invocation;
    const caller = invocation?.caller;
    const agentId = !authInfo.user && caller?.kind === 'agent' && invocation.actor?.kind === 'agent'
        && caller.id === invocation.actor.id && caller.id === invocation.subject ? caller.id : '';
    return {
        ...(agentId ? { agentId } : {}),
        actorUserId: String(userId).replace(/^user:/, ''),
        actorRoles: roles.map(String),
    };
}
