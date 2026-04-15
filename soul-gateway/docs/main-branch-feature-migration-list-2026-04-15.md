# Soul Gateway Main-Branch Feature Migration List — 2026-04-15

This document inventories product behaviors from the default branch of `proxies` that can be migrated into the current `soul-gateway-v2-src` implementation.

Scope:

- old-reference checkout: `/Users/danielsava/work/file-parser/proxies-main-branch`
- old-reference branch: `main`
- old-reference commit used for this comparison: `05da1f7b46e04e62acee8d16590746fb775a4f0f`
- live product reference for that branch family: `https://soul.axiologic.dev`
- current implementation under evaluation: `/Users/danielsava/work/file-parser/proxies/soul-gateway`

This is a migration inventory, not a spec. It should be used to guide parity work without reintroducing the old branch architecture or compatibility shims.

## Migration rule

Port product behavior, not old implementation structure.

- Keep the current middleware-first runtime and current schema / management model.
- Do not restore `app/src/`-style legacy APIs just to regain UI behavior.
- Re-express old features through the current `src/` routes, snapshot model, pricing directory, provider auto-provisioning, and dashboard.

## Recommended migration targets

| Priority | Feature | Old-branch evidence | Current status | Migration notes |
|---|---|---|---|---|
| P0 | Broader pricing / context / tag coverage for auto-seeded provider models | `app/src/api/models.mjs`, `app/src/pipeline/openrouter-pricing.mjs`, `app/src/public/index.html` | Partial | The current branch already overlays missing metadata from the shared pricing directory, but many NVIDIA rows still stay unresolved because lookup is intentionally conservative. Add provider-specific normalization and an alias map for known mismatches so more auto-seeded rows resolve to OpenRouter metadata. |
| P0 | Curated model-tag taxonomy plus automatic tag seeding | `app/src/utils/model-naming.mjs`, `app/src/db/init.mjs` | Missing | The old branch had a stable predefined tag list and a large rule set that auto-tagged model families (`codex`, `gemini`, `llama`, `vision`, `embeddings`, `writer`, etc.) plus provider-based `tool-calling` enrichment. The current branch mostly relies on provider/OpenRouter metadata and only derives a narrow set of tags. Port the curated tag vocabulary and heuristic tag assignment as a shared helper used by import, auto-provision, resync, and management overlays. |
| P0 | Free-model classification parity | `app/src/api/models.mjs`, `app/src/db/init.mjs`, `app/src/db/keys-dao.mjs`, `app/src/pipeline/cost-throttler.mjs` | Partial | The old branch treated `is_free` as a first-class catalog and budget concept. The current branch already has `pricingMode`, `requestPriceUsd`, `isFree`, and UI free filters, but many rows still fail to classify because metadata enrichment is incomplete. Improve enrichment coverage first, then verify `is_free` survives auto-provision, management list responses, and request-time cost/budget accounting. |
| P1 | Rich `/v1/models` metadata | `app/src/api/models.mjs` | Missing | The old branch exposed extra fields on `/v1/models`: `mode`, `input_price`, `output_price`, `context_window`, `sort_order`, `is_free`, `billing_type`, `tags`, and tier metadata such as `billing_types`. The current branch returns only minimal OpenAI-compatible list entries from `src/public-api/register-routes.mjs`. Extend the current route with non-breaking extra fields sourced from the snapshot / enriched catalog. |
| P1 | Models-page search parity | `app/src/public/js/app.mjs` | Partial | The old models page searched by model name, provider key, and tag text. The current models page only searches `model_key` and `provider_key`. Add tag and display-name search to the current `modelsPage.filteredModels` logic. |
| P1 | Stable tag-filter chips even when the DB is sparse | `app/src/api/models.mjs`, `app/src/utils/model-naming.mjs` | Missing | The old branch served `PREDEFINED_TAGS` from the API, so the dashboard had a stable filter vocabulary even before tags were present on rows. The current `/management/models/tags` only returns distinct tags already stored in the DB. Change the route to return a merged set: predefined taxonomy plus observed DB tags. |
| P1 | Better provider-discovery metadata before fallback | `app/src/api/providers.mjs` | Partial | The old provider discovery path copied upstream pricing when it existed. The current branch now preserves provider metadata first and only falls back to OpenRouter when fields are missing. Keep that precedence, but expand provider-specific parsing so discovery returns more context/pricing/tag data directly from upstream before OpenRouter is consulted. |
| P2 | Search / retrieval tier auto-maintenance | `app/src/api/providers.mjs` | Missing | The old branch updated `axl/search` automatically when syncing search providers. The current branch has tiers as cascade models but no equivalent auto-maintained search tier behavior. Only bring this back if `search` remains a supported product concept in the new branch. |
| P2 | Tier billing summaries in public and management views | `app/src/api/models.mjs` | Missing | The old branch computed `billing_types` and `is_free` for tiers from their member models. If the new branch keeps tiers as a first-class UI concept, this derived billing summary should be reintroduced on the current tier-management and `/v1/models` views. |

## Important old-branch details worth porting directly

### 1. Tag seeding heuristics

The old branch had explicit model-family tagging rules in `app/src/db/init.mjs`. Those rules covered:

- coding families: `codex`, `codestral`, `codegemma`, `starcoder`, `coder`
- reasoning families: `opus`, `deepseek`, `grok`, `glm`, `thinker`
- fast/chat families: `haiku`, `gpt-4o`, `gemini flash`, `gemma`, `phi`, `zamba`
- long-context families: `opus`, `gemini pro`, `jamba`, `32k`
- multimodal / vision families: `vision`, `vlm`, `llava`, `paligemma`, `fuyu`, `neva`
- embeddings / retrieval families: `embed`, `e5`, `bge`, `rerank`
- domain families: `palmyra-fin`, `palmyra-med`, `writer`
- multilingual families: `qwen`, `yi`, `eurollm`, `swallow`, `sea-lion`

These rules explain why the old models page had richer chips than the current branch even when upstream metadata was thin.

### 2. Tool-calling tag augmentation

The old branch appended `tool-calling` to models from known tool-capable providers in `app/src/db/init.mjs`.

That behavior should move into a current helper that runs during:

- model import from `main`
- provider auto-provision / resync
- management overlay enrichment for legacy rows

### 3. OpenRouter was only one layer of enrichment

The old branch used OpenRouter pricing fallback in two places:

- management list path: `app/src/api/models.mjs`
- request-time resolution path: `app/src/pipeline/model-router.mjs`

But the old richness did not come only from OpenRouter. It also came from:

- stored `is_free`
- stored `context_window`
- stored `tags`
- provider `billing_type`
- seeded tag rules

The current branch should follow the same overall model:

- use provider metadata first
- use directory fallback second
- use curated classification third when metadata is still too thin

## Concrete migration tasks

1. Introduce a shared `model-tag-classifier` helper in `src/` that ports the old `seedModelTags()` family rules into the current architecture.
2. Change `/management/models/tags` to return `predefined taxonomy ∪ stored tags`, not only stored tags.
3. Expand `PricingDirectory.lookup()` matching with provider-aware aliases for known NVIDIA, Codex, and other model-id mismatches.
4. Apply the same alias logic in both auto-provision sync and management overlay enrichment so stored rows and discovery rows behave consistently.
5. Extend the public `/v1/models` route to emit the extra fields that old clients and dashboards expected.
6. Update the current models-page search to match tags and display names, not just `model_key` and `provider_key`.
7. Re-evaluate tier summaries after the direct-model metadata work lands; restore tier-level `billing_types` only if the current tiers UI still needs it.

## Features already present or partially present in the current branch

These do not need to be reintroduced from scratch:

- provider create / update now seeds models automatically
- provider discovery now preserves provider metadata first and only falls back when fields are missing
- the models page already has `freeOnly`, `billingFilter`, `tagFilter`, request/token/free pricing modes, and formatted context-window rendering
- the models page already persists discovered `capabilities`, `tags`, and `metadata` when adding a manual model
- the pricing directory already understands token pricing, request pricing, free models, context length, max output tokens, and a small set of capability tags

The remaining work is coverage and parity, not a blank-slate implementation.

## Files to inspect first in a new session

Old branch:

- `/Users/danielsava/work/file-parser/proxies-main-branch/soul-gateway/app/src/api/models.mjs`
- `/Users/danielsava/work/file-parser/proxies-main-branch/soul-gateway/app/src/api/providers.mjs`
- `/Users/danielsava/work/file-parser/proxies-main-branch/soul-gateway/app/src/pipeline/openrouter-pricing.mjs`
- `/Users/danielsava/work/file-parser/proxies-main-branch/soul-gateway/app/src/db/init.mjs`
- `/Users/danielsava/work/file-parser/proxies-main-branch/soul-gateway/app/src/public/js/app.mjs`
- `/Users/danielsava/work/file-parser/proxies-main-branch/soul-gateway/app/src/public/index.html`

Current branch:

- `/Users/danielsava/work/file-parser/proxies/soul-gateway/src/runtime/policy/pricing-directory.mjs`
- `/Users/danielsava/work/file-parser/proxies/soul-gateway/src/runtime/providers/auto-provisioner.mjs`
- `/Users/danielsava/work/file-parser/proxies/soul-gateway/src/management/models-route.mjs`
- `/Users/danielsava/work/file-parser/proxies/soul-gateway/src/public-api/register-routes.mjs`
- `/Users/danielsava/work/file-parser/proxies/soul-gateway/src/dashboard/js/app.mjs`
- `/Users/danielsava/work/file-parser/proxies/soul-gateway/src/dashboard/index.html`
