# Soul Gateway — Middleware-First Refactor Plan

## Status (2026-04-07)

| Phase | Title | Status |
|---|---|---|
| 1 | Middleware kernel + unified context | **Shipped** |
| 2 | Adapters for legacy gateway middleware | **Shipped** |
| 3 | Gateway-level stream wrapping support | **Shipped** |
| 4 | Provider hooks → provider middleware | **Shipped** |
| 5 | Provider plugins → transport middleware | **Shipped** |
| 6 | Ingress/egress → route middleware | **Shipped** |
| 7 | Cascade as model strategy (runtime) | **Shipped** |
| 7b | Cascade as model strategy (snapshot) | **Shipped** — DB schema migration deferred to Phase 7c |
| 8 | Unified bindings + management API | Pending |
| 9 | Remove legacy abstractions | **Partial** — engines, cascade, resolveTier retired |

After Phase 6, the entire request lifecycle runs as a single kernel-composed chain. The route handler in `src/public-api/register-routes.mjs` calls `runRouteRequest()` from `src/runtime/route/run-route-request.mjs`, which builds the canonical chain (errorBoundary → parseBody → authenticate → identity → bindSnapshot → normalizeIngress → validateRequest → resolveModel → resolveSession → respond → gatewayDispatch terminal) and runs it through `compose([...])`.

After Phase 7, the cascade is also a kernel composition. The execution engine resolves a request as either:

- **Direct model** → `runSingleModelAttempt(model, ...)` runs the provider chain (`bufferingMiddleware` + provider hook middlewares + transport) once.
- **Cascade (tier)** → `executeResolvedRequest` builds a cascade kernel ctx, installs `ctx.invokeModel` via `installInvokeModel(ctx)`, and runs `cascadeMiddleware` through the kernel composer. The cascade middleware loops over candidates and dispatches each one via `ctx.invokeModel`, applying the same cooldown / cascade-error semantics the legacy `executeModelCascade` had.

Three new modules implement this:

- `src/runtime/execution/single-model-attempt.mjs` — `runSingleModelAttempt`, the smallest "dispatch one model once" primitive.
- `src/runtime/execution/cascade-middleware.mjs` — `cascadeMiddleware({ tier, resolveCandidates, maxAttempts, onCooldown })` returns a kernel terminal.
- `src/runtime/execution/invoke-model.mjs` — `installInvokeModel(ctx)` wires `ctx.invokeModel(modelOrKey)` to `runSingleModelAttempt`.

Phase 9 has been started. The following legacy modules and tests have been deleted because every behavior they covered is now covered by the kernel and its adapters:

- `src/request/pipeline.mjs` — replaced by `src/runtime/route/run-route-request.mjs::runRouteRequest`
- `src/request/request-context.mjs` — replaced by `src/runtime/kernel/context.mjs::createKernelContext`
- `src/runtime/middleware/middleware-engine.mjs` — replaced by `src/runtime/kernel/compose.mjs` + `legacy-gateway-adapter.mjs`
- `src/runtime/hooks/provider-hook-engine.mjs` — replaced by `src/runtime/kernel/legacy-provider-hook-adapter.mjs`
- `src/runtime/hooks/provider-hook-context.mjs` — replaced by the kernel ctx
- `src/runtime/execution/model-cascade.mjs` — replaced by `cascade-middleware.mjs` + `installInvokeModel`
- `src/test/unit/provider-hooks.test.mjs` — replaced by `kernel-provider-hook-adapter.test.mjs`
- `src/test/unit/hook-ordering.test.mjs` — covered by `kernel-legacy-adapter.test.mjs` and `kernel-provider-hook-adapter.test.mjs`
- The `runMiddlewarePlan` describe blocks in `src/test/unit/middleware.test.mjs` — covered by `kernel.test.mjs` and `kernel-legacy-adapter.test.mjs`

The remaining Phase 9 cleanup items (still pending) are:

- Renaming the `executor*` modules to `transport*` — currently the executor catalog still acts as the registry that the transport adapter wraps per attempt, which is functionally equivalent to a "transport catalog". A pure rename plus a `getTransport()` shortcut would close this out.
- Retiring `resolveTier()` — depends on Phase 7b (the schema change that adds `strategy_kind` and `model_children`).
- Retiring the split assignment tables (`middleware_assignments`, `provider_hook_assignments`) — depends on Phase 8.

### Phase 7b — Snapshot synthesizer (shipped)

The runtime now treats every addressable target as a model.  The snapshot loader synthesizes a cascade model for each tier row at load time:

- For each tier, `flattenTierChildren()` walks the tier's model list AND its `fallback_tier_id` chain, deduplicating models and skipping disabled ones.
- The flattened list becomes `model.children`, ordered by the original priority.
- A synthetic model record is created with `strategyKind: 'cascade'`, `modelKey: tier.tierKey`, and `discoverySource: 'synthesized'`.
- If a real direct model already exists with the same key, the direct model wins (no overwrite).

Direct model records get `strategyKind: 'direct'` and `children: null`.

The execution engine branches on `model.strategyKind` only — there is no separate "tier" code path.  The legacy `resolveTier` helper has been retired.  `snapshot.tiers` is still loaded for the management API, but the dispatch pipeline never reads it.

### Phase 7c — pending DB schema migration

When Phase 7c eventually lands it will:

- Add `models.strategy_kind = 'direct' | 'cascade'` and `models.max_attempts integer`.
- Add a `model_children(parent_model_id, child_model_id, priority, enabled, settings)` table.
- Migrate every existing tier into a real `cascade` model row with `model_children` rows for its members, in priority order.
- Drop the runtime synthesizer in favor of direct loading from the new tables.
- Eventually drop `tiers` and `tier_models` after the management API and dashboard migrate to model-children.

The runtime is already shaped to consume this schema; Phase 7c is a pure data-layer migration with no behavior change.

## Goal

Refactor the `soul-gateway/src/` runtime so the core execution model is a single middleware architecture:

- everything is middleware
- transports are terminal middlewares
- gateway policies are gateway-scoped middlewares
- provider behavior is provider-scoped middleware
- model behavior is model-scoped middleware
- a tier becomes a model with cascade strategy, not a separate execution abstraction

This plan describes the target architecture and a migration sequence from the current codebase. It is intentionally forward-looking and therefore lives outside `soul-gateway/docs/specs/`, which remains reserved for current behavior.

## Current problems to remove

The current runtime is split across multiple overlapping abstractions:

- the public request stage machine in `src/request/pipeline.mjs`
- gateway middleware in `src/runtime/middleware/`
- provider hooks in `src/runtime/hooks/`
- executors in `src/runtime/executors/`
- provider plugins in `src/runtime/providers/`
- separate tier/cascade execution in `src/runtime/execution/model-cascade.mjs`
- special request normalization and response serialization layers in `src/request/`

This creates duplicated behavior, duplicated assignment systems, and duplicated composition rules:

- gateway middleware and provider hooks both implement request/response interception
- executors and provider plugins both represent terminal execution
- tiers are treated as something other than models even though they are just cascading model targets
- streaming is first-class in provider hooks but not in gateway middleware
- format conversion is outside the middleware model even though it is request/response shaping

## Architectural principles

### 1. One composition model

Use one middleware contract everywhere:

```js
async function middleware(ctx, next) {
  // before
  await next();
  // after
}
```

Allowed behaviors:

- mutate `ctx.request` before `next()`
- mutate `ctx.response` after `next()`
- short-circuit by setting `ctx.response` and not calling `next()`
- throw a classified gateway error
- wrap a response stream
- act as the terminal handler by producing the upstream response

### 2. One runtime context

Every middleware receives the same core context shape, with scoped views added where needed:

- `ctx.requestId`
- `ctx.route`
- `ctx.request`
- `ctx.response`
- `ctx.identity`
- `ctx.auth`
- `ctx.session`
- `ctx.target`
- `ctx.attempt`
- `ctx.snapshot`
- `ctx.services`
- `ctx.state`
- `ctx.metadata`
- `ctx.signal`
- `ctx.log`
- `ctx.invokeModel(modelKey, options)`

`ctx.target` should always describe the model currently being invoked, plus the bound provider if one exists.

### 3. One target concept

A model is the only addressable execution target.

There are two model strategy kinds:

- `direct`: dispatch to a provider transport
- `cascade`: evaluate child models in order until one succeeds

Under this model:

- a former tier is just a `cascade` model
- aliases still resolve to models
- fallback chains become child model relationships

### 4. Transport is terminal middleware

A transport is the last middleware in a provider/model chain. It:

- converts the canonical request into the upstream protocol
- sends it to the upstream or local backend
- converts upstream events into the canonical event stream
- classifies raw transport/upstream errors

Transport does not do policy.

### 5. Canonical stream first

The response should be represented as a canonical event stream as early as possible.

Canonical events:

- `message_start`
- `text_delta`
- `tool_call_delta`
- `usage`
- `done`
- `error`

If a middleware needs a buffered response, that should happen through an explicit buffering middleware inserted into the chain, not by defaulting the whole runtime to buffer-first execution.

### 6. Specs remain current-state only

The refactor plan is not a replacement for the current specs. During migration:

- `soul-gateway/docs/specs/` describes the shipping implementation
- this document describes the target architecture and rollout

## Target runtime layout

The refactor should converge on something close to this:

```text
src/runtime/
  kernel/
    middleware-compose.mjs
    request-runtime.mjs
    target-invoker.mjs
    response-buffer.mjs
    stream-bridge.mjs
    runtime-context.mjs
  planning/
    runtime-compiler.mjs
    binding-resolver.mjs
    model-plan-compiler.mjs
  middleware/
    gateway/
    model/
    provider/
    route/
    transport/
    shared/
  registry/
    runtime-snapshot-loader.mjs
    model-resolver.mjs
  formats/
    ingress/
    egress/
    protocols/
```

Key points:

- `kernel/` owns execution semantics
- `planning/` compiles immutable middleware chains from DB snapshot + loaded modules
- `middleware/` contains all runtime behavior, including route, policy, provider, and transport logic
- `formats/` becomes middleware-oriented instead of a special pipeline stage

## Target middleware scopes and order

For a normal direct model request:

```text
route middleware
  -> gateway middleware
    -> model middleware
      -> provider middleware
        -> transport middleware
```

For a cascade model request:

```text
route middleware
  -> gateway middleware
    -> cascade model middleware
      -> invoke child direct/cascade models
```

Rules:

- route scope runs once per incoming HTTP request
- gateway scope runs once per incoming HTTP request
- model scope runs once for each model invocation attempt
- provider scope runs once for each provider-bound model attempt
- transport is terminal and must be last

## Concrete middleware categories

### Route middleware

Move these into route-level middleware:

- JSON body parsing
- auth header extraction
- request identity resolution
- ingress format normalization
- egress response serialization
- SSE framing for streaming responses

This replaces the current request pipeline stage machine as the main abstraction.

### Gateway middleware

These remain once-per-request policies:

- rate limiter
- budget enforcer
- content blocker
- loop detector
- request logger
- response cache
- token tracker
- response filter when it is gateway-scoped
- session context when it is gateway-scoped

Gateway middleware must support stream wrapping as well as pre/post request logic.

### Model middleware

Model-bound behavior includes:

- cascade strategy
- model-level prompt injection
- model-level context compression
- model-level response filtering
- model-level concurrency
- model-level timeout
- model-level retry policy

The current model override blobs should become explicit middleware bindings instead of ad hoc model fields.

### Provider middleware

Provider-bound behavior includes:

- credential lease / release
- provider-specific request shaping
- provider-specific prompt injection
- provider-specific output compression
- provider-specific stream normalization steps that are not transport-specific
- provider-specific response filtering
- account-pool selection and rotation

This fully replaces provider hooks and wrapper-style behavior.

### Transport middleware

Examples:

- `openai-http-transport`
- `anthropic-http-transport`
- `copilot-transport`
- `kiro-transport`
- `search-transport`
- `local-process-transport`

OpenAI-compatible vendors should mostly differ by provider configuration, not by separate runtime architecture.

## Data model changes

### Models

Keep one table of addressable models, but add a strategy field:

- `strategy_kind = 'direct' | 'cascade'`

For `direct` models:

- reference provider
- reference provider-side model id

For `cascade` models:

- no direct provider execution
- ordered children define fallback sequence

### Replace tiers with model relationships

Replace `tiers` and `tier_models` with a generalized relation such as:

- `model_children`
- `parent_model_id`
- `child_model_id`
- `priority`
- `enabled`
- `settings`

This lets a cascade model use direct child models or other cascade models.

### Replace split assignment tables with one bindings table

Replace:

- `middleware_assignments`
- `provider_hook_assignments`

with one table such as:

- `middleware_bindings`
- `middleware_id`
- `scope` = `route | gateway | model | provider`
- `target_id`
- `sort_order`
- `enabled`
- `settings`

Eliminate:

- `hook_mode`
- separate `phase` column for provider hooks

because around-middleware removes the need to model phases at the binding layer.

### Providers

A provider should keep:

- display/configuration data
- auth strategy
- account-pool data
- transport key
- settings

It should not imply a separate execution abstraction.

## Runtime compiler design

The snapshot loader should compile runtime plans up front.

Proposed compiled snapshot shape:

```js
{
  generation,
  aliases,
  modelsByKey,
  providersByKey,
  gatewayChain,
  routeChains,
  compiledModels: Map(modelKey, {
    model,
    strategyKind,
    middlewareChain,
    providerChain,
    transportKey,
    children,
  }),
  loadedAt
}
```

The compiler is responsible for:

- resolving middleware modules
- merging default settings with binding overrides
- ordering chains
- validating illegal combinations
- compiling route/gateway/model/provider chains once

Requests should execute only against this compiled snapshot, with no secondary lookup path through separate catalogs.

## Proposed migration phases

### Phase 1: Introduce the middleware kernel alongside the current runtime

Add the new kernel without changing behavior yet.

Deliverables:

- `middleware-compose.mjs`
- unified `ctx` factory
- terminal middleware support
- canonical stream wrapper support
- request-scoped state and metadata helpers

Acceptance criteria:

- unit tests prove ordering, short-circuiting, error propagation, and stream wrapping
- no existing routes changed yet

### Phase 2: Add compatibility adapters for existing gateway middleware

Wrap current `pre/post` middleware modules in the new around-middleware contract.

Deliverables:

- adapter from legacy gateway middleware to new middleware
- planner that can compile current gateway bindings into the new chain

Acceptance criteria:

- built-in gateway middleware behavior remains unchanged
- the new kernel can run the current gateway policies end to end

### Phase 3: Add gateway stream middleware support

Close the current gap where gateway middleware cannot wrap streams.

Deliverables:

- canonical stream response object
- stream wrapping in gateway scope
- buffering middleware for post-processing that requires full response bodies

Acceptance criteria:

- response cache, token tracker, response filter, and request logger can operate correctly for both buffered and streaming flows

### Phase 4: Convert provider hooks into unified provider middleware

Replace provider hook catalog and engine with provider-scoped middleware chains.

Deliverables:

- adapter for current provider hooks
- provider bindings compiled into provider middleware plans
- retirement path for `provider-hook-engine.mjs` and `provider-hook-catalog.mjs`

Acceptance criteria:

- built-in provider request/response/stream behaviors run under the unified kernel
- no duplicate provider-hook execution path remains in request dispatch

### Phase 5: Convert provider plugins into transport middlewares

Refactor built-in providers so the terminal piece is a transport middleware rather than a provider/executor object.

Deliverables:

- transport contract
- one transport module per protocol family
- provider config loader resolves `transport_key`

Acceptance criteria:

- OpenAI-compatible providers share one transport
- Anthropic, Copilot, Kiro, Search, and local/custom backends expose transport middleware
- executor catalog becomes unnecessary

### Phase 6: Move ingress and egress into route middleware

Replace the current request stage machine with route chains.

Deliverables:

- route middleware for JSON body parsing
- auth and identity middleware
- ingress normalization middleware
- egress serialization middleware
- SSE response bridge middleware

Acceptance criteria:

- `/v1/chat/completions`, `/v1/messages`, and `/v1/responses` are composed from route middleware, not a hard-coded stage function

### Phase 7: Make cascade a model strategy

Replace tiers with cascade models.

Deliverables:

- `strategy_kind` support
- model child relation
- `cascade` middleware that invokes children via `ctx.invokeModel()`
- alias and cooldown logic updated to work at model-only level

Acceptance criteria:

- every current tier can be represented as a cascade model
- `resolveTier()` and `model-cascade.mjs` become obsolete

### Phase 8: Replace split tables and management APIs

Migrate storage and management APIs to the unified model.

Deliverables:

- `middleware_bindings` table
- `model_children` table
- management endpoints and dashboard updates
- migration scripts from legacy assignments and tiers

Acceptance criteria:

- the UI manages one middleware binding system
- tiers are presented as cascade models
- provider hooks and executor-specific UI paths are removed

### Phase 9: Remove legacy runtime paths

Delete the old abstractions once parity is proven.

Remove:

- executor catalog
- provider hook catalog
- provider hook engine
- middleware `pre/post` only engine
- tier-specific execution path
- wrapper compatibility support

Acceptance criteria:

- all tests run against the middleware-only runtime
- docs/specs updated to describe the new current behavior

## File-by-file replacement map

### Replace or retire

- `src/request/pipeline.mjs`
- `src/runtime/middleware/middleware-engine.mjs`
- `src/runtime/hooks/provider-hook-engine.mjs`
- `src/runtime/hooks/provider-hook-catalog.mjs`
- `src/runtime/execution/execution-engine.mjs`
- `src/runtime/execution/model-cascade.mjs`
- `src/runtime/executors/`

### Heavily refactor

- `src/runtime/providers/`
- `src/runtime/registry/snapshot-loader.mjs`
- `src/bootstrap/service-installers.mjs`
- `src/request/format-normalizer.mjs`
- `src/request/format-serializers.mjs`
- management routes for providers, models, tiers, and middlewares

### Preserve as reusable logic with new ownership

- auth logic
- account pool and credential manager
- pricing and budget helpers
- token estimation and spend cache
- blacklist and session DAO logic
- converter logic, but moved under transport/route middleware ownership

## Risks and controls

### Risk: streaming regressions

Control:

- make canonical stream tests a first-class gate
- add golden tests for OpenAI, Anthropic, and Responses streaming output

### Risk: duplicated behavior during migration

Control:

- only one kernel executes a given request path at a time
- use adapters temporarily, but avoid dual execution

### Risk: management API churn

Control:

- introduce compatibility translation in the management layer first
- migrate persistence after runtime parity is proven

### Risk: overloading middleware with too many responsibilities

Control:

- keep middleware small and single-purpose
- reserve transport middleware for actual I/O
- keep planning/compilation separate from execution

## Test strategy

Add or expand tests in these groups:

- middleware kernel ordering and abort behavior
- canonical stream transformation and buffering
- route middleware ingress/egress parity
- gateway policy parity
- provider middleware parity
- transport contract tests per protocol family
- cascade model behavior
- snapshot compiler tests
- migration tests for legacy bindings to unified bindings

Add golden integration coverage for:

- direct model request
- cascade model fallback after quota/rate-limit failure
- streaming OpenAI route
- streaming Anthropic route
- cached response short-circuit
- provider-specific request shaping

## Rollout recommendation

Do not attempt this as one branch-wide rewrite.

Recommended order:

1. introduce new kernel and adapters
2. move gateway middleware first
3. add streaming support at gateway level
4. unify provider hooks into provider middleware
5. convert providers into transports
6. convert route normalization/serialization into route middleware
7. convert tiers into cascade models
8. migrate schema and management APIs
9. delete legacy abstractions

That sequence keeps the highest-risk areas isolated:

- streaming
- provider dispatch
- schema migrations

## Definition of done

The refactor is complete when all of the following are true:

- request execution is driven by one middleware kernel
- there is no executor abstraction
- there is no provider hook abstraction separate from middleware
- all request/response shaping is middleware-based
- transports are terminal middlewares
- tiers no longer exist as a separate runtime concept
- `soul-gateway/docs/specs/` has been rewritten to describe the new current behavior
