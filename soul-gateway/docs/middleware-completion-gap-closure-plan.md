# Middleware Completion Gap-Closure Plan

## Purpose

This document closes the remaining implementation gaps found while reviewing `docs/middleware-completion-plan.md` against the current `soul-gateway/src/` runtime.

The middleware-first refactor is mostly complete. The remaining work is narrower:

- remove dead legacy execution code
- align current-state docs and diagrams with the shipped runtime
- tighten the transport terminal contract to the intended middleware boundary
- remove the last helper-style result envelope still used by cascade re-entry

This is a short-horizon implementation plan for the current branch, not a historical migration plan.

## Status

Implemented on this branch:

- Workstream A: done
- Workstream B: done
- Workstream C: done
- Workstream D: done

## Findings To Close

### Gap 1: `ctx.invokeModel(...)` still returns a helper envelope

Current state:

- `invokeModelCapabilityMiddleware()` still returns an object with:
  - `collected`
  - `accountId`
  - `queueWaitMs`
  - `retryTrace`
  - `model`
- `cascadeMiddleware()` consumes that object and copies fields back onto the parent ctx.

Why this is a gap:

- `docs/middleware-completion-plan.md` says the hot path should communicate through `ctx.response` and `ctx.metadata`, not helper return envelopes.

Target:

- internal cascade re-entry should use a child kernel ctx as the unit of exchange
- parent cascade code should read `childCtx.response` and `childCtx.metadata`
- object return values should be limited to compatibility/helper APIs that are intentionally outside the request middleware runtime

### Gap 2: Dead legacy execution helper still exists

Current state:

- `src/runtime/execution/provider-dispatch.mjs` remains in the tree
- it still describes the old execution-engine path in its file header
- it has no active call sites in the current runtime

Why this is a gap:

- the plan explicitly calls for removing stale helper orchestrators from the hot path
- dead files that still describe the old architecture create confusion during future refactors

Target:

- remove the file
- verify there are no active imports or test references

### Gap 3: Current-state docs still describe an "execution engine"

Current state:

- `docs/backend-and-ui-flows.md`
- `docs/specs/README.md`
- `docs/specs/DS001-request-pipeline.md`
- `docs/specs/DS006-database-schema.md`

still use wording that predates `modelExecutionMiddleware()`.

Why this is a gap:

- the current-state docs should describe the current branch exactly
- the remaining terminology drift makes the runtime look less middleware-first than it is

Target:

- replace "execution engine" wording with `modelExecutionMiddleware()` / model-execution chain terminology
- ensure every flow node is described consistently as router, middleware, terminal middleware, helper, service, or UI handler
- remove stale diagram fields like `hookMode`

### Gap 4: Transport dispatch is still more permissive than the target contract

Current state:

- `transportDispatchMiddleware()` still:
  - falls back from `provider.adapterKey` to `model.providerKey`
  - falls back from `transportCatalog` to `providerCatalog.getPlugin(...)`
  - emits a synthetic stub completion if no catalog exists

Why this is a gap:

- the completion plan says transport resolution should happen through the transport terminal using `ctx.target.provider.adapterKey`
- permissive fallback paths were useful during transition, but they weaken the architecture contract now

Target:

- require `ctx.target.provider`
- resolve by `provider.adapterKey` / `provider.adapter_key`
- resolve through `appCtx.services.transportCatalog`
- throw configuration errors for missing transport catalog, missing adapter key, or missing transport plugin

## Workstreams

## Workstream A: Remove dead legacy execution artifacts

### Scope

- `src/runtime/execution/provider-dispatch.mjs`
- any dead comments or tests that still mention that helper

### Acceptance criteria

- the dead file is removed
- grep shows no remaining runtime references to `dispatchProviderAttempt`

## Workstream B: Fix current-state docs and diagrams

### Scope

- `docs/backend-and-ui-flows.md`
- `docs/specs/README.md`
- `docs/specs/DS001-request-pipeline.md`
- `docs/specs/DS006-database-schema.md`

### Required changes

- replace "execution engine" wording with model-execution middleware wording
- remove `hookMode` from diagrams
- remove or explicitly qualify stale `executionKind` fields if they are shown only as persisted compatibility data
- keep the flow diagrams current with the actual runtime files:
  - `src/runtime/route/gateway-dispatch.mjs`
  - `src/runtime/execution/model-execution.mjs`
  - `src/runtime/execution/transport-dispatch-middleware.mjs`

### Acceptance criteria

- docs describe the current runtime without mentioning retired execution helpers as active concepts

## Workstream C: Tighten the transport terminal contract

### Scope

- `src/runtime/execution/transport-dispatch-middleware.mjs`
- `src/test/unit/transport-dispatch-middleware.test.mjs`
- any other tests that rely on the permissive fallback behavior

### Design

- require `ctx.target.model`
- require `ctx.target.provider`
- require `ctx.appCtx.services.transportCatalog`
- require `provider.adapterKey` or `provider.adapter_key`
- call `transportCatalog.getTransport(adapterKey)`
- adapt and invoke the resolved transport

### Remove

- provider-key fallback
- provider-catalog fallback
- synthetic stub completion path

### Acceptance criteria

- transport dispatch is a strict transport middleware boundary
- tests reflect the stricter contract

## Workstream D: Replace internal invoke-model envelopes with child ctx exchange

### Scope

- `src/runtime/execution/invoke-model-capability-middleware.mjs`
- `src/runtime/execution/cascade-middleware.mjs`
- `src/test/unit/invoke-model.test.mjs`
- `src/test/unit/cascade-middleware.test.mjs`
- any cascade parity tests affected by the contract change

### Design

- split the internal capability from any helper-return surface:
  - internal kernel capability returns the finished child ctx
  - optional helper wrappers may still project that ctx into a convenience object where appropriate outside the hot path
- update `cascadeMiddleware()` to:
  - call the internal child-dispatch capability
  - copy `childCtx.response` to `ctx.response`
  - copy required metadata from `childCtx.metadata`
  - record the actual selected model from child metadata

### Compatibility rule

- `ctx.invokeModel` inside the request middleware runtime should become ctx-first
- if extension/plugin APIs still need a returned object, keep that as an extension-SDK helper, not as the core runtime exchange contract

### Acceptance criteria

- cascade no longer depends on `{ collected, accountId, retryTrace, ... }`
- the hot path communicates through child ctx + parent ctx, not helper envelopes

## Recommended Order

1. Workstream A
2. Workstream B
3. Workstream C
4. Workstream D
5. targeted tests
6. full `npm run test:unit`

## Risks

- tightening transport dispatch may break permissive tests or unsupported ad-hoc contexts that never installed `transportCatalog`
- changing `ctx.invokeModel` can easily regress cascade metadata propagation if child ctx metadata is copied incorrectly
- docs may continue to drift unless they are updated in the same change as the runtime slice

## Done Definition

This gap-closure work is complete when:

- no dead legacy execution helper remains in `src/runtime/execution/`
- current-state docs no longer describe an active "execution engine"
- transport dispatch is strict and transport-only
- cascade re-entry uses child ctx exchange instead of helper return envelopes
- targeted tests and the unit suite pass
