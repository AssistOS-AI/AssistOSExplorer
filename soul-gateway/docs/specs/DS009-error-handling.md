# DS009 — Error Handling

## Summary

This spec describes how Soul Gateway classifies upstream errors, retries them with exponential backoff at the HTTP level, cascades to alternate models at the tier level, rotates to alternate accounts at the provider level, and logs the full retry sequence for post-incident analysis.

## Error classification

Errors from upstream providers are classified by type. Each error type has a determination attached: is it retryable, should it trigger a model cooldown, should it cascade to the next model immediately, or should it fail the request outright.

The taxonomy:

| Error type | Typical HTTP | Meaning | Retry behavior |
|---|---|---|---|
| `authentication_error` | 401 | Credential is invalid or expired | No retry; surface to caller |
| `authorization_error` | 403 | Credential is valid but lacks permission for the resource (e.g. Codex scope doesn't allow `/v1/models`) | No retry; surface to caller |
| `rate_limit_error` | 429 | Provider rate limit hit | Triggers cooldown cascade (see DS004) |
| `payment_required` | 402 | Quota exhausted, billing issue | Triggers cooldown cascade; also triggers account rotation for OAuth providers |
| `content_policy_violation` | 400 | Provider refused on content grounds | No retry; surface to caller |
| `model_not_found` | 404 | Requested model doesn't exist upstream | No retry; immediate cascade |
| `provider_server_error` | 500 / 502 / 503 / 504 | Upstream 5xx | HTTP retry with backoff |
| `provider_timeout` | — | Socket timeout or gateway timeout | HTTP retry with backoff |
| `provider_unavailable` | — | Connection refused or DNS failure | HTTP retry with backoff |

### Error envelope

Public and management HTTP APIs emit a consistent JSON error envelope:

```json
{ "error": { "message": "...", "type": "rate_limit_error", "detail": { ... } } }
```

- The `type` field is stable and machine-readable. Clients can switch on `error.type` for programmatic handling.
- The same `type` values are reused across routes — a 429 from a management endpoint uses the same type as a 429 from `/v1/chat/completions`.
- Common transport failures (socket timeouts, connection refusal, DNS failures) are normalized into the shared `provider_timeout` / `provider_unavailable` taxonomy before retry or cascade decisions are made.
- The same backend classifier runs for late stream failures. If a backend stream throws while draining, or yields a canonical `error` event, the backend terminal converts that failure into the backend's typed `GatewayError` before buffering or route serialization sees it.

## HTTP-level retry

When an upstream provider returns a retryable error, the system retries the same model with exponential backoff.

- Default: up to 3 retries per model attempt.
- Delays: 1s, 2s, 4s — multiplied by the backoff multiplier (default 2) and capped at a maximum delay (default 30s).
- Each retry delay is ±20% random jitter to prevent thundering-herd re-retry storms across multiple concurrent requests.
- Each attempt has a per-request timeout (default 120 seconds).
- Retry configuration is tunable via environment variables (`HTTP_RETRY_MAX_ATTEMPTS`, `HTTP_RETRY_BASE_DELAY_MS`, `HTTP_RETRY_MULTIPLIER`, `HTTP_RETRY_MAX_DELAY_MS`, `HTTP_RETRY_JITTER_PCT`).

If all HTTP retries for a single model fail with a retryable error, the loop exits and the error enters the model-level cascade logic.

## Model-level cascade

When a model fails after exhausting its HTTP retries, the cascade logic kicks in (implemented as the outer retry loop in the request pipeline):

- **Cooldown trigger** — errors classified as `rate_limit_error` or `payment_required` place the model in cooldown (default 1 hour) and the system re-resolves the tier to find the next available model. See DS004 for cooldown details.
- **Immediate cascade** — any other classified error (authentication failure, connection error, server error after retries, etc.) cascades to the next model in the tier without placing the current one in cooldown.
- **Unclassified error** — if the error doesn't match any known type, the request fails immediately without cascading. Unclassified errors are rare and usually indicate a gateway bug rather than an upstream issue.

The cascade loop is bounded by `maxModelRetries` (default 5) to prevent infinite loops when many models in a tier are broken simultaneously.

An `attemptedModels` set prevents re-resolving to a model that already failed in the current request, so the cascade strictly moves forward through the tier's priority list.

## Account rotation

For OAuth-managed providers (Copilot, Codex, Kiro, Gemini, Claude.ai), `payment_required` (402) and quota-specific rate-limit errors trigger rotation to the next authenticated account before the model cascade kicks in.

- The exhausted account is marked with a reset time (typically next midnight UTC) and automatically restored when the reset time passes.
- If the current account fails with a quota error, the pipeline rotates and retries the same model on the next available account — only once per request, then falls through to the model cascade if the second account also fails.
- If all accounts for the provider are exhausted, the request fails with a 429 and retry guidance indicating that all accounts are exhausted.

Account rotation is transparent to the caller: from the client's perspective, the request either succeeds (possibly on a different account) or fails with a final 429. The audit log records which account served the request.

## Retry logging

The complete retry sequence — attempt number, status code, error type, delay between retries, account used, model used — is recorded in the audit log for each request. Post-incident analysis can reconstruct exactly which attempts were made, which models were cascaded through, and why.

Log fields relevant to retry analysis:

- `retry_attempts` — number of HTTP retries on the final model
- `model_attempts` — number of models tried in the cascade
- `error_type` — final error classification
- `error_message` — upstream error message (redacted if the response filter matched)
- `retry_details` — structured array of each attempt's status, timing, and cause

## SSE error frames

When an error occurs after HTTP headers have already been sent (i.e. during streaming), the gateway cannot send a normal JSON error response. Instead, the error boundary emits a terminal SSE error frame in the same wire format as the active route serializer:

- OpenAI Chat — unnamed `data: {"error":{"message":"...","type":"..."}}`
- Anthropic Messages — `event: error`
- OpenAI Responses — `event: response.failed`

The response is then ended. This ensures streaming clients receive a machine-readable terminal error instead of a silently truncated stream.

Because the backend terminal reclassifies late stream failures before they escape the provider chain, these SSE error frames preserve the backend's typed gateway error (`provider_model_not_found`, `provider_timeout`, `provider_rate_limited`, etc.) instead of collapsing to a generic `internal_error`.

If headers have not been sent, the normal JSON error envelope is used (see "Error envelope" above).

At the HTTP server level, if headers were sent and an unhandled error occurs outside the route chain, the response socket is destroyed immediately since no structured error can be written.

## Fail-fast requirements

The gateway enforces fail-fast behavior for configuration and runtime invariants:

- **Missing signing key** — If neither `ADMIN_SESSION_SIGNING_KEY` nor `ENCRYPTION_KEY` is set, dashboard auth throws `ConfigurationError` at the point of use rather than falling back to a default key.
- **Missing concurrency config** — If a model lacks concurrency configuration, `ConcurrencyController.acquire()` throws `ConfigurationError` instead of silently defaulting.
- **Missing response** — If the route chain reaches the `respond` middleware without `ctx.response` being set, it throws `InternalServerError` rather than passing `undefined` to the serializer.
- **DAO update builders** — `models-dao` filters updates through an explicit allowlist, while several other DAO update helpers still build SQL column lists from caller-supplied field names. Callers therefore must pass already-vetted field sets; the current runtime does not enforce a uniform update allowlist across every DAO.

## Related specs

- **DS001** — the pipeline that drives both the HTTP retry loop and the model cascade loop.
- **DS002** — account rotation integrates with the provider auth layer.
- **DS004** — cooldown state and the model cascade loop.
- **DS013** — retry and timeout configuration knobs.
- **DS015** — audit log fields for retry analysis.
