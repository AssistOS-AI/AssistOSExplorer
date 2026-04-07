# DS012 — Management API & Dashboard

## Summary

This spec describes the web dashboard, its authentication model, and the catalog of management operations exposed as both dashboard UI and REST API endpoints. It documents operations at the capability level — what's configurable and what the resulting effect on runtime behavior is — rather than listing every endpoint with its exact request/response schema (the HTTP handlers are the source of truth for that).

## Web dashboard

- The system provides a web-based dashboard for administration.
- Dashboard access is protected with a password. Login returns a time-limited session token (default 12 hours) delivered via an HttpOnly cookie. The token is HMAC-signed and verified on every request.
- State-changing dashboard operations require a CSRF token. The server generates a random token per session and rejects requests where the `X-CSRF-Token` header does not match the session's token.
- The dashboard provides UI for all management operations listed below.
- Data-backed tabs (Providers, Models, Tiers, Keys, Blacklist, Middlewares) automatically re-fetch their data when the user navigates to them, so mutations made in another tab become visible without a browser refresh. Tabs backed by their own live-refresh streams (Logs, Activity, Costs, Errors, Usage via WebSocket or SSE) use those streams instead of the navigation refresh.
- The Extensions page has been removed. Extension packaging and discovery are not exposed as a first-class UI surface; operational management is done on the Providers page (for executors and provider hooks) and Middlewares page (for gateway hooks).

## Provider template catalog

The provider-create UI derives its template choices from the live provider template catalog rather than a hardcoded client-side list, so newly-added OAuth-capable templates appear automatically. The template catalog merges two sources:

1. **Loaded provider plugins** representing distinct vendor offerings — the OAuth-backed plugins: GitHub Copilot, OpenAI Codex, Anthropic Claude.ai, AWS Kiro, Google Gemini OAuth.
2. **A static preset catalog** of vendor-labeled configurations sharing a protocol-family plugin — OpenAI-compatible vendors (OpenAI direct, OpenRouter, NVIDIA, Groq, Fireworks, Together, DeepSeek, DeepInfra, Perplexity, Mistral, Mistral Codestral, xAI, Cohere), a direct Anthropic API preset, and eight web-search engines (Tavily, Brave, Exa, Serper, Jina, DuckDuckGo, SearXNG, Gemini Search grounding).

Protocol-family dispatcher plugins (`openai-api`, `anthropic-api`, `search-builtin`) are marked as hidden in their manifest and do not surface in the template dropdown as standalone entries — a user always picks a vendor preset (which pre-fills display name, base URL, and auth strategy) rather than the raw dispatcher. The two derived OAuth plugins (`gemini-openai`, `claudeai-api`) explicitly opt out of their parent's hidden flag since they are distinct vendor offerings without a preset.

## Management operations

All operations are available as both dashboard UI and REST API endpoints. Mutations that affect live routing or policy state (providers, models, tiers, blacklist rules, cooldowns, and middleware configuration) trigger runtime refresh so subsequent requests observe the updated configuration without a process restart.

### Key management

Create, list, update, revoke API keys; view daily spend; reset budgets. See DS007 for the per-key property catalog.

### Model management

Create, list, update, delete, enable/disable models; set pricing and concurrency; tag-based organization; discover available models from a provider.

### Provider management

Create, list, update, delete providers; view provider templates; test connectivity; initiate and complete OAuth flows; manage OAuth accounts (view status, remove, reset quota); sync discovered models into the registry.

- Provider creation supports a "Provider Mode" selector (**External API** or **Custom Pipeline**), and the persisted provider kind is derived from that mode rather than selected independently. Custom Pipeline providers are composed on the Providers page via a pipeline composer modal.
- Provider update accepts API-key-only PATCH bodies so callers can rotate credentials without re-sending the unchanged column fields — the handler loads the provider first for an honest 404, skips the DAO update when no column fields are present, and always runs the credential upsert separately.

### Connectivity tests

The Test button on each provider invokes the plugin's `testConnection` lifecycle method:

- **OpenAI-compatible providers** first try `GET /models`; if that returns 404 (as on Mistral's Codestral subdomain, which only exposes `/chat/completions` and `/fim/completions`), the plugin falls back to an empty `POST /chat/completions` probe. Status-code interpretation: 2xx or 4xx other than 401/403/404 means reachable and credential recognised; 401/403 surfaces the auth failure; a double-404 means the base URL is wrong.
- **Search providers** resolve which engine the row represents by walking `ctx.resolvedModel.provider_model_id → settings.engine → provider_key → base_url hostname`, so the Test button reports the actual engine name ("Exa Search credentials present", "Brave Search credentials present", "DuckDuckGo does not require authentication") rather than a generic default.
- **OAuth-backed providers** validate the credential lease (presence + non-expired) rather than making a live call that is known to fail due to scope restrictions (e.g. the Codex OAuth token isn't accepted by `api.openai.com/v1/models`).

### Provider pipeline composer

When a provider is set to "Custom" mode, a modal allows selecting an executor (terminal backend) and composing request, stream, and response hook lanes. Hooks can be added, removed, reordered, and configured per-hook. Saving the pipeline persists the executor key and hook assignments to the database. The composer is accessible via a "Pipeline" button in the providers table.

### Executor inventory

List all registered executor modules from the executor catalog via `GET /management/executors`.

### Tier management

Create, list, update, delete, enable/disable tiers; configure model priority lists and fallback chains. See DS004 for tier resolution semantics.

### Middleware management

List available middlewares; assign middlewares to tiers or models with custom settings and execution order; rescan for new middlewares. See DS003 for the middleware framework and DS014 for the built-in middleware catalog.

### Provider hook management

List all registered provider hook modules from the hook catalog; list hook assignments for a specific provider grouped by phase; create, update, and delete hook assignments on a provider. Assignment mutations wait for a runtime refresh before the API response is returned, so the provider pipeline reflects changes immediately after the mutation completes.

### Content policy management

Create, list, update, delete, enable/disable blacklist rules. See DS008 for pattern matching semantics.

### Cooldown management

View active model cooldowns; clear individual or all cooldowns. See DS004 for cooldown lifecycle.

### Log management

Search logs with filters; view individual log entries; retrieve logs for a specific session; stream logs in real time. See DS015 for observability details.

### Metrics dashboards

View cost, usage, error, activity, and token metrics with configurable time ranges. See DS015 for the metrics catalog.

### Export

Bulk export audit logs as CSV or JSON, with filters for time range, soul ID, model, and status.

## Error envelope

Management API errors follow the same shared envelope as the public LLM endpoints:

```json
{ "error": { "message": "...", "type": "validation_error", "detail": { ... } } }
```

The `type` values for management-specific errors include `validation_error` (400), `authentication_required` (401), `csrf_token_mismatch` (403), `not_found` (404), `conflict` (409), and `internal_error` (500). See DS009 for the full error classification taxonomy.

## Related specs

- **DS001** — the public `/v1/*` endpoints that the management API sits alongside.
- **DS002** — provider auth and format converter details.
- **DS003** — middleware framework that the middleware and provider hook management endpoints operate on.
- **DS007** — per-key properties the key management endpoints surface.
- **DS009** — shared error envelope used by every management endpoint.
- **DS015** — log, metrics, and session endpoints referenced by this spec.
