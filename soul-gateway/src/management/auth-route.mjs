/**
 * Management auth routes.
 *
 * POST /management/auth/login
 * POST /management/auth/logout
 * GET  /management/auth/session
 */

import { readJsonBody } from '../core/json-body.mjs';
import { sendJson } from '../core/responses.mjs';
import { BadRequestError } from '../core/errors.mjs';
import {
  loginAdmin,
  requireAdmin,
  createAdminSessionCookie,
} from '../runtime/security/dashboard-auth.mjs';
import { generateCsrfToken } from '../runtime/security/csrf.mjs';
import { DEFAULTS } from '../config/defaults.mjs';

/**
 * POST /management/auth/login
 * Body: { password }
 * Response: { ok, expiresAt, csrfToken, token? }
 */
export async function handleLogin(ctx) {
  const { req, res, appCtx } = ctx;
  const body = await readJsonBody(req);

  if (!body || typeof body.password !== 'string') {
    throw new BadRequestError('Missing password field');
  }

  const config = appCtx.config.env;
  const { token, expiresAt } = await loginAdmin(body.password, config);
  const csrfToken = generateCsrfToken();

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

  requireAdmin(req, appCtx.config.env);

  // Clear cookie by setting Max-Age=0
  res.setHeader('Set-Cookie', 'soul_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
  sendJson(res, 200, { ok: true });
}

/**
 * GET /management/auth/session
 * Validate current admin session.
 */
export async function handleSession(ctx) {
  const { req, res, appCtx } = ctx;

  try {
    const decoded = requireAdmin(req, appCtx.config.env);
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
