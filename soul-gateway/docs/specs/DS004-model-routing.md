# DS004 -- Model Routing

## Summary

This specification describes the model resolution algorithm that maps a requested model name to a concrete upstream provider and model, including tier-based fallback, cooldown management, concurrency control, and pricing lookup.

## Problem

Clients request models by name (e.g., `copilot/gpt-4o`, `axl/fast`), but upstream dispatch needs a specific provider key, provider model, base URL, and pricing information. The routing system must handle direct model lookups, tier-based priority resolution with fallback chains, transient error cooldowns, and per-model concurrency limits.

## Design

### Resolution Algorithm

`resolveModel(requestedModel)` follows a three-step resolution process:

```
  resolveModel("axl/deep")
         |
    1. Direct model_config lookup by name
       - Found + type='model' + enabled? --> return buildModelInfo()
       - Found + type='tier'? --> fall through to step 2
       - Not found? --> fall through to step 2
         |
    2. Tier-based resolution (resolveFromTier)
       - Look up model_config with type='tier' and matching name
       - Iterate model_refs[] in priority order
         - Skip models in cooldown (isModelInCooldown)
         - Skip disabled models
         - Skip models missing provider_key/provider_model
       - First valid model? --> return buildModelInfo(model, tier)
       - No valid model? --> follow fallback_model chain
         |
    3. Fallback chain
       - tier.fallback_model points to another tier name
       - resolveFromTier(fallbackName, visited)
       - Cycle detection via visited Set
         |
    Not found? --> throw ModelNotFoundError (404)
```

**Step 1: Direct Lookup**

Query `model_configs` by name. If found and `type !== 'tier'` and `is_enabled === true`, return the model info directly via `buildModelInfo()`.

**Step 2: Tier-Based Lookup**

If no direct match (or the entry is of type `tier`), treat the requested name as a tier and call `resolveFromTier()`:

1. Look up the tier in `model_configs` where `type = 'tier'`
2. If tier is disabled, return null
3. Iterate through `model_refs` (ordered priority list of model names)
4. Skip models that are in cooldown (`isModelInCooldown()`)
5. For each model, look up in `model_configs` -- if enabled and has provider_key + provider_model, return it
6. If no model available, follow `fallback_model` to the next tier (with cycle detection via visited set)

```javascript
async function resolveFromTier(tierName, visited = new Set()) {
  if (visited.has(tierName)) return null; // prevent cycles
  visited.add(tierName);

  const tier = await getTierByName(tierName);
  if (!tier || !tier.is_enabled) return null;

  // Try each model in priority order
  for (const modelName of (tier.model_refs || [])) {
    if (isModelInCooldown(modelName)) continue;
    const mc = await getModelByName(modelName);
    if (mc && mc.is_enabled && mc.provider_key && mc.provider_model) {
      return { modelConfig: mc, tier };
    }
  }

  // Follow fallback tier chain
  if (tier.fallback_model) {
    return resolveFromTier(tier.fallback_model, visited);
  }

  return null;
}
```

**Step 3: Error**

If neither direct nor tier resolution succeeds, throw `ModelNotFoundError` (404).

### Tier System

Tiers are stored in the `model_configs` table with `type = 'tier'`. Instead of mapping directly to a provider and upstream model, a tier contains an ordered list of model references (`model_refs`) and an optional `fallback_model` pointing to another tier. When a client requests a tier by name, the model router resolves it to the first available model in the list.

**Tier Fields:**

| Field | Type | Purpose |
|-------|------|---------|
| `type` | string | Set to `'tier'` to distinguish from regular model configs |
| `name` | string | The tier name clients use in the `model` field (e.g., `"axl/fast"`, `"axl/deep"`) |
| `display_name` | string | Human-readable name shown in the dashboard |
| `model_refs` | text[] | Ordered array of model names. The first enabled, non-cooldown model wins. |
| `fallback_model` | string | Name of another tier to try if all models in `model_refs` are exhausted or in cooldown |
| `is_enabled` | boolean | Disabled tiers return a "model not found" error |
| `sort_order` | integer | Controls display ordering in the dashboard and API listings |

**Resolution Order within a Tier:**

Models in `model_refs` are tried strictly in array order (index 0 is highest priority). For each model name:

1. Check if in cooldown (`isModelInCooldown(modelName)`) -- skip if yes
2. Look up in `model_configs` by name
3. Verify it is enabled and has `provider_key` + `provider_model` set
4. First passing model is returned

**Example Configuration:**

A typical "axl/fast" tier with three models and a fallback to the "axl/deep" tier:

```json
{
  "name": "axl/fast",
  "display_name": "Fast Tier",
  "type": "tier",
  "model_refs": [
    "groq/llama-3.3-70b",
    "fireworks/llama-3.3-70b",
    "openai/gpt-4o-mini"
  ],
  "fallback_model": "axl/deep",
  "is_enabled": true,
  "sort_order": 10
}
```

In this example, the router first tries the Groq-hosted Llama model. If it is in cooldown or disabled, it moves to the Fireworks-hosted version, then to GPT-4o-mini. If all three are unavailable, it follows the fallback to the "axl/deep" tier and repeats the process with that tier's model list.

**Middleware Assignment on Tiers:**

Tiers can have middlewares assigned at the tier level via the `model_middlewares` table. During request processing, tier-level middlewares execute before model-level middlewares. This allows you to apply policies (like rate limiting or budget enforcement) to an entire tier regardless of which specific model gets selected.

**Runtime Behavior:**

| Scenario | Behavior |
|----------|----------|
| Model enters cooldown mid-request | The pipeline re-resolves the tier (up to `maxModelRetries` = 5 times), potentially selecting the next model in the list. |
| All models in cooldown | Fallback chain is followed. If exhausted, the original dispatch error is returned to the client. |
| Tier is disabled | Returns a `ModelNotFoundError` with `"(disabled)"` suffix. |
| Circular fallback | Cycle detection returns null, causing a `ModelNotFoundError`. |

### Model Info Object

`buildModelInfo()` constructs the return value:

```javascript
{
  resolvedModel: 'axl/fast',             // Original requested name
  modelConfigName: 'copilot/gpt-4o',     // Resolved model_config name
  modelConfigId: 'uuid',                 // model_configs.id
  providerKey: 'copilot',                // Provider identifier
  providerModel: 'gpt-4o',              // Upstream model name
  providerConfigId: 'uuid',             // provider_configs.id
  mode: 'deep',                         // Model mode
  inputPrice: 0,                        // Per 1M input tokens
  outputPrice: 0,                       // Per 1M output tokens
  pricingType: 'token',                 // 'token' | 'request'
  requestCost: 0,                       // Flat cost for request-priced models
  isFree: true,                         // Free model flag
  maxConcurrency: 3,                    // Max concurrent requests
  tierName: 'axl/fast',                 // Tier name (if resolved via tier)
  tierId: 'uuid',                       // Tier ID (if resolved via tier)
}
```

### Model Naming and Dashboard Display

Models follow the `<provider>/<model>` naming convention (e.g., `copilot/gpt-4o`, `openai/gpt-4o-mini`). Tiers follow the `axl/<tier>` naming convention (e.g., `axl/fast`, `axl/deep`, `axl/code`). The `/v1/models` API and all internal routing use these names directly.

For backward compatibility, the model router still resolves old-style names: `axl/copilot/gpt-4o` resolves to `copilot/gpt-4o`, and bare tier names like `fast` resolve to `axl/fast`.

### OpenRouter Pricing Fallback

When a model has no pricing in the database (`inputPrice === 0 && outputPrice === 0`) and is not request-priced, `buildModelInfo()` calls `lookupOpenRouterPricing(providerModel)` to fetch pricing data from OpenRouter's model directory. This ensures cost tracking works even for models with incomplete DB configuration.

### Cooldown System

The cooldown system (`model-cooldown.mjs`) is an in-memory Map keyed by `modelConfigName`. Cooldown state does not survive process restarts -- after a restart, all models are immediately available again.

**Cooldown Entry:**

```javascript
{
  expiresAt: timestamp,          // Date.now() + cooldownDurationMs
  errorType: 'rate_limit_error', // The error classification that triggered cooldown
  message: 'Rate limit exceeded',// Original error message from upstream
  cooledAt: ISO string,          // ISO 8601 timestamp when cooldown started
}
```

**Cooldown triggers** (`shouldTriggerCooldown()`): errors classified as `payment_required` or `rate_limit_error` (configurable via `config.cooldownTriggers`).

```javascript
export function shouldTriggerCooldown(errorClassification) {
  if (!errorClassification?.type) return false;
  return config.cooldownTriggers.includes(errorClassification.type);
}

export function shouldCascade(errorClassification) {
  return !!errorClassification?.type;
}
```

**Cascade types:** Two cascade behaviors exist in the pipeline's model-retry loop:

| Cascade Type | Trigger | Enters Cooldown? | Action |
|-------------|---------|-------------------|--------|
| **Cooldown cascade** | `payment_required` (402), `rate_limit_error` (429) | Yes | Quota/billing errors that are likely to persist. The model is blacklisted for the full cooldown duration before trying the next model in the tier. |
| **Immediate cascade** | Any other classified error (auth failures, connection errors, etc.) | No | Transient errors where the next model in the tier is tried immediately without adding a cooldown entry. |

**Cooldown duration**: `config.cooldownDurationMs` (default 1 hour / 3,600,000ms), configurable via `COOLDOWN_DURATION_MS` env var.

**Lifecycle:**

1. **Trigger:** During dispatch, an upstream error with a matching classification is caught. The pipeline calls `putModelInCooldown(modelConfigName, errorType, message)`.
2. **Skip:** On subsequent requests, the tier resolver calls `isModelInCooldown(modelName)` for each model in `model_refs`. Models in cooldown are skipped.
3. **Auto-expiry:** Each call to `isModelInCooldown()` checks if `Date.now() >= entry.expiresAt` and automatically removes expired entries.
4. **Periodic cleanup:** A background `setInterval` every 5 minutes purges expired entries that haven't been checked by a request.
5. **Manual clear:** Operators can clear cooldowns via the API:
   - `DELETE /api/v1/cooldowns/:model` -- clear a specific model
   - `DELETE /api/v1/cooldowns` -- clear all cooldowns

**Dashboard:** `getCooldownStatus()` returns all active cooldowns with remaining time, used by the dashboard's cooldown panel:

```json
[
  {
    "model": "copilot/claude-sonnet-4.5",
    "errorType": "payment_required",
    "message": "Premium request quota exceeded",
    "cooledAt": "2026-03-31T14:00:00Z",
    "expiresAt": "2026-03-31T15:00:00Z",
    "remainingMs": 1800000
  }
]
```

### Concurrency Semaphore

`model-queue.mjs` implements per-model concurrency control:

```javascript
acquireModelSlot(resolvedModel, maxConcurrency)
```

**Semaphore Design:**

```javascript
// Per-model state
{
  active: number,        // Currently running requests
  maxConcurrency: number,// Limit (from model_configs.max_concurrency, default 3)
  waiters: Array,        // Queue of pending requests
}
```

**Acquisition:**

1. If `active < maxConcurrency`, increment and return a release function immediately
2. Otherwise, add to the waiters queue with a 60-second timeout
3. On timeout, throw `QueueTimeoutError` (503 with `Retry-After: 10`)
4. When a slot becomes available, the next waiter is resolved

**Release Behavior:**

The release function uses direct handoff: if there are waiters, the slot is passed directly to the next waiter without decrementing `active`. This prevents race conditions where a new request could steal the slot between decrement and waiter notification.

```javascript
function release(sem) {
  if (sem.waiters.length > 0) {
    const next = sem.waiters.shift();
    next.resolve(); // direct handoff
  } else {
    sem.active--;   // no waiters, free the slot
  }
}
```

**Dynamic Concurrency:**

The `maxConcurrency` is updated every time `getSemaphore()` is called, so changes to `model_configs.max_concurrency` via the admin API take effect on the next request without restart.

**Queue Statistics:**

`getQueueStats()` returns the state of all semaphores for the `/metrics` endpoint:

```json
{
  "copilot/gpt-4o": { "active": 2, "max": 3, "waiting": 0 },
  "kiro/claude-sonnet-4.5": { "active": 3, "max": 3, "waiting": 1 }
}
```

### Model Retry Loop

The pipeline's outer retry loop (in `pipeline.mjs`) handles model-level failures:

```
for modelAttempt = 0..maxModelRetries (5):
  resolve model
  acquire concurrency slot
  try:
    dispatch with per-provider retries
    stream or buffer response
    break on success
  catch:
    if cooldown trigger -> put in cooldown, continue
    if cascade trigger  -> continue (no cooldown)
    else                -> throw (non-recoverable)
  finally:
    release slot
```

The `attemptedModels` set prevents re-resolving to a model that already failed in this request.

```javascript
// Simplified from pipeline.mjs
for (let modelAttempt = 0; modelAttempt <= config.maxModelRetries; modelAttempt++) {
  if (modelAttempt > 0) {
    modelInfo = await resolveModel(body.model); // re-resolves, skipping cooldown models
  }

  try {
    result = await dispatchWithRetry(body.messages, modelInfo, llmParams);
    break; // success
  } catch (err) {
    if (shouldTriggerCooldown(err.errorClassification)) {
      putModelInCooldown(modelInfo.modelConfigName, ...);
      continue; // try next model
    }
    if (shouldCascade(err.errorClassification)) {
      continue; // try next model without cooldown
    }
    throw err; // non-cascadable error
  }
}
```

### Pricing

Cost calculation is handled by `calculateCost()` in `cost-calculator.mjs`. Two pricing models are supported:

**Token-based Pricing:**

Most direct API providers (OpenAI, Anthropic, Google) charge per token:

```
input_cost  = (prompt_tokens / 1,000,000) * input_price
output_cost = (completion_tokens / 1,000,000) * output_price
total_cost  = input_cost + output_cost
```

Prices are stored in the `model_configs` table as USD per 1M tokens. If the database has no pricing and the model is token-priced, OpenRouter's API is queried as a fallback.

**Per-request Pricing:**

Subscription-based providers (Copilot, Kiro) charge a flat rate per request regardless of token count:

```
input_cost  = 0
output_cost = 0
total_cost  = request_cost
```

Request costs are set by the migration in `init.mjs` based on model tier:

| Provider | Tier | Cost per Request |
|----------|------|-----------------|
| Copilot | Free (GPT-4o, GPT-4.1, GPT-5 mini) | $0.00 |
| Copilot | Cheap premium (Haiku, Flash, Grok) | $0.01 - $0.013 |
| Copilot | Standard premium (Sonnet, GPT-5.x) | $0.04 |
| Copilot | Expensive (Opus 4.x) | $0.12 |
| Kiro | Light (Qwen, Minimax) | $0.002 - $0.01 |
| Kiro | Haiku | $0.016 |
| Kiro | Sonnet | $0.052 |
| Kiro | Opus | $0.088 |

All costs are rounded to 6 decimal places to avoid floating-point drift.

### Configuration

Model routing behavior is controlled by these `config.mjs` settings:

| Setting | Default | Env Var | Description |
|---------|---------|---------|-------------|
| `maxModelRetries` | 5 | `MAX_MODEL_RETRIES` | Maximum model-level cascade attempts (cooldown fallback loop) |
| `cooldownDurationMs` | 3,600,000 (1h) | `COOLDOWN_DURATION_MS` | How long a model stays in cooldown |
| `cooldownTriggers` | `['payment_required', 'rate_limit_error']` | -- | Error types that trigger cooldown (vs immediate cascade) |
| `maxRetries` | 3 | -- | HTTP-level retries per model |
| `initialDelayMs` | 1,000 | -- | Base delay for exponential backoff |
| `backoffMultiplier` | 2 | -- | Delay multiplier per retry |
| `maxDelayMs` | 30,000 | -- | Maximum delay between retries |
| `jitterPercent` | 20 | -- | Random jitter +/- percentage on retry delay |

## Implementation

| File | Role |
|------|------|
| `pipeline/model-router.mjs` | `resolveModel()`, `resolveFromTier()`, `buildModelInfo()` |
| `pipeline/model-cooldown.mjs` | Cooldown state: put, check, clear, should-trigger, should-cascade |
| `pipeline/model-queue.mjs` | Per-model concurrency semaphore with queue and timeout |
| `pipeline/openrouter-pricing.mjs` | OpenRouter pricing fallback lookup |
| `pipeline/cost-calculator.mjs` | Cost calculation for token-based and per-request pricing |
| `db/models-dao.mjs` | `getModelByName()`, `getTierByName()` DB queries |

## Dependencies

- DS001 (Request Pipeline) -- pipeline drives the model retry loop
- DS006 (Database Schema) -- model_configs table with type, model_refs, fallback_model
- DS009 (Error Handling) -- error classification determines cooldown vs cascade vs throw
