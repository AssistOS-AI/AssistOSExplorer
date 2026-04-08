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

Free models do not count against budgets.

## Spend cache

Spend is tracked through a shared in-memory runtime service so the hot path does not need to aggregate audit logs on every request.

- cache entries are refreshed when stale
- completed requests record cost back into the cache
- cache misses can be repopulated from the database

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

The dashboard still exposes a Tiers page, but tier-level policy editing is implemented as bindings on cascade models.

## Related specs

- **DS001** — where rate and budget middleware runs in the request path
- **DS004** — direct vs cascade models and tier compatibility
- **DS014** — built-in middleware catalog entries for rate limiter and budget enforcer
- **DS015** — spend and usage surfaces in observability
