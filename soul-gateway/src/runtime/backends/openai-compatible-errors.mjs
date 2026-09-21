/**
 * Error classification for OpenAI-compatible upstreams (OpenAI, OpenRouter,
 * and other `/chat/completions` vendors served by the `openai-api` backend).
 *
 * @module runtime/backends/openai-compatible-errors
 */

import {
    ProviderAuthError,
    ProviderRateLimitError,
    ProviderQuotaError,
    ProviderContentPolicyError,
    ProviderModelNotFoundError,
    ProviderTimeoutError,
    ProviderBadRequestError,
} from '../../core/errors.mjs';
import { HTTP_STATUS } from '../../core/constants.mjs';
import {
    classifyTransportOrServerError,
    describeProviderRateLimit,
    getProviderErrorType,
    getProviderMessage,
    getProviderStatus,
    markAccountScoped,
    rateLimitCooldownMs,
} from './error-helpers.mjs';
import { isFreeOnlyProvider } from '../providers/free-model-policy.mjs';

/**
 * Classify an upstream OpenAI-compatible failure.
 *
 * - 401 and 402 describe the provider account (bad key, no credit): no
 *   retry, and cascades skip sibling children on the same account.
 * - 403 is model or request specific (a guardrail block on one model):
 *   the next cascade child may still succeed, but a retry cannot.
 * - 404 means the model or its endpoints are gone: cascade, never retry.
 * - 429 separates account quota (daily/billing, marked until its reset)
 *   from one model's momentary capacity (short cooldown from Retry-After).
 *   Daily or billing wording alone marks the account only on a free-only
 *   provider; elsewhere it needs an explicit error type or headers.
 * - Other 4xx are caller-request failures and neither retry nor cascade.
 */
export function classifyOpenAiCompatibleError(error, ctx) {
    const provider = ctx?.providerRecord?.providerKey || 'openai';
    const status = getProviderStatus(error);
    const body = error?.body || {};
    const errorType = getProviderErrorType(error);

    if (status === HTTP_STATUS.UNAUTHORIZED) {
        return markAccountScoped(
            new ProviderAuthError(provider, 'Invalid API key')
        );
    }
    if (status === 402) {
        return markAccountScoped(new ProviderQuotaError(provider));
    }
    if (status === HTTP_STATUS.FORBIDDEN) {
        return new ProviderAuthError(provider, 'Access denied');
    }
    if (status === HTTP_STATUS.NOT_FOUND) {
        const model =
            body.error?.param === 'model' ? body.error?.message : 'unknown';
        const notFound = new ProviderModelNotFoundError(provider, model);
        notFound.cascade = true;
        return notFound;
    }
    if (status === 408) {
        return new ProviderTimeoutError(provider);
    }
    if (status === HTTP_STATUS.TOO_MANY_REQUESTS) {
        const rateLimit = describeProviderRateLimit(error, {
            messageHeuristics: isFreeOnlyProvider(ctx?.providerRecord),
        });
        if (rateLimit.accountScoped) {
            return markAccountScoped(new ProviderQuotaError(provider), {
                quotaResetAt: rateLimit.resetAt,
            });
        }
        const limited = new ProviderRateLimitError(provider);
        limited.cooldownMs = rateLimitCooldownMs(rateLimit.headers);
        return limited;
    }
    if (status === HTTP_STATUS.BAD_REQUEST) {
        if (errorType === 'content_policy_violation') {
            return new ProviderContentPolicyError(provider);
        }
        return new ProviderBadRequestError(provider, getProviderMessage(error));
    }
    if (status >= 400 && status < HTTP_STATUS.INTERNAL_SERVER_ERROR) {
        return new ProviderBadRequestError(provider, getProviderMessage(error));
    }
    if (status >= HTTP_STATUS.INTERNAL_SERVER_ERROR && status < 600) {
        return classifyTransportOrServerError(provider, error, status);
    }

    return classifyTransportOrServerError(provider, error);
}
