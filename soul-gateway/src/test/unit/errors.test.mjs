import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    GatewayError,
    AuthenticationRequiredError,
    InvalidApiKeyError,
    ExpiredApiKeyError,
    RevokedApiKeyError,
    BadRequestError,
    ValidationError,
    UnsupportedFormatError,
    ModelNotFoundError,
    TargetDisabledError,
    TierExhaustedError,
    ModelQueueTimeoutError,
    RateLimitExceededError,
    BudgetExceededError,
    ContentBlockedError,
    LoopDetectedError,
    ProviderAuthError,
    ProviderRateLimitError,
    ProviderQuotaError,
    ProviderContentPolicyError,
    ProviderModelNotFoundError,
    ProviderTimeoutError,
    ProviderUnavailableError,
    ProviderServerError,
    ProviderAccountsExhaustedError,
    MiddlewareAbortError,
    ConfigurationError,
    InternalServerError,
    toHttpErrorPayload,
} from '../../core/errors.mjs';

describe('Error taxonomy', () => {
    const errorSpecs = [
        // [Class, args, expectedStatus, expectedType, retryable, cooldown, cascade]
        [
            AuthenticationRequiredError,
            [],
            401,
            'authentication_required',
            false,
            false,
            false,
        ],
        [InvalidApiKeyError, [], 401, 'invalid_api_key', false, false, false],
        [ExpiredApiKeyError, [], 403, 'api_key_expired', false, false, false],
        [RevokedApiKeyError, [], 403, 'api_key_revoked', false, false, false],
        [BadRequestError, [], 400, 'bad_request', false, false, false],
        [ValidationError, [], 400, 'validation_error', false, false, false],
        [
            UnsupportedFormatError,
            [],
            400,
            'unsupported_format',
            false,
            false,
            false,
        ],
        [
            ModelNotFoundError,
            ['gpt-4'],
            404,
            'model_not_found',
            false,
            false,
            false,
        ],
        [
            TargetDisabledError,
            ['fast-tier'],
            409,
            'target_disabled',
            false,
            false,
            false,
        ],
        [
            TierExhaustedError,
            ['fast-tier'],
            503,
            'tier_exhausted',
            true,
            false,
            false,
        ],
        [
            ModelQueueTimeoutError,
            ['gpt-4'],
            429,
            'model_queue_timeout',
            true,
            false,
            true,
        ],
        [
            RateLimitExceededError,
            ['key-1', 60],
            429,
            'rate_limit_exceeded',
            true,
            false,
            false,
        ],
        [
            BudgetExceededError,
            ['daily'],
            429,
            'budget_exceeded',
            true,
            false,
            false,
        ],
        [
            ContentBlockedError,
            ['test rule'],
            400,
            'content_blocked',
            false,
            false,
            false,
        ],
        [LoopDetectedError, [], 429, 'loop_detected', true, false, false],
        [
            ProviderAuthError,
            ['openai'],
            502,
            'provider_auth_error',
            false,
            false,
            true,
        ],
        [
            ProviderRateLimitError,
            ['openai'],
            429,
            'provider_rate_limited',
            true,
            true,
            true,
        ],
        [
            ProviderQuotaError,
            ['openai'],
            429,
            'provider_quota_exhausted',
            true,
            true,
            true,
        ],
        [
            ProviderContentPolicyError,
            ['openai'],
            400,
            'provider_content_policy',
            false,
            false,
            true,
        ],
        [
            ProviderModelNotFoundError,
            ['openai', 'gpt-x'],
            502,
            'provider_model_not_found',
            false,
            false,
            false,
        ],
        [
            ProviderTimeoutError,
            ['openai'],
            504,
            'provider_timeout',
            true,
            false,
            true,
        ],
        [
            ProviderUnavailableError,
            ['openai'],
            503,
            'provider_unavailable',
            true,
            false,
            true,
        ],
        [
            ProviderServerError,
            ['openai', 500],
            502,
            'provider_server_error',
            true,
            false,
            true,
        ],
        [
            ProviderAccountsExhaustedError,
            ['copilot'],
            429,
            'provider_accounts_exhausted',
            true,
            false,
            true,
        ],
        [
            MiddlewareAbortError,
            ['rate-limiter', 429, 'too many requests'],
            429,
            'middleware_abort_error',
            false,
            false,
            false,
        ],
        [
            ConfigurationError,
            [],
            500,
            'configuration_error',
            false,
            false,
            false,
        ],
        [InternalServerError, [], 500, 'internal_error', false, false, false],
    ];

    for (const [
        Cls,
        args,
        status,
        errorType,
        retryable,
        cooldown,
        cascade,
    ] of errorSpecs) {
        it(`${Cls.name} has correct properties`, () => {
            const err = new Cls(...args);
            assert(err instanceof GatewayError, 'should extend GatewayError');
            assert(err instanceof Error, 'should extend Error');
            assert.equal(
                err.httpStatus,
                status,
                `httpStatus should be ${status}`
            );
            assert.equal(
                err.errorType,
                errorType,
                `errorType should be ${errorType}`
            );
            assert.equal(
                err.retryable,
                retryable,
                `retryable should be ${retryable}`
            );
            assert.equal(
                err.cooldown,
                cooldown,
                `cooldown should be ${cooldown}`
            );
            assert.equal(err.cascade, cascade, `cascade should be ${cascade}`);
        });
    }

    it('covers all 27 error types from the design doc', () => {
        assert.equal(errorSpecs.length, 27, 'should have 27 error classes');
    });
});

describe('toHttpErrorPayload', () => {
    it('serializes GatewayError correctly', () => {
        const err = new RateLimitExceededError('key-1', 60);
        const { status, body } = toHttpErrorPayload(err);
        assert.equal(status, 429);
        assert.equal(body.error.type, 'rate_limit_exceeded');
        assert.equal(body.error.retry_after_seconds, 60);
    });

    it('serializes unknown error as 500', () => {
        const { status, body } = toHttpErrorPayload(new TypeError('oops'));
        assert.equal(status, 500);
        assert.equal(body.error.type, 'internal_error');
    });
});
