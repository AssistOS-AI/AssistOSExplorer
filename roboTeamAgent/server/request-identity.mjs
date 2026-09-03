export function parseRouterAuthInfo(req) {
    const raw = req?.headers?.['x-ploinky-auth-info'];
    if (!raw) return null;
    try {
        const parsed = JSON.parse(String(raw));
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
        return null;
    }
}

export function routerUser(req) {
    const authInfo = parseRouterAuthInfo(req);
    const user = authInfo?.user;
    if (!user || typeof user !== 'object') return null;
    const id = String(user.id || user.sub || '').trim();
    if (!id) return null;
    return {
        id,
        username: String(user.username || user.name || user.email || '').trim(),
        roles: Array.isArray(user.roles) ? user.roles.map(String) : [],
    };
}

export function requestActor(req, internalToken) {
    const suppliedInternalToken = String(req?.headers?.['x-roboteam-internal-token'] || '');
    if (internalToken && suppliedInternalToken.length === internalToken.length) {
        const left = Buffer.from(suppliedInternalToken);
        const right = Buffer.from(internalToken);
        if (left.length === right.length && cryptoSafeEqual(left, right)) {
            const id = String(req?.headers?.['x-roboteam-user-id'] || '').trim();
            let roles = [];
            try {
                const parsed = JSON.parse(String(req?.headers?.['x-roboteam-user-roles'] || '[]'));
                if (Array.isArray(parsed)) roles = parsed.map(String);
            } catch {
                roles = [];
            }
            return { id, username: '', roles, internal: true };
        }
    }
    const user = routerUser(req);
    return user ? { ...user, internal: false } : null;
}

export function isAdminActor(actor) {
    const roles = Array.isArray(actor?.roles) ? actor.roles : [];
    return roles.some((role) => String(role || '').trim().toLowerCase() === 'admin')
        || String(actor?.username || '').trim().toLowerCase() === 'admin'
        || String(actor?.id || '').trim().toLowerCase() === 'local:admin';
}

function cryptoSafeEqual(left, right) {
    let difference = 0;
    for (let index = 0; index < left.length; index += 1) {
        difference |= left[index] ^ right[index];
    }
    return difference === 0;
}
