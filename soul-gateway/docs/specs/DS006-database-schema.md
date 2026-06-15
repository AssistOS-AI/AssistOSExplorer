# DS006 — Database Schema

## Summary

This spec describes the SQLite tables Soul Gateway uses to persist configuration and audit data. The database file lives at `SQLITE_PATH`, defaulting to `/data/soul-gateway.sqlite3` inside the Ploinky-managed Soul Gateway container. The runtime initializes the current schema on startup from `soul-gateway/src/db/schema/sqlite-current.sql`, which is the single source of truth for exact column types, constraints, and indexes. There is no Postgres schema, no separate database agent, and no historical import path in the SQLite deployment.

This document stays at the capability level: which data lives in which table and what it's used for.

## Table families

### Provider configuration

- **`providers`** — one row per configured upstream LLM provider. Carries the provider key, display name, adapter key (the backend module key that serves this provider's requests), auth strategy (`api_key` / `oauth` / `subscription`), base URL, OAuth adapter key, kind (`external_api` / `custom`), provider mode, capability flags (supports_streaming, supports_tools, supports_messages_api, supports_responses_api), and free-form settings/metadata JSON blobs. `adapter_key` is declared `NOT NULL` because `backendDispatchMiddleware()` resolves the handling terminal middleware from this field via `backendCatalog.getTerminal(provider.backendKey)`. The DB column keeps the historical name `adapter_key`; the snapshot loader exposes it as `provider.backendKey` in the runtime view.
- Enabled provider rows are validated against the loaded backend catalog during snapshot load; a row whose `adapter_key` does not match a loaded backend aborts the refresh/startup path instead of being tolerated.
- **`provider_accounts`** — one row per credential stored for a provider. API-key accounts carry encrypted `secret_ciphertext`, `secret_iv`, and `secret_auth_tag` columns (all SQLite `BLOB`) holding the AES-256-GCM components of the encrypted key. OAuth accounts carry a `credentials_path` pointing at an encrypted credential file on disk and token expiry metadata used by the refresh loop. Every account tracks status (`active` / `refreshing` / `quota_exhausted` / `reauth_required` / `deleted`), quota reset time, last-used time, and per-account error state.
- **`middleware_bindings(scope='provider')`** — provider-scoped middleware bindings. This is the replacement for the deleted `provider_hook_assignments` table.
- Enabled provider-scoped bindings are validated against the loaded provider middleware registry during snapshot load; unknown `middleware_key` values abort the refresh/startup path instead of being skipped.

### Model registry

- **`models`** — one row per addressable model the gateway can route to. Direct models carry a provider foreign key plus provider-specific model id. Cascade models carry `strategy_kind='cascade'` and no provider foreign key, and act as the runtime backing for the dashboard `Tiers` page.
- For direct models, `discovery_source` distinguishes operator-managed rows (`manual`) from provider-seeded rows (`auto_provisioned` / `synced`). Provider sync updates only non-manual rows and disables missing discovered rows rather than deleting them.
- Provider-seeded direct rows may carry `metadata.openrouter` when the gateway had to enrich missing pricing/context/tag fields from the cached OpenRouter-backed directory during sync or Add Model recovery.
- **`model_aliases`** — maps alternative names to canonical model keys so public aliases and dashboard-friendly shortcuts both resolve correctly.
- **`model_children`** — ordered children for cascade models. This replaces the old tier-membership tables in the active runtime.

### API keys and auth

- **`api_keys`** — one row per signed-subject API key tracked by Soul Gateway. The schema is signed-subject-only: columns are `subject_id` (UNIQUE, e.g. `agent:<repo>/<agentName>` or `user:<userId>`), `subject_type` (`agent` | `user`), `source` (always `signed-subject`), `key_hash` (HMAC of the deterministic key for fast lookup), per-key RPM/TPM/daily/monthly limits, `status` (`active` | `revoked`), and a metadata JSON blob. The previous `key_ciphertext`, `key_iv`, and `key_auth_tag` columns are gone — no encrypted plaintext key is stored because the key is deterministic from the subject and Ploinky's signing key. Revoking a row blocks that subject's deterministic key; deleting the row permits recreation on the next valid signed request. Rotating Ploinky's Ed25519 signing key invalidates every signed key simultaneously.
- **`sessions`** — persistent conversation-group rows used by the request path and dashboard session browsers. Rows are created for live traffic by the session resolver. Implicit-session creation holds an exclusive `BEGIN IMMEDIATE` write transaction around the find-or-create so two racing requests for the same `(api_key, agent)` pair cannot both insert: it rechecks for an existing open row inside the activity window, computes the next `sequence_no`, and inserts a new row only when none exists. Because the SQLite database is a single connection serialized by the runtime's database facade, concurrent creators deterministically reuse the existing open session or allocate one new `sequence_no`.

### Middleware and policy

- **`middlewares`** — catalog of registered middleware modules. Rows are written by the middleware loader at startup and on rescans.
- **`middleware_bindings`** — unified middleware binding table. `scope='gateway'` applies globally, `scope='model'` binds to a direct or cascade model, and `scope='provider'` binds to a provider.
- **`blacklist_rules`** — content policy rules with a pattern, match type (`exact` / `substring` / `regex`), description, and enabled flag. Evaluated by the content blocker middleware.

### Observability and state

- **`audit_logs`** — one row per public request. The route middleware inserts the row near the top of the request pipeline with `status='in_progress'`, then finalizes it after success or failure. Rows carry requestor identity (soul ID, agent, session, API key ID), requested and resolved routing fields, response excerpt when available, HTTP status, error type/message, token counts, costs, latency, time-to-first-byte, retry details, and flags (cached, blocked, streaming, cascaded). Stored as a single indexed table; a retention job deletes rows older than `LOG_RETENTION_DAYS`.
- **`session_state`** — reserved per-session state storage exposed through management/session surfaces. The table exists in the schema, but the current built-in loop-detector and session-context middlewares keep their active working state in memory rather than depending on this table on the hot path.
- **`model_cooldowns`** — active model cooldowns. Cooldown state is primarily held in memory for performance; the table exists for the management API to list and clear cooldowns. Cooldowns do not survive process restarts.

## Encryption

Provider account encrypted columns (`provider_accounts.secret_ciphertext/iv/auth_tag`) are SQLite `BLOB` values holding raw bytes — not hex-encoded strings. The runtime normalizes SQLite `Uint8Array` values back to Node `Buffer` instances before decrypting so encryption callers continue to use raw bytes. This is a hard requirement: storing hex strings into these columns corrupts the auth tag length and fails every subsequent decryption.

The `api_keys` table has no ciphertext columns. API keys are signed-subject values verified cryptographically; only a key hash is stored for lookup.

## Retention

SQLite stores audit logs in a single indexed `audit_logs` table. The retention job deletes rows older than `LOG_RETENTION_DAYS`; it does not create or drop monthly partitions.

## Historical import

The SQLite cutover intentionally starts from an empty database. Old Postgres data and main-branch historical data are not imported.

## Related specs

- **DS002** — how provider rows and provider_accounts rows get populated (via OAuth flows, API-key creation, auto-provisioning).
- **DS004** — how `models` and cascade models are consumed by the model router.
- **DS007** — how `api_keys` is consumed by the rate limiter and budget enforcer.
- **DS008** — how `blacklist` is evaluated.
- **DS015** — how `audit_logs` is written and broadcast.
