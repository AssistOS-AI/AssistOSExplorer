# DS004 — Model Routing

## Summary

Soul Gateway routes every request through a model record in `snapshot.models`.

Each model has a `strategyKind`:

- `direct` — dispatch one provider/model pair
- `cascade` — walk an ordered list of child models until one succeeds

The runtime no longer has a separate tier execution path. A tier is just a cascade model stored in the unified model tables.

The dashboard still exposes a dedicated `Tiers` page and `/management/tiers` management surface, but that UI edits the same cascade model records in `models` + `model_children`; it is not a separate runtime subsystem.

## Model registry

The snapshot loader reads models from the unified schema:

- `models`
- `model_aliases`
- `model_children`
- `providers`
- `middleware_bindings`
- `model_cooldowns`

`snapshot.models` contains both direct and cascade models. The snapshot no longer relies on `tiers`, `tier_models`, or a synthesized in-memory tier map.

## Model-name normalization

`normalizeModelName(input, snapshot)` resolves names in this order:

1. exact `snapshot.models` match
2. alias match
3. bare-name lookup across direct-model `<provider>/<name>` keys only
4. case-insensitive retry

Bare cascade shorthand such as `fast -> axl/fast` is no longer supported. Cascade models must be addressed by their full model key (for example `axl/fast`).

The normalizer returns:

- `kind: 'model'`
- `kind: 'unknown'`

## Direct models

A direct model dispatches through the kernel-composed direct chain (see DS003 §"Model execution chain"):

```text
bindDirectTarget       // normalize model+provider records on ctx.target
concurrency            // outer slot lifecycle (held across retries)
retry(attemptChain)    // wraps the per-attempt subchain
finalizeDirectResult   // shape into chat-completion envelope
```

Each per-attempt subchain runs `attemptContext → timeout → credentialLease → providerBindings (provider middleware + backendDispatch)` in a forked kernel context.

## Cascade models

A cascade model stores an ordered `children` list loaded from `model_children`.

`modelExecutionMiddleware()` runs cascade models through the kernel-composed cascade chain:

```text
finalizeDirectResult        // preserve child envelope/stream or shape buffered leaf result
invokeModelCapability       // installs ctx.invokeModel(...)
cascadeAdapter (terminal)   // runs cascadeMiddleware over children
```

For each attempt the cascade middleware:

- skips children already failed in this request
- skips cooled-down child models
- skips disabled child models
- invokes the next eligible child with `ctx.invokeModel(model)` and reads the finished child ctx
- stops on first success

If every child fails or is unavailable, the runtime throws `TierExhaustedError`.

## Cooldowns

When a model fails with a classified cooldown-triggering error, the runtime records a cooldown entry and future cascades skip that model until the cooldown expires or is cleared.

The snapshot exposes cooldowns through `snapshot.cooldowns`.

## Concurrency

Each direct model enforces a per-model concurrency limit.

- requests wait in a queue when the limit is saturated
- queue timeout rejects with a retryable error
- metrics expose active/max/waiting counts

## Pricing

Models can define:

- token-based pricing
- per-request pricing
- free-model status

Cost is calculated from the model record after each request and feeds budget enforcement and audit logging.

## Model metadata and tagging

Model rows carry pricing, context, capability, and tag metadata that is used by the dashboard, the `/v1/models` listing, and (where it affects routing like `isFree` or `contextWindow`) the request pipeline. Metadata precedence is owned by the shared `enrichModelMetadata()` helper in `src/runtime/policy/model-metadata-classifier.mjs`.

It is applied in three in-memory contexts:

1. `src/runtime/providers/auto-provisioner.mjs` — provider create / OAuth completion / patch-with-credentials / resync / startup reconciliation.
2. `src/management/models-route.mjs` — the `/management/models` list overlay and the `/management/models/providers/:key/models` Add-Model discovery overlay.
3. `src/public-api/register-routes.mjs` — direct-model `/v1/models` entries run the same helper against the already-loaded snapshot record plus the already-installed pricing directory, so older sparse rows still render enriched `_pricing`, `_context`, `_tags`, and `_is_free` without a resync.

The enrichment pipeline is strict-precedence:

1. **Provider-supplied metadata wins.** If the provider's own `/models` response surfaced pricing, context, a capability flag, or a tag, that value is preserved — the directory and the classifier never overwrite it (explicit provider values like `supportsVision: false` also win over optimistic directory claims).
2. **Pricing directory fills remaining gaps.** `src/runtime/policy/pricing-directory.mjs` keeps an OpenRouter-backed model catalog in memory and matches by exact id, canonical slug, curated provider-alias rewrite (NVIDIA `meta/` → `meta-llama/`, Codex models → `openai/`, Copilot vendor prefixes), and finally unique leaf slug. Matching is deterministic; there is no fuzzy search, so adversarial inputs stay unresolved. Directory-sourced fields are stamped in `row.metadata.openrouter` for provenance.
3. **Classifier adds curated family/domain tags.** The classifier owns `PREDEFINED_MODEL_TAGS`, the family rule set (coding, reasoning, agentic, fast, long-context, instruction-following, multilingual, multimodal, creative, writing, research, finance, medical, etc.), and `TOOL_CALLING_PROVIDER_KEYS` for augmenting `tool-calling` on trusted providers (with explicit opt-outs such as `copilot/gpt-4o`). The classifier is pure and has no side effects. It **never** emits capability-signal tags (`vision`, `audio`, `tool-calling` from direct signal, `structured-outputs`, `moderated`, `free`) — those come from provider or directory data only. Classifier-sourced tags are stamped in `row.metadata.classifier`.

`snapshot.models` records freeze the enriched values (`pricingMode`, `inputPricePerMillion`, `outputPricePerMillion`, `requestPriceUsd`, `isFree`, `tags`, `capabilities`, `metadata`) so request-time code and the public `/v1/models` handler read an already-enriched view without issuing DB or network calls.

## Public model listing

`GET /v1/models` returns the OpenAI-compatible model list derived from `snapshot.models` plus `snapshot.aliases`. The base entry shape (`id`, `object`, `created`, `owned_by`, `permission`, `root`, `parent`) is preserved so vanilla OpenAI clients keep working.

Gateway-specific extensions use the `_`-prefix convention so they cannot collide with a future OpenAI field:

- `_alias: true` and `root`/`parent` pointing at the target on alias entries
- `_strategy: 'cascade'` with `_child_count`, `_billing_types`, and a derived `_is_free` (true iff every enabled child resolves as free) on cascade models
- `_pricing`, `_context`, `_tags`, and `_is_free` on direct models, sourced from the snapshot record after the same in-memory enrichment precedence is applied

The handler does not issue DB queries or network calls; it reads the already-loaded snapshot and the already-installed in-memory pricing directory only.

## Related specs

- **DS001** — request pipeline and dispatch entrypoint
- **DS003** — middleware scopes and provider execution
- **DS007** — budget/rate-limit policies that run around model dispatch
- **DS009** — retry and error classification semantics
- **DS012** — model and middleware management surfaces
