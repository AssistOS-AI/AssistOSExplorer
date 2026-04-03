import { ERROR_MESSAGES, ERROR_TYPES, HTTP_STATUS } from './constants.mjs';

/**
 * Typed error hierarchy for Soul Gateway.
 *
 * Every error carries:
 *   - httpStatus: the status code to send to the client
 *   - errorType:  machine-readable string (stable across versions)
 *   - retryable:  whether the client should retry
 *   - cooldown:   whether this error should trigger model cooldown
 *   - cascade:    whether the execution engine should cascade to the next model
 *   - retryAfterSeconds: optional hint for Retry-After header
 */

// ── base class ───────────────────────────────────────────────────────

export class GatewayError extends Error {
  constructor(message, {
    httpStatus,
    errorType,
    retryable = false,
    cooldown = false,
    cascade = false,
    retryAfterSeconds = null,
    detail = null,
  }) {
    super(message);
    this.name = this.constructor.name;
    this.httpStatus = httpStatus;
    this.errorType = errorType;
    this.retryable = retryable;
    this.cooldown = cooldown;
    this.cascade = cascade;
    this.retryAfterSeconds = retryAfterSeconds;
    this.detail = detail;
  }
}

// ── client errors ────────────────────────────────────────────────────

export class AuthenticationRequiredError extends GatewayError {
  constructor(message = ERROR_MESSAGES.MISSING_BEARER_TOKEN) {
    super(message, { httpStatus: HTTP_STATUS.UNAUTHORIZED, errorType: ERROR_TYPES.AUTHENTICATION_REQUIRED });
  }
}

export class InvalidApiKeyError extends GatewayError {
  constructor(message = ERROR_MESSAGES.INVALID_API_KEY) {
    super(message, { httpStatus: HTTP_STATUS.UNAUTHORIZED, errorType: ERROR_TYPES.INVALID_API_KEY });
  }
}

export class ExpiredApiKeyError extends GatewayError {
  constructor(message = ERROR_MESSAGES.API_KEY_EXPIRED) {
    super(message, { httpStatus: HTTP_STATUS.FORBIDDEN, errorType: ERROR_TYPES.API_KEY_EXPIRED });
  }
}

export class RevokedApiKeyError extends GatewayError {
  constructor(message = ERROR_MESSAGES.API_KEY_REVOKED) {
    super(message, { httpStatus: HTTP_STATUS.FORBIDDEN, errorType: ERROR_TYPES.API_KEY_REVOKED });
  }
}

export class BadRequestError extends GatewayError {
  constructor(message = ERROR_MESSAGES.BAD_REQUEST) {
    super(message, { httpStatus: HTTP_STATUS.BAD_REQUEST, errorType: ERROR_TYPES.BAD_REQUEST });
  }
}

export class ValidationError extends GatewayError {
  constructor(message = ERROR_MESSAGES.VALIDATION_FAILED) {
    super(message, { httpStatus: HTTP_STATUS.BAD_REQUEST, errorType: ERROR_TYPES.VALIDATION_ERROR });
  }
}

export class UnsupportedFormatError extends GatewayError {
  constructor(message = ERROR_MESSAGES.UNSUPPORTED_INGRESS_FORMAT) {
    super(message, { httpStatus: HTTP_STATUS.BAD_REQUEST, errorType: ERROR_TYPES.UNSUPPORTED_FORMAT });
  }
}

// ── routing errors ───────────────────────────────────────────────────

export class ModelNotFoundError extends GatewayError {
  constructor(model) {
    super(`Model not found: ${model}`, { httpStatus: HTTP_STATUS.NOT_FOUND, errorType: ERROR_TYPES.MODEL_NOT_FOUND });
  }
}

export class TargetDisabledError extends GatewayError {
  constructor(target) {
    super(`Target is disabled: ${target}`, { httpStatus: HTTP_STATUS.CONFLICT, errorType: ERROR_TYPES.TARGET_DISABLED });
  }
}

export class TierExhaustedError extends GatewayError {
  constructor(tier) {
    super(`All models in tier exhausted: ${tier}`, {
      httpStatus: HTTP_STATUS.SERVICE_UNAVAILABLE, errorType: ERROR_TYPES.TIER_EXHAUSTED, retryable: true,
    });
  }
}

export class ModelQueueTimeoutError extends GatewayError {
  constructor(model) {
    super(`Queue timeout waiting for concurrency slot: ${model}`, {
      httpStatus: HTTP_STATUS.TOO_MANY_REQUESTS, errorType: ERROR_TYPES.MODEL_QUEUE_TIMEOUT, retryable: true, cascade: true,
    });
  }
}

// ── policy errors ────────────────────────────────────────────────────

export class RateLimitExceededError extends GatewayError {
  constructor(keyId, retryAfterSeconds = 60) {
    super(ERROR_MESSAGES.RATE_LIMIT_EXCEEDED, {
      httpStatus: HTTP_STATUS.TOO_MANY_REQUESTS, errorType: ERROR_TYPES.RATE_LIMIT_EXCEEDED, retryable: true, retryAfterSeconds,
    });
  }
}

export class BudgetExceededError extends GatewayError {
  constructor(kind = 'daily') {
    super(`${kind} budget exceeded`, {
      httpStatus: HTTP_STATUS.TOO_MANY_REQUESTS, errorType: ERROR_TYPES.BUDGET_EXCEEDED, retryable: true,
    });
  }
}

export class ContentBlockedError extends GatewayError {
  constructor(ruleDescription) {
    super(`Content blocked: ${ruleDescription}`, {
      httpStatus: HTTP_STATUS.BAD_REQUEST, errorType: ERROR_TYPES.CONTENT_BLOCKED, detail: { rule: ruleDescription },
    });
  }
}

export class LoopDetectedError extends GatewayError {
  constructor(message = ERROR_MESSAGES.AGENT_LOOP_DETECTED) {
    super(message, {
      httpStatus: HTTP_STATUS.TOO_MANY_REQUESTS, errorType: ERROR_TYPES.LOOP_DETECTED, retryable: true,
    });
  }
}

// ── provider errors ──────────────────────────────────────────────────

export class ProviderAuthError extends GatewayError {
  constructor(provider, message = ERROR_MESSAGES.PROVIDER_AUTHENTICATION_FAILED) {
    super(message, {
      httpStatus: HTTP_STATUS.BAD_GATEWAY, errorType: ERROR_TYPES.PROVIDER_AUTH_ERROR, cascade: true,
      detail: { provider },
    });
  }
}

export class ProviderRateLimitError extends GatewayError {
  constructor(provider) {
    super(`Provider rate limited: ${provider}`, {
      httpStatus: HTTP_STATUS.TOO_MANY_REQUESTS, errorType: ERROR_TYPES.PROVIDER_RATE_LIMITED,
      retryable: true, cooldown: true, cascade: true,
    });
  }
}

export class ProviderQuotaError extends GatewayError {
  constructor(provider) {
    super(`Provider quota exhausted: ${provider}`, {
      httpStatus: HTTP_STATUS.TOO_MANY_REQUESTS, errorType: ERROR_TYPES.PROVIDER_QUOTA_EXHAUSTED,
      retryable: true, cooldown: true, cascade: true,
    });
  }
}

export class ProviderContentPolicyError extends GatewayError {
  constructor(provider) {
    super(`Provider content policy rejection: ${provider}`, {
      httpStatus: HTTP_STATUS.BAD_REQUEST, errorType: ERROR_TYPES.PROVIDER_CONTENT_POLICY, cascade: true,
    });
  }
}

export class ProviderModelNotFoundError extends GatewayError {
  constructor(provider, model) {
    super(`Provider model not found: ${provider}/${model}`, {
      httpStatus: HTTP_STATUS.BAD_GATEWAY, errorType: ERROR_TYPES.PROVIDER_MODEL_NOT_FOUND,
    });
  }
}

export class ProviderTimeoutError extends GatewayError {
  constructor(provider) {
    super(`Provider request timed out: ${provider}`, {
      httpStatus: HTTP_STATUS.GATEWAY_TIMEOUT, errorType: ERROR_TYPES.PROVIDER_TIMEOUT,
      retryable: true, cascade: true,
    });
  }
}

export class ProviderUnavailableError extends GatewayError {
  constructor(provider) {
    super(`Provider unavailable: ${provider}`, {
      httpStatus: HTTP_STATUS.SERVICE_UNAVAILABLE, errorType: ERROR_TYPES.PROVIDER_UNAVAILABLE,
      retryable: true, cascade: true,
    });
  }
}

export class ProviderServerError extends GatewayError {
  constructor(provider, status) {
    super(`Provider server error (${status}): ${provider}`, {
      httpStatus: HTTP_STATUS.BAD_GATEWAY, errorType: ERROR_TYPES.PROVIDER_SERVER_ERROR,
      retryable: true, cascade: true,
    });
  }
}

export class ProviderAccountsExhaustedError extends GatewayError {
  constructor(provider) {
    super(`All accounts exhausted for: ${provider}`, {
      httpStatus: HTTP_STATUS.TOO_MANY_REQUESTS, errorType: ERROR_TYPES.PROVIDER_ACCOUNTS_EXHAUSTED,
      retryable: true, cascade: true,
    });
  }
}

// ── middleware errors ─────────────────────────────────────────────────

export class MiddlewareAbortError extends GatewayError {
  constructor(middlewareName, httpStatus = HTTP_STATUS.INTERNAL_SERVER_ERROR, message = ERROR_MESSAGES.MIDDLEWARE_ABORT) {
    super(message, {
      httpStatus, errorType: ERROR_TYPES.MIDDLEWARE_ABORT_ERROR,
      detail: { middleware: middlewareName },
    });
  }
}

export class SyntheticResponseAbort extends GatewayError {
  constructor(middlewareName) {
    super(ERROR_MESSAGES.SYNTHETIC_RESPONSE_FROM_MIDDLEWARE, {
      httpStatus: HTTP_STATUS.OK, errorType: ERROR_TYPES.SYNTHETIC_RESPONSE,
      detail: { middleware: middlewareName },
    });
    /** Attached by the middleware that aborts with a cached/synthetic response. */
    this.syntheticResponse = null;
  }
}

// ── configuration / internal ─────────────────────────────────────────

export class ConfigurationError extends GatewayError {
  constructor(message = ERROR_MESSAGES.CONFIGURATION_ERROR) {
    super(message, { httpStatus: HTTP_STATUS.INTERNAL_SERVER_ERROR, errorType: ERROR_TYPES.CONFIGURATION_ERROR });
  }
}

export class InternalServerError extends GatewayError {
  constructor(message = ERROR_MESSAGES.INTERNAL_SERVER_ERROR) {
    super(message, { httpStatus: HTTP_STATUS.INTERNAL_SERVER_ERROR, errorType: ERROR_TYPES.INTERNAL_ERROR });
  }
}

// ── serialization ────────────────────────────────────────────────────

/**
 * Convert any error into a stable JSON payload for the HTTP response body.
 */
export function toHttpErrorPayload(error) {
  if (error instanceof GatewayError) {
    const payload = {
      error: {
        message: error.message,
        type: error.errorType,
      },
    };
    if (error.retryAfterSeconds != null) {
      payload.error.retry_after_seconds = error.retryAfterSeconds;
    }
    if (error.detail) {
      payload.error.detail = error.detail;
    }
    return { status: error.httpStatus, body: payload };
  }

  // Untyped / unexpected error — 500
  return {
    status: HTTP_STATUS.INTERNAL_SERVER_ERROR,
    body: {
      error: {
        message: ERROR_MESSAGES.INTERNAL_SERVER_ERROR,
        type: ERROR_TYPES.INTERNAL_ERROR,
      },
    },
  };
}
