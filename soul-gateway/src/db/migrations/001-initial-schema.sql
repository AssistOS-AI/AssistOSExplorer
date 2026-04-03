-- Soul Gateway canonical schema

CREATE SCHEMA IF NOT EXISTS soul_gateway;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
SET search_path TO soul_gateway, public;

-- ── api_keys ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS api_keys (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label                 text NOT NULL,
  key_hash              bytea NOT NULL UNIQUE,
  key_ciphertext        bytea NOT NULL,
  key_iv                bytea NOT NULL,
  key_auth_tag          bytea NOT NULL,
  key_hint              text NOT NULL,
  rpm_limit             integer NOT NULL DEFAULT 60 CHECK (rpm_limit > 0),
  tpm_limit             integer NOT NULL DEFAULT 100000 CHECK (tpm_limit > 0),
  daily_budget_usd      numeric(14,8),
  monthly_budget_usd    numeric(14,8),
  expires_at            timestamptz,
  status                text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  last_used_at          timestamptz,
  metadata              jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  revoked_at            timestamptz,
  CHECK (daily_budget_usd IS NULL OR daily_budget_usd >= 0),
  CHECK (monthly_budget_usd IS NULL OR monthly_budget_usd >= 0)
);

CREATE INDEX IF NOT EXISTS api_keys_status_expires_idx
  ON api_keys (status, expires_at);
CREATE INDEX IF NOT EXISTS api_keys_last_used_idx
  ON api_keys (last_used_at DESC);

-- ── providers ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS providers (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_key          text NOT NULL UNIQUE,
  display_name          text NOT NULL,
  kind                  text NOT NULL CHECK (kind IN ('external_api', 'search', 'local_model', 'wrapper', 'deep_research')),
  adapter_key           text NOT NULL,
  auth_strategy         text NOT NULL CHECK (auth_strategy IN ('none', 'api_key', 'oauth', 'hybrid', 'custom')),
  oauth_adapter_key     text,
  base_url              text,
  enabled               boolean NOT NULL DEFAULT true,
  supports_streaming    boolean NOT NULL DEFAULT true,
  supports_tools        boolean NOT NULL DEFAULT true,
  supports_messages_api boolean NOT NULL DEFAULT false,
  supports_responses_api boolean NOT NULL DEFAULT false,
  settings              jsonb NOT NULL DEFAULT '{}'::jsonb,
  metadata              jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (auth_strategy <> 'oauth')
    OR oauth_adapter_key IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS providers_enabled_kind_idx
  ON providers (enabled, kind);
CREATE INDEX IF NOT EXISTS providers_oauth_adapter_idx
  ON providers (oauth_adapter_key);

-- ── provider_accounts ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS provider_accounts (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id             uuid NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  account_label           text NOT NULL,
  auth_type               text NOT NULL CHECK (auth_type IN ('api_key', 'oauth')),
  status                  text NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active', 'refreshing', 'reauth_required', 'quota_exhausted', 'disabled', 'deleted')),
  external_account_id     text,
  secret_ciphertext       bytea,
  secret_iv               bytea,
  secret_auth_tag         bytea,
  secret_hint             text,
  credentials_path        text,
  access_token_expires_at timestamptz,
  refresh_token_expires_at timestamptz,
  refresh_margin_seconds  integer NOT NULL DEFAULT 300 CHECK (refresh_margin_seconds >= 0),
  quota_resets_at         timestamptz,
  last_used_at            timestamptz,
  last_error_type         text,
  last_error_message      text,
  last_error_at           timestamptz,
  metadata                jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  deleted_at              timestamptz,
  CHECK (
    (auth_type = 'api_key' AND secret_ciphertext IS NOT NULL)
    OR (auth_type = 'oauth' AND credentials_path IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS provider_accounts_rotation_idx
  ON provider_accounts (provider_id, status, quota_resets_at);
CREATE INDEX IF NOT EXISTS provider_accounts_refresh_idx
  ON provider_accounts (provider_id, access_token_expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS provider_accounts_ext_id_unique_idx
  ON provider_accounts (provider_id, external_account_id)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS provider_accounts_lru_idx
  ON provider_accounts (last_used_at ASC NULLS FIRST);

-- ── models ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS models (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  model_key                 text NOT NULL UNIQUE,
  display_name              text NOT NULL,
  provider_id               uuid NOT NULL REFERENCES providers(id) ON DELETE RESTRICT,
  provider_model_id         text NOT NULL,
  execution_kind            text NOT NULL CHECK (execution_kind IN ('provider_model', 'search_model', 'local_model', 'wrapper_model')),
  enabled                   boolean NOT NULL DEFAULT true,
  concurrency_limit         integer NOT NULL DEFAULT 3 CHECK (concurrency_limit > 0),
  queue_timeout_ms          integer NOT NULL DEFAULT 60000 CHECK (queue_timeout_ms > 0),
  request_timeout_ms        integer NOT NULL DEFAULT 120000 CHECK (request_timeout_ms > 0),
  pricing_mode              text NOT NULL DEFAULT 'external_directory'
                            CHECK (pricing_mode IN ('external_directory', 'token', 'request', 'free')),
  input_price_per_million   numeric(14,8),
  output_price_per_million  numeric(14,8),
  request_price_usd         numeric(14,8),
  rate_limit_override       jsonb NOT NULL DEFAULT '{}'::jsonb,
  budget_override           jsonb NOT NULL DEFAULT '{}'::jsonb,
  loop_override             jsonb NOT NULL DEFAULT '{}'::jsonb,
  response_filter_override  jsonb NOT NULL DEFAULT '{}'::jsonb,
  retry_policy              jsonb NOT NULL DEFAULT '{}'::jsonb,
  capabilities              jsonb NOT NULL DEFAULT '{}'::jsonb,
  tags                      text[] NOT NULL DEFAULT '{}'::text[],
  is_free                   boolean NOT NULL DEFAULT false,
  discovery_source          text NOT NULL DEFAULT 'manual'
                            CHECK (discovery_source IN ('manual', 'auto_provisioned', 'synced')),
  metadata                  jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CHECK (
    pricing_mode <> 'token'
    OR (input_price_per_million IS NOT NULL AND output_price_per_million IS NOT NULL)
  ),
  CHECK (
    pricing_mode <> 'request'
    OR request_price_usd IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS models_provider_enabled_idx
  ON models (provider_id, enabled);
CREATE INDEX IF NOT EXISTS models_tags_gin_idx
  ON models USING GIN (tags);
CREATE INDEX IF NOT EXISTS models_enabled_kind_idx
  ON models (enabled, execution_kind);

-- ── model_aliases ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS model_aliases (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alias                 text NOT NULL UNIQUE,
  model_id              uuid NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS model_aliases_model_idx
  ON model_aliases (model_id);

-- ── tiers ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS tiers (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tier_key                 text NOT NULL UNIQUE,
  display_name             text NOT NULL,
  description              text,
  fallback_tier_id         uuid REFERENCES tiers(id) ON DELETE SET NULL,
  max_model_attempts       integer NOT NULL DEFAULT 5 CHECK (max_model_attempts > 0),
  enabled                  boolean NOT NULL DEFAULT true,
  rate_limit_override      jsonb NOT NULL DEFAULT '{}'::jsonb,
  budget_override          jsonb NOT NULL DEFAULT '{}'::jsonb,
  loop_override            jsonb NOT NULL DEFAULT '{}'::jsonb,
  response_filter_override jsonb NOT NULL DEFAULT '{}'::jsonb,
  metadata                 jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CHECK (fallback_tier_id IS NULL OR fallback_tier_id <> id)
);

CREATE INDEX IF NOT EXISTS tiers_fallback_idx
  ON tiers (fallback_tier_id);
CREATE INDEX IF NOT EXISTS tiers_enabled_key_idx
  ON tiers (enabled, tier_key);

-- ── tier_models ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS tier_models (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tier_id               uuid NOT NULL REFERENCES tiers(id) ON DELETE CASCADE,
  model_id              uuid NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  priority              integer NOT NULL CHECK (priority > 0),
  enabled               boolean NOT NULL DEFAULT true,
  settings              jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tier_id, model_id),
  UNIQUE (tier_id, priority)
);

CREATE INDEX IF NOT EXISTS tier_models_routing_idx
  ON tier_models (tier_id, enabled, priority);
CREATE INDEX IF NOT EXISTS tier_models_model_idx
  ON tier_models (model_id);

-- ── middlewares ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS middlewares (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  middleware_key        text NOT NULL UNIQUE,
  display_name          text NOT NULL,
  source_type           text NOT NULL CHECK (source_type IN ('builtin', 'custom')),
  hook_mode             text NOT NULL CHECK (hook_mode IN ('pre', 'post', 'both')),
  module_path           text NOT NULL,
  version               text NOT NULL,
  checksum              text NOT NULL,
  default_settings      jsonb NOT NULL DEFAULT '{}'::jsonb,
  enabled               boolean NOT NULL DEFAULT true,
  metadata              jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS middlewares_enabled_source_idx
  ON middlewares (enabled, source_type);

-- ── middleware_assignments ───────────────────────────────────────────

CREATE TABLE IF NOT EXISTS middleware_assignments (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  middleware_id         uuid NOT NULL REFERENCES middlewares(id) ON DELETE CASCADE,
  target_type           text NOT NULL CHECK (target_type IN ('tier', 'model')),
  tier_id               uuid REFERENCES tiers(id) ON DELETE CASCADE,
  model_id              uuid REFERENCES models(id) ON DELETE CASCADE,
  sort_order            integer NOT NULL DEFAULT 100,
  enabled               boolean NOT NULL DEFAULT true,
  settings              jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (target_type = 'tier' AND tier_id IS NOT NULL AND model_id IS NULL)
    OR
    (target_type = 'model' AND model_id IS NOT NULL AND tier_id IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS middleware_assignments_tier_unique_idx
  ON middleware_assignments (middleware_id, tier_id)
  WHERE target_type = 'tier';
CREATE UNIQUE INDEX IF NOT EXISTS middleware_assignments_model_unique_idx
  ON middleware_assignments (middleware_id, model_id)
  WHERE target_type = 'model';
CREATE INDEX IF NOT EXISTS middleware_assignments_tier_plan_idx
  ON middleware_assignments (tier_id, enabled, sort_order);
CREATE INDEX IF NOT EXISTS middleware_assignments_model_plan_idx
  ON middleware_assignments (model_id, enabled, sort_order);

-- ── blacklist_rules ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS blacklist_rules (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_key              text NOT NULL UNIQUE,
  description           text NOT NULL,
  match_type            text NOT NULL CHECK (match_type IN ('exact', 'substring', 'regex')),
  pattern               text NOT NULL,
  case_sensitive        boolean NOT NULL DEFAULT false,
  priority              integer NOT NULL DEFAULT 100,
  enabled               boolean NOT NULL DEFAULT true,
  metadata              jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS blacklist_rules_eval_idx
  ON blacklist_rules (enabled, priority, match_type);

-- ── model_cooldowns ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS model_cooldowns (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  model_id              uuid NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  source_account_id     uuid REFERENCES provider_accounts(id) ON DELETE SET NULL,
  request_id            text,
  reason_type           text NOT NULL,
  reason_message        text,
  started_at            timestamptz NOT NULL DEFAULT now(),
  expires_at            timestamptz NOT NULL,
  cleared_at            timestamptz,
  cleared_by            text,
  metadata              jsonb NOT NULL DEFAULT '{}'::jsonb,
  CHECK (expires_at > started_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS model_cooldowns_active_unique_idx
  ON model_cooldowns (model_id) WHERE cleared_at IS NULL;
CREATE INDEX IF NOT EXISTS model_cooldowns_expires_idx
  ON model_cooldowns (expires_at);
CREATE INDEX IF NOT EXISTS model_cooldowns_reason_idx
  ON model_cooldowns (reason_type, cleared_at);

-- ── sessions ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS sessions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_key             text NOT NULL,
  group_display         text NOT NULL,
  sequence_no           integer NOT NULL CHECK (sequence_no > 0),
  api_key_id            uuid NOT NULL REFERENCES api_keys(id) ON DELETE RESTRICT,
  soul_id               text,
  agent_name            text NOT NULL,
  explicit_session_id   text,
  status                text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  started_at            timestamptz NOT NULL DEFAULT now(),
  last_activity_at      timestamptz NOT NULL DEFAULT now(),
  ended_at              timestamptz,
  request_count         integer NOT NULL DEFAULT 0,
  input_tokens_total    bigint NOT NULL DEFAULT 0,
  output_tokens_total   bigint NOT NULL DEFAULT 0,
  metadata              jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (group_key, sequence_no)
);

CREATE INDEX IF NOT EXISTS sessions_implicit_lookup_idx
  ON sessions (api_key_id, agent_name, last_activity_at DESC);
CREATE INDEX IF NOT EXISTS sessions_soul_idx
  ON sessions (soul_id, last_activity_at DESC);
CREATE INDEX IF NOT EXISTS sessions_status_idx
  ON sessions (status, last_activity_at DESC);

-- ── session_state ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS session_state (
  session_id            uuid PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  summary_text          text NOT NULL DEFAULT '',
  facts_json            jsonb NOT NULL DEFAULT '[]'::jsonb,
  recent_fingerprints   jsonb NOT NULL DEFAULT '[]'::jsonb,
  recent_similarity     jsonb NOT NULL DEFAULT '[]'::jsonb,
  recent_token_volume   bigint NOT NULL DEFAULT 0,
  response_count        integer NOT NULL DEFAULT 0,
  last_response_at      timestamptz,
  last_loop_detected_at timestamptz,
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS session_state_updated_idx
  ON session_state (updated_at DESC);

-- ── audit_logs (partitioned) ────────────────────────────────────────

CREATE TABLE IF NOT EXISTS audit_logs (
  started_at              timestamptz NOT NULL,
  log_id                  uuid NOT NULL DEFAULT gen_random_uuid(),
  request_id              text NOT NULL,
  request_format          text NOT NULL CHECK (request_format IN ('openai_chat', 'anthropic_messages', 'openai_responses')),
  status                  text NOT NULL CHECK (status IN ('in_progress', 'succeeded', 'failed', 'aborted')),
  api_key_id              uuid NOT NULL,
  soul_id                 text,
  agent_name              text,
  user_agent              text,
  session_id              uuid,
  requested_model         text NOT NULL,
  resolved_model_id       uuid,
  resolved_provider_id    uuid,
  tier_id                 uuid,
  provider_account_id     uuid,
  http_status             integer,
  error_type              text,
  error_message           text,
  retryable               boolean,
  cascaded                boolean NOT NULL DEFAULT false,
  cache_hit               boolean NOT NULL DEFAULT false,
  blocked                 boolean NOT NULL DEFAULT false,
  loop_detected           boolean NOT NULL DEFAULT false,
  truncated               boolean NOT NULL DEFAULT false,
  slow                    boolean NOT NULL DEFAULT false,
  oversized               boolean NOT NULL DEFAULT false,
  streaming               boolean NOT NULL DEFAULT false,
  queue_wait_ms           integer,
  latency_ms              integer,
  ttfb_ms                 integer,
  completed_at            timestamptz,
  attempt_count           integer NOT NULL DEFAULT 0,
  retry_trace             jsonb NOT NULL DEFAULT '[]'::jsonb,
  middleware_trace        jsonb NOT NULL DEFAULT '[]'::jsonb,
  request_headers         jsonb NOT NULL DEFAULT '{}'::jsonb,
  request_payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  response_payload        jsonb,
  response_excerpt        text,
  response_fingerprint    text,
  input_tokens            integer,
  output_tokens           integer,
  total_tokens            integer,
  input_cost_usd          numeric(14,8) NOT NULL DEFAULT 0,
  output_cost_usd         numeric(14,8) NOT NULL DEFAULT 0,
  total_cost_usd          numeric(14,8) NOT NULL DEFAULT 0,
  budget_exempt           boolean NOT NULL DEFAULT false,
  flags                   jsonb NOT NULL DEFAULT '{}'::jsonb,
  metadata                jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (started_at, log_id)
) PARTITION BY RANGE (started_at);

-- Note: audit_logs FK references are intentionally omitted in the partitioned parent
-- because cascading FKs on partitioned tables cause performance issues.
-- Referential integrity is enforced at the application layer.

CREATE INDEX IF NOT EXISTS audit_logs_request_id_idx
  ON audit_logs (request_id);
CREATE INDEX IF NOT EXISTS audit_logs_api_key_started_idx
  ON audit_logs (api_key_id, started_at DESC);
CREATE INDEX IF NOT EXISTS audit_logs_soul_started_idx
  ON audit_logs (soul_id, started_at DESC);
CREATE INDEX IF NOT EXISTS audit_logs_agent_started_idx
  ON audit_logs (agent_name, started_at DESC);
CREATE INDEX IF NOT EXISTS audit_logs_requested_model_started_idx
  ON audit_logs (requested_model, started_at DESC);
CREATE INDEX IF NOT EXISTS audit_logs_status_started_idx
  ON audit_logs (status, started_at DESC);
CREATE INDEX IF NOT EXISTS audit_logs_error_started_idx
  ON audit_logs (error_type, started_at DESC);
CREATE INDEX IF NOT EXISTS audit_logs_session_started_idx
  ON audit_logs (session_id, started_at DESC);
