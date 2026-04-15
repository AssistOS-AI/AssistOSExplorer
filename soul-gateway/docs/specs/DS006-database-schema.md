# DS006 — Database Schema

## Summary

This spec describes the PostgreSQL tables Soul Gateway uses to persist its configuration and audit data. The schema is namespaced as `soul_gateway` and initialized/migrated by the runtime's bootstrap layer on startup. This document stays at the capability level: which data lives in which table and what it's used for. Column-by-column DDL lives in the migration files under `soul-gateway/src/db/migrations/` and is the single source of truth for exact column types, constraints, and indexes.

Migration `004-unified-model-bindings.sql` establishes the current target schema shape. Historical data migration from the old `main`-branch app schema is handled separately by `soul-gateway/src/db/import/import-main-branch-data.mjs`; it is not encoded into the SQL migrations.

## Table families

### Provider configuration

- **`providers`** — one row per configured upstream LLM provider. Carries the provider key, display name, adapter key (the backend module key that serves this provider's requests), auth strategy (`api_key` / `oauth` / `subscription`), base URL, OAuth adapter key, kind (`external_api` / `custom`), provider mode, capability flags (supports_streaming, supports_tools, supports_messages_api, supports_responses_api), and free-form settings/metadata JSON blobs. `adapter_key` is declared `NOT NULL` because `backendDispatchMiddleware()` resolves the handling terminal middleware from this field via `backendCatalog.getTerminal(provider.backendKey)`. The DB column keeps the historical name `adapter_key`; the snapshot loader exposes it as `provider.backendKey` in the runtime view.
- **`provider_accounts`** — one row per credential stored for a provider. API-key accounts carry encrypted `secret_ciphertext`, `secret_iv`, and `secret_auth_tag` columns (all `bytea`) holding the AES-256-GCM components of the encrypted key. OAuth accounts carry a `credentials_path` pointing at an encrypted credential file on disk and token expiry metadata used by the refresh loop. Every account tracks status (`active` / `refreshing` / `quota_exhausted` / `reauth_required` / `deleted`), quota reset time, last-used time, and per-account error state.
- **`middleware_bindings(scope='provider')`** — provider-scoped middleware bindings. This is the replacement for the deleted `provider_hook_assignments` table.

### Model registry

- **`models`** — one row per addressable model the gateway can route to. Direct models carry a provider foreign key plus provider-specific model id. Cascade models carry `strategy_kind='cascade'` and no provider foreign key, and act as the runtime backing for the dashboard `Tiers` page.
- **`model_aliases`** — maps alternative names to canonical model keys so public aliases and dashboard-friendly shortcuts both resolve correctly.
- **`model_children`** — ordered children for cascade models. This replaces the old tier-membership tables in the active runtime.

### API keys and auth

- **`api_keys`** — one row per soul-gateway API key issued to a client. Carries label, HMAC hash of the plaintext key (for lookup), encrypted plaintext key (so the full key can be recovered for display/export if needed) using the same AES-256-GCM components as provider accounts, per-key RPM limit, per-key TPM limit, per-key daily budget, per-key monthly budget, expiration, status (active/revoked), and a metadata JSON blob.
- **`sessions`** — persistent conversation-group rows used by the request path and dashboard session browsers. Rows are created for live traffic by the session resolver and can also be backfilled from `main`-branch `call_logs` during historical import. Implicit-session creation runs on a checked-out client inside `BEGIN ISOLATION LEVEL READ COMMITTED`, then takes `pg_advisory_xact_lock(hashtext('implicit:<api_key>:<agent>'))` to serialize per-group creators, rechecks for an existing open row on a fresh post-lock snapshot, and inserts with `ON CONFLICT (group_key, sequence_no) DO NOTHING` only when no eligible row exists. Because the transaction explicitly uses `READ COMMITTED`, statements issued after the lock is granted see rows committed by earlier contenders and concurrent creators deterministically reuse the existing open session or allocate one new `sequence_no`. The `ON CONFLICT` clause is defense-in-depth: if it ever fires, the DAO re-reads the open session row and returns it.

### Middleware and policy

- **`middlewares`** — catalog of registered middleware modules. Rows are written by the middleware loader at startup and on rescans.
- **`middleware_bindings`** — unified middleware binding table. `scope='gateway'` applies globally, `scope='model'` binds to a direct or cascade model, and `scope='provider'` binds to a provider.
- **`blacklist_rules`** — content policy rules with a pattern, match type (`exact` / `substring` / `regex`), description, and enabled flag. Evaluated by the content blocker middleware.

### Observability and state

- **`audit_logs`** — one row per public request. The route middleware inserts the row near the top of the request pipeline with `status='in_progress'`, then finalizes it after success or failure. Rows carry requestor identity (soul ID, agent, session, API key ID), requested and resolved routing fields, response excerpt when available, HTTP status, error type/message, token counts, costs, latency, time-to-first-byte, retry details, and flags (cached, blocked, streaming, cascaded). Partitioned by month for query performance and retention management. Historical `main`-branch `call_logs` can be backfilled into this table by the dedicated importer.
- **`session_state`** — reserved per-session state storage exposed through management/session surfaces. The table exists in the schema, but the current built-in loop-detector and session-context middlewares keep their active working state in memory rather than depending on this table on the hot path.
- **`model_cooldowns`** — active model cooldowns. Cooldown state is primarily held in memory for performance; the table exists for the management API to list and clear cooldowns. Cooldowns do not survive process restarts.

## Encryption

All encrypted columns across the schema (`api_keys.key_ciphertext/iv/auth_tag` and `provider_accounts.secret_ciphertext/iv/auth_tag`) are `bytea` and hold raw byte values — not hex-encoded strings. The runtime's encryption module produces and consumes `Buffer` values directly so there is no encoding dance between Node and the database. This is a hard requirement: storing hex strings into these columns corrupts the auth tag length and fails every subsequent decryption.

## Partitioning

`audit_logs` is partitioned by month. A background job creates next month's partition in advance and drops partitions older than the configured retention period (default 90 days). Queries against the audit log are expected to include a time-range filter that aligns with the partitioning key so they read only the relevant partitions.

## Historical import

When migrating from the older `main`-branch Soul Gateway app database, the runtime does not rely on SQL migration files alone. The dedicated importer at `soul-gateway/src/db/import/import-main-branch-data.mjs` reads the old tables (`provider_configs`, `model_configs`, `model_middlewares`, old `api_keys`) and writes them into the current schema (`providers`, `provider_accounts`, `models`, `model_children`, `middleware_bindings`, current `api_keys`).

When run with `--include-call-logs`, the same importer also reads historical `call_logs`, writes them into `audit_logs`, and derives closed `sessions` rows from the imported `main`-branch log stream so imported history remains browsable in the current dashboard/session APIs.

## Related specs

- **DS002** — how provider rows and provider_accounts rows get populated (via OAuth flows, API-key creation, auto-provisioning).
- **DS004** — how `models` and cascade models are consumed by the model router.
- **DS007** — how `api_keys` is consumed by the rate limiter and budget enforcer.
- **DS008** — how `blacklist` is evaluated.
- **DS015** — how `audit_logs` is written and broadcast.
