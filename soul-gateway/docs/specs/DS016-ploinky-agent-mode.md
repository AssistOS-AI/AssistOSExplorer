# DS016 - Ploinky Agent Mode

Soul Gateway has one deployment model: it is a Ploinky-managed agent with HTTP services. Browser-facing management access is protected by Ploinky's default login and protected-service identity. Public inference traffic still uses Soul Gateway API-key auth on `/v1/*`.

The old profile split is removed from active behavior. `SOUL_GATEWAY_MODE` and `TRUST_PLOINKY_ROUTER_AUTH` may be parsed for one release as deprecated no-op inputs, but they do not select behavior.

Ploinky-managed startup uses the mounted `/code` checkout as the only runtime source. The manifest points `agent`, `cli`, and `install` to `/code`; startup rejects missing `/code/src` instead of falling back to source carried in the image.

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
2. Verify the router-request JWT with this agent's injected `PLOINKY_AGENT_SECRET` for audience `agent:proxies/soul-gateway`, tool `__http_service__`, the signed request hash, and replay-protected `jti`.
3. Require `admin` in the Ploinky user's roles.
4. Reject requests that rely only on Soul Gateway cookies, bearer dashboard tokens, or caller-supplied identity headers.

The removed `/management/auth/*` endpoints return HTTP 410 with instructions to use Ploinky login. They never create or validate Soul Gateway sessions. Management writes do not require Soul Gateway CSRF tokens; the router invocation JWT is the request binding.

Soul Gateway preserves the verified Ploinky user from `x-ploinky-auth-info` on management route context and exposes a non-secret `GET /management/me` view. The keys dashboard uses `user.keyOwner` from that view to prefill the user API key owner. Soul Gateway does not infer ownership from browser state and does not accept an unauthenticated owner claim.

## Signed-Subject API Key Authentication

Soul Gateway verifies incoming bearer tokens as Ploinky-signed subject identity. Agent runtime keys are raw signed-subject values with the format `<subjectId>|<base64url-ed25519-signature>`, where the signature is over the exact UTF-8 bytes of `subjectId`. User-facing API keys use an encoded wrapper around the generic user subject form `user:<userId>`, with the format `sk-soul-<base64url(user:<userId>|<base64url-ed25519-signature>)>`; admin-created user keys use `user:<owner>:<name>` as their inner subject. Soul Gateway decodes user wrappers before verifying the inner signature with `PLOINKY_AGENT_API_PUBLIC_KEY`; Ploinky signs with its Ed25519 private key, which never enters Soul Gateway or agent processes. Raw user signed-subject bearer tokens are rejected.

There is no shared workspace default key. The manifest does not declare a `sharedGeneratedSecret` for Soul Gateway API keys. Instead, each Ploinky agent receives these injected env vars at startup:

| Variable | Value |
|---|---|
| `PLOINKY_AGENT_API_KEY` | The agent's raw signed-subject key: `<subjectId>|<base64url-sig>` |
| `PLOINKY_AGENT_API_PUBLIC_KEY` | Ed25519 public key Soul Gateway uses to verify signed keys |

These names are reserved; any manifest-declared values with the same names are stripped before injection. Provenance markers `PLOINKY_ENV_SOURCE_PLOINKY_AGENT_API_KEY=generated` and `PLOINKY_ENV_SOURCE_PLOINKY_AGENT_API_PUBLIC_KEY=generated` are injected alongside them.

**Legacy identity headers:** Soul Gateway rejects `x-soul-id`, `x-agent-name`, and `x-soul-agent` headers with HTTP 400. Identity is established exclusively from the signed-subject key.

**Loop guard:** A request whose signed-subject key resolves to the same subject as the model being invoked (a self-recursive discovery call) is rejected with HTTP 400.

**Admin-provisioned user keys:** Administrators can provision user keys from the protected management dashboard. The gateway endpoint `POST /management/keys` records a policy row for a router-signed `user:<owner>:<name>` subject with `subject_type='user'` and `source='signed-subject'`; Ploinky's router identity endpoint mints the copied bearer value as `sk-soul-<base64url(user:<owner>:<name>|<signature>)>`, and the gateway stores no key material. User keys are revocable. A revoked user subject id is burned, so rotation is revoke plus a different name. Agent keys are unchanged: they are discovered from Ploinky agent registration, are not provisioned by this endpoint, remain raw runtime-injected signed-subject values, and remain non-revocable in key management.

## Local LLM Hub And Tier Seeding

The local gateway is the LLM hub. The legacy local-provider and remote-provider
bootstraps were removed (commit `c9ed615`, 2026-06-17).

The local gateway also keeps upstream provider catalogs fresh. Provider create/update, OAuth completion, and manual sync use the strict shared sync path, while startup and interval refresh use the same path best-effort across eligible providers. Newly discovered upstream models become local direct model rows. Upstream models that disappear are disabled but preserved so history, metadata, and operator context remain available.

- Local models are discovered from enabled Ploinky agents
  (`runPloinkyReconcileOnce`), keyed `ploinky/<repo>/<agent-model>`.
- `seedDefaultTiers` reads the tier keys named in `LLM_DEFAULT_TIERS`
  (default `fast,plan,deep`). When a configured key has no existing model row,
  it creates a cascade model whose single child is the model discovered for
  `LLM_DEFAULT_AGENT` (default `default-local-llm`).
- When a legacy same-name alias row exists and no model owns that key, the alias
  is promoted into a cascade tier whose single child is the alias's former
  target; the alias row is then deleted.
- Existing cascade tiers are kept. Same-name aliases are deleted, and
  seeder-owned cascades are child-repaired only when their stored child list
  differs from the expected single child. User-created/manual cascades are not
  child-repaired.
- If a non-cascade model already owns a configured tier key, seeding warns and
  skips that key, leaving any same-name alias unchanged.

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
- `PROVIDER_MODEL_REFRESH_INTERVAL_MS`
- `OAUTH_ADAPTERS_ENABLED`

Deployments that want the provider model catalog refresh job disabled set `PROVIDER_MODEL_REFRESH_INTERVAL_MS=0`; deployments that want OAuth adapters disabled leave `OAUTH_ADAPTERS_ENABLED` empty.

## Settings Entry

`IDE-plugins/soul-gateway-settings/` is an AchillesIDE application plugin entry with policy key `soul-gateway/soul-gateway`. It remains `adminOnly: true`, so non-admin Explorer users do not see it.

The entry declares `settingsUrl: "/services/soul-gateway/management/"`. Explorer's Settings button opens that local router-protected dashboard directly instead of loading a Soul Gateway settings modal. It relies on Ploinky auth cookies and protected-service forwarding. It does not implement Soul Gateway-specific auth.

The dashboard at `/services/soul-gateway/management/` is the canonical operator UI for providers, models, API keys, and observability. The settings entry must not point Explorer users at a direct container port or a remote Soul Gateway deployment.

The dashboard has no Soul Gateway login form, no dashboard session token flow, and no CSRF/dashboard-cookie contract.

## Decisions & Questions

1. 2026-06-24: Ploinky's router-signed subject identity credential is the only local agent API key. Agents present `PLOINKY_AGENT_API_KEY`, Soul Gateway verifies with `PLOINKY_AGENT_API_PUBLIC_KEY`, and the former Soul Gateway-named compatibility alias is removed.
2. 2026-06-24: Per `docs/superpowers/plans/2026-06-24-create-user-keys.md` and `docs/superpowers/specs/2026-06-24-create-user-keys-design.md`, admin-created user keys reuse Ploinky router signing while Soul Gateway only provisions policy for `user:<owner>:<name>` subjects. This does not change agent discovery, agent-key injection, or the non-revocable agent-key contract.
3. 2026-06-27: Admin-created user keys are copied and accepted only as encoded `sk-soul-...` bearer tokens. The encoded payload contains the existing signed-subject key, but the visible copied key string no longer displays the literal `user:<owner>:<name>` text or a version marker. Base64url is reversible and is not a privacy boundary. Raw user signed-subject bearer tokens are rejected.
4. 2026-06-29: User-key owner autofill is derived from the verified Ploinky management context exposed by `/management/me`. Admins can still override the owner through the protected create-key flow, but Soul Gateway never trusts unauthenticated browser identity for ownership.

## Migration Notes

- Existing provider data and database API keys remain valid.
- Existing `soul_session` cookies are ignored.
- Users authenticate through `/auth/login`.
- Public `/v1/*` compatibility is preserved by reverse-proxy rewrites to the Ploinky router service.
- Direct public container-port access is not a deployment contract.
- 2026-06-17 (`c9ed615`): removed `LOCAL_LLM_*` and `SOUL_GATEWAY_PROVIDER_*`
  bootstraps in favor of the local-hub + `seedDefaultTiers` model. The local
  gateway is the LLM hub and does not delegate to a remote gateway.
- 2026-06-26: removed the `/management/auth/login|logout|session` 410 compatibility
  stubs and the dashboard Logout button / connection-status badge. The dashboard
  authenticates solely through the Ploinky router `/auth/login` and `/auth/logout`.
