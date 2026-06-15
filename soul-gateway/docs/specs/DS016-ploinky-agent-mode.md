# DS016 - Ploinky Agent Mode

Soul Gateway has one deployment model: it is a Ploinky-managed agent with HTTP services. Browser-facing management access is protected by Ploinky's default login and protected-service identity. Public inference traffic still uses Soul Gateway API-key auth on `/v1/*`.

The old profile split is removed from active behavior. `SOUL_GATEWAY_MODE` and `TRUST_PLOINKY_ROUTER_AUTH` may be parsed for one release as deprecated no-op inputs, but they do not select behavior.

## HTTP Services

The manifest declares these service routes:

| External Prefix | Internal Prefix | Access |
|---|---|---|
| `/services/soul-gateway/v1/` | `/v1/` | public |
| `/services/soul-gateway/management/` | `/management/` | authenticated |
| `/public-services/soul-gateway-health/` | `/healthz/` | public |

The `/v1/` service is not protected by router login because sibling agents and external clients authenticate with `Authorization: Bearer <Soul Gateway API key>`. Requests without a valid Soul Gateway key fail before model execution. The management service is router-protected and receives authoritative identity from Ploinky. The health service is public for deployment smoke checks.

Production compatibility for `https://soul.axiologic.dev/v1/*` is provided by the reverse proxy rewriting to `/services/soul-gateway/v1/*`; direct publication of Soul Gateway's internal container port is not part of the contract.

## Management Auth

Management auth accepts only verified Ploinky protected-service identity:

1. Read `x-ploinky-auth-info`, which contains the authenticated Ploinky user, `invocationToken`, and `invocationBody`.
2. Verify the invocation JWT with `PLOINKY_DERIVED_MASTER_KEY` for audience `agent:proxies/soul-gateway`, tool `__http_service__`, the signed body hash, and replay-protected `jti`.
3. Require `admin` in the Ploinky user's roles.
4. Reject requests that rely only on Soul Gateway cookies, bearer dashboard tokens, or caller-supplied identity headers.

The removed `/management/auth/*` endpoints return HTTP 410 with instructions to use Ploinky login. They never create or validate Soul Gateway sessions. Management writes do not require Soul Gateway CSRF tokens; the router invocation JWT is the request binding.

## Signed-Subject API Key Authentication

Soul Gateway verifies incoming bearer tokens as signed-subject keys. The format is `<subjectId>|<base64url-ed25519-signature>`, where the signature is over the exact UTF-8 bytes of `subjectId`. Subject ids are `agent:<repo>/<agentName>` or `user:<userId>`. Soul Gateway verifies signatures with `PLOINKY_SOUL_GATEWAY_API_PUBLIC_KEY`; Ploinky signs with its Ed25519 private key, which never enters Soul Gateway or agent processes.

There is no shared workspace default key. The legacy `SOUL_GATEWAY_API_KEY` shared-generated workspace secret is removed. The manifest does not declare a `sharedGeneratedSecret` for Soul Gateway API keys. Instead, each Ploinky agent receives these injected env vars at startup:

| Variable | Value |
|---|---|
| `PLOINKY_AGENT_API_KEY` | The agent's signed-subject key: `<subjectId>|<base64url-sig>` |
| `SOUL_GATEWAY_API_KEY` | Compatibility alias — same signed value as `PLOINKY_AGENT_API_KEY` |
| `PLOINKY_SOUL_GATEWAY_API_PUBLIC_KEY` | Ed25519 public key Soul Gateway uses to verify signed keys |

These names are reserved; any manifest-declared values with the same names are stripped before injection. Provenance markers `PLOINKY_ENV_SOURCE_PLOINKY_AGENT_API_KEY=generated` and `PLOINKY_ENV_SOURCE_SOUL_GATEWAY_API_KEY=generated` are injected alongside them.

**Legacy identity headers:** Soul Gateway rejects `x-soul-id`, `x-agent-name`, and `x-soul-agent` headers with HTTP 400. Identity is established exclusively from the signed-subject key.

**Loop guard:** A request whose signed-subject key resolves to the same subject as the model being invoked (a self-recursive discovery call) is rejected with HTTP 400.

## Local LLM Bootstrap

`bootstrapLocalLlmProvider` runs when the SQLite database is open and an explicit `LOCAL_LLM_BASE_URL` is present. It no longer depends on deployment mode, and the default manifest profile does not enable it implicitly.

- `LOCAL_LLM_BASE_URL` sets the OpenAI-compatible endpoint.
- `LOCAL_LLM_MODEL` selects the single-model fallback when set.
- `LOCAL_LLM_DISCOVERY_MODE=single` registers only `LOCAL_LLM_MODEL`; `auto` probes the endpoint model list before fallback.
- `LOCAL_LLM_ALIASES` maps compatibility aliases such as `fast`, `plan`, and `code`.
- `LOCAL_LLM_API_KEY`, when present, is stored as an encrypted provider account and upgrades the provider auth strategy to `api_key`.

## Soul Gateway Provider Bootstrap

Explorer deployments treat their local Ploinky-managed Soul Gateway as the reference gateway. If the deployment has a credential for `soul.axiologic.dev`, that remote gateway is registered as a normal provider inside the local gateway rather than replacing the agent's signed-subject `PLOINKY_AGENT_API_KEY`.

`bootstrapSoulGatewayProvider` runs before the local LLM bootstrap when the SQLite database is open and `SOUL_GATEWAY_PROVIDER_API_KEY` is present. In the Ploinky agent manifest, `SOUL_GATEWAY_PROVIDER_API_KEY` is sourced from an operator-provided credential for the remote `soul.axiologic.dev` gateway.

- It creates or reconciles provider key `soul-gateway` with display name `Soul Gateway`, backend `openai-api`, kind `external_api`, auth strategy `api_key`, and base URL `SOUL_GATEWAY_PROVIDER_BASE_URL` (default `https://soul.axiologic.dev/v1`).
- It stores `SOUL_GATEWAY_PROVIDER_API_KEY` as an encrypted provider API-key account.
- `SOUL_GATEWAY_PROVIDER_DISCOVERY_MODE=auto` syncs the provider's `/models` response at startup; `off` creates only the provider/account.
- `SOUL_GATEWAY_PROVIDER_ALIASES` mirrors same-named discovered provider models such as `soul-gateway/fast` into local aliases such as `fast`. During migration it may reassign configured aliases that still point at `local-llm/*` fallback models, but it does not take over aliases owned by other providers.

The Soul Gateway agent's own `PLOINKY_AGENT_API_KEY` (and its `SOUL_GATEWAY_API_KEY` alias) are its signed-subject keys for calling other gateway instances. Remote credentials for `soul.axiologic.dev` are provider-account secrets inside the local gateway.

## Ploinky Agent Discovery

Soul Gateway discovers enabled Ploinky agents by calling the router discovery endpoint. The call is agent-only and requires an HTTP Agent Assertion (`Authorization: Bearer <jwt>`) bound via `computeRchHttp()` (NOT `computeRchTool()`), tool `__openai_agent_discovery__`, target `ploinky-router`, and a replay-protected `jti`.

**Endpoint:** `GET /api/router/openai-agent-discovery`

**Response shape:**

```json
{
  "complete": true,
  "agents": [
    {
      "subjectId": "agent:<repo>/<agentName>",
      "routeKey": "<routeKey>",
      "repo": "<repo>",
      "agent": "<agentName>",
      "name": "<displayName>",
      "routerPath": "/<routeKey>",
      "chatCompletionsPath": "/<routeKey>/v1/chat/completions",
      "supportsStreaming": false,
      "usesDefaultOpenAiResponder": true,
      "manifest": {}
    }
  ]
}
```

Response paths are router-relative; no container-internal `127.0.0.1` URLs appear.

## Ploinky Agent Reconciliation

Reconciliation runs at startup (before the initial runtime snapshot is installed) and on a ~60-second timer. Each pass:

1. Calls the discovery endpoint (see above) with the Soul Gateway agent's own signed-subject key.
2. For each discovered agent, upserts one provider row (`ploinky:<subjectId>`, kind `external_api`, auth_strategy `none`, adapter_key `ploinky-agent-openai`) and one model row (`ploinky/<repo>/<agent>`, discovery_source `synced`, strategy_kind `direct`). The `ploinky-agent-discovery` marker is stored in row metadata only.
3. After any DB change, calls `performRuntimeRefresh(appCtx, { snapshot: true })` so routing sees the updated rows immediately. This refresh call is mandatory; omitting it leaves the runtime snapshot stale.
4. Stale-disables previously-discovered rows that are absent from the latest discovery response, BUT ONLY when `complete === true`. An incomplete discovery pass must not disable any rows.

## Default OpenAI Responder

Every agent answers `POST /v1/chat/completions` through the shared AgentServer. When a manifest has no `endpoints.chatCompletions` declaration, AgentServer uses a DEFAULT capability/listability responder: it returns an OpenAI-compatible message describing the agent and its MCP tools. The default responder does NOT invoke tools and rejects `stream: true` requests with an error.

Manifest `endpoints.chatCompletions` is the only way to provide real chat behavior; agents that declare it replace the default responder entirely for that agent.

The `usesDefaultOpenAiResponder: true` field in discovery responses identifies agents relying on this default so Soul Gateway can set appropriate capability metadata on the model row.

## Delegated Agent-to-Agent OpenAI Route

Agent-to-agent OpenAI calls are router-mediated. The router accepts a delegated HTTP Agent Assertion only on the path-exact route `POST /<routeKey>/v1/chat/completions`. For that path the router:

1. Verifies the Agent Assertion against the buffered request body using `computeRchHttp()`.
2. Strips the caller-supplied `x-ploinky-auth-info` header.
3. Mints a Router Request token bound to the exact body bytes.
4. Proxies to the target AgentServer, which verifies the Router Request before running its `/v1/chat/completions` handler.

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
