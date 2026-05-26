# DS016 — Embedded Mode

Soul Gateway runs in two manifest-selected modes: **standalone** and **embedded**. This spec covers the embedded mode contract.

## Mode Selection

The active mode is determined by `SOUL_GATEWAY_MODE`:

- `embedded` — started as a dependency of another Ploinky agent (typically Explorer). Reachable through Ploinky HTTP service routes. Management auth delegates to the Ploinky router; inference auth remains Soul Gateway API-key based.
- Any other value or unset — standalone mode. Port-bound, dashboard-password/API-key based, externally reachable.

The Soul Gateway manifest declares `embedded` and `standalone` profiles under `profiles`. Standalone operation may use the workspace's active profile, while Explorer declares Soul Gateway as an `enable` object with `profile: "embedded"` so only the dependency runs with the embedded overlay.

## Embedded Auth

### Router SSO

When `TRUST_PLOINKY_ROUTER_AUTH=true` and `SOUL_GATEWAY_MODE=embedded`, the dashboard `requireAdmin` middleware accepts Ploinky router identity:

1. Reads `x-ploinky-auth-info` header (JSON with `user`, `roles`, `invocationToken`, and `invocationBody`).
2. Verifies the invocation JWT with `PLOINKY_DERIVED_MASTER_KEY` for audience `agent:proxies/soul-gateway`, tool `__http_service__`, the signed `invocationBody` hash, and a replay-protected `jti`.
3. Requires `admin` in the user's `roles` array.
4. Falls through to session-cookie auth if router auth is unavailable or rejected.

Router-authenticated management writes do not require Soul Gateway's dashboard CSRF token because the verified router invocation token already binds the call to the authenticated Explorer request body. Cookie or bearer dashboard sessions still require CSRF on unsafe methods.

### Synthetic API Key

In embedded mode, if the bearer token matches `SOUL_GATEWAY_API_KEY`, Soul Gateway authorizes a `workspace-default` key with no budget or rate limits. When Postgres is configured, the key is idempotently persisted to `api_keys` so request sessions, budgets, and audit rows have a real FK-compatible key id. When no database is configured, the runtime falls back to an in-memory synthetic record. The comparison uses `timingSafeEqual`.

The `SOUL_GATEWAY_API_KEY` value is a workspace-scoped generated secret produced deterministically by Ploinky's generated-secret model. Soul Gateway and consumer agents declare `sharedGeneratedSecret: true`, so they share by the `SOUL_GATEWAY_API_KEY` env name without custom derivation fields.

## Local LLM Bootstrap

On startup in embedded mode, `bootstrapLocalLlmProvider` idempotently creates a `local-llm` provider:

- `kind: "local_model"`, `adapterKey: "openai-api"`.
- `authStrategy: "api_key"` when `LOCAL_LLM_API_KEY` is present; otherwise `authStrategy: "none"` for true local no-auth endpoints.
- `baseUrl` from `LOCAL_LLM_BASE_URL` (default: `https://lmstudio.axiologic.dev/v1`).
- `LOCAL_LLM_DISCOVERY_MODE=single` registers only `LOCAL_LLM_MODEL` (default: `gemma-3-12b-it`). This is the default because the RAAS LM Studio endpoint may list installed but unloaded models.
- `LOCAL_LLM_DISCOVERY_MODE=auto` probes the endpoint model list and only falls back to `LOCAL_LLM_MODEL` if discovery returns no models.
- `LOCAL_LLM_ALIASES` defaults to `fast,axl/fast,plan,code,write,deep,ultra` and maps Achilles default model names to the embedded local model so Explorer-adjacent agents work without custom model configuration.
- Skips creation if the provider already exists or if no base URL is configured.
- If the provider already exists and `LOCAL_LLM_API_KEY` is later configured, startup stores or refreshes the encrypted API-key account and upgrades the provider auth strategy to `api_key`. This lets a workspace recover from an initial no-auth bootstrap without deleting the provider or database.
- When `LOCAL_LLM_API_KEY` is configured, the token is stored as an encrypted provider account and is not exposed to Explorer, `llmAssistant`, plugin code, logs, or static files. Consumer agents still authenticate to Soul Gateway with the workspace-generated `SOUL_GATEWAY_API_KEY`.

## HTTP Services

The manifest declares three `httpServices` entries:

| External Prefix | Internal Prefix | Auth |
|---|---|---|
| `/services/soul-gateway/v1/` | `/v1/` | none |
| `/services/soul-gateway/management/` | `/management/` | protected |
| `/public-services/soul-gateway-health/` | `/healthz/` | none |

The `/v1/` route intentionally does not require router login because agent callers authenticate to Soul Gateway with `Authorization: Bearer ${SOUL_GATEWAY_API_KEY}` and may run outside a browser session. The route is still not anonymous at the Soul Gateway layer; public API requests without a valid Soul Gateway key fail before model execution. Protected management routes receive `x-ploinky-auth-info` from the router. The health route is public for deployment smoke checks.

## URL Resolution

Consumer agents resolve Soul Gateway's base URL through `resolveSoulGatewayBaseURL()` in achillesAgentLib:

- If `PLOINKY_ENV_SOURCE_SOUL_GATEWAY_API_KEY=generated`, Achilles treats the key as an embedded workspace key and uses `${PLOINKY_ROUTER_URL}/services/soul-gateway/v1`. In this state, inherited `SOUL_GATEWAY_BASE_URL` / `SOUL_GATEWAY_URL` values are ignored so a generated embedded key is never sent to a standalone gateway by accident.
- If `SOUL_GATEWAY_API_KEY` is explicit or unmarked, Achilles treats it as a standalone credential. `SOUL_GATEWAY_BASE_URL` has highest priority, `SOUL_GATEWAY_URL` remains the legacy alias, and key-only setups keep the `LLMConfig.json` Soul Gateway URL.

Explorer-adjacent consumers normally receive the embedded workspace-generated `SOUL_GATEWAY_API_KEY` plus `PLOINKY_ENV_SOURCE_SOUL_GATEWAY_API_KEY=generated`, so Achilles uses the router service URL. If an operator provides `SOUL_GATEWAY_API_KEY` through workspace vars, process env, `.env`, or deployment injection, Ploinky marks the source as `explicit`; Achilles then keeps the `LLMConfig.json` Soul Gateway URL unless `SOUL_GATEWAY_BASE_URL` / `SOUL_GATEWAY_URL` is also explicit. This preserves the developer convention where a local `.env` key is enough to use the standalone gateway.

## Embedded Profile Defaults

- `PORT=7000` with `ports: []` so the embedded profile clears the standalone `8042` binding and lets Ploinky map a random localhost port to container port `7000`.
- `DASHBOARD_PASSWORD=""` (management via router SSO, not password).
- `OAUTH_ADAPTERS_ENABLED=""` (disabled by default).
- `TOKEN_REFRESH_INTERVAL_MS=0`, `PRICING_REFRESH_INTERVAL_MS=0` (schedulers disabled).
- `ENCRYPTION_KEY` and `ADMIN_SESSION_SIGNING_KEY` are agent-scoped generated secrets.

## Settings Plugin

The `IDE-plugins/soul-gateway-settings/` plugin registers in Explorer's Settings modal under Plugins. It is `adminOnly: true` — non-admin users do not see it.

The plugin calls protected management routes through the Ploinky router for provider CRUD, model discovery, and API key management. The `workspace-default` embedded key is shown as a managed, non-revealable, non-revocable key so admins can see that Explorer and `llmAssistant` already have an automatic workspace credential. The plaintext generated key is never returned by management routes or rendered by the plugin.

## Backward Compatibility

- Standalone deployments are unaffected. Existing API keys, dashboard login, Postgres storage, port binding, and deploy workflows continue unchanged.
- Router auth is gated by `SOUL_GATEWAY_MODE=embedded` and `TRUST_PLOINKY_ROUTER_AUTH=true`.
- Adding `httpServices` is inert unless the agent runs behind a Ploinky router.
- Rotating `PLOINKY_MASTER_KEY` changes the generated API key; Explorer and Soul Gateway derive it in sync. The generated-secret migration intentionally does not preserve old embedded encrypted provider/account data; existing embedded workspaces should re-enter provider credentials after upgrade if needed.
