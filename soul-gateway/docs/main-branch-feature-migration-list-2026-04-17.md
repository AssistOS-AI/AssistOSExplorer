# Soul Gateway Main-Branch Feature Migration List — 2026-04-17

Supersedes `main-branch-feature-migration-list-2026-04-15.md`. The
earlier list has largely been executed; this revision records what has
landed on `soul-gateway-v2-src` since then and narrows the remaining
work to the items that are still concrete and architecturally sound.

Scope references unchanged from the prior revision:

- old-reference checkout: `/Users/danielsava/work/file-parser/proxies-main-branch`
- old-reference branch: `main`
- old-reference commit used for this comparison: `05da1f7b46e04e62acee8d16590746fb775a4f0f`
- live product reference for that branch family: `https://soul.axiologic.dev`
- current implementation under evaluation: `/Users/danielsava/work/file-parser/proxies/soul-gateway`
- current-branch tip at this revision: `bc98d20` on `soul-gateway-v2-src`

## Migration rule (unchanged)

Port product behavior, not old implementation structure.

- Keep the current middleware-first runtime and current schema / management model.
- Do not restore `app/src/`-style legacy APIs just to regain UI behavior.
- Re-express old features through the current `src/` routes, snapshot model, pricing directory, provider auto-provisioning, and dashboard.

## Status since 2026-04-15

The vast majority of the prior list is **done**. The pricing /
metadata / tag / free-model enrichment workstream is no longer in
flight — it has landed on `soul-gateway-v2-src` and is visible through
the runtime and the dashboard.

### Completed (previously P0 / P1 / P2)

| Prior item | Landing place on `soul-gateway-v2-src` |
|---|---|
| P0 Broader pricing / context / tag coverage for auto-seeded models | `enrichModelMetadata()` in `src/runtime/policy/model-metadata-classifier.mjs` + `src/runtime/policy/pricing-directory.mjs` + `enrichDiscoveryDescriptors()` / `enrichStoredModelRows()` in `src/runtime/providers/auto-provisioner.mjs` |
| P0 Curated model-tag taxonomy + automatic tag seeding | `PREDEFINED_MODEL_TAGS` and the family-rule classifier in `src/runtime/policy/model-metadata-classifier.mjs` |
| P0 Free-model classification parity | `CURATED_FREE_PROVIDER_KEYS` + per-model overrides in `src/runtime/policy/curated-model-metadata.mjs`, fed through `enrichModelMetadata()` |
| P1 Rich `/v1/models` metadata | Additive `_pricing` / `_context` / `_tags` / `_is_free` / `_billing_types` fields in `src/public-api/register-routes.mjs` (`decorateDirectModel`, `summarizeCascadeChildren`) |
| P1 Models-page search parity | `filteredModels` in `src/dashboard/js/app.mjs` now matches `model_key`, `provider_key`, and `tags` |
| P1 Stable tag-filter chips when DB is sparse | `handleListModelTags` in `src/management/models-route.mjs` returns `PREDEFINED_MODEL_TAGS ∪ stored tags` |
| P1 Better provider-discovery metadata before fallback | `discoverModels()` in `src/runtime/backends/builtin/openai-api.backend.mjs` preserves provider-supplied pricing / context / capability tags; directory fallback runs only where provider data is missing |
| P2 Tier billing summaries in public and management views | Cascade entries in `/v1/models` carry `_billing_types` and `_is_free` derived from enabled children |

### Previously-flagged gaps that are no longer gaps

- All eight search engines (Tavily, Brave, Exa, Serper, Jina, DuckDuckGo, SearXNG, Gemini grounding) are consolidated into one `src/runtime/backends/builtin/search-builtin.backend.mjs` dispatcher backend surfaced through provider presets.
- `ws/soul-stream.mjs`, `api/agents.mjs`, and `api/system-metrics.mjs` are all re-expressed in the current branch: `/ws/logs/soul/:soulId`, `/management/agents/tree` + `/management/sessions[/:id[/logs]]`, and `/management/metrics/system` respectively.
- `pipeline/stream-tap.mjs` is superseded architecturally by `runtime/route/canonical-stream-to-sse.mjs` plus backend terminal late-stream classification (`classifyBackendStream`) — no migration needed.
- All twelve main-branch middleware families (`blacklist-scanner`, `budget-enforcer`, `cache`, `context-compressor`, `loop-detector`, `output-compressor`, `rate-limiter`, `request-logger`, `response-filter`, `session-context`, `system-prompt-injector`, `tpm-tracker`) are present in `src/runtime/middleware/builtin/` (some renamed: `cache` → `response-cache`, `tpm-tracker` → `token-tracker`, `blacklist-scanner` → `content-blocker`).

## Remaining migration candidates

Only three items from the 2026-04-15 list remain, and one new item
has been added after auditing the runtime end-to-end.

### 1. P0 — Close the model-cooldown loop (new this revision)

**Current state on `soul-gateway-v2-src`:**

- the `model_cooldowns` table exists (`src/db/dao/cooldowns-dao.mjs` has `create()`, `deleteExpired()`, `list()`)
- the snapshot loader reads active cooldowns into `snapshot.cooldowns` (a `Set<modelKey>`) — see `src/runtime/registry/snapshot-loader.mjs:150-152`
- the background scheduler cleans up expired rows every 60 s — see `src/background/scheduler.mjs:34-38`
- the cascade middleware exposes an `onCooldown(modelKey, err)` hook when an attempt fails with `err.cooldown === true`
- a management UI for cooldowns exists under `src/management/cooldowns-route.mjs`

**Where the loop is broken:**

- `src/runtime/route/gateway-dispatch.mjs:54-59` installs `ctx.metadata.onCooldown` as a **log-only** callback. It never calls `cooldownsDao.create()`.
- `snapshot.cooldowns` is read **zero** times anywhere in the runtime. The resolve-model middleware and the cascade middleware both ignore it. There is no code that skips a model because it is currently cooled down.

**What "migration" means here:**

1. replace the log-only `onCooldown` in `gateway-dispatch.mjs` with a persistent writer that calls `cooldownsDao.create()` against the correct `modelId`, records `reasonType` / `reasonMessage` / `expiresAt` from the triggering `GatewayError`, and emits the log line as before.
2. teach `cascade-middleware.mjs` to treat a `snapshot.cooldowns`-hit child as an immediate "skip, try next" without counting an attempt (matches the spirit of main-branch's `isModelInCooldown`).
3. optionally teach `resolve-model` to fail a request when the resolved direct model is in `snapshot.cooldowns` with a typed `GatewayError` — but only if product wants that behavior for non-cascade calls. Main-branch did not uniformly enforce this.
4. after a successful cooldown write, request a `snapshot: true` runtime refresh through the existing refresh service so the next request sees the new `snapshot.cooldowns` set.
5. wire tests: a cascade over two children where the first one throws a cooldown error should put the first into `model_cooldowns`, should succeed on the second, and a subsequent cascade request should bypass the cooled-down child without attempting it.

**Architectural fit:** clean. All work happens inside existing kernel middleware (`gateway-dispatch`, `cascade-middleware`), an existing DAO, and the existing refresh service. No new abstractions.

**Spec impact:** DS004 (model routing) and DS009 (error handling) both need an updated paragraph describing the write side and the read side of the cooldown loop.

### 2. P2 — `axl/search` auto-maintenance (carried over)

**Current state:** the search backend dispatcher exists, and multiple
search engines are wired as OpenAI-compatible providers, but the
product-level `axl/search` cascade tier from the old branch is not
auto-maintained when a new search provider is added or removed.

**Migration notes:** only bring this back if `search` is still a
supported product concept in the current branch. Express it as a
management-side rule that keeps the cascade children of the `axl/search`
`models(strategy_kind='cascade')` row in sync with the enabled search
providers. Do not introduce a runtime abstraction for it — it is
configuration maintenance, not request-time behavior.

**Architectural fit:** clean if implemented at the management /
scheduler layer. Do not reintroduce a separate "search tier registry"
runtime object.

### 3. P3 — Curated provider↔OpenRouter alias map (carried over)

**Current state:** the pricing directory matches by exact id, canonical
slug, display name, and unique leaf slug. NVIDIA rows in particular
still carry no pricing / context / tags when none of these match
(see `debug-handoff-2026-04-15.md` for examples).

**Migration notes:** add a small curated alias table between provider
`modelKey` / `providerModelId` strings and the OpenRouter canonical id.
Keep it in the classifier layer so it applies uniformly to discovery,
management list responses, and request-time cost calculation. Do not
widen the matching heuristics into fuzzy search — the intentional
conservatism is correct product behavior.

**Architectural fit:** clean. It is a pure data addition inside
`src/runtime/policy/` with one callsite in `enrichModelMetadata()`.

## Not migration candidates

These items from the old branch should *not* be brought back:

- **In-memory cooldown store** (old `pipeline/model-cooldown.mjs`). The
  DB-backed `model_cooldowns` table plus `snapshot.cooldowns` is the
  right replacement — see migration candidate #1.
- **`pipeline/middleware-runner.mjs` style stage machine**. Replaced
  by kernel `compose()` + `ctx.abort` semantics. DS003 forbids
  reintroducing executor / runner / stage abstractions on the request
  path.
- **`app/src/api/router.mjs`**. Replaced by the current `createRouter()`
  in core routing.
- **`pipeline/llm-client.mjs`**. Replaced by the backend terminal
  contract in `backend-interface.mjs` + `backend-terminal.mjs`. Do not
  reintroduce a separate LLM client layer.
- **`providers/format-converters/*`**. Replaced by
  `runtime/backends/converters/*` inside the backend modules.

## Suggested work order

1. Land **item #1 (cooldown loop)** first. It fixes a real runtime
   correctness gap (cooldown-emitting errors are silent) and unblocks
   `DS004` / `DS009` spec updates.
2. Decide **item #2 (search tier)** on product grounds. If the answer
   is "yes we still want `axl/search` as a first-class product concept",
   implement it as a small management-side maintainer; if no, delete
   the note.
3. Land **item #3 (alias map)** last. It is incremental coverage, not
   a correctness gap. Collect real misses from deployed NVIDIA rows
   first, then encode them as data.

## Files to inspect first in a follow-up session

Current branch:

- `src/runtime/route/gateway-dispatch.mjs` — where `onCooldown` is installed today (log-only)
- `src/runtime/execution/cascade-middleware.mjs` — consumer of the cooldown hook; first place to add `snapshot.cooldowns` skip behavior
- `src/runtime/execution/model-execution.mjs` — forwards `onCooldown` from ctx.metadata into cascade options
- `src/db/dao/cooldowns-dao.mjs` — the write path the hook should call
- `src/runtime/registry/snapshot-loader.mjs` — already exposes `snapshot.cooldowns`
- `src/runtime/registry/runtime-refresh.mjs` — triggers a refresh after a cooldown write so the next request sees it
- `src/management/cooldowns-route.mjs` — already present for admin visibility
- `src/background/scheduler.mjs` — already expires old cooldowns
- `src/runtime/policy/model-metadata-classifier.mjs` — target for the alias-map addition (#3)
- `src/management/tiers-route.mjs` — target for the `axl/search` maintainer (#2)

Old branch (reference only):

- `app/src/pipeline/model-cooldown.mjs` — the in-memory cooldown semantics to mirror in DB form
- `app/src/api/providers.mjs` — the old `axl/search` auto-maintenance logic
