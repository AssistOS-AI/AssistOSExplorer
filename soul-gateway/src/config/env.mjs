/**
 * Read and validate all environment variables.
 * Returns a plain frozen object — no side effects.
 */
export function readEnv(processEnv = process.env) {
    const env = {
        // Server
        PORT: int(processEnv.PORT, 7000),
        HOST: str(processEnv.HOST, '127.0.0.1'),

        // Database (embedded SQLite)
        SQLITE_PATH: str(processEnv.SQLITE_PATH, './data/soul-gateway.sqlite3'),

        // Security
        ENCRYPTION_KEY: str(processEnv.ENCRYPTION_KEY, null),
        API_KEY_HASH_PEPPER: str(processEnv.API_KEY_HASH_PEPPER, null),
        // Deprecated dashboard-session settings. Parsed for one release so
        // old deployments do not fail env loading, but management auth ignores
        // them and relies on Ploinky protected HTTP services.
        ADMIN_SESSION_SIGNING_KEY: str(processEnv.ADMIN_SESSION_SIGNING_KEY, null),
        DASHBOARD_PASSWORD: str(processEnv.DASHBOARD_PASSWORD, null),

        // Paths
        DATA_DIR: str(processEnv.DATA_DIR, './data'),
        CREDENTIALS_DIR: str(processEnv.CREDENTIALS_DIR, './data/credentials'),
        EXTENSIONS_DIR: str(processEnv.EXTENSIONS_DIR, './extensions'),
        DASHBOARD_STATIC_DIR: str(
            processEnv.DASHBOARD_STATIC_DIR,
            './src/dashboard'
        ),

        // Observability
        LOG_RETENTION_DAYS: int(processEnv.LOG_RETENTION_DAYS, 90),
        STREAM_HEARTBEAT_MS: int(processEnv.STREAM_HEARTBEAT_MS, 15_000),
        WS_PING_INTERVAL_MS: int(processEnv.WS_PING_INTERVAL_MS, 15_000),
        PARTITION_AHEAD_DAYS: int(processEnv.PARTITION_AHEAD_DAYS, 14),
        PARTITION_JOB_INTERVAL_MS: int(
            processEnv.PARTITION_JOB_INTERVAL_MS,
            3_600_000
        ),
        RETENTION_JOB_CRON_UTC_MINUTE: int(
            processEnv.RETENTION_JOB_CRON_UTC_MINUTE,
            10
        ),

        // Routing
        COOLDOWN_DURATION_MS: int(processEnv.COOLDOWN_DURATION_MS, 3_600_000),
        DEFAULT_MODEL_ATTEMPTS: int(processEnv.DEFAULT_MODEL_ATTEMPTS, 5),
        DEFAULT_MODEL_CONCURRENCY: int(processEnv.DEFAULT_MODEL_CONCURRENCY, 3),
        DEFAULT_QUEUE_TIMEOUT_MS: int(
            processEnv.DEFAULT_QUEUE_TIMEOUT_MS,
            60_000
        ),
        DEFAULT_REQUEST_TIMEOUT_MS: int(
            processEnv.DEFAULT_REQUEST_TIMEOUT_MS,
            120_000
        ),

        // Execution / retry
        HTTP_RETRY_MAX_ATTEMPTS: int(processEnv.HTTP_RETRY_MAX_ATTEMPTS, 3),
        HTTP_RETRY_BASE_DELAY_MS: int(
            processEnv.HTTP_RETRY_BASE_DELAY_MS,
            1000
        ),
        HTTP_RETRY_MULTIPLIER: num(processEnv.HTTP_RETRY_MULTIPLIER, 2),
        HTTP_RETRY_MAX_DELAY_MS: int(
            processEnv.HTTP_RETRY_MAX_DELAY_MS,
            30_000
        ),
        HTTP_RETRY_JITTER_PCT: num(processEnv.HTTP_RETRY_JITTER_PCT, 0.2),

        // Rate limiting & budgets
        DEFAULT_RPM_LIMIT: int(processEnv.DEFAULT_RPM_LIMIT, 60),
        DEFAULT_TPM_LIMIT: int(processEnv.DEFAULT_TPM_LIMIT, 100_000),
        DEFAULT_DAILY_BUDGET_USD: num(processEnv.DEFAULT_DAILY_BUDGET_USD, 2.0),

        // Sessions
        SESSION_TIMEOUT_MINUTES: int(processEnv.SESSION_TIMEOUT_MINUTES, 30),

        // Spend cache
        SPEND_CACHE_TTL_MS: int(processEnv.SPEND_CACHE_TTL_MS, 10_000),

        // Auth
        TOKEN_REFRESH_INTERVAL_MS: int(
            processEnv.TOKEN_REFRESH_INTERVAL_MS,
            60_000
        ),
        QUOTA_RESET_SWEEP_MS: int(processEnv.QUOTA_RESET_SWEEP_MS, 300_000),

        // Pricing
        PRICING_DIRECTORY_URL: str(processEnv.PRICING_DIRECTORY_URL, null),
        PRICING_REFRESH_INTERVAL_MS: int(
            processEnv.PRICING_REFRESH_INTERVAL_MS,
            21_600_000
        ),

        // Provider catalog refresh
        PROVIDER_MODEL_REFRESH_INTERVAL_MS: int(
            processEnv.PROVIDER_MODEL_REFRESH_INTERVAL_MS,
            900_000
        ),

        // Safety / loop detection
        LOOP_MIN_RESPONSES: int(processEnv.LOOP_MIN_RESPONSES, 3),
        LOOP_WINDOW_SIZE: int(processEnv.LOOP_WINDOW_SIZE, 7),
        LOOP_SIMILARITY_THRESHOLD: int(processEnv.LOOP_SIMILARITY_THRESHOLD, 5),
        LOOP_GROWTH_THRESHOLD_TOKENS: int(
            processEnv.LOOP_GROWTH_THRESHOLD_TOKENS,
            50_000
        ),
        LOOP_REPETITIVE_RATIO_THRESHOLD: num(
            processEnv.LOOP_REPETITIVE_RATIO_THRESHOLD,
            0.6
        ),
        LOOP_INTERVENTION_MESSAGE: str(
            processEnv.LOOP_INTERVENTION_MESSAGE,
            null
        ),

        // Export
        EXPORT_BATCH_SIZE: int(processEnv.EXPORT_BATCH_SIZE, 500),

        // Shutdown
        SHUTDOWN_GRACE_MS: int(processEnv.SHUTDOWN_GRACE_MS, 30_000),

        // Ingress
        BODY_LIMIT_BYTES: int(processEnv.BODY_LIMIT_BYTES, 5_242_880),

        // Auth
        ALLOW_UNAUTHENTICATED: bool(processEnv.ALLOW_UNAUTHENTICATED, false),

        // Ploinky agent integration
        // Deprecated mode flags are parsed for one release as no-op values so
        // older deployments do not fail startup while manifests/workflows move
        // to the single Ploinky-agent deployment model.
        PLOINKY_DERIVED_MASTER_KEY: hex64(
            processEnv.PLOINKY_DERIVED_MASTER_KEY,
            null,
            'PLOINKY_DERIVED_MASTER_KEY'
        ),
        SOUL_GATEWAY_MODE: str(processEnv.SOUL_GATEWAY_MODE, null),
        TRUST_PLOINKY_ROUTER_AUTH: bool(
            processEnv.TRUST_PLOINKY_ROUTER_AUTH,
            false
        ),
        OAUTH_ADAPTERS_ENABLED: str(processEnv.OAUTH_ADAPTERS_ENABLED, null),
        LLM_DEFAULT_AGENT: str(processEnv.LLM_DEFAULT_AGENT, null),
        LLM_DEFAULT_TIERS: str(
            processEnv.LLM_DEFAULT_TIERS,
            'fast,plan,deep'
        ),

        // Ploinky signed-subject auth (production path). Injected by the
        // Ploinky router/agent runtime. When ALLOW_UNAUTHENTICATED is not
        // true, the public key, router URL, agent id, and agent secret are
        // required at startup (see assertSignedSubjectAuthConfig).
        PLOINKY_AGENT_API_PUBLIC_KEY: str(
            processEnv.PLOINKY_AGENT_API_PUBLIC_KEY,
            null
        ),
        PLOINKY_ROUTER_URL: str(processEnv.PLOINKY_ROUTER_URL, null),
        PLOINKY_AGENT_ID: str(processEnv.PLOINKY_AGENT_ID, null),
        PLOINKY_AGENT_PRINCIPAL: str(processEnv.PLOINKY_AGENT_PRINCIPAL, null),
        PLOINKY_AGENT_SECRET: str(processEnv.PLOINKY_AGENT_SECRET, null),
        PLOINKY_AGENT_API_KEY: str(processEnv.PLOINKY_AGENT_API_KEY, null),
        PLOINKY_ENV_SOURCE_PLOINKY_AGENT_API_KEY: str(
            processEnv.PLOINKY_ENV_SOURCE_PLOINKY_AGENT_API_KEY,
            null
        ),
        PLOINKY_ENV_SOURCE_PLOINKY_AGENT_API_PUBLIC_KEY: str(
            processEnv.PLOINKY_ENV_SOURCE_PLOINKY_AGENT_API_PUBLIC_KEY,
            null
        ),

    };

    return Object.freeze(env);
}

/**
 * Environment variables required for Ploinky signed-subject authentication,
 * which is the production path for Soul Gateway.
 */
const SIGNED_SUBJECT_AUTH_REQUIRED = Object.freeze([
    'PLOINKY_AGENT_API_PUBLIC_KEY',
    'PLOINKY_ROUTER_URL',
    'PLOINKY_AGENT_ID',
    'PLOINKY_AGENT_SECRET',
]);

/**
 * Enforce the signed-subject auth contract at startup.
 *
 * Signed-subject auth is the production path. Unless `ALLOW_UNAUTHENTICATED`
 * is enabled, all of {@link SIGNED_SUBJECT_AUTH_REQUIRED} must be present;
 * otherwise startup fails with an error naming every missing variable.
 *
 * `ALLOW_UNAUTHENTICATED` is the only non-Ploinky development path. In that
 * mode signed-subject auth is disabled, a loud warning is logged, and the
 * Ploinky env is not required. This mode must never be used in production and
 * must not silently accept legacy workspace API keys.
 *
 * This function is intentionally separate from {@link readEnv} so that
 * `readEnv` stays side-effect-free and never throws for missing Ploinky env.
 *
 * @param {object} config Parsed config carrying the PLOINKY_* fields and the
 *   parsed boolean `ALLOW_UNAUTHENTICATED` (the object returned by `readEnv`).
 * @param {{ log?: { warn?: Function, error?: Function } }} [options]
 * @returns {void}
 * @throws {Error} when signed-subject auth is required but misconfigured.
 */
export function assertSignedSubjectAuthConfig(config, { log = console } = {}) {
    if (config.ALLOW_UNAUTHENTICATED === true) {
        const warn =
            typeof log?.warn === 'function'
                ? log.warn.bind(log)
                : console.warn.bind(console);
        warn(
            'ALLOW_UNAUTHENTICATED=true — Ploinky signed-subject authentication ' +
                'is DISABLED. This is a development-only mode and must not be ' +
                'used in production.'
        );
        return;
    }

    const missing = SIGNED_SUBJECT_AUTH_REQUIRED.filter(
        (name) => config[name] === null || config[name] === undefined
    );

    if (missing.length > 0) {
        throw new Error(
            'Ploinky signed-subject authentication requires the following ' +
                `environment variable(s): ${missing.join(', ')}. Start Soul ` +
                'Gateway as a Ploinky-managed agent so these are injected, or ' +
                'set ALLOW_UNAUTHENTICATED=true for development (not for ' +
                'production).'
        );
    }
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

function hex64(raw, fallback, name) {
    if (raw === undefined || raw === '') return fallback;
    const value = String(raw).trim();
    if (!/^[0-9a-fA-F]{64}$/.test(value)) {
        throw new Error(`${name} must be a 64-character hex string`);
    }
    return value;
}
