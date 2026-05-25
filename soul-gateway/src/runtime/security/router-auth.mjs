import { isEmbeddedMode } from '../../config/env.mjs';

const EXPECTED_TOOL = '__http_service__';

let _verifyFn = null;
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

async function loadVerifier(config = {}) {
    if (typeof config.verifyInvocationToken === 'function') {
        return config.verifyInvocationToken;
    }
    if (_verifyFn) return _verifyFn;
    try {
        const mod = await import('achillesAgentLib/jwt/jwtVerify.mjs');
        _verifyFn = mod.verifyInvocationToken;
        return _verifyFn;
    } catch {
        throw new RouterAuthError('achillesAgentLib JWT verifier not available');
    }
}

async function resolveReplayCache(config = {}) {
    if (config.replayCache) return config.replayCache;
    if (_replayCache) return _replayCache;
    try {
        const mod = await import('achillesAgentLib/jwt/jwtVerify.mjs');
        if (typeof mod.createMemoryReplayCache === 'function') {
            _replayCache = mod.createMemoryReplayCache({ maxSize: 4096 });
        }
    } catch {
        // loadVerifier() reports the actionable error; absence of replay cache
        // should not mask that path.
    }
    return _replayCache;
}

function resolveSecret(config) {
    const derivedKey = config.env.PLOINKY_DERIVED_MASTER_KEY
        || process.env.PLOINKY_DERIVED_MASTER_KEY;
    if (!derivedKey) {
        throw new RouterAuthError('PLOINKY_DERIVED_MASTER_KEY not configured');
    }
    return Buffer.from(String(derivedKey).trim(), 'hex');
}

export async function authenticateRouterAdmin(req, config) {
    if (!isEmbeddedMode(config.env)) {
        return null;
    }
    if (!config.env.TRUST_PLOINKY_ROUTER_AUTH) {
        return null;
    }

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

    const verifyInvocationToken = await loadVerifier(config);
    const replayCache = await resolveReplayCache(config);
    const secret = resolveSecret(config);
    const principal = process.env.PLOINKY_AGENT_PRINCIPAL
        || 'agent:proxies/soul-gateway';

    verifyInvocationToken(invocationToken, {
        secret,
        expectedAudience: principal,
        expectedTool: EXPECTED_TOOL,
        bodyObject: authInfo.invocationBody,
        replayCache,
    });

    return {
        authenticated: true,
        source: 'router-sso',
        user: authInfo.user,
    };
}
