import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { requestActor } from './request-identity.mjs';

// Workspace robot listing is a directory read. It is decided only on the
// Router-signed request, never on the unsigned compatibility header, and only
// for a verified direct user without a guest role who is an administrator or
// holds the Explorer access capability. Internal MCP calls qualify only when the
// tool proved that an agent is listing on its own behalf.
export const LISTING_CAPABILITY = 'explorer.access';
export const AGENT_LISTING_ORIGIN = 'agent';

function normalizedRoles(value) {
    return Array.isArray(value)
        ? value.filter((role) => typeof role === 'string').map((role) => role.trim().toLowerCase())
        : [];
}

export function verifiedDirectUser(payload) {
    const actor = payload?.actor;
    const subject = payload?.sub;
    if (!actor || typeof actor !== 'object' || actor.kind !== 'user') return false;
    if (typeof subject !== 'string' || !/^user:.+/.test(subject) || !subject.slice(5).trim()) return false;
    if (actor.id !== subject) return false;
    return !payload.usr && !payload.user && !payload.delegation;
}

export function listingDecision(payload) {
    if (!verifiedDirectUser(payload)) return { entitled: false, admin: false };
    const roles = normalizedRoles(payload.actor.roles);
    if (roles.includes('guest')) return { entitled: false, admin: false };
    const admin = roles.includes('admin');
    const capabilities = Array.isArray(payload.actor.capabilities) ? payload.actor.capabilities : [];
    return { entitled: admin || capabilities.includes(LISTING_CAPABILITY), admin };
}

async function loadRouteVerifier(env) {
    const runtimeRoot = env.PLOINKY_AGENT_RUNTIME_ROOT || '/Agent';
    try {
        const helper = await import(pathToFileURL(path.resolve(runtimeRoot, 'lib/invocationAuth.mjs')).href);
        const usable = ['verifyHttpRouteAuthInfoFromHeaders', 'readAgentSecret', 'expectedAudienceForSelf']
            .every((name) => typeof helper[name] === 'function');
        return usable ? helper : null;
    } catch {
        return null;
    }
}

function deny(status, error) {
    return { ok: false, status, error };
}

export async function authorizeRobotListing(req, url, { internalToken = '', env = process.env } = {}) {
    const actor = requestActor(req, internalToken);
    if (actor?.internal) {
        if (actor.listingOrigin !== AGENT_LISTING_ORIGIN) {
            return deny(403, 'robot listing requires an agent acting on its own behalf');
        }
        return { ok: true, canAdmin: false };
    }
    if (typeof req.headers['x-ploinky-auth-info'] !== 'string') {
        return deny(401, 'authenticated Ploinky user is required');
    }
    const verifier = await loadRouteVerifier(env);
    if (!verifier || !verifier.readAgentSecret(env) || !verifier.expectedAudienceForSelf(env)) {
        return deny(503, 'request verification is unavailable');
    }
    const verified = verifier.verifyHttpRouteAuthInfoFromHeaders(req.headers, {
        env,
        method: req.method,
        path: url.pathname,
        query: url.search,
        body: Buffer.alloc(0),
    });
    if (!verified?.ok) return deny(401, 'authenticated Ploinky user is required');
    const decision = listingDecision(verified.payload);
    if (!decision.entitled) return deny(403, 'Explorer access is required to list robots');
    return { ok: true, canAdmin: decision.admin };
}

// Whether this exact request is proven to come from a verified non-guest
// administrator. Used only to widen outward projections; any missing helper,
// key, header, verification failure or internal caller yields false. Each
// signed request is verified once, so callers must not combine this with
// authorizeRobotListing on the same request.
export async function verifiedAdminRequest(req, url, { internalToken = '', env = process.env, body = Buffer.alloc(0) } = {}) {
    try {
        if (requestActor(req, internalToken)?.internal) return false;
        if (typeof req.headers['x-ploinky-auth-info'] !== 'string') return false;
        const verifier = await loadRouteVerifier(env);
        if (!verifier || !verifier.readAgentSecret(env) || !verifier.expectedAudienceForSelf(env)) return false;
        const verified = verifier.verifyHttpRouteAuthInfoFromHeaders(req.headers, {
            env, method: req.method, path: url.pathname, query: url.search, body,
        });
        return Boolean(verified?.ok && listingDecision(verified.payload).admin);
    } catch {
        return false;
    }
}
