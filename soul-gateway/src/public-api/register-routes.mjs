/**
 * Public API route registration.
 *
 * Registers all public-facing routes: the three ingress formats
 * (OpenAI Chat, Anthropic Messages, OpenAI Responses) plus
 * the models listing endpoint.
 *
 * Each completion route delegates to `runRouteRequest`, which composes
 * the canonical route chain (parse → auth → identity → snapshot →
 * normalize → validate → resolveModel → resolveSession → respond →
 * gatewayDispatch terminal) through the kernel composer.
 */

import { runRouteRequest } from '../runtime/route/run-route-request.mjs';
import { sendJson } from '../core/responses.mjs';

/**
 * Register public API routes on an existing path router.
 *
 * @param {object} router - router to add routes to
 * @param {object} appCtx - application context
 */
export function registerPublicApiRoutes(router, appCtx) {
    // Canonical routes
    router.add('POST', '/v1/chat/completions', (ctx) =>
        handleCompletionRoute(ctx, 'openai_chat')
    );
    router.add('POST', '/v1/messages', (ctx) =>
        handleCompletionRoute(ctx, 'anthropic_messages')
    );
    router.add('POST', '/v1/responses', (ctx) =>
        handleCompletionRoute(ctx, 'openai_responses')
    );
    router.add('GET', '/v1/models', (ctx) => handleListModels(ctx));
}

// ── Route handlers ──────────────────────────────────────────────────

/**
 * Handle a completion request for any ingress format by entering the
 * kernel-composed route chain.
 */
async function handleCompletionRoute(ctx, routeKind) {
    await runRouteRequest({
        req: ctx.req,
        res: ctx.res,
        appCtx: ctx.appCtx,
        routeKind,
    });
}

/**
 * Handle GET /v1/models — return the list of available addressable
 * targets.  After Workstream F2 every target (direct model or cascade
 * model) lives in `snapshot.models`, so this handler is a single-pass
 * enumeration.  Cascade models carry a `_strategy='cascade'` flag plus
 * a child count so UIs can still distinguish them from direct models
 * if they want to; vanilla OpenAI clients see them as regular models.
 */
function handleListModels(ctx) {
    const snapshot = ctx.appCtx.services.snapshot;

    if (!snapshot) {
        sendJson(ctx.res, 200, { object: 'list', data: [] });
        return;
    }

    const data = [];

    for (const [modelKey, model] of snapshot.models) {
        const entry = {
            id: modelKey,
            object: 'model',
            created: Math.floor(snapshot.loadedAt / 1000),
            owned_by: model.providerKey || 'soul-gateway',
            permission: [],
            root: modelKey,
            parent: null,
        };
        if (model.strategyKind === 'cascade') {
            entry._strategy = 'cascade';
            entry._child_count = Array.isArray(model.children)
                ? model.children.length
                : 0;
        }
        data.push(entry);
    }

    // Add aliases as virtual models
    for (const [alias, target] of snapshot.aliases) {
        data.push({
            id: alias,
            object: 'model',
            created: Math.floor(snapshot.loadedAt / 1000),
            owned_by: 'soul-gateway',
            permission: [],
            root: target,
            parent: target,
            _alias: true,
        });
    }

    sendJson(ctx.res, 200, { object: 'list', data });
}
