/**
 * Management auth routes.
 *
 * POST /management/auth/login
 * POST /management/auth/logout
 * GET  /management/auth/session
 */

import { readJsonBody } from '../core/json-body.mjs';
import { sendJson } from '../core/responses.mjs';
import { BadRequestError, RateLimitExceededError } from '../core/errors.mjs';
import {
    loginAdmin,
    requireAdmin,
    createAdminSessionCookie,
} from '../runtime/security/dashboard-auth.mjs';
import { verifyRequiredCsrf } from '../runtime/security/csrf.mjs';
import { DEFAULTS } from '../config/defaults.mjs';

// ── Login rate limiting ─────────────────────────────────────────────
const LOGIN_WINDOW_MS = 60_000;
const LOGIN_MAX_ATTEMPTS = 5;

/** @type {Map<string, number[]>} IP -> sorted array of timestamps */
const _loginAttempts = new Map();

function checkLoginRateLimit(ip) {
    const now = Date.now();
    const cutoff = now - LOGIN_WINDOW_MS;
    let timestamps = _loginAttempts.get(ip);
    if (timestamps) {
        timestamps = timestamps.filter((t) => t > cutoff);
    } else {
        timestamps = [];
    }
    if (timestamps.length >= LOGIN_MAX_ATTEMPTS) {
        _loginAttempts.set(ip, timestamps);
        throw new RateLimitExceededError('login', 60);
    }
    timestamps.push(now);
    _loginAttempts.set(ip, timestamps);
}

/**
 * POST /management/auth/login
 * Body: { password }
 * Response: { ok, expiresAt, csrfToken, token? }
 */
export async function handleLogin(ctx) {
    const { req, res, appCtx } = ctx;

    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
        || req.socket?.remoteAddress
        || 'unknown';
    checkLoginRateLimit(ip);

    const body = await readJsonBody(req);

    if (!body || typeof body.password !== 'string') {
        throw new BadRequestError('Missing password field');
    }

    const config = appCtx.config.env;
    const { token, expiresAt, csrfToken } = await loginAdmin(body.password, config);

    const cookie = createAdminSessionCookie(token, DEFAULTS.adminSessionTtlMs);
    res.setHeader('Set-Cookie', cookie);

    sendJson(res, 200, {
        ok: true,
        expiresAt,
        csrfToken,
        token,
    });
}

/**
 * POST /management/auth/logout
 * Clears the session cookie.
 */
export async function handleLogout(ctx) {
    const { req, res, appCtx } = ctx;

    const decoded = await requireAdmin(
        req,
        appCtx.config.env,
        appCtx.routerAuth || appCtx
    );
    verifyRequiredCsrf({
        headers: req.headers,
        session: { csrfToken: decoded.csrfToken },
    });

    // Clear cookie by setting Max-Age=0
    res.setHeader(
        'Set-Cookie',
        'soul_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0'
    );
    sendJson(res, 200, { ok: true });
}

/**
 * GET /management/auth/session
 * Validate current admin session.
 */
export async function handleSession(ctx) {
    const { req, res, appCtx } = ctx;

    try {
        const decoded = await requireAdmin(
            req,
            appCtx.config.env,
            appCtx.routerAuth || appCtx
        );
        sendJson(res, 200, {
            authenticated: true,
            expiresAt: decoded.exp,
        });
    } catch {
        sendJson(res, 200, {
            authenticated: false,
            expiresAt: null,
        });
    }
}
