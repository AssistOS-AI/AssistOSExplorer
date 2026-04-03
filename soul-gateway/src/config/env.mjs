/**
 * Read and validate all environment variables.
 * Returns a plain frozen object — no side effects.
 */
export function readEnv(processEnv = process.env) {
  const env = {
    // Server
    PORT:                        int(processEnv.PORT, 8042),
    HOST:                        str(processEnv.HOST, '127.0.0.1'),

    // Database
    DATABASE_URL:                str(processEnv.DATABASE_URL, null),
    PG_POOL_MAX:                 int(processEnv.PG_POOL_MAX, 20),
    PG_POOL_MIN:                 int(processEnv.PG_POOL_MIN, 2),
    PG_IDLE_TIMEOUT_MS:          int(processEnv.PG_IDLE_TIMEOUT_MS, 30_000),
    PG_CONNECT_TIMEOUT_MS:       int(processEnv.PG_CONNECT_TIMEOUT_MS, 2000),
    PG_MAX_USES:                 int(processEnv.PG_MAX_USES, 10_000),

    // Security
    ENCRYPTION_KEY:              str(processEnv.ENCRYPTION_KEY, null),
    API_KEY_HASH_PEPPER:         str(processEnv.API_KEY_HASH_PEPPER, null),
    ADMIN_SESSION_SIGNING_KEY:   str(processEnv.ADMIN_SESSION_SIGNING_KEY, null),
    DASHBOARD_PASSWORD:          str(processEnv.DASHBOARD_PASSWORD, null),

    // Paths
    DATA_DIR:                    str(processEnv.DATA_DIR, './data'),
    CREDENTIALS_DIR:             str(processEnv.CREDENTIALS_DIR, './data/credentials'),
    EXTENSIONS_DIR:              str(processEnv.EXTENSIONS_DIR, './extensions'),
    DASHBOARD_STATIC_DIR:        str(processEnv.DASHBOARD_STATIC_DIR, './src/dashboard'),

    // Observability
    LOG_RETENTION_DAYS:          int(processEnv.LOG_RETENTION_DAYS, 90),
    STREAM_HEARTBEAT_MS:         int(processEnv.STREAM_HEARTBEAT_MS, 15_000),
    WS_PING_INTERVAL_MS:         int(processEnv.WS_PING_INTERVAL_MS, 15_000),
    PARTITION_AHEAD_DAYS:        int(processEnv.PARTITION_AHEAD_DAYS, 14),
    PARTITION_JOB_INTERVAL_MS:   int(processEnv.PARTITION_JOB_INTERVAL_MS, 3_600_000),
    RETENTION_JOB_CRON_UTC_MINUTE: int(processEnv.RETENTION_JOB_CRON_UTC_MINUTE, 10),

    // Routing
    COOLDOWN_DURATION_MS:        int(processEnv.COOLDOWN_DURATION_MS, 3_600_000),
    DEFAULT_MODEL_ATTEMPTS:      int(processEnv.DEFAULT_MODEL_ATTEMPTS, 5),
    DEFAULT_MODEL_CONCURRENCY:   int(processEnv.DEFAULT_MODEL_CONCURRENCY, 3),
    DEFAULT_QUEUE_TIMEOUT_MS:    int(processEnv.DEFAULT_QUEUE_TIMEOUT_MS, 60_000),
    DEFAULT_REQUEST_TIMEOUT_MS:  int(processEnv.DEFAULT_REQUEST_TIMEOUT_MS, 120_000),

    // Execution / retry
    HTTP_RETRY_MAX_ATTEMPTS:     int(processEnv.HTTP_RETRY_MAX_ATTEMPTS, 3),
    HTTP_RETRY_BASE_DELAY_MS:    int(processEnv.HTTP_RETRY_BASE_DELAY_MS, 1000),
    HTTP_RETRY_MULTIPLIER:       num(processEnv.HTTP_RETRY_MULTIPLIER, 2),
    HTTP_RETRY_MAX_DELAY_MS:     int(processEnv.HTTP_RETRY_MAX_DELAY_MS, 30_000),
    HTTP_RETRY_JITTER_PCT:       num(processEnv.HTTP_RETRY_JITTER_PCT, 0.20),

    // Rate limiting & budgets
    DEFAULT_RPM_LIMIT:           int(processEnv.DEFAULT_RPM_LIMIT, 60),
    DEFAULT_TPM_LIMIT:           int(processEnv.DEFAULT_TPM_LIMIT, 100_000),
    DEFAULT_DAILY_BUDGET_USD:    num(processEnv.DEFAULT_DAILY_BUDGET_USD, 2.0),

    // Sessions
    SESSION_TIMEOUT_MINUTES:     int(processEnv.SESSION_TIMEOUT_MINUTES, 30),

    // Spend cache
    SPEND_CACHE_TTL_MS:          int(processEnv.SPEND_CACHE_TTL_MS, 10_000),

    // Auth
    TOKEN_REFRESH_INTERVAL_MS:   int(processEnv.TOKEN_REFRESH_INTERVAL_MS, 60_000),
    QUOTA_RESET_SWEEP_MS:        int(processEnv.QUOTA_RESET_SWEEP_MS, 300_000),

    // Pricing
    PRICING_DIRECTORY_URL:       str(processEnv.PRICING_DIRECTORY_URL, null),
    PRICING_REFRESH_INTERVAL_MS: int(processEnv.PRICING_REFRESH_INTERVAL_MS, 21_600_000),

    // Safety / loop detection
    LOOP_MIN_RESPONSES:              int(processEnv.LOOP_MIN_RESPONSES, 3),
    LOOP_WINDOW_SIZE:                int(processEnv.LOOP_WINDOW_SIZE, 7),
    LOOP_SIMILARITY_THRESHOLD:       int(processEnv.LOOP_SIMILARITY_THRESHOLD, 5),
    LOOP_GROWTH_THRESHOLD_TOKENS:    int(processEnv.LOOP_GROWTH_THRESHOLD_TOKENS, 50_000),
    LOOP_REPETITIVE_RATIO_THRESHOLD: num(processEnv.LOOP_REPETITIVE_RATIO_THRESHOLD, 0.60),
    LOOP_INTERVENTION_MESSAGE:       str(processEnv.LOOP_INTERVENTION_MESSAGE, null),

    // Export
    EXPORT_BATCH_SIZE:           int(processEnv.EXPORT_BATCH_SIZE, 500),

    // Shutdown
    SHUTDOWN_GRACE_MS:           int(processEnv.SHUTDOWN_GRACE_MS, 30_000),

    // Ingress
    BODY_LIMIT_BYTES:            int(processEnv.BODY_LIMIT_BYTES, 5_242_880),

    // Auth
    ALLOW_UNAUTHENTICATED:       bool(processEnv.ALLOW_UNAUTHENTICATED, false),

    // Built-in search provider keys
    SEARCH_TAVILY_API_KEY:       str(processEnv.SEARCH_TAVILY_API_KEY, null),
    SEARCH_BRAVE_API_KEY:        str(processEnv.SEARCH_BRAVE_API_KEY, null),
    SEARCH_EXA_API_KEY:          str(processEnv.SEARCH_EXA_API_KEY, null),
    SEARCH_SERPER_API_KEY:       str(processEnv.SEARCH_SERPER_API_KEY, null),
    SEARCH_JINA_API_KEY:         str(processEnv.SEARCH_JINA_API_KEY, null),
    SEARCH_SEARXNG_BASE_URL:     str(processEnv.SEARCH_SEARXNG_BASE_URL, null),

    // Deep research
    DEEP_RESEARCH_PROVIDERS:     str(processEnv.DEEP_RESEARCH_PROVIDERS, null),
    DEEP_RESEARCH_MAX_RESULTS:   int(processEnv.DEEP_RESEARCH_MAX_RESULTS, 20),
  };

  return Object.freeze(env);
}

// ── helpers ──────────────────────────────────────────────────────────

function str(raw, fallback) {
  if (raw === undefined || raw === '') return fallback;
  return String(raw);
}

function int(raw, fallback) {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.trunc(n);
}

function num(raw, fallback) {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return n;
}

function bool(raw, fallback) {
  if (raw === undefined || raw === '') return fallback;
  return raw === 'true' || raw === '1' || raw === 'yes';
}
