# Soul Gateway — Specification Index

Soul Gateway is a multi-provider LLM proxy that accepts OpenAI-compatible chat completion requests (plus Anthropic Messages and OpenAI Responses formats) and dispatches them to upstream providers while enforcing per-key rate limits, budgets, content policy, and an extensible middleware pipeline. It speaks to upstream LLM providers through both static API keys and managed OAuth flows, pools multiple accounts per provider, rotates on quota exhaustion, and handles request-level observability (audit logs, real-time log streaming, cost metrics) as a first-class feature.

This directory holds the design specifications for the runtime that lives under `soul-gateway/src/`. Each `DSxxx` file is focused on a single capability area; the file names are stable and cross-referenced from other specs and the codebase. Start here if you're trying to understand what the system does or where a given behavior is documented.

## Abstraction Model

The runtime is organized around three distinct kinds of processing units:

### Gateway Hooks — "middleware"

Gateway hooks run once per request at the gateway scope, regardless of which provider ultimately handles the request. They implement `onRequest` (pre-dispatch) and/or `onResponse` (post-dispatch) phases. These are what the product UI calls *middleware*: rate limiter, budget enforcer, cache, content blocker, loop detector, token tracker, request logger, response filter, and so on. Gateway stream hooks (`wrapStream` at gateway scope) are a known gap in the middleware engine and are discovered but not executed.

### Provider Hooks — "wrapper"

Provider hooks run inside a specific provider's pipeline, around its executor. They implement any combination of `onRequest`, `wrapStream`, and `onResponse` phases. They operate per-provider, allowing provider-specific request shaping, response filtering, and stream transformation. Four built-in provider hooks ship with the gateway (context compacter, prompt injector, output compressor, response filter) and extension hooks can add more. Assignments are managed through the provider pipeline composer on the Providers page.

### Executors

An executor is the terminal component that fulfills a request. It calls an upstream API, runs a local model, performs a search, or executes custom logic. Canonical executor types are `external_api`, `search`, `local_model`, and `custom`. Every built-in provider plugin (OpenAI-compatible, Anthropic, Copilot, Codex, Kiro, Search, Gemini) is adapted into the executor contract at startup. Custom executors load from `extensions/executors/*.executor.mjs`.

### Request lifecycle with all three layers present

```
client request
  → gateway request middlewares (DS003)
    → provider request hooks (DS003)
      → executor (DS002)
    → provider stream hooks (DS003)
    → provider response hooks (DS003)
  → gateway response middlewares (DS003)
response to client
```

Gateway middlewares enclose the entire dispatch cycle; provider hooks are fully nested inside the dispatch boundary.

## Specification Index

| File | Topic | What you'll find |
|---|---|---|
| [DS001](DS001-request-pipeline.md) | Request pipeline | Full `/v1/chat/completions`, `/v1/messages`, `/v1/responses` request lifecycle from HTTP ingress to response. Identity headers, streaming vs non-streaming, request IDs. |
| [DS002](DS002-provider-auth.md) | Provider authentication | Static API keys, five managed OAuth flows (Copilot, Kiro, Codex, Gemini, Claude.ai), multi-account pooling, token refresh, auto-provisioning, format converters, custom search providers. |
| [DS003](DS003-middleware-framework.md) | Middleware, hooks, and extensions | The three-abstraction model (gateway hooks / provider hooks / executors), extension discovery, custom in-gateway models, provider pipeline composer, deprecated `kind='wrapper'` migration notes. |
| [DS004](DS004-model-routing.md) | Model routing | Model resolution algorithm, tier-based fallback with cycle detection, cooldown system, concurrency semaphores, pricing lookup. |
| [DS005](DS005-streaming.md) | Streaming | SSE pass-through from upstream, tool-call delta handling, non-streaming buffering, real-time log broadcasting via WebSocket and SSE. |
| [DS006](DS006-database-schema.md) | Database schema | Postgres table layout at a capability level — providers, provider_accounts, models, tiers, api_keys, blacklist rules, middlewares, sessions, audit logs, session state. |
| [DS007](DS007-rate-limiting-budgets.md) | Rate limiting, budgets, and API keys | Per-key RPM/TPM limits, daily/monthly budgets, cost calculation, spend caching, API key lifecycle (create, revoke, reset, hints). |
| [DS008](DS008-content-filtering.md) | Content filtering | Blacklist rules (exact, substring, regex) evaluated pre-dispatch, regex-based response filtering pre-return, per-tier / per-model overrides. |
| [DS009](DS009-error-handling.md) | Error handling | Error classification taxonomy, HTTP-level retry with exponential backoff, model-level cascade, account rotation on quota exhaustion, retry logging. |
| [DS010](DS010-agent-loop-detector.md) | Agent loop detector | Behavioral loop detection middleware — response similarity + growth-with-repetition signals, three response modes (intervene / block / log), per-tier configuration. |
| [DS012](DS012-api-reference.md) | Management API & dashboard | Dashboard authentication, CSRF, the full management operation catalog (keys, models, providers, tiers, middlewares, cooldowns, logs, metrics), connectivity tests, provider template catalog. |
| [DS013](DS013-configuration-deployment.md) | Configuration & deployment | Environment variables, self-initialization, `achillesAgentLib` configuration modes, health check, graceful shutdown. |
| [DS014](DS014-built-in-middlewares.md) | Built-in middlewares | Per-middleware capability description for the 12 gateway middlewares that ship with the runtime. |
| [DS015](DS015-observability.md) | Observability | Audit logging, real-time log streaming (WebSocket + SSE), metrics dashboards, session and agent tracking, data export. |

## Cross-reference conventions

- A capability that touches more than one subsystem is documented in the DS file closest to its *home* and cross-referenced from the others. If you can't find something where you expect, start from this README or search for the feature name across all DS files.
- Cooldowns and retries live in **DS004** (model routing) and **DS009** (error handling); read both for the full picture.
- API key lifecycle lives in **DS007** (rate limiting & budgets); provider credentials live in **DS002**. The two concepts are unrelated.
- Gateway middlewares and provider hooks are both in **DS003** because they share the hook contract, but DS014 has the per-middleware detail for the built-in gateway middlewares.

## Changes to this index

When a new capability is added that doesn't fit any existing DS file, create a new `DS0xx-<topic>.md` file, add a row to the table above, and cross-reference it from any related DS files. When a capability is removed, delete the section from the relevant DS file (do not leave dangling references).
