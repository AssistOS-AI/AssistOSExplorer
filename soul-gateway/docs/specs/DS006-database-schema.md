# DS006 -- Database Schema

## Summary

This specification describes the PostgreSQL database schema used by Soul Gateway, including all tables, columns, types, constraints, indexes, the monthly partitioning strategy for call logs, and the incremental migration strategy.

## Problem

Soul Gateway needs persistent storage for API keys, model configurations, provider configurations, blacklist rules, call logs, middleware registrations, middleware assignments, and rate-limit state. The call log table grows continuously and must be partitioned for query performance and data retention.

## Design

### Schema

All tables are created in the `soul_gateway` schema. The database is initialized by `db/init.mjs`, which runs the DDL from `schema.sql`, applies incremental migrations, creates monthly partitions, and seeds default data. The connection pool is configured with a maximum of 20 connections, and every query sets `search_path TO soul_gateway, public`.

```sql
CREATE SCHEMA IF NOT EXISTS soul_gateway;
SET search_path TO soul_gateway;
```

### Table: api_keys

Stores client API keys with encrypted values and per-key limits. Each key is stored as both a SHA-256 hash (for lookup) and an encrypted copy (for display hints).

| Column | Type | Default | Constraints | Description |
|--------|------|---------|-------------|-------------|
| id | UUID | gen_random_uuid() | PRIMARY KEY | Unique key identifier |
| key_hash | TEXT | | UNIQUE NOT NULL | SHA-256 hash of the raw API key (lookup index) |
| encrypted_key | BYTEA | | NOT NULL | AES-256 encrypted key (for admin display) |
| label | TEXT | | | Human-readable label (e.g., "Production") |
| key_hint | TEXT | | | Masked hint (e.g., "sk-soul-36cc...c01b") |
| monthly_budget | NUMERIC | NULL | | Monthly spending limit in USD (default $10 via migration; NULL = unlimited) |
| daily_budget | NUMERIC | 2 | | Daily spending limit in USD |
| rpm_limit | INT | 60 | | Requests per minute limit |
| tpm_limit | INT | 100000 | | Tokens per minute limit |
| expires_at | TIMESTAMPTZ | | | Optional expiration timestamp |
| is_revoked | BOOLEAN | false | | Soft-delete / revocation flag |
| budget_reset_at | TIMESTAMPTZ | | | Allows mid-month budget reset |
| last_used_at | TIMESTAMPTZ | | | Updated on each authenticated request |
| created_at | TIMESTAMPTZ | now() | | Creation timestamp |

**Removed columns:** `family_id` and `key_type` were dropped during the families-removal and key-simplification migrations. All keys are now permanent and standalone with per-key rate limits and budgets.

### Table: model_configs

Unified table for both individual models and tiers. The `type` column distinguishes them. Tiers use `model_refs` and `fallback_model` instead of provider fields. Tiers were originally a separate `model_tiers` table; a migration in `init.mjs` copies tier data into `model_configs` with `type = 'tier'`, migrates `tier_middlewares` into `model_middlewares`, then drops the old tables.

| Column | Type | Default | Constraints | Description |
|--------|------|---------|-------------|-------------|
| id | UUID | gen_random_uuid() | PRIMARY KEY | Unique ID |
| name | TEXT | | UNIQUE NOT NULL | Model identifier (e.g., `copilot/gpt-4o`) |
| display_name | TEXT | | | Human-friendly name |
| type | TEXT | 'model' | NOT NULL, CHECK (type IN ('model', 'tier')) | Entry type |
| upstream_model | TEXT | | | Legacy: upstream model name (nullable) |
| provider_key | TEXT | | | References a provider_configs.name |
| provider_model | TEXT | | | Model name as sent to the upstream provider |
| provider_config_id | UUID | | FK to provider_configs(id), SET NULL on delete | Provider foreign key |
| upstream_source | TEXT | | | Source classification (e.g., `openai`, `anthropic`, `google`) |
| mode | TEXT | 'axl/deep' | | Routing mode hint |
| input_price | NUMERIC | 0 | | Price per 1M input tokens (USD) |
| output_price | NUMERIC | 0 | | Price per 1M output tokens (USD) |
| pricing_type | TEXT | 'token' | | `'token'` or `'request'` |
| request_cost | NUMERIC | 0 | | Flat cost per request (for request-priced models) |
| max_concurrency | INT | 3 | | Maximum concurrent requests to this model |
| sort_order | INT | 100 | | Display ordering in /v1/models |
| context_window | TEXT | | | Context window description (e.g., "200k") |
| is_enabled | BOOLEAN | true | | Soft-disable toggle |
| is_free | BOOLEAN | false | | Free models don't count against API key budget |
| tags | TEXT[] | '{}' | | Tag array for tag-based model selection |
| model_refs | TEXT[] | '{}' | | Tier only: ordered list of model names in priority order |
| fallback_model | TEXT | | | Tier only: fallback tier/model name if all refs exhausted |
| created_at | TIMESTAMPTZ | now() | | Creation timestamp |

### Table: provider_configs

Upstream LLM provider connection details. Each provider has a protocol, base URL, and either an encrypted API key or managed OAuth credentials on disk.

| Column | Type | Default | Constraints | Description |
|--------|------|---------|-------------|-------------|
| id | UUID | gen_random_uuid() | PRIMARY KEY | Unique ID |
| name | TEXT | | UNIQUE NOT NULL | Provider slug (e.g., `copilot`, `openai`) |
| display_name | TEXT | | | Human-friendly name |
| protocol | TEXT | 'openai' | NOT NULL | API protocol (`openai`, `anthropic`, etc.) |
| base_url | TEXT | | NOT NULL | Base URL for API calls |
| encrypted_api_key | BYTEA | | | AES-256 encrypted API key (nullable for managed-auth providers) |
| key_hint | TEXT | | | Masked key hint for admin display |
| billing_type | TEXT | 'api_key' | | `'api_key'` or `'subscription'` |
| auth_type | TEXT | 'api_key' | | `'api_key'`, `'managed'`, or `'internal'` |
| is_enabled | BOOLEAN | true | | Soft-disable toggle |
| created_at | TIMESTAMPTZ | now() | | Creation timestamp |
| updated_at | TIMESTAMPTZ | now() | | Last update timestamp |

### Table: blacklist_rules

Content moderation rules that block requests matching specific patterns.

| Column | Type | Default | Constraints | Description |
|--------|------|---------|-------------|-------------|
| id | UUID | gen_random_uuid() | PRIMARY KEY | Unique ID |
| pattern | TEXT | | NOT NULL | Pattern to match against prompt content |
| match_type | TEXT | | CHECK (IN ('exact', 'substring', 'regex')) NOT NULL | How to match |
| action | TEXT | 'block' | | Action on match |
| description | TEXT | | | Human-readable description of the rule |
| is_enabled | BOOLEAN | true | | Soft-disable toggle |
| created_at | TIMESTAMPTZ | now() | | Creation timestamp |

### Table: call_logs (Partitioned)

The main audit trail. Every pipeline request generates one row regardless of success or failure. The table is partitioned by `RANGE (started_at)` on monthly boundaries.

| Column | Type | Default | Description |
|--------|------|---------|-------------|
| **Identity** | | | |
| id | UUID | gen_random_uuid() | Row ID (part of composite PK with started_at) |
| soul_id | TEXT | | Soul identifier from X-Soul-Id header |
| api_key_id | UUID | | Which API key was used |
| agent_name | TEXT | | Agent name from X-Soul-Agent header |
| session_id | UUID | | Session ID from X-Soul-Session header |
| **Request fields** | | | |
| requested_model | TEXT | | Model name as sent by client |
| resolved_model | TEXT | | Actual model used after routing |
| mode | TEXT | | Routing mode |
| is_streaming | BOOLEAN | | Whether stream=true was requested |
| request_messages | JSONB | | Full messages array |
| request_size_bytes | INT | | Byte size of the request |
| **Response fields** | | | |
| response_content | TEXT | | Full response text |
| status_code | INT | | HTTP status (200, 400, 401, 429, 502, etc.) |
| stop_reason | TEXT | | Finish reason (stop, length, tool_calls, error) |
| error_type | TEXT | | Error classification (null on success) |
| error_message | TEXT | | Error message (null on success) |
| response_size_bytes | INT | | Byte size of the response content |
| **Metrics** | | | |
| latency_ms | INT | | Total request duration in milliseconds |
| ttfb_ms | INT | | Time to first byte (first chunk from provider) |
| prompt_tokens | INT | | Input tokens consumed |
| completion_tokens | INT | | Output tokens generated |
| total_tokens | INT | | Total token count |
| input_cost | NUMERIC | | Cost of input tokens (USD) |
| output_cost | NUMERIC | | Cost of output tokens (USD) |
| total_cost | NUMERIC | | Total cost of the request (USD) |
| **Retry & Flags** | | | |
| retry_count | INT | 0 | Number of HTTP-level retries |
| retry_reason | TEXT | | Classification of the retried error |
| retries_detail | JSONB | | Array of { attempt, status, error_type, delay_ms } |
| blocked_by_blacklist | BOOLEAN | false | Whether request was blocked by content policy |
| blacklist_rule_id | UUID | | Which blacklist rule matched |
| blacklist_match | TEXT | | The matched content |
| is_truncated | BOOLEAN | false | Finish reason was not 'stop' |
| is_slow | BOOLEAN | false | Latency exceeded slowRequestMs threshold |
| prompt_size_warning | BOOLEAN | false | Prompt exceeded token warning threshold |
| is_free | BOOLEAN | false | Denormalized: whether model is free |
| **Cache** | | | |
| prompt_hash | TEXT | | SHA-256 hash of messages + model |
| cache_hit | BOOLEAN | false | Whether this was served from cache |
| **Timestamps** | | | |
| started_at | TIMESTAMPTZ | | NOT NULL. When the request began (part of composite PK) |
| completed_at | TIMESTAMPTZ | | When the request finished |

**Primary Key:** Composite `(id, started_at)` -- required for range partitioning. The partition key must be part of the primary key.

**Partition Strategy:** `PARTITION BY RANGE (started_at)`. The `ensurePartitions()` function in `init.mjs` creates partition tables for the current month plus the next 3 months on every startup. Each partition covers a single calendar month:

```sql
call_logs_2026_03  -- 2026-03-01 to 2026-04-01
call_logs_2026_04  -- 2026-04-01 to 2026-05-01
...
```

Partitions older than `config.retentionDays` (90 days) are dropped.

### Indexes on call_logs

| Index | Columns | Condition | Purpose |
|-------|---------|-----------|---------|
| idx_call_logs_soul_started | (soul_id, started_at) | | Filter logs by soul_id + time range |
| idx_call_logs_model_started | (resolved_model, started_at) | | Filter logs by resolved_model + time range |
| idx_call_logs_started | (started_at) | | Time-range scans for dashboards and exports |
| idx_call_logs_error | (error_type) | WHERE error_type IS NOT NULL | Partial index: only rows with errors (for error dashboard) |
| idx_call_logs_blocked | (blocked_by_blacklist) | WHERE blocked_by_blacklist = true | Partial index: only blocked requests |
| idx_call_logs_session | (api_key_id, session_id, started_at) | | Session history lookup |
| idx_call_logs_key_started | (api_key_id, started_at) | | Per-key budget aggregation queries |
| idx_call_logs_prompt_hash | (prompt_hash) | WHERE status_code = 200 AND prompt_hash IS NOT NULL | Partial index: successful requests with hash (for caching) |

### Additional Indexes

| Index | Table | Purpose |
|-------|-------|---------|
| idx_model_configs_type | model_configs | Fast tier vs model filtering |
| idx_model_middlewares_model | model_middlewares | Load middlewares for a model/tier |
| idx_model_middlewares_order | model_middlewares | Load middlewares in sort_order for a model |

### Table: middlewares

Registry of discovered middleware plugins. Populated automatically by `scanMiddlewares()` on startup.

| Column | Type | Default | Constraints | Description |
|--------|------|---------|-------------|-------------|
| id | UUID | gen_random_uuid() | PRIMARY KEY | Unique ID |
| name | TEXT | | UNIQUE NOT NULL | Middleware name (from module export) |
| description | TEXT | | | What the middleware does |
| file_name | TEXT | | NOT NULL | Source file name in middlewares/ directory |
| type | TEXT | 'both' | NOT NULL, CHECK (IN ('pre', 'post', 'both')) | Hook type |
| supports_streaming | BOOLEAN | false | | Whether after() runs on streaming responses |
| default_settings | JSONB | '{}' | | Default configuration for this middleware |
| version | TEXT | '1.0.0' | | Middleware version |
| is_discovered | BOOLEAN | true | | Set to false when file removed from disk |
| created_at | TIMESTAMPTZ | now() | | First discovery timestamp |
| updated_at | TIMESTAMPTZ | now() | | Last update timestamp |

### Table: model_middlewares

Junction table assigning middlewares to models/tiers with per-assignment configuration.

| Column | Type | Default | Constraints | Description |
|--------|------|---------|-------------|-------------|
| id | UUID | gen_random_uuid() | PRIMARY KEY | Unique ID |
| model_config_id | UUID | | REFERENCES model_configs(id) ON DELETE CASCADE, NOT NULL | Target model or tier |
| middleware_id | UUID | | REFERENCES middlewares(id) ON DELETE CASCADE, NOT NULL | Assigned middleware |
| is_enabled | BOOLEAN | true | | Per-assignment enable toggle |
| sort_order | INT | 100 | | Execution priority (lower runs first) |
| settings | JSONB | '{}' | | Override settings merged with defaults |
| created_at | TIMESTAMPTZ | now() | | Creation timestamp |
| updated_at | TIMESTAMPTZ | now() | | Last update timestamp |

**Unique constraint:** `(model_config_id, middleware_id)` -- each middleware can be assigned to a model at most once.

**Indexes:** `idx_model_middlewares_model` on `(model_config_id)`, `idx_model_middlewares_order` on `(model_config_id, sort_order)`.

### Table: rate_limit_state

Sliding window counters for rate limiting (survives process restarts).

| Column | Type | Default | Constraints | Description |
|--------|------|---------|-------------|-------------|
| key | TEXT | | PRIMARY KEY | Rate limit key (e.g., `rpm:key:<uuid>`) |
| window_start | TIMESTAMPTZ | | NOT NULL | Start of current sliding window |
| counter | INT | 0 | | Number of requests/tokens in current window |
| updated_at | TIMESTAMPTZ | now() | | Last update timestamp |

### Migration Strategy

The `migrate()` function in `init.mjs` uses an additive, idempotent approach:

- All DDL uses `ADD COLUMN IF NOT EXISTS` or `CREATE TABLE IF NOT EXISTS`
- Column removals use `DROP COLUMN IF EXISTS`
- Constraint additions are wrapped in `DO $$ BEGIN ... EXCEPTION WHEN duplicate_object THEN NULL; END $$`
- Data migrations are idempotent (guarded by `ON CONFLICT ... DO UPDATE`)
- No separate migration files or version table -- the full migration set runs every startup
- Old tables (e.g., `soul_families`, `model_tiers`, `tier_middlewares`) are dropped after data is migrated

This means the database reaches a consistent state regardless of which previous version was deployed. Every migration statement is safe to run repeatedly.

## Implementation

| File | Role |
|------|------|
| `db/schema.sql` | DDL for all tables |
| `db/init.mjs` | Connection pool, schema creation, migration, partition management |
| `db/keys-dao.mjs` | API key CRUD and resolution |
| `db/models-dao.mjs` | Model and tier CRUD |
| `db/providers-dao.mjs` | Provider CRUD |
| `db/blacklist-dao.mjs` | Blacklist rule CRUD |
| `db/logs-dao.mjs` | Log insertion and queries |
| `db/middlewares-dao.mjs` | Middleware and model_middleware CRUD |

## Dependencies

- DS001 (Request Pipeline) -- pipeline writes to call_logs
- DS003 (Middleware Framework) -- middlewares and model_middlewares tables
- DS004 (Model Routing) -- model_configs table with type/model_refs/fallback
- DS007 (Rate Limiting & Budgets) -- rate_limit_state table
- DS008 (Content Filtering) -- blacklist_rules table
