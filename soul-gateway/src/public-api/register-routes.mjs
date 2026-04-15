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
import { enrichModelMetadata } from '../runtime/policy/model-metadata-classifier.mjs';

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
 *
 * In addition to the OpenAI-compatible base shape, each entry carries
 * additive gateway-specific fields under the `_`-prefix convention:
 *
 *   - `_pricing` — pricing mode and token/request prices (direct models)
 *   - `_context` — context window / max output tokens (direct models)
 *   - `_tags` — stored tag set (direct models)
 *   - `_is_free` — explicit free flag (direct models; cascades derive
 *                  from children — true iff every enabled child is free)
 *   - `_billing_types` — distinct child pricing modes (cascade models)
 *
 * All fields are derived in-memory from the already-loaded snapshot and
 * the already-installed pricing directory. No DB or network calls are
 * made from this handler.
 */
function handleListModels(ctx) {
    const snapshot = ctx.appCtx.services.snapshot;
    const pricingDirectory = ctx.appCtx.services?.pricingDirectory || null;

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
            const children = Array.isArray(model.children) ? model.children : [];
            entry._child_count = children.length;
            const summary = summarizeCascadeChildren(snapshot, children);
            if (summary.billingTypes.length > 0) {
                entry._billing_types = summary.billingTypes;
            }
            if (summary.isFree != null) {
                entry._is_free = summary.isFree;
            }
        } else {
            decorateDirectModel(entry, model, pricingDirectory);
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

function decorateDirectModel(entry, model, pricingDirectory) {
    const enriched = enrichModelMetadata(
        {
            providerKey: model.providerKey || null,
            providerModelId: model.providerModelId || null,
            modelKey: model.modelKey || null,
            displayName: model.displayName || null,
            pricingMode: model.pricingMode ?? null,
            inputPricePerMillion: model.inputPricePerMillion ?? null,
            outputPricePerMillion: model.outputPricePerMillion ?? null,
            requestPriceUsd: model.requestPriceUsd ?? null,
            isFree: model.isFree ?? null,
            contextWindow: model.capabilities?.contextWindow ?? null,
            maxOutputTokens: model.capabilities?.maxOutputTokens ?? null,
            supportsTools: model.capabilities?.supportsTools ?? null,
            supportsVision: model.capabilities?.supportsVision ?? null,
            supportsStreaming: model.capabilities?.supportsStreaming ?? null,
            capabilities: model.capabilities || {},
            tags: Array.isArray(model.tags) ? [...model.tags] : [],
            metadata: model.metadata || {},
        },
        {
            pricingDirectory,
        }
    );
    const hasPricing =
        (enriched.pricingMode != null &&
            enriched.pricingMode !== 'external_directory') ||
        enriched.inputPricePerMillion != null ||
        enriched.outputPricePerMillion != null ||
        enriched.requestPriceUsd != null;
    if (hasPricing) {
        entry._pricing = {
            mode: enriched.pricingMode || null,
            input_per_million: enriched.inputPricePerMillion,
            output_per_million: enriched.outputPricePerMillion,
            request: enriched.requestPriceUsd,
        };
    }

    const capabilities = enriched.capabilities || {};
    if (
        capabilities.contextWindow != null ||
        capabilities.maxOutputTokens != null
    ) {
        entry._context = {
            window: capabilities.contextWindow ?? null,
            max_output_tokens: capabilities.maxOutputTokens ?? null,
        };
    }

    if (Array.isArray(enriched.tags) && enriched.tags.length > 0) {
        entry._tags = [...enriched.tags];
    }

    if (enriched.isFree === true) {
        entry._is_free = true;
    } else if (hasPricing) {
        entry._is_free = enriched.isFree === true;
    }
}

/**
 * Derive a cascade model's billing summary from its children. Returns
 * `billingTypes` (distinct pricing modes across enabled children,
 * sorted) and `isFree` (true iff at least one enabled child exists and
 * every one of them is free). `isFree` is `null` when no enabled child
 * could be resolved in the snapshot.
 */
function summarizeCascadeChildren(snapshot, children) {
    const billingTypes = new Set();
    let resolved = 0;
    let allFree = true;
    for (const child of children) {
        if (child.childEnabled === false) continue;
        const childModel = snapshot.models.get(child.modelKey);
        if (!childModel) continue;
        resolved += 1;
        if (childModel.pricingMode) {
            billingTypes.add(childModel.pricingMode);
        }
        if (childModel.isFree !== true) {
            allFree = false;
        }
    }
    return {
        billingTypes: [...billingTypes].sort(),
        isFree: resolved > 0 ? allFree : null,
    };
}
