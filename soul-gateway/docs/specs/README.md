# Soul Gateway — Specification Index

Soul Gateway is a multi-provider LLM proxy under `soul-gateway/src/`. It accepts OpenAI Chat Completions, Anthropic Messages, and OpenAI Responses requests, normalizes them to a canonical request shape, applies gateway policy, dispatches through provider middleware and a backend terminal, and returns either buffered JSON or streamed SSE.

This directory documents the current behavior of the code on this branch. Forward-looking refactor notes and migration plans live outside `docs/specs/`.

Project invariant: All upstream LLM provider protocol calls must go through `achillesAgentLib`. Search providers are normal OpenAI-compatible models; Soul Gateway backends own vendor-specific search execution behind the standard model interface. External consumers call search models through `achillesAgentLib` the same way they call LLM models. Soul Gateway owns gateway policy, credential leasing, routing, and canonical stream normalization.

## Runtime model

Soul Gateway runs on one middleware kernel in `src/runtime/kernel/`.

- The public route layer is a kernel chain in `src/runtime/route/`.
- Gateway policy runs as gateway middlewares compiled from `middleware_bindings`.
- Provider-specific shaping runs as provider middlewares resolved from `providerMiddlewareRegistry`.
- The upstream call is a terminal **backend** middleware. Backend modules live in `src/runtime/backends/builtin/*.backend.mjs`. The unified `BackendCatalog` registers each module once and stores both the module (for lifecycle/admin calls) and a precompiled kernel terminal middleware (for the request hot path). There is no separate provider-execution or transport-execution subsystem.
- Every addressable target is a model. Cascade models live in `models` + `model_children`; the dashboard exposes a separate `Tiers` page and `/management/tiers` API family as a management view over those cascade model records.

The only intentionally retained historical bridge is the `main`-branch data import flow under `src/db/import/`.

## Request flow

```text
client request
  -> route chain
    -> gateway middlewares
      -> modelExecutionMiddleware()
        -> direct model: provider middlewares -> backend terminal
        -> cascade model: cascade middleware -> invoke child model attempts
    -> respond middleware
response to client
```

In buffered mode the provider chain drains the canonical stream into a buffered completion before route egress. In streaming mode the route layer writes SSE directly from the canonical stream.

## Specification index

| File | Topic | What you'll find |
|---|---|---|
| [DS001](DS001-request-pipeline.md) | Request pipeline | End-to-end request lifecycle for all three public ingress formats, including auth, identity, model resolution, gateway dispatch, and route egress. |
| [DS002](DS002-provider-auth.md) | Provider authentication | Static API keys, managed OAuth flows, account pooling, provider templates, and provider-side auth behavior. |
| [DS003](DS003-middleware-framework.md) | Middleware, backends, and extensions | Kernel contract, runtime context, gateway/provider/backend scopes, the unified backend catalog, and extension discovery. |
| [DS004](DS004-model-routing.md) | Model routing | Direct vs cascade models, name normalization, cascade fallback, cooldowns, concurrency, and pricing. |
| [DS005](DS005-streaming.md) | Streaming | Canonical event streams, provider stream wrapping, route-level SSE egress, buffering rules, and real-time log streaming. |
| [DS006](DS006-database-schema.md) | Database schema | Capability-level schema overview for providers, provider accounts, models, model children, middleware bindings, API keys, logs, and sessions. |
| [DS007](DS007-rate-limiting-budgets.md) | Rate limiting, budgets, and API keys | Per-key RPM/TPM limits, daily/monthly budgets, spend caching, pricing, and API-key lifecycle. |
| [DS008](DS008-content-filtering.md) | Content filtering | Blacklist rules, response filtering, where those policies run, and how overrides are applied. |
| [DS009](DS009-error-handling.md) | Error handling | Error classification, retry policy, cascade triggers, cooldown triggers, and shared error envelopes. |
| [DS010](DS010-agent-loop-detector.md) | Agent loop detector | Loop-detection heuristics, session-scoped state, response modes, and middleware settings. |
| [DS012](DS012-api-reference.md) | Management API & dashboard | Dashboard auth, provider/model management, middleware binding APIs, and observability endpoints. |
| [DS013](DS013-configuration-deployment.md) | Configuration & deployment | Environment variables, initialization, importer/DDL split, health checks, and shutdown behavior. |
| [DS014](DS014-built-in-middlewares.md) | Built-in middlewares | Current built-in gateway middleware catalog and how those modules are assigned and ordered. |
| [DS015](DS015-observability.md) | Observability | Audit logging, live log streaming, metrics dashboards, session grouping, and exports. |

## Cross-reference notes

- DS001 describes where the layers run; DS003 describes the middleware contract those layers use.
- DS002 documents provider authentication and the `achillesAgentLib` provider-transport ownership invariant.
- DS004 is the source of truth for cascade model routing behavior.
- DS005 covers client-visible streaming; DS015 covers dashboard log streaming.
- DS012 documents the active management and dashboard endpoints.
- DS013 documents runtime configuration, Achilles configuration modes, and production deployment details for `soul.axiologic.dev`.
