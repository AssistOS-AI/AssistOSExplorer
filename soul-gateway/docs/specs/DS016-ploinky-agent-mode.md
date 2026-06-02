# DS016 - Ploinky Agent Mode

Soul Gateway has one deployment model: it is a Ploinky-managed agent with HTTP services. Browser-facing management access is protected by Ploinky's default login and protected-service identity. Public inference traffic still uses Soul Gateway API-key auth on `/v1/*`.

The old profile split is removed from active behavior. `SOUL_GATEWAY_MODE` and `TRUST_PLOINKY_ROUTER_AUTH` may be parsed for one release as deprecated no-op inputs, but they do not select behavior.

## HTTP Services

The manifest declares these service routes:

| External Prefix | Internal Prefix | Auth |
|---|---|---|
| `/services/soul-gateway/v1/` | `/v1/` | none |
| `/services/soul-gateway/management/` | `/management/` | protected |
| `/public-services/soul-gateway-health/` | `/healthz/` | none |

The `/v1/` service is not protected by router login because sibling agents and external clients authenticate with `Authorization: Bearer <Soul Gateway API key>`. Requests without a valid Soul Gateway key fail before model execution. The management service is router-protected and receives authoritative identity from Ploinky. The health service is public for deployment smoke checks.

Production compatibility for `https://soul.axiologic.dev/v1/*` is provided by the reverse proxy rewriting to `/services/soul-gateway/v1/*`; direct publication of Soul Gateway's internal container port is not part of the contract.

## Management Auth

Management auth accepts only verified Ploinky protected-service identity:

1. Read `x-ploinky-auth-info`, which contains the authenticated Ploinky user, `invocationToken`, and `invocationBody`.
2. Verify the invocation JWT with `PLOINKY_DERIVED_MASTER_KEY` for audience `agent:proxies/soul-gateway`, tool `__http_service__`, the signed body hash, and replay-protected `jti`.
3. Require `admin` in the Ploinky user's roles.
4. Reject requests that rely only on Soul Gateway cookies, bearer dashboard tokens, or caller-supplied identity headers.

The removed `/management/auth/*` endpoints return HTTP 410 with instructions to use Ploinky login. They never create or validate Soul Gateway sessions. Management writes do not require Soul Gateway CSRF tokens; the router invocation JWT is the request binding.

## Workspace API Key

When `SOUL_GATEWAY_API_KEY` is configured, that value is accepted as the managed `workspace-default` key in any host context.

Ploinky normally supplies the key as a workspace-scoped generated secret (`sharedGeneratedSecret: true`) so Soul Gateway and consumer agents receive the same value by env name. When the SQLite database is open, the generated workspace key is idempotently persisted to `api_keys` so request sessions, budgets, and audit rows have a durable, FK-compatible key id. Without a database, the runtime uses an in-memory synthetic record.

Existing database keys remain valid. Existing rows marked with the legacy workspace-default metadata flag are still recognized for migration compatibility, but new behavior is keyed by `workspaceDefault`.

## Local LLM Bootstrap

`bootstrapLocalLlmProvider` runs when the SQLite database is open and an explicit `LOCAL_LLM_BASE_URL` is present. It no longer depends on deployment mode, and the default manifest profile does not enable it implicitly.

- `LOCAL_LLM_BASE_URL` sets the OpenAI-compatible endpoint.
- `LOCAL_LLM_MODEL` selects the single-model fallback when set.
- `LOCAL_LLM_DISCOVERY_MODE=single` registers only `LOCAL_LLM_MODEL`; `auto` probes the endpoint model list before fallback.
- `LOCAL_LLM_ALIASES` maps compatibility aliases such as `fast`, `plan`, and `code`.
- `LOCAL_LLM_API_KEY`, when present, is stored as an encrypted provider account and upgrades the provider auth strategy to `api_key`.

## Soul Gateway Provider Bootstrap

Explorer deployments treat their local Ploinky-managed Soul Gateway as the reference gateway. If the deployment has a credential for `soul.axiologic.dev`, that remote gateway is registered as a normal provider inside the local gateway rather than replacing the local generated `SOUL_GATEWAY_API_KEY`.

`bootstrapSoulGatewayProvider` runs before the local LLM bootstrap when the SQLite database is open and `SOUL_GATEWAY_PROVIDER_API_KEY` is present. In the Ploinky agent manifest, `SOUL_GATEWAY_PROVIDER_API_KEY` is sourced from an operator-provided `SOUL_GATEWAY_API_KEY`, while the container's local `SOUL_GATEWAY_API_KEY` remains the workspace-generated key accepted by `/v1/*`.

- It creates or reconciles provider key `soul-gateway` with display name `Soul Gateway`, backend `openai-api`, kind `external_api`, auth strategy `api_key`, and base URL `SOUL_GATEWAY_PROVIDER_BASE_URL` (default `https://soul.axiologic.dev/v1`).
- It stores `SOUL_GATEWAY_PROVIDER_API_KEY` as an encrypted provider API-key account.
- `SOUL_GATEWAY_PROVIDER_DISCOVERY_MODE=auto` syncs the provider's `/models` response at startup; `off` creates only the provider/account.
- `SOUL_GATEWAY_PROVIDER_ALIASES` mirrors same-named discovered provider models such as `soul-gateway/fast` into local aliases such as `fast`. During migration it may reassign configured aliases that still point at `local-llm/*` fallback models, but it does not take over aliases owned by other providers.

The local `SOUL_GATEWAY_API_KEY` remains the generated key accepted by the Explorer-local gateway's `/v1/*` service. Remote credentials are provider-account secrets inside that local gateway, not replacement caller credentials.

## Scheduler And OAuth Behavior

Schedulers and OAuth adapters are controlled by explicit env config, not deployment mode:

- `TOKEN_REFRESH_INTERVAL_MS`
- `PRICING_REFRESH_INTERVAL_MS`
- `OAUTH_ADAPTERS_ENABLED`

Deployments that want those jobs disabled set the intervals to `0` and leave OAuth adapters empty.

## Settings Entry

`IDE-plugins/soul-gateway-settings/` is an AchillesIDE application plugin entry with policy key `soul-gateway/soul-gateway`. It remains `adminOnly: true`, so non-admin Explorer users do not see it.

The entry declares `settingsUrl: "/services/soul-gateway/management/"`. Explorer's Settings button opens that local router-protected dashboard directly instead of loading a Soul Gateway settings modal. It relies on Ploinky auth cookies and protected-service forwarding. It does not implement Soul Gateway-specific auth.

The dashboard at `/services/soul-gateway/management/` is the canonical operator UI for providers, models, API keys, and observability. The settings entry must not point Explorer users at a direct container port or a remote Soul Gateway deployment.

The dashboard has no Soul Gateway login form, no dashboard session token flow, and no CSRF/dashboard-cookie contract.

## Migration Notes

- Existing provider data and database API keys remain valid.
- Existing `soul_session` cookies are ignored.
- Users authenticate through `/auth/login`.
- Public `/v1/*` compatibility is preserved by reverse-proxy rewrites to the Ploinky router service.
- Direct public container-port access is not a deployment contract.
