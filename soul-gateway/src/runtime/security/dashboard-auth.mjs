/**
 * Management authentication.
 *
 * Soul Gateway management is protected by the Ploinky router. The router strips
 * caller-supplied identity headers, forwards authenticated user metadata, and
 * signs each protected HTTP service invocation. This module only accepts that
 * verified router identity; the legacy dashboard password/session flow is gone.
 */

import { AuthenticationRequiredError } from '../../core/errors.mjs';
import { authenticateRouterAdmin } from './router-auth.mjs';

export async function requireAdmin(req, config, routerAuthOptions = {}) {
    let routerResult = null;
    try {
        routerResult = await authenticateRouterAdmin(req, {
            ...routerAuthOptions,
            env: config,
        });
    } catch (err) {
        throw new AuthenticationRequiredError(
            err?.message || 'Admin session required'
        );
    }
    if (routerResult) return routerResult;

    throw new AuthenticationRequiredError('Admin session required');
}
