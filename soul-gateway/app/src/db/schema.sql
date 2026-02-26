-- Soul Gateway PostgreSQL Schema
CREATE SCHEMA IF NOT EXISTS soul_gateway;
SET search_path TO soul_gateway;

-- API Keys
CREATE TABLE IF NOT EXISTS api_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    key_hash TEXT UNIQUE NOT NULL,
    encrypted_key BYTEA NOT NULL,
    label TEXT,
    key_hint TEXT,
    monthly_budget NUMERIC DEFAULT NULL,
    rpm_limit INT DEFAULT 60,
    tpm_limit INT DEFAULT 100000,
    expires_at TIMESTAMPTZ,
    is_revoked BOOLEAN DEFAULT false,
    last_used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Model Configs
CREATE TABLE IF NOT EXISTS model_configs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT UNIQUE NOT NULL,
    display_name TEXT,
    upstream_model TEXT,
    provider_key TEXT,
    provider_model TEXT,
    upstream_source TEXT,
    mode TEXT DEFAULT 'deep',
    input_price NUMERIC DEFAULT 0,
    output_price NUMERIC DEFAULT 0,
    max_concurrency INT DEFAULT 3,
    sort_order INT DEFAULT 100,
    context_window TEXT,
    is_enabled BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Blacklist Rules
CREATE TABLE IF NOT EXISTS blacklist_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pattern TEXT NOT NULL,
    match_type TEXT NOT NULL CHECK (match_type IN ('exact', 'substring', 'regex')),
    action TEXT DEFAULT 'block',
    description TEXT,
    is_enabled BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Call Logs (partitioned by month)
CREATE TABLE IF NOT EXISTS call_logs (
    id UUID DEFAULT gen_random_uuid(),
    soul_id TEXT,
    api_key_id UUID,
    agent_name TEXT,
    session_id UUID,
    -- request
    requested_model TEXT,
    resolved_model TEXT,
    mode TEXT,
    is_streaming BOOLEAN,
    request_messages JSONB,
    request_size_bytes INT,
    -- response
    response_content TEXT,
    status_code INT,
    stop_reason TEXT,
    error_type TEXT,
    error_message TEXT,
    response_size_bytes INT,
    -- metrics
    latency_ms INT,
    ttfb_ms INT,
    prompt_tokens INT,
    completion_tokens INT,
    total_tokens INT,
    input_cost NUMERIC,
    output_cost NUMERIC,
    total_cost NUMERIC,
    -- retry
    retry_count INT DEFAULT 0,
    retry_reason TEXT,
    retries_detail JSONB,
    -- flags
    blocked_by_blacklist BOOLEAN DEFAULT false,
    blacklist_rule_id UUID,
    blacklist_match TEXT,
    is_truncated BOOLEAN DEFAULT false,
    is_slow BOOLEAN DEFAULT false,
    prompt_size_warning BOOLEAN DEFAULT false,
    -- cache
    prompt_hash TEXT,
    cache_hit BOOLEAN DEFAULT false,
    -- timestamps
    started_at TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ,
    PRIMARY KEY (id, started_at)
) PARTITION BY RANGE (started_at);

-- Create indexes on the partitioned table
CREATE INDEX IF NOT EXISTS idx_call_logs_soul_started ON call_logs(soul_id, started_at);
CREATE INDEX IF NOT EXISTS idx_call_logs_model_started ON call_logs(resolved_model, started_at);
CREATE INDEX IF NOT EXISTS idx_call_logs_started ON call_logs(started_at);
CREATE INDEX IF NOT EXISTS idx_call_logs_error ON call_logs(error_type) WHERE error_type IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_call_logs_blocked ON call_logs(blocked_by_blacklist) WHERE blocked_by_blacklist = true;
CREATE INDEX IF NOT EXISTS idx_call_logs_session ON call_logs(api_key_id, session_id, started_at);
CREATE INDEX IF NOT EXISTS idx_call_logs_key_started ON call_logs(api_key_id, started_at);
-- idx_call_logs_prompt_hash is created in migrate() after the column is added

-- Rate Limit State
CREATE TABLE IF NOT EXISTS rate_limit_state (
    key TEXT PRIMARY KEY,
    window_start TIMESTAMPTZ NOT NULL,
    counter INT DEFAULT 0,
    updated_at TIMESTAMPTZ DEFAULT now()
);
