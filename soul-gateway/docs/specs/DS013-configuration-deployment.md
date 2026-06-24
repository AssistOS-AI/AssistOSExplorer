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
| Database | `SQLITE_PATH` |
| Security | `ENCRYPTION_KEY`, `API_KEY_HASH_PEPPER`, `PLOINKY_AGENT_API_PUBLIC_KEY`, `PLOINKY_AGENT_ID`, `PLOINKY_AGENT_SECRET` |
| Directories | `DATA_DIR`, `CREDENTIALS_DIR`, `EXTENSIONS_DIR`, `DASHBOARD_STATIC_DIR` |
| Observability | `LOG_RETENTION_DAYS`, `STREAM_HEARTBEAT_MS`, `WS_PING_INTERVAL_MS`, `PARTITION_AHEAD_DAYS`, `PARTITION_JOB_INTERVAL_MS`, `RETENTION_JOB_CRON_UTC_MINUTE` |
| Cooldown | `COOLDOWN_DURATION_MS` |
| Routing defaults | `DEFAULT_MODEL_ATTEMPTS`, `DEFAULT_MODEL_CONCURRENCY`, `DEFAULT_QUEUE_TIMEOUT_MS`, `DEFAULT_REQUEST_TIMEOUT_MS` |
| HTTP retry | `HTTP_RETRY_MAX_ATTEMPTS`, `HTTP_RETRY_BASE_DELAY_MS`, `HTTP_RETRY_MULTIPLIER`, `HTTP_RETRY_MAX_DELAY_MS`, `HTTP_RETRY_JITTER_PCT` |
| Rate limiting & budgets | `DEFAULT_RPM_LIMIT`, `DEFAULT_TPM_LIMIT`, `DEFAULT_DAILY_BUDGET_USD` |
| Auth/jobs | `SESSION_TIMEOUT_MINUTES`, `TOKEN_REFRESH_INTERVAL_MS`, `QUOTA_RESET_SWEEP_MS`, `ALLOW_UNAUTHENTICATED` (dev gate — bypasses signed-subject verification; never set in production), `OAUTH_ADAPTERS_ENABLED` |
| Ploinky injection | `PLOINKY_AGENT_API_KEY` (signed-subject key for this agent), `PLOINKY_AGENT_API_PUBLIC_KEY` (Ed25519 public key for verifying incoming signed-subject keys) |
| Pricing/export/shutdown | `PRICING_DIRECTORY_URL`, `PRICING_REFRESH_INTERVAL_MS`, `EXPORT_BATCH_SIZE`, `SHUTDOWN_GRACE_MS`, `BODY_LIMIT_BYTES` |
| Loop detection | `LOOP_MIN_RESPONSES`, `LOOP_WINDOW_SIZE`, `LOOP_SIMILARITY_THRESHOLD`, `LOOP_GROWTH_THRESHOLD_TOKENS`, `LOOP_REPETITIVE_RATIO_THRESHOLD`, `LOOP_INTERVENTION_MESSAGE` |
| Search bootstrap / legacy inputs | `SEARCH_TAVILY_API_KEY`, `SEARCH_BRAVE_API_KEY`, `SEARCH_EXA_API_KEY`, `SEARCH_SERPER_API_KEY`, `SEARCH_JINA_API_KEY`, `SEARCH_SEARXNG_BASE_URL` |
| Deep research | `DEEP_RESEARCH_PROVIDERS`, `DEEP_RESEARCH_MAX_RESULTS` |

The gateway opens its embedded SQLite database at `SQLITE_PATH` (default `/data/soul-gateway.sqlite3` inside the Ploinky-managed container). There is no external database connection to configure. `ENCRYPTION_KEY` is optional because the runtime auto-generates and persists `DATA_DIR/encryption.key` on first run if needed.

Ploinky-managed containers run Soul Gateway from the repository checkout mounted at `/code`. The runtime image is not an application artifact and does not provide a fallback source tree. Startup fails closed when `/code/src` is missing so stale image content cannot mask an invalid Ploinky checkout.

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
2. **Open SQLite and initialize schema** — the database file is created under `/data` and schema objects are created if missing.
3. **Generate encryption key** if not provided — a random 32-byte key is written to `DATA_DIR/encryption.key` with 0600 permissions.
4. **Discover middlewares** — scans built-in and extension middleware directories and syncs the middleware catalog rows into the database.
5. **Install execution services** — creates the concurrency controller, spend cache, encryption key, and the shared cached pricing/model directory service. That directory is used for `external_directory` pricing lookups plus missing pricing/context/tag enrichment in management flows, and the runtime kicks off an initial best-effort background refresh.
6. **Discover backend modules** — loads built-in backend modules from `runtime/backends/builtin/` and any configured backend extensions from `extensions/backends/`. Backend modules and provider-scope middleware extensions are registered into the unified `BackendCatalog` and the `providerMiddlewareRegistry` respectively.
7. **Register OAuth adapters** — the five OAuth adapters are registered into the OAuth manager.
8. **Reconcile providers** — any enabled provider with at least one active stored credential and zero model rows gets its auto-provision pass re-run to catch up before the initial snapshot is built.
9. **Load the runtime snapshot** — providers, models, model children, middleware bindings, and API keys are loaded into the in-memory runtime state used by the request path. Snapshot load validates enabled providers against the loaded backend catalog and enabled provider-scoped bindings against the loaded provider middleware registry; invalid composition aborts startup/refresh.
10. **Start background jobs** — token refresh loop, cooldown cleanup, audit-log retention, quota reset sweep, spend cache cleanup.
11. **Start the HTTP server** — the public and management routes are registered and the server begins accepting requests.

Each step logs a structured event so the operator can see the initialization sequence in the startup log.

## Historical data import

The SQLite cutover intentionally starts from an empty database. Old Postgres data and `main`-branch historical data are not imported, and there is no importer in the SQLite deployment.

## Local and development DB reset

This schema change removes the `key_ciphertext`, `key_iv`, and `key_auth_tag` columns from `api_keys` and replaces the table with the signed-subject schema. Local and development installs must delete and recreate the SQLite database file after updating to this schema. No automated migration is provided. Production deployments with no existing key rows can drop and recreate the DB file; deployments with existing data should consult the schema diff and apply it manually if a cold recreation is not acceptable.

## `achillesAgentLib` configuration modes

The src-based runtime package includes `achillesAgentLib` as an installed deployment dependency, so built-in backend modules and any backend / provider-middleware extensions may depend on it without requiring per-deployment manual installation.

Request-time LLM inference must go through `achillesAgentLib`. Soul Gateway may use Achilles in direct-provider mode while serving a request, passing the credential leased from the gateway account store and the provider settings resolved from the runtime snapshot. LLM backend `execute()` paths must not add vendor-specific completion/generation transports; those belong in Achilles. Search providers are normal OpenAI-compatible models; Soul Gateway search backends own their vendor-specific execution (HTTP search APIs, browser automation) behind the standard model interface. External callers use `achillesAgentLib.callSearch()` to call search models through the auto-configured `soul_gateway` provider.

Lifecycle probes and model discovery may use direct vendor HTTP when they are only validating provider connectivity or syncing catalog metadata. They must use leased credentials and must not become an alternate request-time LLM completion path. Prefer Achilles lifecycle helpers when the relevant provider module exposes them.

The shared Achilles LLM layer supports two configuration modes:

### Soul Gateway discovery mode

Driven by `PLOINKY_AGENT_API_KEY` and optionally `SOUL_GATEWAY_URL` / `SOUL_GATEWAY_BASE_URL`. Consumer agents authenticate with their signed-subject bearer and let the gateway handle provider selection, rate limiting, budgeting, and observability. A key-only setup uses the `LLMConfig.json` Soul Gateway URL; URL env vars override that default only for unmarked keys.

This is the production mode for everything that sits behind Soul Gateway. The consumer doesn't need to know which upstream provider is actually serving the request.

For Ploinky workspaces, consumer agents start with a generated `PLOINKY_AGENT_API_KEY`, `PLOINKY_ENV_SOURCE_PLOINKY_AGENT_API_KEY=generated`, and an empty `SOUL_GATEWAY_BASE_URL`, which makes Achilles discover the router service at `${PLOINKY_ROUTER_URL}/services/soul-gateway/v1`. While the key source is `generated`, Achilles ignores inherited public URL env vars so generated keys stay paired with the router service. Explorer-started consumer manifests do not opt into explicit API-key overrides; remote gateways belong in provider configuration inside the local gateway.

Explorer production uses the generated-key path for local calls. To delegate to
an upstream AXL Proxy (e.g. `soul.axiologic.dev`), set `AXL_PROXY_API_KEY` and
`AXL_PROXY_BASE_URL`; the local gateway then registers a delegating `axl-proxy`
provider and mirrors the upstream `/v1/models`. This keeps the Explorer-local
gateway as the reference policy, logging, budget, and settings surface, with
local `fast/plan/deep` tiers retained.

### Direct-provider mode

Driven by canonical provider credentials: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, `HUGGINGFACE_API_KEY`, `COPILOT_TOKEN`, `KIRO_ACCESS_TOKEN`, etc. When `PLOINKY_AGENT_API_KEY` is absent, `achillesAgentLib` falls back to direct-provider mode and speaks to each upstream using its canonical credentials. Used for local development, testing the achilles layer in isolation, and operating the gateway itself (which uses direct-provider mode internally to avoid bootstrapping through itself).

Request-time provider credentials still come from the gateway credential lease. Provider/search credential environment variables are bootstrap or Achilles direct-provider inputs; gateway backend modules must not use them as ad hoc request-time credential lookups.

## Production deployment

The production Soul Gateway service runs at `https://soul.axiologic.dev`. Public health verification goes through the Ploinky router service at `/public-services/soul-gateway-health/`. The remote host is `admin@45.136.70.141`; use `ssh -i ~/proxies_server_private_key.pem admin@45.136.70.141` for read-only status/debug checks unless the user explicitly asks for a state-changing remote operation.

Operational paths on the remote host:

- Workspace: `~/soulGateway`
- Source checkout: `~/code/proxies`
- Soul Gateway service: `soul-gateway` Ploinky agent
- Expected production database file: `/data/soul-gateway.sqlite3` inside the Soul Gateway container
- Host-local router health check: `curl -s http://localhost:8080/public-services/soul-gateway-health/`

Useful read-only checks:

```bash
ssh -i ~/proxies_server_private_key.pem admin@45.136.70.141 'cd ~/soulGateway && ploinky status'
ssh -i ~/proxies_server_private_key.pem admin@45.136.70.141 'curl -s http://localhost:8080/public-services/soul-gateway-health/'
ssh -i ~/proxies_server_private_key.pem admin@45.136.70.141 'podman ps --format "table {{.Names}}\t{{.Status}}"'
```

Deployment and admin workflows are defined in the repository-level GitHub Actions files:

- `../.github/workflows/deploy-soul-gateway.yml` — `Deploy Soul Gateway`, with `deploy`, `restart`, `stop`, and `status` actions
- `../.github/workflows/destroy-soul-gateway.yml` — `Destroy Soul Gateway`
- `../.github/workflows/soul-gateway-admin.yml` — `Soul Gateway Admin`

Prefer the workflows for deploy, restart, stop, destroy, and admin tasks. After any deploy or restart, verify both the public `https://soul.axiologic.dev/public-services/soul-gateway-health/` endpoint and the host-local Ploinky router public health service, confirm the Soul Gateway container is running with no Ploinky Postgres dependency, and confirm its SQLite file exists at `${SQLITE_PATH:-/data/soul-gateway.sqlite3}`.

## Health check

A health check endpoint reports whether the system is operational:

- Public/router contract: `GET /public-services/soul-gateway-health/` returns HTTP 200 with `{ ok, db, snapshotGeneration, uptimeSeconds }`
- Internal implementation detail: `GET /healthz` is the container-local target behind the router public health service and is not a direct public probing contract.

Current implementation detail:

- the handler probes SQLite with `SELECT 1`
- a failed database probe sets `db: false`
- the handler still returns HTTP 200 even when `db` is false
- the old `/health` compatibility alias is gone

The router public health service is unauthenticated and has minimal overhead so it can be polled frequently by a load balancer or orchestrator without exposing the Soul Gateway container port.

## Management authentication

Soul Gateway management is protected by Ploinky's protected HTTP service identity. The gateway accepts only router-provided `x-ploinky-auth-info` plus a verified Ploinky router-request JWT signed with this agent's injected `PLOINKY_AGENT_SECRET`, and it requires the authenticated user to have the `admin` role.

The removed Soul Gateway dashboard login/session endpoints return HTTP 410 with "use Ploinky login" semantics. `DASHBOARD_PASSWORD`, `ADMIN_SESSION_SIGNING_KEY`, `SOUL_GATEWAY_MODE`, and `TRUST_PLOINKY_ROUTER_AUTH` are deprecated compatibility inputs only; they are parsed for one release but do not control active behavior. Existing `soul_session` cookies are ignored.

## Graceful shutdown

On `SIGTERM` / `SIGINT` the runtime shuts down gracefully:

1. The HTTP server stops accepting new connections and `appCtx.draining` is set to `true`.
2. Background jobs (token refresh, cleanup tasks, audit-log retention, quota reset sweep) are stopped.
3. SSE and WebSocket subscriber connections are closed via the broadcast hub.
4. In-flight requests are allowed to complete, up to a configurable grace period (`SHUTDOWN_GRACE_MS`, default 30 seconds).
5. Pending audit log writes are flushed.
6. The backend catalog shuts down all loaded backends.
7. The SQLite database handle closes.
8. The process exits with code 0.

If the grace period expires with requests still in flight, the remaining connections are terminated and the process exits anyway — a slow shutdown should never block container orchestration indefinitely.

## Encryption key management

- On first startup, if `ENCRYPTION_KEY` is not set and `DATA_DIR/encryption.key` does not exist, the runtime generates a random 32-byte key, writes it to `DATA_DIR/encryption.key` with 0600 permissions, and uses it from there on.
- On subsequent startups, the key is loaded from the env var if set, otherwise from the persisted file.
- Rotating the encryption key requires re-encrypting all `provider_accounts.secret_*` rows, which is not automated. Operators should plan rotations with a maintenance window. The `api_keys` table no longer stores encrypted ciphertext — it holds only a key hash — so rotating the encryption key does not require an `api_keys` migration.

## Ploinky agent deployment

Soul Gateway declares one default Ploinky-agent profile:

- Runtime image: `docker.io/assistos/ploinky-node:24-bookworm-tools`.
- `agent`, `cli`, and `install` commands point at `/code`.
- The container image supplies Node and system dependencies only; application source comes from the enabled repository checkout mounted by Ploinky.
- `PORT=7000`.
- `ports: []` so the public interface is the Ploinky router, not the internal container port.
- `PLOINKY_AGENT_API_KEY` is injected by the Ploinky launcher as a signed-subject key; it is not a manifest `sharedGeneratedSecret` field.
- `AXL_PROXY_API_KEY` activates the AXL Proxy delegating mirror (register the
  `axl-proxy` provider + mirror its catalog). Resolved by Ploinky from
  `.secrets`, `process.env`, or the nearest ancestor `.env`.
- `AXL_PROXY_BASE_URL` is the upstream OpenAI-compatible base URL
  (e.g. `https://soul.axiologic.dev/v1`); required for the mirror to activate.
- `AXL_PROXY_DISCOVERY_MODE` controls model discovery (`auto` or `off`).
- `/services/soul-gateway/v1/` uses router `access: "public"` because callers authenticate with a signed-subject API key.
- `/services/soul-gateway/management/` uses router `access: "authenticated"` and requires Ploinky admin identity.
- `/public-services/soul-gateway-health/` is unauthenticated for smoke checks.
- `TOKEN_REFRESH_INTERVAL_MS`, `PRICING_REFRESH_INTERVAL_MS`, and `OAUTH_ADAPTERS_ENABLED` explicitly control schedulers and OAuth behavior.

Dedicated production workspaces should enable the agent with Ploinky local auth, for example:

```bash
ploinky enable agent proxies/soul-gateway --auth pwd --user admin --password "$PLOINKY_ADMIN_PASSWORD" as soul-gateway
```

Public `/v1/*` compatibility is maintained by reverse-proxy rewrite rules that route `soul.axiologic.dev/v1/*` to `/services/soul-gateway/v1/*`.

## Decisions & Questions

1. 2026-06-24: Ploinky's router-signed subject identity credential is the only local agent API key. Agents present `PLOINKY_AGENT_API_KEY`, Soul Gateway requires `PLOINKY_AGENT_API_PUBLIC_KEY` for verification, and the former Soul Gateway-named compatibility alias is removed.

## Related specs

- **DS001** — the HTTP server that this spec starts.
- **DS006** — the database schema that the migration step creates.
- **DS009** — the retry knobs this spec sets defaults for.
- **DS015** — the background jobs (partition maintenance, log retention purge) that this spec starts.
- **DS016** — the Ploinky agent mode contract (router auth, workspace API key, HTTP services, settings dashboard entry).
