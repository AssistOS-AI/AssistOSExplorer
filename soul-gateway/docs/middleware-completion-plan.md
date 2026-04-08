# Middleware Completion Plan

## Purpose

This document defines the remaining refactor work needed to make Soul Gateway fully middleware-first below the HTTP routing layer.

The current runtime is already middleware-first in the route layer, gateway policy layer, provider middleware layer, and transport layer. The remaining work is to convert the request-time orchestration that still lives in helper functions into middleware where that logic represents a real execution boundary.

This is a forward-looking design and implementation plan. It does not describe the current runtime contract.

## Non-Negotiable Rule

For `soul-gateway/`, middleware first is the architectural rule:

- any request-time behavioral boundary below HTTP routing should be middleware
- pure routers, serializers, parsers, DAO functions, snapshot/refresh loaders, and other non-interception helpers do not need to be middleware
- no new executor, hook, wrapper, stage-machine, or request/response-wrapper abstractions should be introduced into the request path

The practical question is not "can every function be rewritten as middleware". The question is "does this function represent request-time behavior that should participate in ordered composition around a shared kernel context".

## Current State

Already middleware:

- route chain middlewares in `src/runtime/route/`
- gateway and model middlewares compiled from `middleware_bindings`
- provider middlewares compiled from `middleware_bindings(scope='provider')`
- `bufferingMiddleware(...)`
- `wrappingStreamMiddleware(...)`
- `cascadeMiddleware(...)`
- transport terminal middleware produced by `adaptProviderPluginToTransport(...)`

Still request-time orchestration rather than middleware:

- `executeResolvedRequest(...)` in `src/runtime/execution/execution-engine.mjs`
- `runSingleModelAttempt(...)` in `src/runtime/execution/single-model-attempt.mjs`
- `installInvokeModel(...)` in `src/runtime/execution/invoke-model.mjs`
- the inline `dispatchTerminal` inside `src/runtime/route/gateway-dispatch.mjs`
- concurrency acquire/release around a direct-model attempt
- retry loop around a direct-model attempt
- timeout signal setup/teardown around an attempt
- credential lease acquire/release around an attempt
- transport lookup before composing the provider chain

These are the remaining high-value candidates for middleware conversion.

## What Should Become Middleware

The following behaviors should be expressed as middleware or middleware factories:

- model-strategy dispatch
- direct-model execution
- cascade-model execution
- concurrency slot lifecycle
- retry lifecycle
- per-attempt timeout lifecycle
- per-attempt credential lease lifecycle
- transport dispatch from `ctx.target.provider.adapterKey`
- optional attempt-scoped metadata capture

The following should stay helpers or services:

- `registerPublicApiRoutes(...)`
- `createRouter()`
- `compose(...)`
- `createKernelContext(...)`
- `forkKernelContext(...)`
- `normalizeIncomingFormat(...)`
- `validateNormalizedRequest(...)`
- `canonicalStreamToSse(...)`
- `streamSseResponse(...)`
- `loadRuntimeSnapshot(...)`
- `performRuntimeRefresh(...)`
- DAO modules
- `ConcurrencyController` as a service object
- low-level helper primitives such as `withExecutionTimeout(...)`
- low-level helper primitives such as `executeWithHttpRetry(...)` if they are only used inside retry/timeout middleware implementations
- dashboard state methods in `src/dashboard/js/app.mjs`

## Target Shape

The target runtime below routing should look like this:

```text
runRouteRequest
  -> route middlewares
  -> gatewayDispatchMiddleware
       -> compile gateway/model middleware plan
       -> compose([
            ...gatewayMiddlewares,
            modelExecutionMiddleware(),
          ])

modelExecutionMiddleware()
  -> if direct:
       composeDirectModelChain(ctx)
  -> if cascade:
       compose([
            invokeModelCapabilityMiddleware(),
            cascadeMiddleware(...),
          ])

composeDirectModelChain(ctx)
  -> compose([
       bindDirectTargetMiddleware(),
       concurrencyMiddleware(),
       retryMiddleware({
         attemptChain: compose([
           attemptContextMiddleware(),
           timeoutMiddleware(),
           credentialLeaseMiddleware(),
           maybeBufferResponseMiddleware(),
           ...providerMiddlewares,
           transportDispatchMiddleware(),
         ]),
       }),
       finalizeDirectResultMiddleware(),
     ])
```

Important invariants:

- routing remains outside the middleware-first rule
- route middlewares continue to own ingress, auth, identity, snapshot binding, validation, session resolution, and edge egress
- transport remains terminal middleware
- cascade remains middleware, not a separate execution subsystem
- the shared kernel `ctx` remains the unit of composition

## Workstream 1: Introduce Explicit Model-Execution Middleware

### Goal

Replace the request-path use of `executeResolvedRequest(...)` with an exported `modelExecutionMiddleware()` that reads `ctx.target.model` and writes `ctx.response`.

### Scope

- `src/runtime/execution/execution-engine.mjs`
- `src/runtime/route/gateway-dispatch.mjs`
- `src/runtime/execution/invoke-model.mjs`
- tests that call `executeResolvedRequest(...)` directly

### Design

- add `modelExecutionMiddleware(options = {})`
- move the direct-vs-cascade branch into that middleware
- have `gatewayDispatchMiddleware()` end its inner chain with `modelExecutionMiddleware()` instead of an inline dispatch helper
- keep `executeResolvedRequest(...)` only as a transitional wrapper if needed during migration
- remove `executeResolvedRequest(...)` from the hot path once tests are green

### End State

- the route chain enters model execution through middleware, not through a helper that returns a result object
- `gatewayDispatchMiddleware()` composes gateway middleware and a model-execution terminal

## Workstream 2: Convert Direct-Model Attempt Orchestration Into Middleware

### Goal

Break `runSingleModelAttempt(...)` into request-time middlewares, leaving only pure chain-building helpers where needed.

### Current responsibilities inside `runSingleModelAttempt(...)`

- normalize model record
- configure/acquire/release concurrency
- build retry policy
- loop retries
- create timeout signal
- resolve provider record
- resolve transport plugin
- acquire/release credential lease
- compile provider middleware
- decide whether to install `bufferingMiddleware(...)`
- build provider sub-chain
- return result metadata

### Target split

- `bindDirectTargetMiddleware()`:
  reads `ctx.target.model`, resolves `ctx.target.provider`, and stores any static target metadata on `ctx.target`
- `concurrencyMiddleware()`:
  acquires the model slot before `next()` and releases it in `finally`
- `retryMiddleware()`:
  wraps downstream execution, runs attempt subcontexts, and records retry trace in `ctx.metadata`
- `attemptContextMiddleware()`:
  initializes `ctx.attempt`, clones the request if the attempt requires an isolated mutable request view, and resets attempt-local metadata
- `timeoutMiddleware()`:
  installs `ctx.signal` for the duration of one attempt
- `credentialLeaseMiddleware()`:
  leases provider credentials before `next()` and releases them in `finally`
- `transportDispatchMiddleware()`:
  resolves the actual transport from `ctx.target.provider.adapterKey` and invokes it as the terminal middleware
- `finalizeDirectResultMiddleware()`:
  normalizes queue wait, account id, and retry metadata onto the parent ctx after the attempt succeeds

### Design constraints

- concurrency must stay outermost around retries to preserve current semantics
- timeout and credential lease must stay per-attempt, not per-request
- retry must not let one failed attempt leak mutated request state into the next attempt unless explicitly intended
- provider middleware order must remain unchanged
- the buffering decision must remain conditional on `ctx.request.stream`

### End State

- `runSingleModelAttempt(...)` is either removed or reduced to a tiny helper that only composes a direct-model middleware chain and executes it
- no direct-model request-time behavior remains buried in one monolithic helper

## Workstream 3: Make Retry a First-Class Middleware Boundary

### Goal

Move retry behavior out of helper orchestration and into a middleware contract.

### Why

Retry is request-time behavior with clear before/after semantics:

- it starts before downstream execution
- it can run downstream multiple times
- it records trace metadata
- it decides whether to continue or rethrow

That is a middleware concern, not a generic helper concern.

### Design

- implement `retryMiddleware(policy, buildAttemptChain)` or equivalent
- execute downstream attempts in forked attempt contexts
- merge only the successful attempt result back into the parent ctx
- store retry trace on `ctx.metadata.retryTrace`

### Notes

`executeWithHttpRetry(...)` can remain as an internal helper if it still simplifies delay/backoff math, but the request-path boundary should be middleware.

## Workstream 4: Make Timeout and Credential Leasing Middleware

### Goal

Represent attempt-scoped resource lifecycles as middleware.

### Timeout

- introduce `timeoutMiddleware()`
- before `next()`, install attempt-local `ctx.signal`
- in `finally`, clear the timer

### Credential lease

- introduce `credentialLeaseMiddleware()`
- before `next()`, acquire provider credentials using `ctx.target.model.providerId`
- store the lease at `ctx.target.credentialLease`
- in `finally`, release it

### End State

- timeout and credential ownership become explicit middleware boundaries
- transport middleware no longer depends on outer helpers to smuggle in those values

## Workstream 5: Move Transport Resolution Into Terminal Middleware

### Goal

Stop resolving the concrete transport before composition.

### Current issue

The direct attempt path currently looks up the transport plugin and then adapts it into middleware before composing the provider chain. That means the last execution boundary is still partially pre-composition orchestration.

### Target

- add `transportDispatchMiddleware()`
- it reads `ctx.target.provider.adapterKey`
- it looks up the transport from `appCtx.services.transportCatalog`
- it invokes the resolved transport as the actual terminal

### Benefits

- transport selection becomes part of middleware execution instead of a pre-chain helper step
- model execution becomes more uniform
- custom provider routing stays in one place

## Workstream 6: Convert `installInvokeModel(...)` Into a Middleware Capability Boundary

### Goal

Make cascade re-entry capability installation explicit in the middleware model.

### Current state

`installInvokeModel(ctx)` mutates the ctx before `cascadeMiddleware(...)` runs.

### Target

- introduce `invokeModelCapabilityMiddleware()`
- it installs `ctx.invokeModel` before `next()`
- it is used only in chains that need re-entry

### Note

This is lower priority than Workstreams 1 through 5. If it adds complexity without clarity, keeping a tiny helper is acceptable. The main requirement is that the request path itself remains middleware-first.

## Workstream 7: Normalize Result Shaping Around `ctx.response`

### Goal

Remove remaining result-object orchestration patterns where reasonable.

### Current issue

Several helper paths still return objects like:

- `collected`
- `accountId`
- `queueWaitMs`
- `retryTrace`

That is a helper-oriented style rather than a middleware style.

### Target

- attempt middlewares write execution metadata directly to `ctx.metadata`
- terminals and buffers write the payload directly to `ctx.response`
- parent middlewares unwrap only when crossing a true abstraction boundary

### End State

- the hot path communicates primarily through `ctx`
- object return values are reserved for helper utilities, not request orchestration

## Workstream 8: Remove Transitional Entry Points

### Goal

Once the new middleware chain is stable, remove the helper-oriented request-time entrypoints from the hot path.

### Remove or demote

- `executeResolvedRequest(...)` as a hot-path orchestrator
- `runSingleModelAttempt(...)` as a monolithic hot-path orchestrator
- any inline dispatch terminal in `gateway-dispatch.mjs` that is doing more than invoking a middleware terminal

### Keep only if truly needed

- small pure chain builders
- helper math for retry backoff
- helper timer creation
- helper request cloning

## Workstream 9: Documentation and Diagram Cleanup

### Goal

Align architecture docs with the stricter middleware-first boundary.

### Update

- `soul-gateway/docs/backend-and-ui-flows.md`
- relevant current-state specs under `soul-gateway/docs/specs/`

### Required doc changes

- label every backend flow node as one of:
  - middleware
  - terminal middleware
  - router
  - helper
  - service
  - UI handler
- remove any remaining diagram fields that imply old abstractions
- document the direct-model attempt chain as middleware composition rather than helper orchestration

## Recommended Implementation Order

1. add `modelExecutionMiddleware()` and wire `gatewayDispatchMiddleware()` to it
2. extract `concurrencyMiddleware()`
3. extract `timeoutMiddleware()`
4. extract `credentialLeaseMiddleware()`
5. extract `transportDispatchMiddleware()`
6. convert retry into middleware around an attempt subchain
7. decide whether `installInvokeModel(...)` becomes middleware or remains a tiny helper
8. remove or demote the old helper entrypoints
9. update docs and diagrams

This order preserves the current behavior while steadily moving the hot path toward pure middleware composition.

## Files Expected To Change

Primary runtime files:

- `src/runtime/route/gateway-dispatch.mjs`
- `src/runtime/execution/execution-engine.mjs`
- `src/runtime/execution/single-model-attempt.mjs`
- `src/runtime/execution/invoke-model.mjs`
- `src/runtime/execution/http-retry.mjs`
- `src/runtime/execution/timeout-controller.mjs`
- `src/runtime/execution/concurrency-controller.mjs`
- `src/runtime/kernel/transport.mjs`
- `src/runtime/kernel/response-buffer.mjs`
- `src/runtime/middleware/compile-provider-bindings.mjs`

Likely new middleware modules:

- `src/runtime/execution/model-execution.mjs`
- `src/runtime/execution/concurrency-middleware.mjs`
- `src/runtime/execution/retry-middleware.mjs`
- `src/runtime/execution/timeout-middleware.mjs`
- `src/runtime/execution/credential-lease-middleware.mjs`
- `src/runtime/execution/transport-dispatch-middleware.mjs`
- `src/runtime/execution/invoke-model-capability-middleware.mjs`

Primary test files:

- `src/test/unit/execution.test.mjs`
- `src/test/unit/cascade-middleware.test.mjs`
- `src/test/unit/kernel-transport.test.mjs`
- `src/test/unit/route-chain.test.mjs`
- `src/test/unit/route-streaming.test.mjs`
- `src/test/unit/invoke-model.test.mjs`
- new tests for concurrency/retry/timeout/lease middlewares

## Acceptance Criteria

The refactor is complete when all of these are true:

- the route hot path below HTTP routing is expressed as middleware composition
- model strategy dispatch happens through middleware, not a helper that returns result objects
- direct-model execution behavior is decomposed into middleware boundaries
- concurrency, retry, timeout, and credential leasing are middleware boundaries
- transport resolution happens in terminal middleware
- cascade continues to work through middleware and `ctx.invokeModel`
- provider middleware order and streaming behavior are unchanged
- the hot path communicates through `ctx.request`, `ctx.response`, `ctx.target`, and `ctx.metadata`, not helper return envelopes
- stale helper orchestrators are removed from the hot path
- docs and diagrams explicitly distinguish middleware from helpers and services
- tests covering direct, cascade, retry, timeout, credential release, streaming, and abort behavior all pass

## Risks

- retry middleware can accidentally reuse mutated request state across attempts
- moving transport resolution too late can complicate error messages if target binding is incomplete
- timeout and credential middleware must clean up correctly on errors and aborts
- concurrency middleware must preserve current slot ownership semantics across retries
- cascade and streaming interactions are easy to regress if `ctx.response` shape is not preserved exactly

These risks are manageable as long as each workstream lands with focused unit coverage.
