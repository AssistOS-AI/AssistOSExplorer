# Clean Middleware-Chain Architecture Plan

## Purpose

This document defines the target architecture for `soul-gateway/` using the broad middleware model:

- the server is a collection of middleware chains selected by routing
- normal middlewares call `next()`
- terminal middlewares do not call `next()` and fulfill the request by setting `ctx.response`
- helpers and services exist only to support middleware execution, not to compete with it

The goal is a cleaner system with fewer concepts, sharper boundaries, and aggressive removal of legacy leftovers.

This is a forward-looking implementation plan. It does not describe the current shipped runtime contract.

## Architectural Rule

Below HTTP routing, request-time behavior should reduce to:

- middleware
- terminal middleware
- middleware helpers
- request context

Everything else should be either:

- routing
- configuration/data
- lifecycle/admin helpers
- stateful services

If a concept does not clearly earn its existence, it should be merged into one of those buckets or removed.

## Final Concept Set

The target architecture should have only these active runtime concepts:

### 1. Router

Responsible for:

- matching HTTP method/path
- selecting the chain entrypoint
- constructing the initial request ctx

Not responsible for:

- request policy
- model selection logic
- provider execution
- serialization strategy beyond entering the route chain

### 2. Request Context

One mutable ctx object flows through the entire request chain.

Core fields:

- `ctx.request`
- `ctx.response`
- `ctx.route`
- `ctx.auth`
- `ctx.identity`
- `ctx.session`
- `ctx.snapshot`
- `ctx.target`
- `ctx.attempt`
- `ctx.metadata`
- `ctx.signal`
- `ctx.services`

### 3. Middleware

Any request-time behavior that composes around downstream execution:

- route middleware
- gateway middleware
- model middleware
- provider middleware
- retry/timeout/concurrency/lease middleware
- stream-wrapping middleware
- cascade middleware

### 4. Terminal Middleware

The bottom of a chain. It does not call `next()`.

Examples:

- route dispatch terminal
- provider/backend terminal for external HTTP calls
- future local-model terminal

The current `transport` concept already fits this well. If the name stays, it should be understood as "terminal backend middleware", not as a parallel architecture subsystem.

### 5. Helpers

Pure or low-level support code used by middleware:

- parsing
- serialization
- backoff math
- timeout helpers
- stream collectors
- request cloning

Helpers do not own request orchestration.

### 6. Services

Long-lived mutable state or lifecycle coordination:

- DB pools
- runtime snapshot loaders
- refresh services
- credential manager
- cooldown registry
- middleware/transport catalogs

Services are not request-time behavior boundaries.

### 7. Configuration/Data

Persistent or file-based configuration:

- providers
- models
- middleware bindings
- provider definitions/presets/family JSON
- importer mappings

## What Must Be Removed Or Merged

The clean target requires actively deleting or collapsing concepts that overlap.

### Remove from the active runtime model

- any leftover helper orchestrators that duplicate middleware composition
- any provider-execution abstractions parallel to terminal middleware
- any compatibility aliases kept only for historical naming
- dead files and stale extension kinds
- runtime terms that imply old execution layers

### Collapse into existing concepts

- "external backend" into terminal middleware
- "provider behavior" into ordered provider middleware bindings plus provider config
- "provider-specific request shaping" into provider middleware or terminal middleware
- "provider-specific lifecycle helpers" into optional lifecycle capabilities on the terminal backend or generic family helpers

### Keep only where justified

- import/migration code needed to move data from `main`
- SQL migrations
- lifecycle/admin helper functions that are not part of the request path

## Target Mental Model

The target runtime should be understood like this:

```text
HTTP request
  -> router selects a route chain
  -> route middlewares
  -> gateway middlewares
  -> model middlewares
  -> provider middlewares
  -> terminal backend middleware
  -> route egress middleware writes HTTP response
```

For cascade models:

```text
HTTP request
  -> route chain
  -> gateway/model middlewares
  -> cascade middleware
       -> invoke child chain
            -> provider middlewares
            -> terminal backend middleware
```

That is the whole execution architecture.

## Provider Model In The Clean Design

A provider should become a composition concept, not a heavy code concept.

### A provider is:

- provider config
- ordered provider middleware bindings
- exactly one terminal backend key

### A provider is not:

- a separate execution subsystem
- a bag of custom hooks
- a special-case orchestration object

### What code a provider may still need

Only when the upstream protocol is genuinely custom:

- one terminal backend module for the upstream wire protocol
- optional provider middleware extensions for reusable request/response policies

Adding a custom LLM server should usually mean:

1. create one terminal backend extension file
2. create one provider config pointing at that backend
3. optionally attach provider middlewares in order

Not:

1. custom executor
2. custom wrapper
3. custom provider hook
4. custom transport adapter
5. duplicate management logic

## Lifecycle/Admin Capabilities

`discoverModels`, `testConnection`, `validateProviderRecord`, and similar methods are not request-time middleware concerns.

In the clean architecture, these should be treated as lifecycle/admin capabilities associated with the terminal backend family, not as evidence that a separate provider-plugin execution model is needed.

That means one of two acceptable designs:

### Option A: Optional methods on terminal backend modules

- terminal backend exports `execute`
- may also export `discoverModels`
- may also export `testConnection`
- may also export `validateProviderConfig`

This is the simplest path from the current implementation.

### Option B: Split backend runtime and backend lifecycle explicitly

- `backend.execute` / `backend.classifyError`
- `backendLifecycle.discoverModels` / `backendLifecycle.testConnection`

This is cleaner conceptually but more code churn. Start with Option A unless the lifecycle surface becomes too large.

## Config-Driven Families

To reduce code proliferation, the architecture should support a small number of code families plus data definitions.

### Recommended families

- `openai_compat`
- `anthropic_messages`
- `search_engine`
- `custom_http`
- `oauth_api`

### Data-driven provider definition should hold

- provider key
- display name
- backend family or backend key
- base URL
- auth strategy
- default headers
- format capabilities
- discovery strategy
- test-connection strategy
- settings schema/defaults

### Rule

Prefer:

- generic backend family code
- JSON/data definitions

over:

- one code module per vendor

unless the upstream truly requires unique behavior.

## Workstreams

## Workstream 1: Freeze The Target Glossary

### Goal

Make the architecture language consistent before deeper code changes.

### Decisions

- keep `middleware` as the execution unit
- keep `terminal middleware` as the request terminator concept
- keep `transport` only if used strictly to mean "terminal backend middleware"
- stop introducing parallel request-path nouns for the same thing

### Files likely affected

- `docs/backend-and-ui-flows.md`
- `docs/specs/DS001-request-pipeline.md`
- `docs/specs/DS003-middleware-framework.md`
- `docs/specs/README.md`
- repo guidance files

### Acceptance criteria

- the docs describe the runtime as middleware chains plus terminals
- no active docs describe overlapping execution concepts

## Workstream 2: Make Terminal Backends The Only External Execution Concept

### Goal

Ensure every upstream call path goes through terminal middleware and only terminal middleware.

### Scope

- `src/runtime/execution/transport-dispatch-middleware.mjs`
- `src/runtime/kernel/transport.mjs`
- terminal extension loading

### Actions

- keep transport/backend resolution strict
- ensure all upstream request fulfillment happens through terminal middleware
- forbid reintroduction of parallel provider execution helpers

### Acceptance criteria

- there is one way to fulfill an external request: terminal backend middleware

## Workstream 3: Collapse Provider Integration Packaging

### Goal

Reduce "provider plugin" from a first-class architecture concept to either:

- a terminal backend module with optional lifecycle methods, or
- a lifecycle helper around a terminal backend

### Current pain

The code still mixes:

- provider plugin contract
- transport contract
- provider catalog
- transport catalog

even though the request path already treats the backend as terminal middleware.

### Target

- builtin upstream integrations become native transport/backend modules
- `provider-loader` / `provider-catalog` stop being required to understand the request architecture
- management/lifecycle code resolves lifecycle capabilities from the terminal backend side

### Migration options

#### Phase 3A: keep lifecycle methods on transport modules

- move builtin modules from `runtime/providers/builtin/` toward `runtime/transports/builtin/`
- expose `discoverModels` / `testConnection` on transport modules directly
- load one transport catalog for both request path and lifecycle helpers

#### Phase 3B: remove provider loader/catalog

- replace provider catalog loading with transport module loading
- keep provider records as config/data only

### Files likely affected

- `src/runtime/providers/provider-interface.mjs`
- `src/runtime/providers/provider-loader.mjs`
- `src/runtime/providers/provider-catalog.mjs`
- `src/runtime/providers/builtin/*.provider.mjs`
- `src/runtime/transports/provider-transport-adapter.mjs`
- `src/bootstrap/service-installers.mjs`
- `src/runtime/providers/auto-provisioner.mjs`
- `src/management/provider-route-helpers.mjs`
- `src/management/providers-route.mjs`

### Acceptance criteria

- request-time execution no longer depends on a separate provider-plugin mental model
- lifecycle/admin operations can be explained without introducing a second execution architecture

## Workstream 4: Make Provider = Config + Ordered Provider Middlewares + One Terminal Backend

### Goal

Turn providers into configuration assemblies rather than code-heavy runtime concepts.

### Target provider shape

- provider row
- ordered `middleware_bindings(scope='provider')`
- one terminal backend key in provider config

### Required work

- ensure provider middleware management remains flat and ordered
- make the dashboard/provider editor present the provider as a chain
- make terminal backend assignment explicit in the provider editing UX

### Files likely affected

- `src/management/provider-middlewares-route.mjs`
- `src/management/providers-route.mjs`
- `src/dashboard/js/app.mjs`
- `src/dashboard/index.html`
- `docs/backend-and-ui-flows.md`
- `docs/specs/DS012-api-reference.md`

### Acceptance criteria

- a provider can be described as "config + ordered provider middlewares + terminal backend"
- adding a custom provider does not require touching multiple runtime abstractions unless the upstream protocol is genuinely custom

## Workstream 5: Add Family-Driven Provider Definitions

### Goal

Reduce custom code by moving vendor configuration into data definitions where possible.

### Target

- protocol-family code stays in a small number of backend modules
- vendor/base-URL/auth defaults live in JSON or frozen data catalogs
- discovery/test behaviors are selected by simple family strategies when possible

### Use cases

- OpenAI-compatible vendors should be mostly configuration
- Anthropic-like families should be one family implementation plus config
- search providers should be driven by engine/family config where practical

### Files likely affected

- `src/runtime/providers/provider-presets.mjs`
- new `src/runtime/providers/definitions/` or equivalent
- builtin transport modules
- dashboard template surfaces

### Acceptance criteria

- adding a same-family provider is configuration, not new code
- only truly custom protocols require a new terminal backend module

## Workstream 6: Simplify Extension Discovery Around Two Runtime Kinds

### Goal

Keep extension discovery aligned with the clean architecture.

### Target

Runtime extension kinds should effectively reduce to:

- middleware extensions
- terminal backend extensions

Provider-specific middleware remains a scoped middleware extension, not a new runtime concept.

### Actions

- keep extension discovery directories aligned with middleware/terminal categories
- ensure extension manifests do not reintroduce old concepts
- keep transport extensions capable of optional lifecycle methods

### Files likely affected

- `src/runtime/plugins/extension-loader.mjs`
- `src/runtime/plugins/manifest-validator.mjs`
- `src/runtime/plugins/runtime-extension-adapters.mjs`
- docs/specs

### Acceptance criteria

- extension discovery is easy to explain in one sentence
- no obsolete extension kind survives

## Workstream 7: Legacy Removal Pass

### Goal

Delete all leftover code and terminology that no longer earns its existence.

### Removal policy

When a new path is stable:

- delete the old file
- delete compatibility aliases
- delete dead tests
- delete stale docs
- grep for old terms and remove them

### Explicit audit targets

- dead runtime files
- compatibility names in comments/docs
- unused DB fields exposed only by inertia
- old provider/plugin/transport overlap where one concept already subsumes another
- stale dashboard labels and route names

### Allowed exceptions

- SQL migrations
- importer code needed for `main`-branch data porting
- narrowly scoped compatibility surfaces intentionally retained in product UX, such as the Tiers page backed by cascade models

### Acceptance criteria

- grep confirms old active-runtime terms are gone
- the remaining architecture can be described without apologizing for historical leftovers

## Workstream 8: Verification And Cleanliness Gate

### Goal

Refuse to call the refactor complete until the codebase is structurally clean, not only behaviorally correct.

### Required checks

- targeted unit tests for every new middleware boundary
- route-chain integration tests
- cascade and streaming parity tests
- management/provider lifecycle tests
- extension loading tests
- grep audit for removed concepts
- current-state spec review

### Cleanliness checklist

- there is one obvious request path
- there is one obvious external-backend concept
- adding a custom backend is one code module plus config, not a scavenger hunt
- providers are visibly assembled from ordered middleware plus a terminal backend
- old abstractions are deleted, not merely hidden

## Recommended Implementation Order

1. freeze glossary and docs
2. keep transport/backend strict as the only external request terminator
3. move builtin provider integrations toward native backend/transport modules
4. rewire lifecycle/admin code to use backend modules directly
5. make provider editing/management present "provider = chain + terminal backend"
6. introduce family-driven provider definitions for same-family vendors
7. perform a full legacy removal pass
8. run grep audits, specs, and tests before calling the architecture clean

## Risks

- collapsing provider-plugin and transport concepts too fast can break lifecycle/admin flows
- JSON/data-driven families can become an accidental mini-language if over-generalized
- cleanup work can leave stale naming behind in docs/tests if grep audits are skipped
- management/UI may lag behind the runtime unless provider composition is made explicit there too

## Done Definition

This architecture work is complete when all of the following are true:

- the request path below routing is explainable entirely in terms of middleware chains and terminal middlewares
- external upstream fulfillment is implemented only as terminal backend middleware
- providers are configuration plus ordered middleware bindings plus one terminal backend key
- lifecycle capabilities like `discoverModels` no longer justify a parallel execution architecture
- same-family providers are added through configuration instead of new code whenever practical
- dead legacy files, aliases, and concepts are deleted from the active runtime
- only migrations/importers needed for `main`-branch data porting remain as legacy material
- specs and architecture docs describe the cleaned system clearly and directly
