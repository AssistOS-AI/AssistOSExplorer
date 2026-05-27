# DS007 — Rate Limiting, Budgets, and API Keys

## Summary

This spec describes:

- per-key RPM and TPM limits
- daily and monthly budgets
- spend caching
- API-key lifecycle
- middleware-level override settings for rate and budget enforcement

## Per-key rate limiting

Each API key has its own limits.

### Requests per minute (RPM)

- hard limit
- default from the API-key record
- enforced by the `rate-limiter` middleware before dispatch

The middleware can override the effective limit per binding via `overrideRpmLimit`.

### Tokens per minute (TPM)

- soft limit
- tracked per API key
- feeds warnings and observability rather than blocking the request path

## Budgets

The `budget-enforcer` middleware checks:

- daily budget
- monthly budget

The effective limits come from:

1. middleware binding settings (`overrideDailyBudget`, `overrideMonthlyBudget`)
2. API-key defaults
3. environment defaults where applicable

Current implementation detail:

- only the daily budget falls back to an environment default (`DEFAULT_DAILY_BUDGET_USD`)
- monthly budget has no environment fallback

Free models do not count against budgets.

## Spend cache

Spend is tracked through a shared in-memory runtime service so the hot path does not need to aggregate audit logs on every request.

- cache entries are refreshed when stale
- completed requests record cost back into the cache
- cache misses can be repopulated from the database

## External-directory pricing

Models with `pricing_mode='external_directory'` resolve prices through the shared cached pricing directory service.

- the default directory source is OpenRouter's public `/api/v1/models` catalog, overridable via `PRICING_DIRECTORY_URL`
- lookup first tries exact ids / canonical slugs and then a unique leaf-slug match when provider namespaces differ
- directory entries can resolve token pricing, request pricing, or free models
- the same directory also supplies management-side fallback context / tags when provider discovery omitted them

## API key lifecycle

The management API supports:

- create
- list
- update
- revoke
- reset daily budget state

Keys are stored encrypted and also hashed for lookup. The plaintext key is only returned at creation time.

## Override scopes

Rate and budget middleware can be bound at:

- gateway scope
- direct-model scope
- cascade-model scope

The management API writes model-scoped bindings into unified `middleware_bindings` rows. The dashboard exposes `/management/tiers` as a cascade-model editor, but tier-scoped policy still lands in ordinary model-scoped `middleware_bindings` rows targeting the cascade model id.

## Management auth boundary

Soul Gateway does not own management login attempts or session issuance. Browser login throttling belongs to Ploinky's default auth surface. The removed `/management/auth/*` compatibility endpoints return HTTP 410 and do not participate in rate-limit or budget policy.

## Related specs

- **DS001** — where rate and budget middleware runs in the request path
- **DS004** — direct vs cascade models
- **DS014** — built-in middleware catalog entries for rate limiter and budget enforcer
- **DS015** — spend and usage surfaces in observability
