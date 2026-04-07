# DS013 — Configuration & Deployment

## Summary

This spec describes how Soul Gateway is configured (environment variables and application defaults), what the runtime does on startup, how `achillesAgentLib` configuration modes work, and how the process handles health checks and graceful shutdown.

## Configuration surfaces

The runtime is configured via environment variables for everything that varies between deployments and application-level defaults for knobs that are stable but tunable.

### Environment variables

Environment variables cover:

| Surface | Examples |
|---|---|
| Server | `PORT`, `HOST`, `BIND_ADDRESS` |
| Database | `DATABASE_URL`, `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`, `PGSSL` |
| Encryption | `ENCRYPTION_KEY` (base64 32 bytes) |
| Dashboard | `DASHBOARD_PASSWORD`, `ADMIN_SESSION_SIGNING_KEY`, `DASHBOARD_STATIC_DIR` |
| Directories | `DATA_DIR`, `CREDENTIAL_STORE_PATH`, `EXTENSIONS_DIR` |
| Provider API keys | `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, `HUGGINGFACE_API_KEY`, etc. |
| Search API keys | `TAVILY_API_KEY`, `BRAVE_API_KEY`, `EXA_API_KEY`, `SERPER_API_KEY`, `GEMINI_API_KEY`, `JINA_API_KEY` |
| Cooldown | `COOLDOWN_DURATION_MS` |
| HTTP retry | `HTTP_RETRY_MAX_ATTEMPTS`, `HTTP_RETRY_BASE_DELAY_MS`, `HTTP_RETRY_MULTIPLIER`, `HTTP_RETRY_MAX_DELAY_MS`, `HTTP_RETRY_JITTER_PCT` |
| Timeouts | `DEFAULT_REQUEST_TIMEOUT_MS`, `DEFAULT_QUEUE_TIMEOUT_MS` |
| Achilles transport | `SOUL_GATEWAY_API_KEY`, `SOUL_GATEWAY_URL`, `SOUL_GATEWAY_BASE_URL` (for discovery mode) |

All are optional except `DATABASE_URL` (or the individual `PG*` variables). `ENCRYPTION_KEY` is auto-generated on first run if not provided and persisted to the data directory.

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
4. **Discover middlewares** — scans the extensions directory for gateway hooks and adapts built-in middlewares into the catalog.
5. **Discover provider plugins** — loads built-in providers, then discovers provider-hook and executor extensions.
6. **Register OAuth adapters** — the five OAuth adapters are registered into the OAuth manager.
7. **Reconcile providers** — any provider with existing stored credentials that lacks model rows gets its auto-provision pass re-run to catch up.
8. **Load the runtime snapshot** — providers, models, tiers, middleware assignments, and API keys are loaded into the in-memory runtime state used by the request path.
9. **Start background jobs** — token refresh loop, cooldown cleanup, partition maintenance, quota reset sweep, spend cache cleanup.
10. **Start the HTTP server** — the public and management routes are registered and the server begins accepting requests.

Each step logs a structured event so the operator can see the initialization sequence in the startup log.

## `achillesAgentLib` configuration modes

The src-based runtime package includes `achillesAgentLib` as an installed deployment dependency, so built-in provider plugins and external provider/wrapper/model extensions may depend on it without requiring per-deployment manual installation.

The shared Achilles LLM layer supports two configuration modes:

### Soul Gateway discovery mode

Driven by `SOUL_GATEWAY_API_KEY` and `SOUL_GATEWAY_URL` / `SOUL_GATEWAY_BASE_URL`. When these env vars are set, `achillesAgentLib` routes all LLM traffic through the configured Soul Gateway instance — the agent running inside a container (or a test harness, or any other consumer) authenticates with its soul-gateway bearer and lets the gateway handle provider selection, rate limiting, budgeting, and observability.

This is the production mode for everything that sits behind Soul Gateway. The consumer doesn't need to know which upstream provider is actually serving the request.

### Direct-provider mode

Driven by canonical provider credentials: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, `HUGGINGFACE_API_KEY`, `COPILOT_TOKEN`, `KIRO_ACCESS_TOKEN`, etc. When `SOUL_GATEWAY_API_KEY` is absent, `achillesAgentLib` falls back to direct-provider mode and speaks to each upstream using its canonical credentials. Used for local development, testing the achilles layer in isolation, and operating the gateway itself (which uses direct-provider mode internally to avoid bootstrapping through itself).

## Health check

A health check endpoint reports whether the system is operational:

- `GET /healthz` — returns 200 with a short status payload when the gateway can serve requests. Returns 503 when critical dependencies (database, encryption key) are unavailable.

The health check is unauthenticated and has minimal overhead so it can be polled frequently by a load balancer or orchestrator.

## Graceful shutdown

On `SIGTERM` / `SIGINT` the runtime shuts down gracefully:

1. The HTTP server stops accepting new connections but keeps existing connections open.
2. Background jobs (token refresh, cleanup tasks, partition maintenance) are paused.
3. In-flight requests are allowed to complete, up to a configurable grace period (default 30 seconds).
4. The credential manager releases any active leases and wipes the in-memory secrets.
5. The Postgres connection pool drains.
6. The process exits with code 0.

If the grace period expires with requests still in flight, the remaining connections are terminated and the process exits anyway — a slow shutdown should never block container orchestration indefinitely.

## Encryption key management

- On first startup, if `ENCRYPTION_KEY` is not set and `DATA_DIR/encryption.key` does not exist, the runtime generates a random 32-byte key, writes it to `DATA_DIR/encryption.key` with 0600 permissions, and uses it from there on.
- On subsequent startups, the key is loaded from the env var if set, otherwise from the persisted file.
- Rotating the encryption key requires re-encrypting all `provider_accounts.secret_*` and `api_keys.key_*` rows, which is not automated. Operators should plan rotations with a maintenance window.

## Related specs

- **DS001** — the HTTP server that this spec starts.
- **DS006** — the database schema that the migration step creates.
- **DS009** — the retry knobs this spec sets defaults for.
- **DS015** — the background jobs (partition maintenance, log retention purge) that this spec starts.
