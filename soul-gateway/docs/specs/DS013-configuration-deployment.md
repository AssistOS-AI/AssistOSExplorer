# DS013 — Configuration & Deployment

## Summary

This spec describes how Soul Gateway is configured (environment variables and application defaults), what the runtime does on startup, how `achillesAgentLib` configuration modes work, and how the process handles health checks and graceful shutdown.

## Configuration surfaces

The runtime is configured via environment variables for everything that varies between deployments and application-level defaults for knobs that are stable but tunable.

### Environment variables

Environment variables cover:

| Surface | Examples |
|---|---|
| Server | `PORT`, `HOST` |
| Database | `DATABASE_URL`, `PG_POOL_MAX`, `PG_POOL_MIN`, `PG_IDLE_TIMEOUT_MS`, `PG_CONNECT_TIMEOUT_MS`, `PG_MAX_USES` |
| Security | `ENCRYPTION_KEY`, `API_KEY_HASH_PEPPER`, `ADMIN_SESSION_SIGNING_KEY`, `DASHBOARD_PASSWORD` |
| Directories | `DATA_DIR`, `CREDENTIALS_DIR`, `EXTENSIONS_DIR`, `DASHBOARD_STATIC_DIR` |
| Observability | `LOG_RETENTION_DAYS`, `STREAM_HEARTBEAT_MS`, `WS_PING_INTERVAL_MS`, `PARTITION_AHEAD_DAYS`, `PARTITION_JOB_INTERVAL_MS`, `RETENTION_JOB_CRON_UTC_MINUTE` |
| Cooldown | `COOLDOWN_DURATION_MS` |
| Routing defaults | `DEFAULT_MODEL_ATTEMPTS`, `DEFAULT_MODEL_CONCURRENCY`, `DEFAULT_QUEUE_TIMEOUT_MS`, `DEFAULT_REQUEST_TIMEOUT_MS` |
| HTTP retry | `HTTP_RETRY_MAX_ATTEMPTS`, `HTTP_RETRY_BASE_DELAY_MS`, `HTTP_RETRY_MULTIPLIER`, `HTTP_RETRY_MAX_DELAY_MS`, `HTTP_RETRY_JITTER_PCT` |
| Rate limiting & budgets | `DEFAULT_RPM_LIMIT`, `DEFAULT_TPM_LIMIT`, `DEFAULT_DAILY_BUDGET_USD` |
| Sessions/auth | `SESSION_TIMEOUT_MINUTES`, `TOKEN_REFRESH_INTERVAL_MS`, `QUOTA_RESET_SWEEP_MS`, `ALLOW_UNAUTHENTICATED` |
| Pricing/export/shutdown | `PRICING_DIRECTORY_URL`, `PRICING_REFRESH_INTERVAL_MS`, `EXPORT_BATCH_SIZE`, `SHUTDOWN_GRACE_MS`, `BODY_LIMIT_BYTES` |
| Loop detection | `LOOP_MIN_RESPONSES`, `LOOP_WINDOW_SIZE`, `LOOP_SIMILARITY_THRESHOLD`, `LOOP_GROWTH_THRESHOLD_TOKENS`, `LOOP_REPETITIVE_RATIO_THRESHOLD`, `LOOP_INTERVENTION_MESSAGE` |
| Search bootstrap / legacy inputs | `SEARCH_TAVILY_API_KEY`, `SEARCH_BRAVE_API_KEY`, `SEARCH_EXA_API_KEY`, `SEARCH_SERPER_API_KEY`, `SEARCH_JINA_API_KEY`, `SEARCH_SEARXNG_BASE_URL` |
| Deep research | `DEEP_RESEARCH_PROVIDERS`, `DEEP_RESEARCH_MAX_RESULTS` |

The gateway reads database connectivity from `DATABASE_URL`; the old `PGHOST`/`PGPORT`/`PGUSER`/`PGPASSWORD`/`PGDATABASE` inputs are not consumed by the current pool implementation. `ENCRYPTION_KEY` is optional because the runtime auto-generates and persists `DATA_DIR/encryption.key` on first run if needed.

Pricing directory detail:

- `PRICING_DIRECTORY_URL` overrides the external model directory source used for `external_directory` pricing and management-side metadata enrichment
- when `PRICING_DIRECTORY_URL` is unset, the runtime defaults that service to OpenRouter's public `https://openrouter.ai/api/v1/models`
- `PRICING_REFRESH_INTERVAL_MS` controls the cache refresh interval for that shared directory

### Application defaults

Application-level defaults are configurable for:

- Rate limits (default RPM / TPM per key)
- Retry parameters (attempts, delays, multiplier, jitter)
- Alert thresholds (slow request, oversized request)
- Log retention period (default 90 days)
- Session inactivity timeout (default 30 minutes)
- Per-model concurrency default
- Queue timeout default
- Spend cache refresh interval

These live in the application config module and can be overridden by environment variables where the operator needs deployment-specific values.

## Self-initialization on startup

The runtime performs self-initialization on startup so there's no manual provisioning step required in a fresh environment:

1. **Create required storage structures** — data directory, credential directory, extensions directory.
2. **Connect to Postgres and apply migrations** — the schema is created and migrated to the latest version automatically.
3. **Generate encryption key** if not provided — a random 32-byte key is written to `DATA_DIR/encryption.key` with 0600 permissions.
4. **Discover middlewares** — scans built-in and extension middleware directories and syncs the middleware catalog rows into the database.
5. **Install execution services** — creates the concurrency controller, spend cache, encryption key, and the shared cached pricing/model directory service. That directory is used for `external_directory` pricing lookups plus missing pricing/context/tag enrichment in management flows, and the runtime kicks off an initial best-effort background refresh.
6. **Discover backend modules** — loads built-in backend modules from `runtime/backends/builtin/` and any configured backend extensions from `extensions/backends/`. Backend modules and provider-scope middleware extensions are registered into the unified `BackendCatalog` and the `providerMiddlewareRegistry` respectively.
7. **Register OAuth adapters** — the five OAuth adapters are registered into the OAuth manager.
8. **Reconcile providers** — any enabled provider with at least one active stored credential and zero model rows gets its auto-provision pass re-run to catch up before the initial snapshot is built.
9. **Load the runtime snapshot** — providers, models, model children, middleware bindings, and API keys are loaded into the in-memory runtime state used by the request path. Snapshot load validates enabled providers against the loaded backend catalog and enabled provider-scoped bindings against the loaded provider middleware registry; invalid composition aborts startup/refresh.
10. **Start background jobs** — token refresh loop, cooldown cleanup, partition maintenance, quota reset sweep, spend cache cleanup.
11. **Start the HTTP server** — the public and management routes are registered and the server begins accepting requests.

Each step logs a structured event so the operator can see the initialization sequence in the startup log.

## Historical data import from `main`

Applying the SQL migrations only creates the current target schema. It does not backfill data from the old `main`-branch Soul Gateway app schema under `soul-gateway/app/`.

For that cutover, operators run the dedicated importer:

- `npm run import:main -- --dry-run`
- `npm run import:main`
- `npm run import:main:with-logs`

The importer reads `SOURCE_DATABASE_URL` for the old app database, writes into `TARGET_DATABASE_URL` (or `DATABASE_URL`) using the current schema, decrypts old AES-GCM blobs with `SOURCE_ENCRYPTION_KEY`, `SOURCE_ENCRYPTION_KEY_HEX`, or the multi-key `SOURCE_ENCRYPTION_KEYS` input, re-encrypts into the current split ciphertext/IV/auth-tag format using `TARGET_ENCRYPTION_KEY` / `ENCRYPTION_KEY`, and re-hashes client API keys with `TARGET_API_KEY_HASH_PEPPER` / `API_KEY_HASH_PEPPER`.

Optional importer flags:

- `--include-call-logs` — also migrate historical `call_logs` into `audit_logs` and derive closed `sessions` rows from those logs
- `--call-log-batch-size=<n>` — batch size for historical log import; defaults to `500`
- `--session-timeout-minutes=<n>` — implicit-session gap used while deriving historical sessions; defaults to `SESSION_TIMEOUT_MINUTES` or `30`

## `achillesAgentLib` configuration modes

The src-based runtime package includes `achillesAgentLib` as an installed deployment dependency, so built-in backend modules and any backend / provider-middleware extensions may depend on it without requiring per-deployment manual installation.

Request-time LLM inference must go through `achillesAgentLib`. Soul Gateway may use Achilles in direct-provider mode while serving a request, passing the credential leased from the gateway account store and the provider settings resolved from the runtime snapshot. LLM backend `execute()` paths must not add vendor-specific completion/generation transports; those belong in Achilles. Search providers are normal OpenAI-compatible models; Soul Gateway search backends own their vendor-specific execution (HTTP search APIs, browser automation) behind the standard model interface. External callers use `achillesAgentLib.callSearch()` to call search models through the auto-configured `soul_gateway` provider.

Lifecycle probes and model discovery may use direct vendor HTTP when they are only validating provider connectivity or syncing catalog metadata. They must use leased credentials and must not become an alternate request-time LLM completion path. Prefer Achilles lifecycle helpers when the relevant provider module exposes them.

The shared Achilles LLM layer supports two configuration modes:

### Soul Gateway discovery mode

Driven by `SOUL_GATEWAY_API_KEY` and `SOUL_GATEWAY_URL` / `SOUL_GATEWAY_BASE_URL`. When these env vars are set, `achillesAgentLib` routes all LLM traffic through the configured Soul Gateway instance — the agent running inside a container (or a test harness, or any other consumer) authenticates with its soul-gateway bearer and lets the gateway handle provider selection, rate limiting, budgeting, and observability.

This is the production mode for everything that sits behind Soul Gateway. The consumer doesn't need to know which upstream provider is actually serving the request.

### Direct-provider mode

Driven by canonical provider credentials: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, `HUGGINGFACE_API_KEY`, `COPILOT_TOKEN`, `KIRO_ACCESS_TOKEN`, etc. When `SOUL_GATEWAY_API_KEY` is absent, `achillesAgentLib` falls back to direct-provider mode and speaks to each upstream using its canonical credentials. Used for local development, testing the achilles layer in isolation, and operating the gateway itself (which uses direct-provider mode internally to avoid bootstrapping through itself).

Request-time provider credentials still come from the gateway credential lease. Provider/search credential environment variables are bootstrap or Achilles direct-provider inputs; gateway backend modules must not use them as ad hoc request-time credential lookups.

## Production deployment

The production Soul Gateway service runs at `https://soul.axiologic.dev` and exposes `GET /healthz` for public health verification. The remote host is `admin@45.136.70.141`; use `ssh -i ~/proxies_server_private_key.pem admin@45.136.70.141` for read-only status/debug checks unless the user explicitly asks for a state-changing remote operation.

Operational paths on the remote host:

- Workspace: `~/soulGateway`
- Source checkout: `~/code/proxies`
- Soul Gateway service: `soul-gateway` Ploinky agent
- Expected production database: `soul_gateway_v2`
- Local health check from the host: `curl -s http://localhost:8042/healthz`

Useful read-only checks:

```bash
ssh -i ~/proxies_server_private_key.pem admin@45.136.70.141 'cd ~/soulGateway && ploinky status'
ssh -i ~/proxies_server_private_key.pem admin@45.136.70.141 'curl -s http://localhost:8042/healthz'
ssh -i ~/proxies_server_private_key.pem admin@45.136.70.141 'podman ps --format "table {{.Names}}\t{{.Status}}"'
```

Deployment and admin workflows are defined in the repository-level GitHub Actions files:

- `../.github/workflows/deploy-soul-gateway.yml` — `Deploy Soul Gateway`, with `deploy`, `restart`, `stop`, and `status` actions
- `../.github/workflows/destroy-soul-gateway.yml` — `Destroy Soul Gateway`
- `../.github/workflows/soul-gateway-admin.yml` — `Soul Gateway Admin`

Prefer the workflows for deploy, restart, stop, destroy, and admin tasks. After any deploy or restart, verify both the public `https://soul.axiologic.dev/healthz` endpoint and the host-local `http://localhost:8042/healthz` endpoint, then confirm the running container still uses `PGDATABASE=soul_gateway_v2`.

## Health check

A health check endpoint reports whether the system is operational:

- `GET /healthz` — returns HTTP 200 with `{ ok, db, snapshotGeneration, uptimeSeconds }`

Current implementation detail:

- if `DATABASE_URL` is configured, the handler probes `SELECT 1`
- a failed database probe sets `db: false`
- the handler still returns HTTP 200 even when `db` is false
- the old `/health` compatibility alias is gone

The health check is unauthenticated and has minimal overhead so it can be polled frequently by a load balancer or orchestrator.

## Dashboard authentication

Dashboard sessions use HMAC-signed stateless tokens. The signing key is resolved from `ADMIN_SESSION_SIGNING_KEY` or, if absent, from `ENCRYPTION_KEY`. If neither is set, the gateway throws `ConfigurationError` at the point of use — there is no hardcoded fallback key.

Session tokens embed a CSRF token in the format `{exp}.{csrfToken}.{hmac}`. Every mutating management request must include an `X-CSRF-Token` header matching the embedded value — enforcement is unconditional.

Login attempts are rate-limited to 5 per minute per source IP.

## Graceful shutdown

On `SIGTERM` / `SIGINT` the runtime shuts down gracefully:

1. The HTTP server stops accepting new connections and `appCtx.draining` is set to `true`.
2. Background jobs (token refresh, cleanup tasks, partition maintenance, quota reset sweep) are stopped.
3. SSE and WebSocket subscriber connections are closed via the broadcast hub.
4. In-flight requests are allowed to complete, up to a configurable grace period (`SHUTDOWN_GRACE_MS`, default 30 seconds).
5. Pending audit log writes are flushed.
6. The backend catalog shuts down all loaded backends.
7. The Postgres connection pool drains.
8. The process exits with code 0.

If the grace period expires with requests still in flight, the remaining connections are terminated and the process exits anyway — a slow shutdown should never block container orchestration indefinitely.

## Encryption key management

- On first startup, if `ENCRYPTION_KEY` is not set and `DATA_DIR/encryption.key` does not exist, the runtime generates a random 32-byte key, writes it to `DATA_DIR/encryption.key` with 0600 permissions, and uses it from there on.
- On subsequent startups, the key is loaded from the env var if set, otherwise from the persisted file.
- Rotating the encryption key requires re-encrypting all `provider_accounts.secret_*` and `api_keys.key_*` rows, which is not automated. Operators should plan rotations with a maintenance window.

## Deployment profiles

Soul Gateway declares two Ploinky manifest profiles: `standalone` and `embedded`.

### Standalone profile

The default production mode. Soul Gateway binds to `PORT` on `HOST`, uses `DASHBOARD_PASSWORD` for admin login, manages its own API keys in Postgres, and runs background schedulers (token refresh, pricing refresh). This is the mode used at `soul.axiologic.dev`.

### Embedded profile

Used when Soul Gateway runs as a dependency of another Ploinky agent (typically Explorer). Key differences from standalone:

- `SOUL_GATEWAY_MODE=embedded` — activates router SSO auth and synthetic API key handling.
- `TRUST_PLOINKY_ROUTER_AUTH=true` — the `requireAdmin` middleware accepts Ploinky router identity via `x-ploinky-auth-info` after verifying the invocation JWT.
- `DASHBOARD_PASSWORD=""` — management access is through router SSO, not password.
- `TOKEN_REFRESH_INTERVAL_MS=0`, `PRICING_REFRESH_INTERVAL_MS=0` — background schedulers disabled.
- `ENCRYPTION_KEY` and `ADMIN_SESSION_SIGNING_KEY` are derived from `PLOINKY_MASTER_KEY` via `derive: "derived-master"`.
- `SOUL_GATEWAY_API_KEY` is derived with `deriveName: "workspace-default-api-key"` so consumer agents can derive the same value using `deriveRepoName`/`deriveAgentName`.
- The embedded `/services/soul-gateway/v1/` router service uses router `auth: "none"` because sibling agents authenticate with the derived Soul Gateway API key; management routes remain router-protected.
- `LOCAL_LLM_BASE_URL` defaults to `https://lmstudio.axiologic.dev/v1` and `LOCAL_LLM_MODEL` defaults to `gemma-3-12b-it` for embedded local LLM bootstrap.
- `LOCAL_LLM_DISCOVERY_MODE=single` registers only the configured model by default. Use `auto` only when the endpoint can reliably serve every model it advertises.
- `LOCAL_LLM_ALIASES` defaults to `fast,axl/fast,plan,code,write,deep,ultra` so existing Explorer-adjacent agents that request Achilles default models resolve to the embedded local model out of the box.
- `LOCAL_LLM_API_KEY` is optional and deployment-supplied. When present, it is stored as an encrypted provider account; when absent, the embedded provider uses no-auth local endpoint semantics.
- `OAUTH_ADAPTERS_ENABLED=""` — OAuth adapters disabled by default.

Profile selection is workspace-wide via `ploinky profile <name>`. See DS016 for the full embedded mode contract.

## Related specs

- **DS001** — the HTTP server that this spec starts.
- **DS006** — the database schema that the migration step creates.
- **DS009** — the retry knobs this spec sets defaults for.
- **DS015** — the background jobs (partition maintenance, log retention purge) that this spec starts.
- **DS016** — the embedded mode contract (router SSO, synthetic API key, HTTP services, settings plugin).
