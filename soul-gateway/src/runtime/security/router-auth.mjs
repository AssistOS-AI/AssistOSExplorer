import { pathToFileURL } from 'node:url';

const EXPECTED_TOOL = '__http_service__';

let _verifyHttpServiceFn = null;
let _replayCache = null;

export class RouterAuthError extends Error {
    constructor(message) {
        super(message);
        this.name = 'RouterAuthError';
    }
}

function parseAuthInfoHeader(req) {
    const raw = req.headers?.['x-ploinky-auth-info'];
    if (!raw || typeof raw !== 'string') return null;
    try {
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

function hasAdminRole(authInfo) {
    const roles = authInfo?.user?.roles;
    return Array.isArray(roles) && roles.includes('admin');
}

async function loadHttpServiceVerifier(config = {}) {
    if (typeof config.verifyHttpServiceAuthInfo === 'function') {
        return config.verifyHttpServiceAuthInfo;
    }
    if (_verifyHttpServiceFn) return _verifyHttpServiceFn;
    try {
        const mod = await import(pathToFileURL('/Agent/lib/invocationAuth.mjs').href);
        if (typeof mod.verifyHttpServiceAuthInfoFromHeaders === 'function') {
            _verifyHttpServiceFn = mod.verifyHttpServiceAuthInfoFromHeaders;
            return _verifyHttpServiceFn;
        }
    } catch {
        throw new RouterAuthError('Ploinky HTTP service verifier not available');
    }
    throw new RouterAuthError('Ploinky HTTP service verifier not available');
}

async function resolveReplayCache(config = {}) {
    if (config.replayCache) return config.replayCache;
    if (_replayCache) return _replayCache;
    try {
        const mod = await import('achillesAgentLib/jwt/jwtVerify.mjs');
        if (typeof mod.createMemoryReplayCache === 'function') {
            _replayCache = mod.createMemoryReplayCache({ maxSize: 4096 });
        }
    } catch (err) {
        throw new RouterAuthError(
            `Ploinky router replay cache unavailable: ${err?.message || err}`
        );
    }
    if (!_replayCache) {
        throw new RouterAuthError('Ploinky router replay cache unavailable');
    }
    return _replayCache;
}

function requestSurface(req, invocationBody = {}) {
    const method = String(
        req?.method || invocationBody.method || 'GET'
    ).toUpperCase();
    let path = String(invocationBody.path || '');
    let query = String(invocationBody.search ?? '');
    const rawUrl = String(req?.url || '').trim();
    if (rawUrl) {
        try {
            const parsed = new URL(rawUrl, 'http://soul-gateway.local');
            path = parsed.pathname || path;
            query = parsed.search;
        } catch {
            // Fall back to the signed invocation body if a test double or unusual
            // server adapter supplies a non-URL request target.
        }
    }
    return {
        method,
        path,
        query,
        bodyHash: String(invocationBody.bodyHash || ''),
    };
}

export async function authenticateRouterAdmin(req, config) {
    const authInfo = parseAuthInfoHeader(req);
    if (!authInfo) return null;

    if (!hasAdminRole(authInfo)) {
        throw new RouterAuthError('Router user does not have admin role');
    }

    const invocationToken = authInfo.invocationToken;
    if (!invocationToken) {
        throw new RouterAuthError('Missing router invocation token');
    }
    if (!authInfo.invocationBody || typeof authInfo.invocationBody !== 'object') {
        throw new RouterAuthError('Missing router invocation body');
    }

    const verifyHttpServiceAuthInfo = await loadHttpServiceVerifier(config);
    const replayCache = await resolveReplayCache(config);
    const surface = requestSurface(req, authInfo.invocationBody);

    const verified = await verifyHttpServiceAuthInfo(req.headers || {}, {
        env: config?.env || config || process.env,
        replayCache,
        method: surface.method,
        path: surface.path,
        query: surface.query,
        bodyHash: surface.bodyHash,
    });
    if (!verified?.ok) {
        throw new RouterAuthError(
            verified?.reason || `Invalid ${EXPECTED_TOOL} router request`
        );
    }

    return {
        authenticated: true,
        source: 'router-sso',
        user: authInfo.user,
    };
}
