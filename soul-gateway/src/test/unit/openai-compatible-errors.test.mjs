/**
 * Account scope of an upstream 429 on OpenAI-compatible providers.
 *
 * A 429 that exhausted the provider account locks the account; a 429 that
 * only concerns one model must not, because that would block every other
 * model of the same account. Daily or billing wording is trusted only on a
 * free-only provider, where every model draws on one account allowance.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { classifyOpenAiCompatibleError } from '../../runtime/backends/openai-compatible-errors.mjs';
import { ProviderQuotaError, ProviderRateLimitError } from '../../core/errors.mjs';

const ORDINARY = { providerRecord: { providerKey: 'openai', settings: {} } };
const FREE_ONLY = { providerRecord: { providerKey: 'openrouter-free', settings: { free_only: true } } };

function rateLimited(message, { type, headers, metadataHeaders } = {}) {
    const error = new Error(message);
    error.status = 429;
    error.body = {
        error: {
            message,
            ...(type ? { type } : {}),
            ...(metadataHeaders ? { metadata: { headers: metadataHeaders } } : {}),
        },
    };
    if (headers) error.headers = headers;
    return error;
}

function accountScoped(classified) {
    return classified instanceof ProviderQuotaError && classified.failureScope === 'provider-account';
}

describe('429 account scope on an ordinary provider', () => {
    it('keeps a per-model requests-per-day limit model-scoped', () => {
        const classified = classifyOpenAiCompatibleError(
            rateLimited('Rate limit reached for gpt-4o in organization org-x on requests per day (RPD): Limit 10000, Used 10000, Requested 1.'),
            ORDINARY
        );
        assert.ok(classified instanceof ProviderRateLimitError);
        assert.equal(accountScoped(classified), false);
        assert.ok(classified.cooldownMs > 0);
    });

    it('keeps a 429 whose text merely mentions billing model-scoped', () => {
        const classified = classifyOpenAiCompatibleError(
            rateLimited('Too many requests for this model. See billing documentation for higher limits.'),
            ORDINARY
        );
        assert.equal(accountScoped(classified), false);
    });

    it('locks the account on an explicit insufficient_quota type', () => {
        const classified = classifyOpenAiCompatibleError(
            rateLimited('You exceeded your current quota, please check your plan and billing details.', { type: 'insufficient_quota' }),
            ORDINARY
        );
        assert.equal(accountScoped(classified), true);
        assert.ok(classified.quotaResetAt > Date.now());
    });

    it('locks the account when the headers report no remaining requests until a distant reset', () => {
        const reset = String(Date.now() + 3 * 3600_000);
        const classified = classifyOpenAiCompatibleError(
            rateLimited('Rate limit exceeded', { headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset } }),
            ORDINARY
        );
        assert.equal(accountScoped(classified), true);
        assert.equal(classified.quotaResetAt, Number(reset));
    });
});

describe('429 account scope on a free-only provider', () => {
    it('locks the account on the daily free-model wording without headers', () => {
        const classified = classifyOpenAiCompatibleError(
            rateLimited('Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day'),
            FREE_ONLY
        );
        assert.equal(accountScoped(classified), true);
    });

    it('keeps one busy model model-scoped with its Retry-After cooldown', () => {
        const classified = classifyOpenAiCompatibleError(
            rateLimited('Provider returned error', { headers: { 'retry-after': '7' } }),
            FREE_ONLY
        );
        assert.ok(classified instanceof ProviderRateLimitError);
        assert.equal(accountScoped(classified), false);
        assert.equal(classified.cooldownMs, 7000);
    });
});
