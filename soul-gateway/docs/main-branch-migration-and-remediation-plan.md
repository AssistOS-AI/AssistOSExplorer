# Soul Gateway — Main-Branch Migration And Remediation Plan

## Purpose

This plan addresses the findings from the April 8 review of the middleware-first refactor.

The key correction is this:

- The source of truth for data migration is **`main` branch Soul Gateway**, not the intermediate schema on the current branch.
- The `main` branch implementation lives under `soul-gateway/app/`.
- Its schema is materially different from the current runtime schema under `soul-gateway/src/`.

This document therefore focuses on:

1. migrating data from `main` branch schema into the new runtime schema
2. correcting stale current-state specs
3. cleaning up contradictory planning documents
4. proving the migration and the runtime with deterministic verification

This document is intentionally outside `soul-gateway/docs/specs/` because it is a forward-looking execution plan, not a current-behavior spec.

## Status (2026-04-08)

All workstreams in this plan are now implemented:

- target-schema vs historical-import split
- dedicated `main`-branch importer
- source-to-target mappings for providers, API keys, direct models, cascade models, and model middleware bindings
- current-state spec cleanup
- contradictory plan cleanup
- fixture-based importer verification, dry-run/strict verification, idempotent re-import verification, and parity checks against imported cascade semantics
- optional historical `call_logs` -> `audit_logs` migration, including derived closed `sessions` rows for imported history

## Review findings this plan addresses

### Finding 1 — No migration path from `main` branch data

The current migration `src/db/migrations/004-unified-model-bindings.sql` assumes the source schema is the intermediate v2 schema (`tiers`, `tier_models`, `middleware_assignments`, `provider_hook_assignments`) and explicitly says there is no backfill step.

That does not solve the real migration problem.

The actual source schema on `main` is the older app schema under `soul-gateway/app/src/db/schema.sql`, whose core entities are:

- `provider_configs`
- `model_configs`
- `model_middlewares`
- `call_logs`
- legacy `api_keys` format with a single encrypted blob column

### Finding 2 — Most runtime architecture gaps are already closed

The runtime itself has largely crossed the line:

- hot path uses `middleware_bindings`
- provider scope uses `ProviderMiddlewareRegistry`
- route-level SSE is implemented
- `/v1/tiers` and `/management/tiers` are compatibility views over cascade models
- full test suite passes

This means the remaining work is not “finish the architecture from scratch”; it is:

- migrate real source data from `main`
- bring docs into line with the already-shipped runtime
- clean up planning artifacts

### Finding 3 — Current-behavior specs are stale

Several current-behavior docs still describe removed persistence and runtime paths:

- `ProviderHookCatalog`
- `provider_hook_assignments`
- `middleware_assignments`
- synthesized tiers
- old provider-chain composition
- old DB schema

### Finding 4 — The gap-closure plan contradicts itself

`soul-gateway/docs/middleware-refactor-gap-closure-plan.md` says all workstreams are shipped, but still contains the old “Current gaps to close” body as if the work were pending.

### Finding 5 — Verification is now good, but migration verification is missing

`npm test` is green. What is still missing is proof that `main` branch data can be imported correctly into the new runtime model.

## Core decision

Do **not** treat `004-unified-model-bindings.sql` as the complete migration from the old production system.

Instead split the problem into two distinct steps:

1. **Target schema setup** — make sure the new schema exists and is correct.
2. **Source-data import from `main` branch schema** — implement a dedicated importer / backfill tool from `soul-gateway/app/` tables into the new schema.

This should be an application-level migration, not just a destructive SQL migration, because:

- the source schema is different
- encryption formats differ
- field semantics differ
- some transforms require business logic, not simple SQL renames

## Workstream A — Replace the current migration strategy

### A1. Reframe `004-unified-model-bindings.sql`

Current problem:

- It assumes the wrong source schema.
- It drops legacy tables without preserving real `main` data.

Plan:

- Rewrite the intent of `004-unified-model-bindings.sql` so it is only responsible for establishing the **target** schema shape:
  - `models.strategy_kind`
  - `models.max_attempts`
  - `model_children`
  - `middleware_bindings`
- Remove the assumption that the source database is empty or disposable.
- Remove or rewrite the “no backfill step” commentary.
- Do not rely on this SQL file alone to migrate existing production data from `main`.

Acceptance criteria:

- The SQL migration is safe to run as target-schema DDL.
- No comments imply that `main` branch data can be discarded.

### A2. Introduce a dedicated import/backfill tool

Add a dedicated importer outside the migration SQL, for example:

- `soul-gateway/src/db/import/import-main-branch-data.mjs`
- or `soul-gateway/scripts/import-main-branch-data.mjs`

Responsibilities:

- connect to the **source** database that still has the `main` branch schema
- connect to the **target** database using the new schema
- extract, transform, and load data deterministically
- emit an import report with row counts, warnings, and unresolved references
- support dry-run mode
- support idempotent re-runs where possible

Suggested inputs:

- `SOURCE_DATABASE_URL`
- `SOURCE_ENCRYPTION_KEY` or `SOURCE_ENCRYPTION_KEY_HEX`
- `TARGET_DATABASE_URL`
- `TARGET_ENCRYPTION_KEY`
- `TARGET_API_KEY_HASH_PEPPER`

Acceptance criteria:

- Data migration logic is explicit, testable, and independent from the target DDL.

## Workstream B — Define and implement source-to-target mappings

This is the most important part of the plan.

## B1. Providers: `provider_configs` -> `providers` + `provider_accounts`

### Source

`main` branch provider data:

- table: `provider_configs`
- fields include:
  - `name`
  - `display_name`
  - `protocol`
  - `base_url`
  - `encrypted_api_key`
  - `billing_type`
  - `auth_type`
  - `is_enabled`

### Target

Current runtime splits this into:

- `providers`
- `provider_accounts`

### Plan

For each `provider_configs` row:

1. Create or upsert one `providers` row.
2. Derive:
   - `provider_key` from `name`
   - `display_name` from `display_name || name`
   - `adapter_key` from provider template resolution
   - `kind` from protocol/template classification
   - `auth_strategy` from old `auth_type`
   - `base_url` from source row
   - `enabled` from `is_enabled`
3. If `encrypted_api_key` is present:
   - decrypt using the **old** crypto scheme from `main`
   - re-encrypt using the **new** provider account secret format
   - create one active `provider_accounts` row
   - set a deterministic imported label such as `Imported API Key`

### Important implementation detail

The source encryption format is not the same shape as the target:

- `main` stores a single AES-GCM blob in one column
- current runtime stores ciphertext, IV, and auth tag separately

This requires application-level decrypt + re-encrypt.

### Edge cases

- managed / OAuth providers with no API key
- providers whose `name` no longer matches the canonical provider template key
- providers whose `protocol` must now map to a shared adapter (`openai-api`, `anthropic-api`, `search-builtin`, etc.)

### Acceptance criteria

- Every source provider imports into exactly one target provider row.
- Every source API-key-backed provider becomes one target provider account row.
- Imported providers resolve through current runtime transport lookup.

## B2. Client API keys: old `api_keys` -> new `api_keys`

### Source

`main` branch `api_keys` stores:

- `key_hash` as text
- `encrypted_key` as one encrypted blob
- budget / rate-limit fields
- revoke / expiry fields

### Target

Current runtime `api_keys` stores:

- HMAC hash as `bytea`
- encrypted key split into ciphertext / IV / auth tag
- `status`
- metadata

### Plan

For each source key row:

1. Decrypt `encrypted_key` using old crypto.
2. Re-hash plaintext using the current hash routine and target pepper.
3. Re-encrypt plaintext with the new crypto format.
4. Map status:
   - `is_revoked=true` -> `status='revoked'`
   - otherwise `status='active'`
5. Copy:
   - label
   - key hint
   - rpm/tpm
   - daily/monthly budgets
   - expiry
   - last used

### Acceptance criteria

- Imported keys authenticate successfully against the new runtime.
- Revoked/expired states are preserved.

## B3. Direct models: `model_configs(type='model')` -> `models(strategy_kind='direct')`

### Source

Direct models on `main` live in `model_configs` with `type='model'`.

Key fields:

- `name`
- `display_name`
- `provider_key`
- `provider_model`
- `provider_config_id`
- `upstream_source`
- `input_price`
- `output_price`
- `pricing_type`
- `request_cost`
- `is_free`
- `is_enabled`
- `max_concurrency`
- `sort_order`
- `context_window`
- `tags`

### Target

Current runtime direct models live in `models` with:

- `strategy_kind='direct'`
- `provider_id`
- `provider_model_id`
- pricing / concurrency / metadata fields

### Plan

For each source direct model:

1. Resolve the imported target provider row using:
   - `provider_config_id` first when present
   - otherwise `provider_key`
2. Create or upsert a target `models` row:
   - `model_key = name`
   - `display_name = display_name || name`
   - `strategy_kind = 'direct'`
   - `provider_id = resolved provider id`
   - `provider_model_id = provider_model || name`
   - `enabled = is_enabled`
   - `concurrency_limit = max_concurrency`
   - `pricing_mode` mapped from `pricing_type`
   - `input_price_per_million` / `output_price_per_million`
   - `request_price_usd = request_cost`
   - `tags`
   - move old fields like `mode`, `sort_order`, `context_window`, `upstream_source` into `metadata` when there is no first-class target field

### Acceptance criteria

- All direct model names from `main` resolve in the new runtime.
- Pricing and concurrency settings survive migration.

## B4. Tiers: `model_configs(type='tier')` -> `models(strategy_kind='cascade')`

### Source

Tiers on `main` are also stored in `model_configs`, with:

- `type='tier'`
- `name`
- `display_name`
- `model_refs`
- `fallback_model`
- `sort_order`
- `is_enabled`

### Target

Tiers are now compatibility views over cascade models:

- `models(strategy_kind='cascade')`
- `model_children`

### Plan

For each source tier row:

1. Create or upsert one target `models` row:
   - `model_key = name`
   - `display_name = display_name || name`
   - `strategy_kind = 'cascade'`
   - `enabled = is_enabled`
   - `provider_id = NULL`
   - `provider_model_id = NULL`
   - store old presentation fields like `sort_order` in metadata if needed
2. Convert `model_refs` into `model_children` rows:
   - preserve order
   - resolve each referenced source model/tier name to imported target model id
3. Convert `fallback_model` into one final `model_children` row pointing at the imported fallback target.

### Important design choice

Do **not** flatten fallback tiers into one list during import unless there is a strong reason to do so.

Preferred mapping:

- local `model_refs` remain the direct children of the cascade model
- `fallback_model` becomes one trailing child entry
- if that child is itself a cascade model, nested cascade dispatch preserves old behavior naturally

This is a better match to the `main` branch semantics than destructive flattening.

### Edge cases

- fallback target missing
- self-reference
- fallback cycle between tiers
- `model_refs` containing names no longer present

### Acceptance criteria

- `/v1/tiers` and `/management/tiers` show the imported tiers.
- Requests addressed to imported tier names dispatch correctly.
- Fallback behavior matches `main` branch semantics.

## B5. Middleware catalog: old `middlewares` -> new `middlewares`

### Source

`main` branch middleware catalog rows use:

- `name`
- `file_name`
- `type`
- `supports_streaming`
- `default_settings`

### Target

Current runtime middleware catalog rows use:

- `middleware_key`
- `display_name`
- `hook_mode`
- `module_path`
- `source_type`
- `default_settings`

### Plan

Do not trust raw row shape compatibility.

Instead:

1. Rescan and load the **current** middleware catalog from code first.
2. Build an explicit compatibility map from `main.middlewares.name` to current `middleware_key`.
3. For any exact matches, bind directly.
4. For renamed modules, use a hard-coded alias table.
5. For unknown middleware names:
   - record them in the import report
   - skip the binding
   - fail the import only if configured in strict mode

### Acceptance criteria

- Every importable source middleware name resolves to a current middleware key.
- Unknown names are visible in the report rather than silently lost.

## B6. Model middleware bindings: `model_middlewares` -> `middleware_bindings(scope='model')`

### Source

`main` branch uses one table:

- `model_middlewares`

This applies both to direct models and to tiers because tiers are also `model_configs`.

### Target

Current runtime uses:

- `middleware_bindings(scope='model', target_id=<model id>)`

### Plan

For each source `model_middlewares` row:

1. Resolve the imported target model id from the source `model_config_id`.
2. Resolve the target `middleware_key` using the compatibility map from B5.
3. Insert or upsert one `middleware_bindings` row:
   - `scope='model'`
   - `target_id=<imported model id>`
   - `middleware_key=<resolved key>`
   - `sort_order`
   - `enabled`
   - `settings`

This preserves tier middleware automatically because imported tiers are cascade models.

### Acceptance criteria

- Imported model/tier middleware bindings appear in management APIs and affect runtime behavior.

## B7. Optional historical observability migration: `call_logs` -> `audit_logs`

This is optional and should be decided explicitly.

### Decision point

Choose one:

1. **Do not migrate historical logs**
2. **Migrate historical logs best-effort**

### If migrating

Create a separate import phase for:

- `call_logs` -> `audit_logs`

Map:

- request/response content
- model fields
- latency / token / cost fields
- status and error fields
- timestamps

### Recommendation

Treat this as a separate, optional importer step.

It should not block the core cutover of providers, API keys, models, tiers, and middleware bindings.

## Workstream C — Make the import safe and repeatable

### C1. Prefer side-by-side migration over in-place mutation

Recommended cutover strategy:

1. Keep the `main` branch database untouched.
2. Stand up a fresh target database with the new runtime schema.
3. Run the import tool from source DB -> target DB.
4. Validate the imported data.
5. Cut traffic over only after validation passes.

Avoid in-place destructive mutation of the old database.

### C2. Add dry-run mode

Dry-run must:

- read source rows
- build mappings
- emit counts and warnings
- not write target rows

### C3. Add idempotent import semantics

Where possible:

- use source-id mapping tables
- or stable upsert keys (`provider_key`, `model_key`, alias, etc.)
- make re-runs converge instead of duplicating rows

### C4. Emit a human-readable import report

Include:

- providers imported
- provider accounts created
- API keys imported
- direct models imported
- cascade models imported
- model children created
- middleware bindings imported
- skipped / unresolved items
- warnings that need operator review

## Workstream D — Clean up stale current-state specs

The runtime has moved further than the specs.

### D1. Rewrite the abstraction summary docs

Update:

- `soul-gateway/docs/specs/README.md`
- `soul-gateway/docs/specs/DS001-request-pipeline.md`
- `soul-gateway/docs/specs/DS003-middleware-framework.md`

Required changes:

- remove references to `ProviderHookCatalog`
- remove references to `provider_hook_assignments`
- remove references to split `middleware_assignments`
- describe the provider chain using:
  - `ProviderMiddlewareRegistry`
  - `middleware_bindings`
  - `transportCatalog`
- describe route streaming as shipped
- explain that `executorCatalog` is only a compatibility alias when mentioned at all

### D2. Rewrite the routing and schema docs

Update:

- `soul-gateway/docs/specs/DS004-model-routing.md`
- `soul-gateway/docs/specs/DS006-database-schema.md`

Required changes:

- remove statements that tiers are still persisted as first-class runtime tables
- document:
  - `models.strategy_kind`
  - `model_children`
  - `middleware_bindings`
- explain the dashboard `Tiers` page as a compatibility view over cascade models

### D3. Sweep API/config docs for stale table names

Update at minimum:

- `soul-gateway/docs/specs/DS012-api-reference.md`
- `soul-gateway/docs/specs/DS013-configuration-deployment.md`
- `soul-gateway/docs/specs/DS014-built-in-middlewares.md`

Search and remove stale references to:

- `tiers` as a backing table
- `provider_hook_assignments`
- `middleware_assignments`
- “hook module” language where the code now uses native middleware modules

### D4. Add a doc-audit pass before marking the work complete

Run a grep audit for these strings across `soul-gateway/docs/specs/`:

- `ProviderHookCatalog`
- `provider_hook_assignments`
- `middleware_assignments`
- `snapshot.tiers`
- `synthesized cascade`
- `compileProviderHookPipeline`

Each remaining occurrence must be either:

- corrected, or
- intentionally retained with explicit compatibility wording

## Workstream E — Fix the contradictory plan documents

### E1. Convert `middleware-refactor-gap-closure-plan.md` into a historical summary

Current problem:

- it says the work is shipped
- it still contains the old “Current gaps to close” body

Plan:

- rewrite it into a concise completed-history document
- remove the stale pending-work sections
- link to this new plan for remaining work

### E2. Keep future-state plans separate from specs

Maintain the current rule:

- `soul-gateway/docs/specs/` = current behavior only
- `soul-gateway/docs/*.md` outside `specs/` = migration and planning docs

## Workstream F — Verification and acceptance

### F1. Add migration fixture tests based on `main`

Create fixture-based tests that model actual `main` branch rows for:

- `provider_configs`
- `api_keys`
- `model_configs` direct
- `model_configs` tier
- `model_middlewares`

Test:

- transformation logic
- imported target row shapes
- fallback tier preservation
- middleware binding preservation

### F2. Add end-to-end import smoke test

Create a migration smoke test that:

1. seeds a temporary source DB with representative `main` schema rows
2. runs the importer
3. boots the new runtime against the target DB
4. verifies:
   - imported providers appear
   - imported models resolve
   - imported tiers list correctly
   - imported middleware bindings affect dispatch

### F3. Add parity checks against source semantics

For a curated fixture set:

- compare `main` tier listing output with new `/management/tiers`
- compare `main` middleware assignments with new management output
- compare model resolution behavior for direct and tier names

### F4. Keep the existing full suite green

Required final checks:

- `npm test`
- migration fixture tests
- import smoke test

## Recommended execution order

### Phase 1 — Unblock the real migration path

1. Rewrite the intent of `004-unified-model-bindings.sql`
2. Add the dedicated importer skeleton
3. Implement source readers for `main` schema

### Phase 2 — Migrate critical configuration data

1. Providers + provider accounts
2. API keys
3. Direct models
4. Tiers -> cascade models
5. Model middleware bindings

### Phase 3 — Prove parity

1. Fixture tests
2. Smoke test
3. Operator-facing import report

### Phase 4 — Bring docs current

1. README / DS001 / DS003
2. DS004 / DS006
3. DS012 / DS013 / DS014
4. grep audit

### Phase 5 — Clean up planning docs

1. Rewrite the contradictory gap-closure plan
2. Keep this document as the active remaining-work plan until migration is complete

## Acceptance checklist

The findings are fully addressed only when all of the following are true:

- the target schema no longer assumes the wrong source schema
- there is a real importer from `main` branch Soul Gateway data
- source `provider_configs` become working target providers / accounts
- source API keys authenticate in the new runtime after import
- source direct models become direct target models
- source tiers become cascade models backing both routing and the dashboard `Tiers` page
- source `model_middlewares` become target `middleware_bindings`
- the import is dry-runnable, repeatable, and reported
- current-state specs match the code that is actually shipping now
- the contradictory plan doc is cleaned up
- runtime tests and migration tests are green

## Immediate next slice

The highest-value first slice is:

1. rewrite `004-unified-model-bindings.sql` comments and intent so it stops pretending it handles source migration
2. add the dedicated `main`-schema importer skeleton
3. implement provider, API key, model, tier, and model-middleware mappings
4. update the stale specs only after those mappings are in place and tested

That sequence addresses the biggest unresolved risk first: preserving real data from the existing `main` branch deployment.
