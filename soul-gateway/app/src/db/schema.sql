-- Soul Gateway PostgreSQL Schema
CREATE SCHEMA IF NOT EXISTS soul_gateway;
SET search_path TO soul_gateway;

-- Soul Families
CREATE TABLE IF NOT EXISTS soul_families (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT UNIQUE NOT NULL,
    description TEXT,
    model_mapping JSONB DEFAULT '{}',
    allowed_models JSONB DEFAULT '[]',
    rpm_limit INT DEFAULT 60,
    tpm_limit INT DEFAULT 100000,
    monthly_budget NUMERIC DEFAULT NULL,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- API Keys
CREATE TABLE IF NOT EXISTS api_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    family_id UUID NOT NULL REFERENCES soul_families(id) ON DELETE CASCADE,
    key_hash TEXT UNIQUE NOT NULL,
    encrypted_key BYTEA NOT NULL,
    key_type TEXT DEFAULT 'permanent',
    label TEXT,
    key_hint TEXT,
    monthly_budget NUMERIC DEFAULT NULL,
    expires_at TIMESTAMPTZ,
    is_revoked BOOLEAN DEFAULT false,
    last_used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_api_keys_family_id ON api_keys(family_id);

-- Model Configs
CREATE TABLE IF NOT EXISTS model_configs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT UNIQUE NOT NULL,
    display_name TEXT,
    upstream_model TEXT,
    provider_key TEXT,
    provider_model TEXT,
    mode TEXT DEFAULT 'deep',
    input_price NUMERIC DEFAULT 0,
    output_price NUMERIC DEFAULT 0,
    is_enabled BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Blacklist Rules
CREATE TABLE IF NOT EXISTS blacklist_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    family_id UUID REFERENCES soul_families(id) ON DELETE CASCADE,
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
    family_id UUID,
    family_name TEXT,
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
CREATE INDEX IF NOT EXISTS idx_call_logs_family_started ON call_logs(family_id, started_at);
CREATE INDEX IF NOT EXISTS idx_call_logs_soul_started ON call_logs(soul_id, started_at);
CREATE INDEX IF NOT EXISTS idx_call_logs_model_started ON call_logs(resolved_model, started_at);
CREATE INDEX IF NOT EXISTS idx_call_logs_started ON call_logs(started_at);
CREATE INDEX IF NOT EXISTS idx_call_logs_error ON call_logs(error_type) WHERE error_type IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_call_logs_blocked ON call_logs(blocked_by_blacklist) WHERE blocked_by_blacklist = true;
CREATE INDEX IF NOT EXISTS idx_call_logs_session ON call_logs(api_key_id, session_id, started_at);
CREATE INDEX IF NOT EXISTS idx_call_logs_key_started ON call_logs(api_key_id, started_at);
CREATE INDEX IF NOT EXISTS idx_call_logs_prompt_hash ON call_logs(prompt_hash, resolved_model) WHERE prompt_hash IS NOT NULL AND status_code = 200;

-- Rate Limit State
CREATE TABLE IF NOT EXISTS rate_limit_state (
    key TEXT PRIMARY KEY,
    window_start TIMESTAMPTZ NOT NULL,
    counter INT DEFAULT 0,
    updated_at TIMESTAMPTZ DEFAULT now()
);
