# Soul Gateway — Legacy Compatibility Cleanup Plan

## Purpose

This plan addresses the remaining architectural leftovers from the middleware-first refactor:

- `executorCatalog` naming and aliases
- `/management/executors` and `/management/provider-hooks` compatibility endpoints
- legacy provider-hook grouping semantics (`request` / `stream` / `response`)
- legacy extension directories and manifest kinds such as `wrappers/` and `kind='wrapper'`
- compatibility helpers and tests that still describe the old model

This document is a forward-looking execution plan, so it lives outside
`soul-gateway/docs/specs/`.

## Important scope decision

The cleanup should **not** optimize for preserving compatibility with the
current branch's transitional implementation.

The migration source of truth is still the older Soul Gateway on the `main`
branch under `soul-gateway/app/`. That matters for:

- data import
- semantic parity for providers, models, tiers, logs, and API keys

It does **not** require preserving the current branch's temporary naming
aliases and compatibility APIs indefinitely.

That changes the cleanup posture:

- remove current-branch transitional names aggressively once the internal and
  UI callers are migrated
- keep only compatibility surfaces that are part of the product contract we
  still want

## Surfaces to keep vs remove

### Keep

These are intentional product or operator surfaces:

- `/v1/tiers` as a compatibility view over cascade models
- `/management/tiers` and the dashboard `Tiers` page as a cascade-model view
- legacy gateway middleware module shape `{ meta, pre?, post? }` for now, if
  built-in gateway middleware migration is not done in the same pass

### Remove

These are transitional implementation leftovers and should be retired:

- `executorCatalog` alias
- `ExecutorCatalog` class name
- `getExecutor()` alias when `getTransport()` is the real API
- `/management/executors`
- `/management/provider-hooks`
- `/management/providers/:providerId/hooks`
- grouped provider phases in management payloads
- extension scanning for `wrappers/`
- extension scanning for legacy `search/` and `models/` executor folders if
  those entries can be migrated to transport extensions
- deprecated `kind='wrapper'` and wrapper-specific validation branches
- provider lifecycle fallback through `options.executorCatalog`

## Current leftover inventory

### 1. Transport naming aliases

Examples:

- `appCtx.services.executorCatalog` alias in
  `src/bootstrap/service-installers.mjs`
- `ExecutorCatalog` class in
  `src/runtime/transports/transport-catalog.mjs`
- `getExecutor()` alias on the transport catalog

Why it remains:

- old management code
- old tests
- transitional provider lifecycle callers

Target state:

- only `transportCatalog`
- only `TransportCatalog`
- only `getTransport()`

### 2. Provider management compatibility URLs

Examples:

- `/management/executors`
- `/management/provider-hooks`
- `/management/providers/:providerId/hooks`

Why they remain:

- the dashboard composer was originally built around executor and provider-hook
  terminology
- grouped payloads let the existing UI survive without a full rewrite

Target state:

- a transport inventory endpoint
- provider middleware endpoints with transport- and middleware-first naming
- flat ordered provider middleware lists

### 3. Provider middleware phase compatibility

Examples:

- `shapeProviderBinding()` returning `phase: 'request'`
- grouped payloads like `{ request: [], stream: [], response: [] }`

Why it remains:

- the current dashboard composer still thinks in phase columns

Target state:

- one ordered provider middleware list
- no phase field
- ordering only

### 4. Extension loader compatibility

Examples:

- `extensions/wrappers/*.wrapper.mjs`
- `extensions/search/*.search.mjs`
- `extensions/models/*.model.mjs`
- `extensions/provider-hooks/*.hook.mjs`
- `extensions/executors/*.executor.mjs`

Why it remains:

- transitional extension support for older extension shapes and naming

Target state:

- one extension model aligned with the runtime concepts
- no wrapper concept
- no executor naming where the runtime means transport

### 5. Deprecated wrapper concept

Examples:

- `kind='wrapper'`
- wrapper validation in manifest and transport interfaces
- tests whose primary purpose is preserving wrapper compatibility

Why it remains:

- compatibility for old extension/provider manifests

Target state:

- no wrapper kind in the active runtime contracts
- wrapping behavior expressed as middleware
- terminal execution expressed as transport

### 6. Provider lifecycle fallback to old naming

Example:

- `_resolveLifecycleTarget(..., options.executorCatalog)` in
  `src/runtime/providers/provider-catalog.mjs`

Why it remains:

- custom-provider lifecycle code was not fully renamed when the transport
  runtime path was switched over

Target state:

- lifecycle code resolves only through provider plugins and transport catalog
  using transport terminology

## Desired target architecture after cleanup

After this cleanup, the architecture should read cleanly:

- middleware is the only execution model
- transport is the terminal execution unit
- provider middleware is one ordered list
- model middleware is one ordered list
- gateway middleware is one ordered list
- transport plugins are discovered, registered, and managed as transports
- there is no wrapper, executor, or provider-hook concept in the active
  runtime model

The only intentional compatibility story that remains is:

- tiers as a UI/API compatibility view over cascade models

## Workstream A — Rename transport concepts completely

### A1. Rename the catalog class and exports

Change:

- `ExecutorCatalog` -> `TransportCatalog`

Files likely involved:

- `src/runtime/transports/transport-catalog.mjs`
- `src/bootstrap/service-installers.mjs`
- all tests importing `ExecutorCatalog`

Plan:

1. Rename the class to `TransportCatalog`.
2. Remove the `ExecutorCatalog` export alias.
3. Remove the `getExecutor()` method.
4. Update all imports and callers to use `TransportCatalog` and
   `getTransport()`.

Acceptance criteria:

- there is no runtime import of `ExecutorCatalog`
- there is no `getExecutor()` call in `src/`
- `transportCatalog` is the only catalog name in the code

### A2. Remove `appCtx.services.executorCatalog`

Change:

- stop binding `appCtx.services.executorCatalog = transportCatalog`

Files likely involved:

- `src/bootstrap/service-installers.mjs`
- tests and helpers that still inject `executorCatalog`

Plan:

1. Remove the alias at bootstrap time.
2. Update all remaining consumers to use `transportCatalog`.
3. Update test fixtures/mocks to inject `transportCatalog`.

Acceptance criteria:

- `executorCatalog` no longer exists in `appCtx.services`
- all runtime and test callers use `transportCatalog`

## Workstream B — Rename management APIs to transport/provider-middleware terms

### B1. Replace `/management/executors`

Introduce a new canonical endpoint, for example:

- `GET /management/transports`

Plan:

1. Add the new endpoint in the management router.
2. Return transport plugin inventory from `transportCatalog`.
3. Update the dashboard composer to fetch `/management/transports`.
4. Remove `/management/executors`.

Acceptance criteria:

- dashboard no longer calls `/management/executors`
- there is no route registered for `/management/executors`
- docs and tests reference `transports`, not `executors`

### B2. Replace `/management/provider-hooks*`

Introduce canonical provider middleware endpoints, for example:

- `GET /management/provider-middlewares`
- `GET /management/providers/:providerId/middlewares`
- `POST /management/providers/:providerId/middlewares`
- `PATCH /management/providers/:providerId/middlewares/:bindingId`
- `DELETE /management/providers/:providerId/middlewares/:bindingId`

Plan:

1. Add the new endpoints.
2. Update dashboard requests to use them.
3. Rename route handlers from `handleListProviderHooks` etc. to
   middleware-first names.
4. Remove the old `/hooks` endpoints.

Acceptance criteria:

- dashboard no longer calls `/management/provider-hooks`
- dashboard no longer calls `/management/providers/:id/hooks`
- the management router uses middleware-first route names only

## Workstream C — Simplify the provider composer UI and API shape

### C1. Remove phase grouping from the backend

Current problem:

- provider middleware bindings are reshaped into fake `request`, `stream`,
  `response` groups even though the runtime stores one list

Plan:

1. Change provider middleware list endpoints to return a flat ordered array.
2. Remove `phase` from the canonical management payload.
3. Use only:
   - `id`
   - `middleware_key`
   - `sort_order`
   - `enabled`
   - `settings`

Acceptance criteria:

- no grouped `{ request, stream, response }` payload remains in the canonical
  API
- no provider middleware response includes a synthetic `phase`

### C2. Rewrite the dashboard composer to one ordered chain

Plan:

1. Replace column-based phase rendering with one ordered list UI.
2. Keep drag reorder, settings edit, enable/disable, add/remove.
3. Keep transport selection as a separate field in the same modal or page.
4. Persist order directly as `sort_order`.

Acceptance criteria:

- the composer UI matches the real runtime model
- there is no phase column or phase-specific code in `src/dashboard/js/app.mjs`

## Workstream D — Clean up extension terminology and discovery

### D1. Replace `executors/` with `transports/`

Plan:

1. Add canonical discovery path:
   - `extensions/transports/*.transport.mjs`
2. Update extension loader and manifest docs.
3. Update transport extension adapters and tests.
4. Remove `extensions/executors/*.executor.mjs`.

Acceptance criteria:

- the canonical extension path is transport-named
- no code path depends on `extCatalog.executors`

### D2. Replace `provider-hooks/` with `provider-middlewares/`

Plan:

1. Add canonical discovery path:
   - `extensions/provider-middlewares/*.middleware.mjs`
2. Update the loader and docs.
3. Remove old provider-hook path scanning.

Acceptance criteria:

- the canonical extension path uses middleware terminology
- no code path depends on `extCatalog.providerHooks`

### D3. Remove `wrappers/`

Plan:

1. Remove scanning of `extensions/wrappers/`.
2. Remove wrapper-to-provider-hook mapping.
3. Remove wrapper compatibility tests.

Acceptance criteria:

- `wrappers/` is not scanned
- no extension entry is tagged from a wrapper path

### D4. Remove legacy `search/` and `models/` extension dirs if unused

This workstream depends on whether these legacy extension directories are still
needed for real deployments.

Plan:

1. inventory any real extension usage
2. if unused, remove scanning for:
   - `extensions/search/*.search.mjs`
   - `extensions/models/*.model.mjs`
3. otherwise migrate them to `transports/`

Acceptance criteria:

- extension discovery matches the active architecture, not the historical one

## Workstream E — Remove wrapper and provider-hook concepts from contracts

### E1. Remove `wrapper` from runtime transport interfaces

Files likely involved:

- `src/runtime/transports/transport-interface.mjs`
- `src/runtime/transports/transport-constants.mjs`
- manifest and validator modules

Plan:

1. remove `wrapper` from allowed transport/executor kinds
2. remove wrapper-specific comments and deprecation paths
3. migrate any tests that still assert wrapper compatibility

Acceptance criteria:

- no runtime contract lists `wrapper` as a valid transport kind

### E2. Remove old provider-hook adapter terminology where not needed

This does not mean every legacy adapter must disappear immediately if gateway
middleware still uses legacy `{ pre, post }` modules. It means:

- provider code should no longer talk about provider hooks
- provider middleware compilation should use middleware-first naming

Plan:

1. rename legacy provider adapter helpers to compatibility-specific names if
   they still exist
2. remove `compileProviderHookPipeline` naming in favor of
   provider-middleware naming
3. stop exporting old names from kernel index modules

Acceptance criteria:

- active runtime APIs no longer expose `provider hook` terminology

## Workstream F — Remove lifecycle fallbacks to old names

### F1. Update provider lifecycle resolution

Current problem:

- `ProviderCatalog._resolveLifecycleTarget()` still accepts
  `options.executorCatalog`

Plan:

1. rename the option to `transportCatalog`
2. update callers
3. remove executor fallback

Acceptance criteria:

- provider lifecycle uses transport terminology only

### F2. Normalize provider records to `adapter_key`

Current problem:

- some comments and lookup code still mention `executor_key`

Plan:

1. audit whether `executor_key` still exists in DB or only in compatibility
   accessors
2. if the schema already uses `adapter_key`, remove runtime comments and
   fallback branches that imply `executor_key` is canonical
3. if the DB still has an old field alias, collapse it in a dedicated schema
   pass

Acceptance criteria:

- `adapter_key` is the only active transport lookup field in runtime code

## Workstream G — Tests, docs, and flow cleanup

### G1. Rewrite test naming around transports and middleware

Plan:

1. rename tests like `executor-contracts.test.mjs`
2. remove compatibility-only wrapper tests
3. keep only tests that prove current runtime behavior

Acceptance criteria:

- test names reinforce the current architecture instead of the old one

### G2. Rewrite current-behavior specs

Update:

- `DS003-middleware-framework.md`
- `DS012-api-reference.md`
- `README.md`
- `backend-and-ui-flows.md`

Plan:

1. remove references to compatibility surfaces that were actually deleted
2. rename remaining transport/middleware concepts consistently
3. keep only intentional compatibility surfaces like tiers

Acceptance criteria:

- specs match the final post-cleanup runtime

### G3. Remove stale comments and historical language in code

Examples:

- comments saying "Workstream G final pass renames this later"
- comments referring to temporary aliases that no longer exist

Acceptance criteria:

- no code comments describe already-completed transitional states

## Recommended implementation order

This is the safest order if you want the repo to stay coherent after each
slice.

### Phase 1 — Internal transport rename

Do first:

1. `TransportCatalog` class rename
2. remove `executorCatalog` alias from services
3. update internal callers and tests

Why first:

- it is mostly internal
- it reduces conceptual noise before touching the dashboard

### Phase 2 — Management API and dashboard composer rename

Do next:

1. add `/management/transports`
2. add `/management/provider-middlewares*`
3. rewrite dashboard requests and UI labels
4. remove old `/executors` and `/provider-hooks*` endpoints

Why second:

- this is the most visible product-facing cleanup
- once done, the runtime and UI speak the same language

### Phase 3 — Flat provider middleware list

Do next:

1. backend returns flat binding arrays
2. dashboard composer becomes one ordered list
3. remove synthetic phase handling

Why third:

- it finishes the provider middleware mental model

### Phase 4 — Extension system cleanup

Do next:

1. canonical `transports/`
2. canonical `provider-middlewares/`
3. remove `wrappers/`
4. migrate or remove `search/` and `models/`

Why fourth:

- extension cleanup is broader and easier once naming is stable elsewhere

### Phase 5 — Contract and lifecycle cleanup

Do last:

1. remove `wrapper` from allowed kinds
2. remove old provider-hook naming from exported helpers
3. remove lifecycle fallback names
4. remove compatibility-only tests

Why last:

- by this point no production path should still depend on old names

## Verification plan

Each phase should have explicit verification.

### For Phase 1

- unit tests for transport catalog
- grep confirms no `executorCatalog` or `getExecutor(` in `src/`

### For Phase 2

- dashboard provider composer works against the new endpoints
- management router tests updated
- no `/management/executors` or `/management/provider-hooks` routes remain

### For Phase 3

- provider composer renders one ordered list
- provider middleware reorder and save round-trips correctly
- no grouped provider binding payload remains

### For Phase 4

- extension loader tests only cover the canonical directories you choose to
  keep
- loading real sample extensions through the new directories works

### For Phase 5

- no `wrapper` kind remains in runtime contracts
- no `provider hook` terminology remains in active runtime APIs
- current-behavior docs are fully updated

### Final acceptance checks

Run at the end:

- `npm run test:unit`
- `npm test`
- a grep audit for:
  - `executorCatalog`
  - `getExecutor(`
  - `/management/executors`
  - `/management/provider-hooks`
  - `wrapper`
  - `providerHook`

Expected outcome:

- only intentional historical references remain in migration notes or archived
  plan documents

## Risks and decisions

### Risk 1 — Over-cleaning product compatibility surfaces

Do not remove:

- `/v1/tiers`
- `/management/tiers`
- dashboard `Tiers` page

Those are intentional compatibility/product surfaces, not architectural debt.

### Risk 2 — Extension ecosystem breakage

If any real deployment still depends on old extension directories or wrapper
manifests, removing them abruptly will break local/operator workflows.

Mitigation:

- inventory actual extension usage before deleting loader support
- if needed, do a short-lived canonical-path migration branch first

### Risk 3 — Dashboard/UI regressions during API rename

Mitigation:

- update the UI and router in the same slice
- verify provider composer end to end before removing old routes

### Risk 4 — Incomplete terminology cleanup

The worst outcome is partial renaming that leaves the codebase even more
confusing.

Mitigation:

- do each workstream to completion
- after each phase, run a grep-based terminology audit

## Definition of done

This cleanup is done when all of the following are true:

- transport is the only execution terminology in active runtime code
- provider middleware is the only provider wrapping terminology in active code
- the dashboard provider composer uses one ordered middleware list
- old compatibility endpoints for executors/provider-hooks are gone
- wrapper compatibility is removed from active runtime contracts
- extension discovery uses only the canonical directory model you choose to keep
- tests and specs describe the post-cleanup architecture accurately
- only intentional tier compatibility remains as a legacy surface
