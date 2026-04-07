# DS006 — Database Schema

## Summary

This spec describes the PostgreSQL tables Soul Gateway uses to persist its configuration and audit data. The schema is namespaced as `soul_gateway` and initialized/migrated by the runtime's bootstrap layer on startup. This document stays at the capability level: which data lives in which table and what it's used for. Column-by-column DDL lives in the migration files under `soul-gateway/src/db/migrations/` and is the single source of truth for exact column types, constraints, and indexes.

## Table families

### Provider configuration

- **`providers`** — one row per configured upstream LLM provider. Carries the provider key, display name, adapter key (the plugin that serves this provider's requests), auth strategy (`api_key` / `oauth` / `subscription`), base URL, OAuth adapter key, kind (`external_api` / `custom`), provider mode, executor key for custom providers, capability flags (supports_streaming, supports_tools, supports_messages_api, supports_responses_api), and free-form settings/metadata JSON blobs. `adapter_key` is declared `NOT NULL` because the execution engine resolves the handling plugin exclusively from this field.
- **`provider_accounts`** — one row per credential stored for a provider. API-key accounts carry encrypted `secret_ciphertext`, `secret_iv`, and `secret_auth_tag` columns (all `bytea`) holding the AES-256-GCM components of the encrypted key. OAuth accounts carry a `credentials_path` pointing at an encrypted credential file on disk and token expiry metadata used by the refresh loop. Every account tracks status (`active` / `refreshing` / `quota_exhausted` / `reauth_required` / `deleted`), quota reset time, last-used time, and per-account error state.
- **`provider_hook_assignments`** — rows binding registered provider hooks to specific providers with a phase (`request` / `stream` / `response`), sort order, and per-assignment settings. The provider pipeline composer reads and writes this table.

### Model registry

- **`models`** — one row per model the gateway can route to. Carries model key, display name, foreign key to `providers`, provider-specific model id, execution kind, enabled flag, concurrency limit, queue and request timeout overrides, pricing mode, per-million input/output pricing, per-request pricing, rate limit / budget / loop / response-filter overrides, retry policy, capabilities, tags, and a metadata JSON blob. Discovered models are tagged with a `discovery_source` (`manual` / `auto`).
- **`model_aliases`** — maps alternative names to canonical model keys so legacy names and dashboard-friendly shortcuts both resolve correctly.
- **`tiers`** — one row per tier (named group of models arranged in priority order). Carries tier name, display name, an ordered `model_refs` array, an optional `fallback_tier_id` pointing at another tier, enabled flag, and sort order.

### API keys and auth

- **`api_keys`** — one row per soul-gateway API key issued to a client. Carries label, HMAC hash of the plaintext key (for lookup), encrypted plaintext key (so the full key can be recovered for display/export if needed) using the same AES-256-GCM components as provider accounts, per-key RPM limit, per-key TPM limit, per-key daily budget, per-key monthly budget, expiration, status (active/revoked), and a metadata JSON blob.
- **`sessions`** — dashboard admin sessions: HMAC-signed bearer tokens issued by the dashboard login endpoint, with expiry and CSRF token.

### Middleware and policy

- **`middlewares`** — catalog of registered middleware modules. Rows are written by the middleware loader at startup and on rescans.
- **`middleware_assignments`** — rows binding middlewares to tiers (tier-scoped policy) or individual models (model-scoped override), with execution sort order and per-assignment setting overrides.
- **`blacklist`** — content policy rules with a pattern, match type (`exact` / `substring` / `regex`), description, and enabled flag. Evaluated by the content blocker middleware (see DS008).

### Observability and state

- **`audit_logs`** — one row per completed request. Carries requestor identity (soul ID, agent, session, API key ID), requested model, resolved model, request content, response content, HTTP status, error type/message, token counts, costs, latency, time-to-first-byte, retry details, and flags (cached, blocked, truncated, slow, oversized). Partitioned by month for query performance and retention management.
- **`session_state`** — per-session conversation state used by the loop detector (DS010) and the session-context middleware (DS014). Includes rolling response fingerprints, cumulative token counts, and last-seen timestamps.
- **`cooldowns`** — active model cooldowns. Cooldown state is primarily held in memory for performance; the table exists for the management API to list and clear cooldowns. Cooldowns do not survive process restarts.

## Encryption

All encrypted columns across the schema (`api_keys.key_ciphertext/iv/auth_tag` and `provider_accounts.secret_ciphertext/iv/auth_tag`) are `bytea` and hold raw byte values — not hex-encoded strings. The runtime's encryption module produces and consumes `Buffer` values directly so there is no encoding dance between Node and the database. This is a hard requirement: storing hex strings into these columns corrupts the auth tag length and fails every subsequent decryption.

## Partitioning

`audit_logs` is partitioned by month. A background job creates next month's partition in advance and drops partitions older than the configured retention period (default 90 days). Queries against the audit log are expected to include a time-range filter that aligns with the partitioning key so they read only the relevant partitions.

## Related specs

- **DS002** — how provider rows and provider_accounts rows get populated (via OAuth flows, API-key creation, auto-provisioning).
- **DS004** — how `models` and `tiers` are consumed by the model router.
- **DS007** — how `api_keys` is consumed by the rate limiter and budget enforcer.
- **DS008** — how `blacklist` is evaluated.
- **DS015** — how `audit_logs` is written and broadcast.
