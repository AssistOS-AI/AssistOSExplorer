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

## Related specs

- **DS001** — request pipeline and dispatch entrypoint
- **DS003** — middleware scopes and provider execution
- **DS007** — budget/rate-limit policies that run around model dispatch
- **DS009** — retry and error classification semantics
- **DS012** — model and middleware management surfaces
