/**
 * Dashboard (admin) authentication.
 *
 * Admin sessions are HMAC-signed tokens containing an expiry timestamp
 * and a CSRF token.  Format: `{exp}.{csrfToken}.{hmac}`.
 * No external JWT library required.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { compareDashboardPassword } from './password.mjs';
import { parseCookies } from '../../core/cookie.mjs';
import { DEFAULTS } from '../../config/defaults.mjs';
import { AuthenticationRequiredError, ConfigurationError } from '../../core/errors.mjs';
import { authenticateRouterAdmin } from './router-auth.mjs';

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
    const csrfToken = randomBytes(32).toString('hex');
    const signingKey = resolveSigningKey(config);
    const token = signSessionToken(exp, csrfToken, signingKey);

    return { token, expiresAt: exp, csrfToken };
}

/**
 * Middleware-style guard: verify the admin session.
 *
 * In embedded mode, tries router SSO first (verified invocation token
 * from the Ploinky router). Falls back to cookie / bearer session auth.
 *
 * @param {{ headers: Record<string,string> }} req
 * @param {{ ADMIN_SESSION_SIGNING_KEY: string }} config  The env object
 * @param {object} routerAuthOptions Optional verifier / replay-cache injection
 * @returns {Promise<{ exp: number } | { authenticated: true, source: string, user: object }>}
 * @throws {AuthenticationRequiredError} if no valid session is found
 */
export async function requireAdmin(req, config, routerAuthOptions = {}) {
    try {
        const routerResult = await authenticateRouterAdmin(req, {
            ...routerAuthOptions,
            env: config,
        });
        if (routerResult) return routerResult;
    } catch {
        // Router auth rejected — fall through to session auth
    }

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
 * Resolve the signing key: use explicit key or derive from ENCRYPTION_KEY.
 * Throws if neither is configured.
 */
function resolveSigningKey(config) {
    if (config.ADMIN_SESSION_SIGNING_KEY)
        return config.ADMIN_SESSION_SIGNING_KEY;
    if (config.ENCRYPTION_KEY) {
        return createHmac('sha256', config.ENCRYPTION_KEY)
            .update('admin-session')
            .digest('hex');
    }
    throw new ConfigurationError(
        'Dashboard auth requires ADMIN_SESSION_SIGNING_KEY or ENCRYPTION_KEY'
    );
}

/**
 * Sign a session token: `{exp}.{csrfToken}.{hmac}`.
 */
function signSessionToken(exp, csrfToken, signingKey) {
    const payload = `${exp}.${csrfToken}`;
    const sig = createHmac('sha256', signingKey).update(payload).digest('hex');
    return `${payload}.${sig}`;
}

/**
 * Verify a session token and return its decoded payload, or null.
 *
 * Token format: `{exp}.{csrfToken}.{hmac}`
 */
function verifySessionToken(token, signingKey) {
    const lastDot = token.lastIndexOf('.');
    if (lastDot < 0) return null;

    const payload = token.slice(0, lastDot);
    const sig = token.slice(lastDot + 1);

    const expected = createHmac('sha256', signingKey)
        .update(payload)
        .digest('hex');
    const sigBuf = Buffer.from(sig, 'utf8');
    const expectedBuf = Buffer.from(expected, 'utf8');
    if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) return null;

    // Parse payload: "{exp}.{csrfToken}"
    const firstDot = payload.indexOf('.');
    if (firstDot < 0) {
        // Missing CSRF token — reject
        return null;
    }

    const exp = Number(payload.slice(0, firstDot));
    if (!Number.isFinite(exp)) return null;
    const csrfToken = payload.slice(firstDot + 1);
    if (!csrfToken) return null;
    return { exp, csrfToken };
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
