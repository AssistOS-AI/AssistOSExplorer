# DS007 — Rate Limiting, Budgets, and API Keys

## Summary

This spec describes per-key rate limiting (RPM and TPM), budget enforcement (daily and monthly), the cost calculation formula, the spend cache that prevents audit-log scans on every request, and the API key lifecycle.

## Per-key rate limiting

Each API key has its own rate limit and budget configuration. Keys are standalone entities — no family, group, or tier concept. Rate limits can be overridden per tier or per model.

### Requests Per Minute (RPM)

- Each API key has a configurable RPM limit (default 60).
- The system tracks request counts in a sliding 60-second window.
- When the limit is exceeded, requests are rejected with a `429` and retry guidance ("retry after 60 seconds").
- RPM is a **hard limit** — the request is blocked before reaching the model.

### Tokens Per Minute (TPM)

- Each API key has a configurable TPM limit (default 100,000).
- The system tracks token usage in a sliding 60-second window.
- Exceeding TPM generates a warning but does not block requests — TPM is a **soft limit**.

## Budgets

### Daily budget

- Each API key can have a daily spending limit (default $2.00, or unlimited if null).
- The system aggregates the cost of successful requests since midnight UTC.
- When the budget is exceeded, requests are rejected until the next UTC day begins.
- Free models (explicitly marked as free) do not count against budgets.
- The daily budget can be reset manually mid-day via the management API (for mid-day recovery after a spike).
- Budget limits can be overridden per tier or per model to be stricter or more generous than the key default.

### Monthly budget

- Each API key can optionally have a monthly spending limit.
- Aggregates cost within the current UTC month.
- Resets at the start of each UTC month.

## Cost calculation

Cost is computed after each request completes and recorded in the audit log.

### Token-based pricing

Most direct API providers (OpenAI, Anthropic, Google, NVIDIA, etc.) charge per token:

```
input_cost  = (prompt_tokens / 1,000,000) × input_price_per_million
output_cost = (completion_tokens / 1,000,000) × output_price_per_million
total_cost  = input_cost + output_cost
```

Prices are stored on the `models` row. When a token-priced model has no pricing configured locally, the gateway can look up pricing from an external pricing directory (e.g. OpenRouter's model catalog).

### Per-request pricing

Subscription-based providers (Copilot, Kiro) charge a flat rate per request regardless of token count:

```
total_cost = request_cost
```

Request costs are set on the `models` row and vary by model tier.

All costs are rounded to six decimal places to avoid floating-point drift.

## Spend caching

To avoid querying the full audit log on every request, the system maintains a short-lived in-memory cache of each key's current daily spend.

- The cache is initialized as a shared runtime service at startup.
- Each entry is refreshed on a ~10-second interval (configurable).
- Long-idle entries are evicted periodically to avoid unbounded memory growth.
- When a key's spend is consulted and the cache entry is missing or stale, the aggregate is re-computed from the audit log for that key only.

This keeps budget enforcement on the critical request path to an in-memory lookup instead of a Postgres aggregate query.

## API key management

### Creation

- The system generates cryptographically random API keys in a `sk-soul-<hex>` format for client authentication. Custom key values are also accepted.
- Keys are stored encrypted. An HMAC hash is used for fast lookup during authentication. The full plaintext key is returned exactly once at creation and cannot be retrieved afterward.
- A key hint (first 12 + last 4 characters, e.g. `sk-soul-abcd...wxyz`) allows administrators to identify keys without seeing the full value.

### Configurable properties

Each key has configurable properties:

| Property | Type | Default | Description |
|---|---|---|---|
| `label` | string | — | Human-readable name (e.g. "production", "dev-team") |
| `rpm_limit` | int | 60 | Per-key RPM limit |
| `tpm_limit` | int | 100000 | Per-key TPM limit (soft) |
| `daily_budget_usd` | decimal | 2.00 | Daily spending cap |
| `monthly_budget_usd` | decimal | null | Optional monthly spending cap |
| `expires_at` | timestamp | null | Optional expiration |
| `status` | enum | `active` | `active` / `revoked` |
| `metadata` | json | `{}` | Free-form metadata |

### Revocation

Keys can be revoked (soft delete) — revoked keys immediately stop authenticating. The key row is kept so the audit log can still resolve the key id to a label.

### Budget reset

The daily budget for a key can be reset manually via the management API — this clears the key's spend cache entry so the next request re-reads from the audit log with a fresh starting point at the current time.

### Listing

The management API lists all keys with their current daily spend, status, and key hint. The full plaintext key is never returned on listings.

## Overrides

Rate limits and budgets can be overridden at two finer scopes beyond the per-key default:

- **Per-tier override** — stored on the tier row. Applies to any request routed through that tier.
- **Per-model override** — stored on the model row. Applies to any request that resolves directly to that model.

The effective limit is computed at dispatch time by taking the most specific override that applies.

## Related specs

- **DS002** — provider credential storage. Note that soul-gateway API keys (this spec) and upstream provider credentials (DS002) are unrelated concepts with separate tables and lifecycles.
- **DS004** — tier and model overrides live on the same rows this spec writes to.
- **DS006** — the `api_keys` table backing this spec.
- **DS014** — the built-in rate limiter and budget enforcer middlewares that apply these policies.
- **DS015** — the audit log that feeds spend aggregation.
