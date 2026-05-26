# Claude Code Prompt: Implement Embedded Soul Gateway For Explorer

You are working in `/Users/danielsava/work/file-parser`.

Implement the plan in:

- `proxies/soul-gateway/docs/explorer-embedded-soul-gateway-plan.md`

Before editing, read these files and treat them as governing context:

- `CLAUDE.md`
- `ploinky/CLAUDE.md`
- `proxies/CLAUDE.md`
- `proxies/soul-gateway/CLAUDE.md`
- `AssistOSExplorer/CLAUDE.md`
- `AssistOSExplorer/explorer/CLAUDE.md`
- `proxies/soul-gateway/docs/explorer-embedded-soul-gateway-plan.md`
- `ploinky/docs/specs/DS011-security-model.md`
- `proxies/soul-gateway/docs/specs/DS013-configuration-deployment.md`

## Goal

Make Soul Gateway work in both modes:

1. `standalone`: preserve the current production deployment shape, including `soul.axiologic.dev`.
2. `embedded`: start automatically with `AssistOSExplorer/explorer`, require no manually generated Soul Gateway API key, use a default local LLM provider, trust Explorer admin login through verified Ploinky router auth, and expose provider/key management through Settings -> Plugins -> Soul Gateway Settings.

## Fixed Decisions

Do not reopen these choices unless implementation proves them impossible:

1. Use semantic `embedded` and `standalone` Ploinky profiles.
2. Keep Postgres for embedded mode. Do not port Soul Gateway to SQLite.
3. Embedded mode must work by default with `LOCAL_LLM_BASE_URL` defaulting to `http://host.containers.internal:11434/v1` and `LOCAL_LLM_MODEL` defaulting to `gemma4:e2b`, unless the deployment overrides them.
4. The Explorer UX is Settings -> Plugins -> Soul Gateway Settings.
5. Expose a minimal public health route at `/public-services/soul-gateway-health/` for deployment smoke checks.

## Runtime And Security Invariants

Preserve these invariants:

- Request-time LLM inference must still go through `achillesAgentLib`.
- Soul Gateway may use direct provider HTTP only for lifecycle probes and model discovery.
- Do not inject `PLOINKY_MASTER_KEY` into agent runtimes.
- Agent-owned generated credentials must use manifest `generatedSecret: true`; shared generated credentials must use `sharedGeneratedSecret: true`.
- HTTP services must be manifest-declared. Do not hardcode Soul Gateway service paths in Ploinky core.
- Ploinky router identity headers are not secure by themselves. Soul Gateway may trust `x-ploinky-auth-info` only in embedded mode and only after verifying the router-issued invocation token for audience `agent:proxies/soul-gateway` and tool `__http_service__`.
- Do not hardcode `http://router/...`. Use `PLOINKY_ROUTER_URL` or runtime URL resolution when Explorer/llmAssistant need an embedded Soul Gateway URL.
- Keep standalone behavior compatible: existing API keys, dashboard login, Postgres, `0.0.0.0:8042:8042`, and deploy workflow behavior must continue to work.
- Embedded mode should use the Ploinky router for browser and sibling-agent access. Direct published ports are implementation details.
- Logs and user-facing errors must not leak API keys, cookies, bearer tokens, invocation JWTs, prompt bodies, or hidden diagnostics.

## Implementation Scope

Implement in phases and commit only coherent changes. Prefer small, testable changes.

### Phase 1: Ploinky Profiles And Routing

- Add semantic `embedded` and `standalone` profile support to Ploinky.
- Update profile validation, active profile handling, dependency graph lookup, and tests.
- Ensure manifests can express and select `embedded` / `standalone` cleanly.
- Preserve existing `default`, `dev`, `qa`, and `prod` behavior.
- Implement and document a dependency-local `enable` profile override so Explorer can run its normal profile while Soul Gateway runs `embedded`.

### Phase 2: Soul Gateway Manifest

- Update `proxies/soul-gateway/manifest.json`.
- Keep current standalone/default behavior stable.
- Add explicit `standalone` and `embedded` profile behavior.
- Embedded profile requirements:
  - `PORT=7000`
  - `SOUL_GATEWAY_MODE=embedded`
  - `TRUST_PLOINKY_ROUTER_AUTH=true`
  - `ALLOW_UNAUTHENTICATED=false`
  - `LOCAL_LLM_BASE_URL=http://host.containers.internal:11434/v1`
  - `LOCAL_LLM_MODEL=gemma4:e2b`
  - generated `ENCRYPTION_KEY`
  - generated `ADMIN_SESSION_SIGNING_KEY`
  - workspace-scoped generated `SOUL_GATEWAY_API_KEY`
  - `DASHBOARD_PASSWORD=""`
  - `OAUTH_ADAPTERS_ENABLED=""`
  - `TOKEN_REFRESH_INTERVAL_MS=0`
  - `PRICING_REFRESH_INTERVAL_MS=0`
- Declare `ports: []` for embedded mode so it clears the standalone `8042` binding and uses the router path plus Ploinky's localhost service mapping to container port `7000`.
- Add root-level `httpServices`:
  - API-key-authenticated `/services/soul-gateway/v1/` -> `/v1/` with router `auth: "none"`
  - protected `/services/soul-gateway/management/` -> `/management/`
  - public `/public-services/soul-gateway-health/` -> `/healthz/`
- Add a `/healthz/` alias if needed because Ploinky normalizes service prefixes with trailing slashes.

### Phase 3: Soul Gateway Embedded Auth

- Add router SSO support to Soul Gateway management auth.
- Gate it on embedded mode and `TRUST_PLOINKY_ROUTER_AUTH=true`.
- Parse `x-ploinky-auth-info`.
- Require admin role.
- Verify the embedded invocation token using the existing Ploinky/Achilles invocation JWT verifier, including audience, tool, signed invocation body hash, and replay id.
- Fall back to the existing `soul_session` dashboard auth path for standalone.
- Add an embedded workspace API-key path:
  - If embedded and bearer token equals `SOUL_GATEWAY_API_KEY`, authorize `workspace-default`.
  - When Postgres is configured, persist the key in `api_keys` so request sessions and audit rows have a real FK-compatible key id.
  - When no database is configured, fall back to an in-memory synthetic key record.
  - Keep DB-backed API keys unchanged.
  - Mark audit metadata so embedded workspace-key traffic is identifiable.

### Phase 4: Local LLM Bootstrap

- Add idempotent embedded provider bootstrap.
- If embedded and no providers exist, create `local-llm`:
  - adapter `openai-api`
  - `authStrategy: "none"`
  - base URL from `LOCAL_LLM_BASE_URL`
  - default model from `LOCAL_LLM_MODEL`
- Adjust the `openai-api` backend so no credential lease is required when provider auth strategy is `none`.
- Attempt model discovery.
- If discovery fails or `/models` is not available, create a fallback model row from `LOCAL_LLM_MODEL`.
- If the default endpoint is unreachable, surface clear diagnostics and fail embedded verification. Do not silently fall back to external providers.

### Phase 5: Explorer And llmAssistant Wiring

- Update `AssistOSExplorer/explorer/manifest.json`:
  - enable `proxies/soul-gateway`
  - make the admin user's roles explicit with `roles: ["admin"]`
  - generate `SOUL_GATEWAY_API_KEY` with `sharedGeneratedSecret: true` so it matches Soul Gateway's embedded key.
  - make `SOUL_GATEWAY_BASE_URL` optional for embedded mode
- Update `AssistOSExplorer/llmAssistant/manifest.json` with the same workspace-generated key and optional base URL.
- Update gateway URL resolution:
  - If `PLOINKY_ENV_SOURCE_SOUL_GATEWAY_API_KEY=generated`, use `${PLOINKY_ROUTER_URL}/services/soul-gateway/v1` and ignore inherited standalone URL env vars.
  - If `SOUL_GATEWAY_API_KEY` is explicit, use `SOUL_GATEWAY_BASE_URL` / `SOUL_GATEWAY_URL` when provided.
  - If `SOUL_GATEWAY_API_KEY` is explicit and no base URL is set, keep the `LLMConfig.json` Soul Gateway URL.
- Update `AssistOSExplorer/.github/workflows/deploy-skills-explorer.yml`:
  - add/enable the `proxies` repo
  - do not require external Soul Gateway secrets for the embedded default
  - ensure the default local LLM deployment is available, using the existing `basic/ollama` agent or the selected local LLM endpoint
  - preserve explicit external gateway overrides when provided
- Keep `proxies/.github/workflows/deploy-soul-gateway.yml` standalone-compatible.

### Phase 6: Explorer Settings Plugin

- Add `proxies/soul-gateway/IDE-plugins/soul-gateway-settings/`.
- Implement a runtime plugin that appears under Settings -> Plugins with a Settings button.
- Suggested plugin config:

```json
{
  "pluginCategory": "application",
  "id": "soul-gateway",
  "component": "soul-gateway-settings",
  "settings": "soul-gateway-settings",
  "label": "Soul Gateway",
  "tooltip": "Configure Soul Gateway providers",
  "presenter": "SoulGatewaySettings",
  "type": "global",
  "adminOnly": true
}
```

- The settings component should call protected router routes under `/services/soul-gateway/management/...`.
- UI must support:
  - local LLM status and base URL
  - model discovery/test connection
  - external provider add/edit/remove
  - write-only provider API-key fields
  - DB-backed API-key list/generate/revoke flows
  - hide the synthetic `workspace-default` embedded key from display and generation flows
  - provider/model status errors
- Extend Explorer Settings plugin metadata handling for `adminOnly`.
- Hide or disable admin-only plugin settings for non-admin users.
- Enforce admin server-side in Soul Gateway regardless of UI hiding.

### Phase 7: Documentation

- Add `proxies/soul-gateway/docs/specs/DS016-embedded-mode.md`.
- Update `proxies/soul-gateway/docs/specs/DS013-configuration-deployment.md`.
- Update relevant `CLAUDE.md` files for:
  - embedded versus standalone modes
  - router-auth trust requirements
  - generated embedded API-key contract
  - Settings plugin location
  - deployment verification

## Verification Requirements

Run targeted tests after each phase where practical.

Minimum expected checks:

- Ploinky profile tests for semantic profiles and dependency graph profile lookup.
- Ploinky HTTP service routing tests, including protected auth and stripped spoofed identity headers.
- Soul Gateway unit tests:
  - standalone auth behavior unchanged
  - embedded admin SSO accepts verified admin invocation
  - embedded admin SSO rejects non-admin, missing token, bad audience, bad tool, forged headers, body mismatch, and replay
  - embedded workspace API key persists when Postgres is configured and falls back to synthetic only without DB
  - DB-backed API keys still work
  - local LLM bootstrap creates `local-llm`
  - `authStrategy: "none"` OpenAI-compatible provider works for discovery/execution
- Explorer tests:
  - plugin aggregation discovers Soul Gateway plugin
  - `adminOnly` plugin settings are hidden/disabled for non-admin
  - generated `SOUL_GATEWAY_API_KEY` manifests resolve consistently
  - default embedded URL resolves from `PLOINKY_ROUTER_URL` only when the key source is `generated`
- Deployment smoke:
  1. Standalone: `https://soul.axiologic.dev/healthz` and host-local `http://localhost:8042/healthz` still work.
  2. Embedded: router health works.
  3. Embedded: `curl http://localhost:<routerPort>/public-services/soul-gateway-health/` returns minimal healthy JSON.
  4. Embedded: `ploinky status` shows Explorer, Soul Gateway, Postgres, and the default local LLM dependency running.
  5. Embedded: Explorer admin can open Settings -> Plugins -> Soul Gateway Settings.
  6. Embedded: non-admin cannot use Soul Gateway management.
  7. Embedded: one llmAssistant request succeeds through Soul Gateway and the default local LLM provider.

If a check cannot be run locally, document why and provide the exact command or workflow to run later.

## Non-Goals

- Do not replace `soul.axiologic.dev` with embedded mode.
- Do not implement SQLite storage.
- Do not make OAuth provider callback support part of embedded v1.
- Do not allow non-admin provider management.
- Do not move request-time LLM generation out of `achillesAgentLib`.

## Handoff Output

When done, summarize:

- files changed
- how standalone compatibility was preserved
- how embedded mode is selected
- how the generated API-key contract works
- how router admin auth is verified
- how the default local LLM is provisioned
- what tests were run
- what remains manual or deployment-dependent
