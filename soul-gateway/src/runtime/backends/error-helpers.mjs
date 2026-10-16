import {
    ProviderServerError,
    ProviderTimeoutError,
    ProviderUnavailableError,
} from '../../core/errors.mjs';
import {
    HTTP_STATUS,
    PROVIDER_MESSAGE_HINTS,
    PROVIDER_NETWORK_ERROR_CODES,
} from '../../core/constants.mjs';

export function getProviderStatus(error) {
    return error?.status || error?.statusCode || error?.httpStatus || null;
}

export function getProviderMessage(error) {
    const body = error?.body || {};
    return body.error?.message || body.message || error?.message || '';
}

export function getProviderErrorType(error) {
    const body = error?.body || {};
    return (
        body.error?.type || body.error?.code || body.__type || body.code || ''
    );
}

export function messageHasHint(message, hints = []) {
    const normalized = String(message || '').toLowerCase();
    return hints.some((hint) =>
        normalized.includes(String(hint).toLowerCase())
    );
}

export function looksLikeQuotaError(message) {
    return messageHasHint(message, PROVIDER_MESSAGE_HINTS.QUOTA);
}

export function looksLikeContentPolicyError(message) {
    return messageHasHint(message, PROVIDER_MESSAGE_HINTS.CONTENT_POLICY);
}

export function isTimeoutTransportCode(code) {
    return PROVIDER_NETWORK_ERROR_CODES.TIMEOUT.includes(code);
}

export function isUnavailableTransportCode(code) {
    return PROVIDER_NETWORK_ERROR_CODES.UNAVAILABLE.includes(code);
}

export function classifyTransportOrServerError(
    provider,
    error,
    fallbackStatus = HTTP_STATUS.INTERNAL_SERVER_ERROR
) {
    if (isTimeoutTransportCode(error?.code)) {
        return new ProviderTimeoutError(provider);
    }

    if (isUnavailableTransportCode(error?.code)) {
        return new ProviderUnavailableError(provider);
    }

    const status = getProviderStatus(error) || fallbackStatus;
    if (status === HTTP_STATUS.SERVICE_UNAVAILABLE) {
        return new ProviderUnavailableError(provider);
    }

    return new ProviderServerError(provider, status);
}

// ── upstream rate-limit and failure-scope helpers ────────────────────

const MIN_COOLDOWN_MS = 5_000;
const MAX_COOLDOWN_MS = 10 * 60_000;
const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 60_000;
const MIN_ACCOUNT_RESET_MS = 60_000;
const MAX_ACCOUNT_RESET_MS = 26 * 60 * 60_000;
// Daily or billing wording in a 429 message. It marks the whole account only
// where every model draws on one account allowance (a free-only provider);
// elsewhere the same words also describe one model's own limit, for example
// a per-model "requests per day" limit, so an ordinary provider needs an
// explicit error type or rate-limit headers. Generic capacity text ("check
// quota", per-minute limits) never marks the account.
const ACCOUNT_QUOTA_MESSAGE_RE =
    /free-models-per-day|per[- ]day|daily (?:limit|quota)|insufficient[_ ]credits|billing/i;
// Without an upstream reset instant, an account lock is short and re-probed
// rather than held until midnight, which bounds a misclassification.
const UNKNOWN_RESET_LOCK_MS = 15 * 60_000;

function lowerCaseKeys(record) {
    const out = {};
    if (!record || typeof record !== 'object') return out;
    for (const [key, value] of Object.entries(record)) {
        if (value !== null && value !== undefined) {
            out[String(key).toLowerCase()] = String(value);
        }
    }
    return out;
}

/**
 * Collect rate-limit headers from the transport error and from the
 * provider body (OpenRouter mirrors them in `error.metadata.headers`).
 *
 * @param {object} error
 * @returns {Record<string, string>} lower-cased header map
 */
export function getProviderRateLimitHeaders(error) {
    return {
        ...lowerCaseKeys(error?.body?.error?.metadata?.headers),
        ...lowerCaseKeys(error?.headers),
    };
}

/**
 * Parse a reset instant from `x-ratelimit-reset`, which providers send
 * either as epoch milliseconds or epoch seconds.
 *
 * @returns {number|null} epoch milliseconds
 */
export function parseRateLimitReset(value, now = Date.now()) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return null;
    const ms = numeric < 1e12 ? numeric * 1000 : numeric;
    return ms > now ? ms : null;
}

/**
 * Cooldown for a transient model-level rate limit, from `retry-after`
 * seconds, clamped so one busy free model is skipped briefly rather than
 * for the global one-hour default.
 */
export function rateLimitCooldownMs(headers) {
    const retryAfter = Number(headers?.['retry-after']);
    const ms = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : DEFAULT_RATE_LIMIT_COOLDOWN_MS;
    return Math.min(MAX_COOLDOWN_MS, Math.max(MIN_COOLDOWN_MS, ms));
}

function nextUtcMidnight(now) {
    const date = new Date(now);
    return Date.UTC(
        date.getUTCFullYear(),
        date.getUTCMonth(),
        date.getUTCDate() + 1
    );
}

/**
 * Decide whether a 429 exhausted the whole provider account (daily or
 * billing quota) rather than one model's momentary capacity.
 *
 * @param {object} error
 * @param {object} [options]
 * @param {number} [options.now]
 * @param {boolean} [options.messageHeuristics] also trust daily or billing
 *   wording in the message; only for a provider whose models share one
 *   account allowance
 * @returns {{ accountScoped: boolean, resetAt: number|null }}
 */
export function describeProviderRateLimit(
    error,
    { now = Date.now(), messageHeuristics = false } = {}
) {
    const headers = getProviderRateLimitHeaders(error);
    const errorType = getProviderErrorType(error);
    const message = getProviderMessage(error);
    const resetAt = parseRateLimitReset(headers['x-ratelimit-reset'], now);
    const remainingZero = headers['x-ratelimit-remaining'] === '0';
    const longReset = resetAt !== null && resetAt - now > 5 * 60_000;
    const accountScoped =
        errorType === 'insufficient_quota' ||
        errorType === 'billing_hard_limit_reached' ||
        (messageHeuristics && ACCOUNT_QUOTA_MESSAGE_RE.test(message)) ||
        (remainingZero && longReset);
    if (!accountScoped) return { accountScoped: false, resetAt: null, headers };
    const fallbackReset = Math.min(nextUtcMidnight(now), now + UNKNOWN_RESET_LOCK_MS);
    const chosen = resetAt ?? fallbackReset;
    const clamped = Math.min(
        now + MAX_ACCOUNT_RESET_MS,
        Math.max(now + MIN_ACCOUNT_RESET_MS, chosen)
    );
    return { accountScoped: true, resetAt: clamped, headers };
}

/**
 * Mark a classified error as belonging to the provider account instead of
 * one model. Cascades skip sibling children on the same provider after such
 * a failure, and the credential lease marks the account exhausted until
 * `quotaResetAt` when one is known.
 */
export function markAccountScoped(error, { quotaResetAt = null } = {}) {
    error.failureScope = 'provider-account';
    error.retryable = false;
    error.cooldown = false;
    if (quotaResetAt !== null) error.quotaResetAt = quotaResetAt;
    return error;
}
