/**
 * Route middleware: durable audit logging.
 *
 * Wraps the route chain to persist one completed audit_logs row per
 * request after the downstream outcome is known.
 *
 * Positioned after auth + ingress normalization so the durable row has
 * the authenticated key and requested model before validation / model
 * resolution run, while still capturing downstream success and error outcomes.
 *
 * @module runtime/route/audit-log
 */

import { calculateRequestCost } from '../policy/cost-calculator.mjs';
import {
    buildBufferedCapture,
    shapeStoredPayload,
} from '../../observability/response-capture.mjs';
import { isCanonicalStream } from '../kernel/index.mjs';

/**
 * @returns {(ctx: object, next: () => Promise<void>) => Promise<void>}
 */
export function auditLogMiddleware() {
    return async function auditLog(ctx, next) {
        const writer = ctx.services?.auditLogWriter;
        if (!writer) {
            await next();
            return;
        }

        const startedAt = new Date(ctx.startedAt);
        const requestFields = {
            startedAt,
            requestId: ctx.requestId,
            requestFormat: ctx.route?.format || ctx.route?.kind || 'unknown',
            apiKeyId: ctx.auth?.keyId || null,
            soulId: ctx.identity?.soulId || null,
            agentName: ctx.identity?.agentName || null,
            userAgent: ctx.http?.req?.headers?.['user-agent'] || null,
            sessionId: ctx.session?.id || null,
            requestedModel: getRequestedModel(ctx),
            streaming: !!ctx.request?.stream,
            requestHeaders: buildStoredRequestHeaders(ctx),
            requestPayload: buildStoredRequestPayload(ctx),
        };

        let caughtError = null;
        try {
            await next();
        } catch (err) {
            caughtError = err;
        }

        const latencyMs = Date.now() - ctx.startedAt;
        const failed = !!caughtError;
        const usage = getCompletedUsage(ctx);
        const cost = calculateCompletedCost(ctx, usage);
        const resolvedModel = getResolvedExecutionModel(ctx);
        const resolvedProviderId =
            ctx.target?.provider?.id ||
            resolvedModel?.providerId ||
            resolvedModel?.provider_id ||
            null;
        const providerAccountId =
            ctx.metadata?.cascadeAccountId ?? ctx.metadata?.backendAccountId ?? null;
        const queueWaitMs =
            ctx.metadata?.cascadeQueueWaitMs ?? ctx.metadata?.queueWaitMs ?? null;
        const retryTrace =
            ctx.metadata?.cascadeRetryTrace || ctx.metadata?.retryTrace || [];
        const { responseExcerpt, responsePayload, truncated } =
            resolveResponseCapture(ctx);

        await writer.write({
            ...requestFields,
            sessionId: ctx.session?.id || requestFields.sessionId,
            status: failed
                ? 'failed'
                : ctx.metadata?.aborted
                  ? 'aborted'
                  : 'succeeded',
            httpStatus: failed
                ? (caughtError.httpStatus || 500)
                : (ctx.metadata?.httpStatus || 200),
            errorType: failed ? (caughtError.errorType || 'internal_error') : null,
            errorMessage: failed ? caughtError.message : null,
            resolvedModelId: resolvedModel?.id || resolvedModel?.modelId || null,
            resolvedProviderId,
            providerAccountId,
            queueWaitMs,
            latencyMs,
            ttfbMs: ctx.metadata?.ttfbMs || null,
            inputTokens: usage?.inputTokens ?? null,
            outputTokens: usage?.outputTokens ?? null,
            totalTokens: usage?.totalTokens ?? null,
            inputCostUsd: cost.inputCostUsd,
            outputCostUsd: cost.outputCostUsd,
            totalCostUsd: cost.totalCostUsd,
            budgetExempt: cost.budgetExempt,
            retryTrace,
            responseExcerpt,
            responsePayload,
            truncated,
            cascaded: Array.isArray(ctx.metadata?.cascadeTrace) &&
                ctx.metadata.cascadeTrace.length > 0,
            cacheHit: !!ctx.metadata?.cacheHit,
            blocked: !!ctx.metadata?.blocked,
            metadata: {
                sourceResolvedModel: getModelKey(resolvedModel),
            },
            completedAt: new Date(),
        });

        if (caughtError) throw caughtError;
    };
}

function getRequestedModel(ctx) {
    return ctx.request?.model ?? ctx.body?.model ?? '(missing)';
}

const SENSITIVE_REQUEST_HEADERS = new Set([
    'authorization',
    'proxy-authorization',
    'cookie',
    'set-cookie',
    'x-api-key',
    'x-csrf-token',
    'cf-access-jwt-assertion',
]);

function buildStoredRequestHeaders(ctx) {
    const headers = ctx.http?.req?.headers;
    if (!headers || typeof headers !== 'object') {
        return {};
    }

    const filtered = {};
    for (const [name, value] of Object.entries(headers)) {
        if (value == null || SENSITIVE_REQUEST_HEADERS.has(name)) {
            continue;
        }

        if (Array.isArray(value)) {
            const compact = value.filter((entry) => entry != null);
            if (compact.length > 0) {
                filtered[name] = compact.map(String);
            }
            continue;
        }

        filtered[name] = String(value);
    }

    return filtered;
}

function buildStoredRequestPayload(ctx) {
    const rawBody = cloneJsonValue(ctx.body);
    const normalizedRequest = cloneJsonValue(ctx.request);

    if (rawBody && typeof rawBody === 'object' && !Array.isArray(rawBody)) {
        if (
            !Object.prototype.hasOwnProperty.call(rawBody, 'model') &&
            normalizedRequest?.model != null
        ) {
            rawBody.model = normalizedRequest.model;
        }
        if (
            !Object.prototype.hasOwnProperty.call(rawBody, 'stream') &&
            normalizedRequest?.stream != null
        ) {
            rawBody.stream = normalizedRequest.stream;
        }
        return rawBody;
    }

    if (
        normalizedRequest &&
        typeof normalizedRequest === 'object' &&
        !Array.isArray(normalizedRequest)
    ) {
        return normalizedRequest;
    }

    return {};
}

function cloneJsonValue(value) {
    if (value == null) {
        return null;
    }

    try {
        return JSON.parse(JSON.stringify(value));
    } catch {
        return null;
    }
}

function getCompletedUsage(ctx) {
    if (ctx.metadata?.usage) {
        return ctx.metadata.usage;
    }

    const usage = ctx.response?.usage ?? ctx.usage ?? null;
    if (!usage) return null;

    const inputTokens =
        usage.inputTokens ??
        usage.input_tokens ??
        usage.promptTokens ??
        usage.prompt_tokens ??
        0;
    const outputTokens =
        usage.outputTokens ??
        usage.output_tokens ??
        usage.completionTokens ??
        usage.completion_tokens ??
        0;
    const totalTokens =
        usage.totalTokens ??
        usage.total_tokens ??
        inputTokens + outputTokens;

    return { inputTokens, outputTokens, totalTokens };
}

function getResolvedExecutionModel(ctx) {
    const model =
        ctx.metadata?.cascadeModel ||
        ctx.target?.model ||
        ctx.metadata?.resolvedModel?.model ||
        null;
    if (typeof model !== 'string') return model;
    return ctx.snapshot?.models?.get?.(model) || null;
}

function getModelKey(model) {
    return model?.modelKey || model?.model_key || null;
}

function calculateCompletedCost(ctx, usage) {
    if (!usage) {
        return {
            inputCostUsd: 0,
            outputCostUsd: 0,
            totalCostUsd: 0,
            budgetExempt: false,
        };
    }

    const model = getResolvedExecutionModel(ctx);
    if (!model) {
        return {
            inputCostUsd: 0,
            outputCostUsd: 0,
            totalCostUsd: 0,
            budgetExempt: false,
        };
    }

    const pricing = calculateRequestCost(
        model,
        usage,
        ctx.appCtx?.services?.pricingDirectory || null,
        model.providerKey || model.provider_key || null,
        model.providerModelId || model.provider_model_id || model.modelKey || null
    );

    ctx.metadata.totalCostUsd = pricing.totalCostUsd;
    return pricing;
}

function resolveResponseCapture(ctx) {
    const maxExcerptChars =
        ctx.appCtx?.config?.defaults?.responseExcerptChars ?? 2000;
    const maxPayloadBytes =
        ctx.appCtx?.config?.defaults?.maxResponsePayloadBytes ?? 131_072;

    let excerpt = null;
    let payload = null;

    const captured = ctx.metadata?.responseCapture;
    if (captured) {
        excerpt = captured.excerpt ?? null;
        payload = captured.payload ?? null;
    } else if (
        ctx.response &&
        !isCanonicalStream(ctx.response) &&
        !isCanonicalStream(ctx.response?.stream)
    ) {
        const built = buildBufferedCapture(ctx.response, { maxExcerptChars });
        excerpt = built.excerpt;
        payload = built.payload;
    }

    const shaped = shapeStoredPayload(payload, { maxPayloadBytes });
    return {
        responseExcerpt: excerpt,
        responsePayload: shaped.payload,
        truncated: shaped.truncated,
    };
}
