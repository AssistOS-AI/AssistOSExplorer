/**
 * Dashboard (admin) authentication.
 *
 * Admin sessions are simple HMAC-signed tokens containing an expiry
 * timestamp.  No external JWT library required.
 */

import { createHmac } from 'node:crypto';
import { compareDashboardPassword } from './password.mjs';
import { parseCookies } from '../../core/cookie.mjs';
import { DEFAULTS } from '../../config/defaults.mjs';
import { AuthenticationRequiredError } from '../../core/errors.mjs';

const COOKIE_NAME = 'soul_session';

// ── Public API ──────────────────────────────────────────────────────

/**
 * Verify the dashboard password and return a signed session token.
 *
 * @param {string} password  User-supplied password
 * @param {{ DASHBOARD_PASSWORD: string|null, ADMIN_SESSION_SIGNING_KEY: string }} config
 * @returns {{ token: string, expiresAt: number }}
 * @throws {AuthenticationRequiredError} if the password is wrong or unset
 */
export async function loginAdmin(password, config) {
    if (!config.DASHBOARD_PASSWORD) {
        throw new AuthenticationRequiredError(
            'Dashboard password not configured'
        );
    }

    const ok = compareDashboardPassword(password, config.DASHBOARD_PASSWORD);
    if (!ok) {
        throw new AuthenticationRequiredError('Invalid password');
    }

    const ttl = DEFAULTS.adminSessionTtlMs;
    const exp = Date.now() + ttl;
    const signingKey = resolveSigningKey(config);
    const token = signSessionToken(exp, signingKey);

    return { token, expiresAt: exp };
}

/**
 * Middleware-style guard: verify the admin session from either a
 * cookie or an Authorization bearer header.
 *
 * @param {{ headers: Record<string,string> }} req
 * @param {{ ADMIN_SESSION_SIGNING_KEY: string }} config
 * @returns {{ exp: number }} decoded payload
 * @throws {AuthenticationRequiredError} if the session is missing/invalid/expired
 */
export function requireAdmin(req, config) {
    const token = extractToken(req);
    if (!token) {
        throw new AuthenticationRequiredError('Admin session required');
    }

    const signingKey = resolveSigningKey(config);
    const decoded = verifySessionToken(token, signingKey);
    if (!decoded) {
        throw new AuthenticationRequiredError('Invalid admin session');
    }

    if (decoded.exp <= Date.now()) {
        throw new AuthenticationRequiredError('Admin session expired');
    }

    return decoded;
}

/**
 * Build a Set-Cookie header value for the admin session.
 *
 * @param {string} token
 * @param {number} ttlMs
 * @returns {string}
 */
export function createAdminSessionCookie(token, ttlMs) {
    const maxAge = Math.ceil(ttlMs / 1000);
    return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`;
}

// ── Internals ───────────────────────────────────────────────────────

/**
 * Resolve the signing key: use explicit key, derive from ENCRYPTION_KEY, or use a fallback.
 */
function resolveSigningKey(config) {
    if (config.ADMIN_SESSION_SIGNING_KEY)
        return config.ADMIN_SESSION_SIGNING_KEY;
    if (config.ENCRYPTION_KEY) {
        return createHmac('sha256', config.ENCRYPTION_KEY)
            .update('admin-session')
            .digest('hex');
    }
    return 'soul-gateway-default-signing-key';
}

/**
 * Sign a session token: `{exp}.{hmac}`.
 */
function signSessionToken(exp, signingKey) {
    const payload = String(exp);
    const sig = createHmac('sha256', signingKey).update(payload).digest('hex');
    return `${payload}.${sig}`;
}

/**
 * Verify a session token and return its decoded payload, or null.
 */
function verifySessionToken(token, signingKey) {
    const dotIdx = token.indexOf('.');
    if (dotIdx < 0) return null;

    const payload = token.slice(0, dotIdx);
    const sig = token.slice(dotIdx + 1);

    const expected = createHmac('sha256', signingKey)
        .update(payload)
        .digest('hex');
    if (sig !== expected) return null;

    const exp = Number(payload);
    if (!Number.isFinite(exp)) return null;

    return { exp };
}

/**
 * Extract a session token from cookies or Authorization header.
 */
function extractToken(req) {
    // 1. Authorization: Bearer <token> — most explicit
    const auth = req.headers?.authorization;
    if (auth && auth.startsWith('Bearer ')) {
        return auth.slice(7).trim();
    }

    // 2. Query string ?token=... (for WebSocket upgrades that can't set headers)
    const url = req.url || '';
    const qIdx = url.indexOf('?');
    if (qIdx >= 0) {
        const search = url.slice(qIdx + 1);
        for (const pair of search.split('&')) {
            const [k, v] = pair.split('=');
            if (decodeURIComponent(k) === 'token' && v) {
                return decodeURIComponent(v);
            }
        }
    }

    // 3. Cookie — fallback for browser navigation
    const cookieHeader = req.headers?.cookie;
    if (cookieHeader) {
        const cookies = parseCookies(cookieHeader);
        if (cookies[COOKIE_NAME]) return cookies[COOKIE_NAME];
    }

    return null;
}
