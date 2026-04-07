# DS004 — Model Routing

## Summary

This spec describes how Soul Gateway resolves a requested model name into a concrete upstream provider and model, how it falls back through tiers when a model is unavailable, how it places failing models into cooldown, how it enforces per-model concurrency, and how it calculates cost.

## Model registry

The system maintains a registry of named models. Each model maps to an upstream provider and a provider-specific model identifier. When a request arrives, the system resolves the requested model name to a concrete provider and model. Resolution supports both direct model names and tier names.

Model names follow a `provider/model` convention (e.g. `codestral/codestral-latest`, `exa/search-exa`). Tier names follow an `axl/<tier>` convention (e.g. `axl/fast`, `axl/deep`, `axl/code`). Legacy naming formats are accepted and normalized for backward compatibility.

## Tier-based fallback

A **tier** is a named group of models arranged in priority order. When a request targets a tier, the system selects the first model in the list that is enabled and not in cooldown.

- Tiers can specify a fallback tier. If all models in the primary tier are unavailable, the system cascades to the fallback tier. Circular fallback references are detected and prevented via a visited-set.
- When a model fails during request processing, the system automatically retries with the next model in the tier (up to a configurable maximum, default 5 attempts). Previously-failed models within the same request are not retried.

### Example

A typical "axl/fast" tier with three models and a fallback to "axl/deep":

```
axl/fast
  ├ groq/llama-3.3-70b          (priority 1)
  ├ fireworks/llama-3.3-70b     (priority 2)
  └ openai/gpt-4o-mini          (priority 3)
  fallback → axl/deep
```

The router first tries the Groq-hosted model. If it is in cooldown or disabled, it moves to the Fireworks-hosted version, then to GPT-4o-mini. If all three are unavailable, it follows the fallback to the "axl/deep" tier and repeats the process with that tier's model list.

### Tier middlewares

Tiers can have middlewares assigned at the tier level. During request processing, tier-level middlewares execute before model-level middlewares. This allows applying policies (like rate limiting or budget enforcement) to an entire tier regardless of which specific model gets selected.

## Model cooldown

When a model returns a quota or rate-limit error from its upstream provider, the system places that model in a temporary cooldown.

- The default cooldown duration is 1 hour, configurable via the `COOLDOWN_DURATION_MS` environment variable.
- Models in cooldown are skipped during tier resolution.
- Cooldowns expire automatically. A background process periodically cleans up expired entries.
- Cooldowns can be cleared manually via the management API — either for a specific model or globally.
- Cooldown state is held in memory. After a restart, all models are immediately available again.

### Cascade behavior

Two cascade types exist in the model retry loop:

- **Cooldown cascade** — triggered by `payment_required` (402) or `rate_limit_error` (429). The model is placed in cooldown and the system cascades to the next model in the tier. Cooldown cascades are triggered by errors that are likely to persist for the full cooldown duration.
- **Immediate cascade** — triggered by any other classified error (auth failures, connection errors, etc.). The next model in the tier is tried immediately without adding a cooldown entry.
- **No cascade** — unclassified errors are returned to the client without trying the next model.

## Concurrency control

Each model has a configurable maximum number of concurrent requests (default 3). When the limit is reached, additional requests wait in a queue with a configurable timeout (default 60 seconds). If the timeout expires, the request is rejected with a 503 and a `Retry-After` header.

- Concurrency limits can be updated via the management API without restarting the system. The semaphore re-reads the limit on every acquisition.
- Release uses direct handoff: if waiters are queued, the slot is passed directly to the next waiter without decrementing `active`. This prevents race conditions where a new request could steal the slot between decrement and waiter notification.
- Per-model queue statistics (active, max, waiting) are exposed via the metrics endpoint.

## Pricing

Each model has configurable pricing: either token-based (cost per million input/output tokens) or request-based (flat fee per request).

- When pricing is not configured locally, the system can look up pricing from an external pricing directory (e.g. OpenRouter's model catalog).
- Cost is calculated after each request and recorded in the audit log.
- Free models (explicitly marked as free) do not count against budgets (see DS007).

### Token-based pricing

```
input_cost  = (prompt_tokens / 1,000,000) × input_price
output_cost = (completion_tokens / 1,000,000) × output_price
total_cost  = input_cost + output_cost
```

### Per-request pricing

Subscription-based providers (Copilot, Kiro) charge a flat rate per request regardless of token count:

```
total_cost = request_cost
```

Request costs are set in the model registry based on the model tier.

All costs are rounded to six decimal places to avoid floating-point drift.

## Model retry loop

The pipeline's outer retry loop handles model-level failures:

```
for modelAttempt in 0..maxModelRetries (default 5):
  resolve model (skipping cooldown models and already-attempted models in this request)
  acquire concurrency slot
  try:
    dispatch with per-provider HTTP retries  (see DS009)
    stream or buffer response
    break on success
  catch:
    if cooldown trigger  → put in cooldown, continue
    if cascade trigger   → continue (no cooldown)
    else                 → throw (non-recoverable)
  finally:
    release slot
```

An `attemptedModels` set prevents re-resolving to a model that already failed in this request.

## Related specs

- **DS001** — the request pipeline that drives the model retry loop.
- **DS002** — provider authentication used during dispatch; account rotation on quota errors.
- **DS003** — middleware and hook assignment that happens around model resolution.
- **DS006** — the DB tables backing the model registry, tiers, and provider records.
- **DS007** — budget enforcement that runs as a middleware attached to tiers and models.
- **DS009** — error classification that determines cooldown vs cascade vs throw.
