/**
 * Route middleware: resolve the per-request session.
 *
 * Looks up (or creates) the session row for the current API key + agent
 * via the existing session DAO logic.  No-op when the gateway is running
 * without a database.
 *
 * Sets `ctx.session` to a normalized session view:
 *   { id, key, explicitId, agentName, soulId, raw }
 *
 * @module runtime/route/resolve-session
 */

import { resolveSession as resolveSessionDao } from '../../request/session.mjs';

/**
 * @returns {(ctx: object, next: () => Promise<void>) => Promise<void>}
 */
export function resolveSessionMiddleware() {
    return async function resolveSessionMw(ctx, next) {
        const apiKey = ctx.auth?.apiKeyRecord;
        const pool = ctx.appCtx?.pool;
        const env = ctx.appCtx?.config?.env || {};

        if (!apiKey || !pool || !env.DATABASE_URL) {
            // No DB → no persistent session.  Build a synthetic identity-only
            // session view so downstream middleware (rate limiter, loop detector)
            // still has a stable session key.
            const explicitId = ctx.identity?.explicitSessionId || null;
            const keyId = ctx.auth?.keyId || 'anonymous';
            ctx.session = {
                id: explicitId,
                key: explicitId ? `explicit:${keyId}:${explicitId}` : keyId,
                explicitId,
                agentName: ctx.identity?.agentName || null,
                soulId: ctx.identity?.soulId || null,
                raw: null,
            };
            await next();
            return;
        }

        const sessionCtx = {
            identity: ctx.identity,
            apiKey,
            appCtx: ctx.appCtx,
        };
        const session = await resolveSessionDao(sessionCtx);

        const explicitId =
            ctx.identity?.explicitSessionId ||
            session?.explicit_session_id ||
            null;
        const keyId = ctx.auth?.keyId || 'anonymous';
        ctx.session = {
            id: session?.id || explicitId || null,
            key: explicitId
                ? `explicit:${keyId}:${explicitId}`
                : session?.group_key || keyId || 'default',
            explicitId,
            agentName: ctx.identity?.agentName || session?.agent_name || null,
            soulId: ctx.identity?.soulId || session?.soul_id || null,
            raw: session,
        };

        await next();
    };
}
