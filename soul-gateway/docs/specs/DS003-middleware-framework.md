# DS003 — Middleware, Hooks, and Extensions

## Summary

This spec describes the three kinds of processing units Soul Gateway runs around an LLM request, how they compose into the request pipeline, how they're discovered and loaded at runtime, and how the legacy `kind='wrapper'` concept maps onto the current model.

## The three abstractions

The runtime is organized around three distinct kinds of processing units. They share a common hook contract but differ in scope and purpose.

### Gateway hooks ("middleware")

Gateway hooks run once per request at the gateway scope, regardless of which provider ultimately handles the request. Equivalent product term: **middleware**.

- Implement `onRequest` (pre-dispatch) and/or `onResponse` (post-dispatch) phases.
- Assigned to tiers (broad policies) and/or individual models (specific overrides).
- Tier-level middlewares execute first, then model-level middlewares. Within each level, execution order is determined by a configurable sort order.
- Default settings can be overridden per-assignment.
- Gateway stream hooks (`wrapStream` at gateway scope) are discovered but not executed — this is a known gap in the middleware engine.
- Managed via the Middlewares page and the middleware management API.
- Twelve built-in gateway middlewares ship with the runtime (see DS014).

### Provider hooks ("wrapper")

Provider hooks run inside a specific provider's pipeline, around its executor. Equivalent product term: **wrapper**.

- Implement any combination of `onRequest`, `wrapStream`, and `onResponse` phases.
- Operate per-provider, allowing provider-specific request shaping, response filtering, and stream transformation.
- Four built-in provider hooks ship with the runtime:
  - **provider-context-compacter** (request phase) — summarizes and compresses older conversation messages when the total estimated token count exceeds a configurable threshold, while preserving a configurable number of recent messages.
  - **provider-prompt-injector** (request phase) — prepends or appends a system message to the conversation. Configurable content, position, and role.
  - **provider-output-compressor** (request phase) — truncates verbose tool and function output in messages before sending to the provider.
  - **provider-response-filter** (response phase) — applies configurable regex find/replace patterns to the response content.
- Built-in provider hooks are not replacements for the gateway middleware versions. They coexist as provider-scoped variants that apply per-provider, inside the provider pipeline, rather than globally at the gateway level.
- Assignments are persisted alongside providers, loaded at startup, and live-refreshed on every mutation so the provider pipeline reflects changes immediately.
- A provider without any hook assignments executes through the direct provider path with no overhead.
- Managed via the provider hook management API and composed on the Providers page via the pipeline composer modal.

### Executors

An executor is the terminal component that fulfills a request. It calls an upstream API, runs a local model, performs a search, or executes custom logic.

- Every built-in provider plugin (OpenAI-compatible, Anthropic, Copilot, Codex, Kiro, Search, Gemini) is automatically adapted into the executor contract at startup, so the executor catalog is populated alongside the provider catalog.
- Executor extensions loaded from `extensions/executors/*.executor.mjs` are registered into the same executor catalog as built-ins.
- An executor has a manifest declaring its key, display name, executor type, and capability flags (`supportsStreaming`, `supportsTools`). Canonical executor types are `external_api`, `search`, `local_model`, `custom`.
- The executor and provider catalogs resolve plugins by exact manifest key. Every provider row carries an `adapter_key` column pointing directly at the plugin that serves it — NVIDIA, Codestral, Groq, and every other OpenAI-compatible vendor all set `adapter_key='openai-api'`, and every search engine preset sets `adapter_key='search-builtin'`. The execution engine and the provider lifecycle path both walk `executor_key || adapter_key || provider_key`, with `adapter_key` as the authoritative signal.
- Custom providers with `provider_mode='custom'` resolve their terminal backend through `executor_key`.
- Provider lifecycle operations (`testConnection`, `discoverModels`) also go through the executor catalog for custom providers.

## Provider mode

Each provider has a mode that determines how its requests are dispatched:

- **`external_api`** — the default. The provider has a specific plugin (`openai-api`, `anthropic-api`, `search-builtin`, `codex-api`, etc.) that handles dispatch.
- **`custom`** — for providers that compose hooks around a custom executor. An optional `executor_key` on the provider record references a specific executor from the executor catalog.

`provider_mode` and `executor_key` are persisted on provider records, exposed through the management API, present in the runtime snapshot, and aliased into the provider execution context. For custom providers, `adapter_key` defaults to `executor_key` (or `provider_key`) if the caller does not send one explicitly.

## Provider pipeline execution

When a provider has hook assignments, the request executes through a structured pipeline instead of calling the provider executor directly:

```
  Request hooks (ascending sort order)
    → Executor (terminal call to upstream API or custom logic)
  Stream hooks (stack semantics — last hook wraps outermost)
  Response hooks (reverse sort order — around-style nesting)
```

- A hook can implement any subset of phases: request-only, stream-only, response-only, request+response, or all three.
- Hook errors are caught and logged but do not abort the pipeline, matching the fault-tolerance model of the gateway middleware engine.
- Settings are resolved per assignment entry by merging the hook's default settings with that assignment's overrides. Reusing the same hook key in multiple phases or multiple assignments preserves distinct settings per binding.
- Provider request hooks receive a mutable hook context that can replace or mutate the normalized request before executor dispatch.
- Provider response hooks run against the buffered collected result and usage object after stream collection. They can inspect or mutate the final response payload before it returns to the gateway response-middlewares layer.

## Relationship to gateway middlewares

Provider hooks run inside the provider pipeline, after gateway request middlewares have already executed and before gateway response middlewares run. Gateway middlewares and provider hooks are separate scoping layers with distinct persistence and execution paths. The full request lifecycle when both are present is:

```
gateway request middlewares
  → provider request hooks
    → executor
  → provider stream hooks
  → provider response hooks
gateway response middlewares
```

This ordering is structurally guaranteed by the runtime: the middleware engine runs pre-hooks, calls the dispatch function (which contains the entire provider pipeline), and then runs post-hooks. The provider pipeline is fully enclosed within the dispatch boundary.

## Middleware pipeline details

### Plugin system

- The system supports pluggable processing units (middlewares) that can run before and/or after the LLM dispatch.
- Middlewares are automatically discovered from a designated directory at startup.
- New middlewares can be added without restarting the system by triggering a rescan via the management API.
- Custom middlewares placed in the extensions directory are automatically loaded during middleware rescan, validated, registered with their pre/post hooks, and persisted to the database so they appear in management listings alongside built-in middlewares.
- Middleware catalog rescans and middleware assignment mutations refresh the live runtime state so subsequent requests see the new middleware definitions and assignment plans without a process restart.

### Middleware types

- **Pre-dispatch** — runs before the request is sent to the LLM. Can inspect or modify the request messages and parameters, abort the request (with an error or a cached response), or set metadata for later use.
- **Post-dispatch** — runs after the LLM response is received. Can inspect the response and usage metrics, modify response content (non-streaming only), or record metrics.
- **Both** — wraps the full dispatch cycle with before and after hooks.

### Hook context

Middleware hooks receive a structured hook context that includes the normalized request, caller/auth metadata, session metadata, bounded runtime services, response/usage data for post hooks, and per-request middleware state. Middleware behavior does not depend on private request annotations.

### Abort mechanics

- A pre-dispatch middleware can abort with an error (e.g., 429 rate limit, 400 content blocked).
- A pre-dispatch middleware can also abort with a success — returning a cached or synthetic response without calling the LLM. This is how response caching works.
- A middleware that fails does not crash the request — errors are caught, logged, and processing continues.

Post-dispatch middlewares run against the final buffered response and usage data produced by the dispatch pipeline, so caching, logging, filtering, token tracking, and budget accounting execute through the same middleware contract as pre-dispatch policy.

## Custom in-gateway models

The system supports registering models whose inference logic runs entirely inside the gateway, without calling any external provider. A custom in-gateway model is a unit of code that receives the standard request (messages, parameters) and produces a standard response (text, tool calls, usage metrics).

### Use cases

- **Multi-LLM orchestrators** — a model that routes sub-requests to multiple upstream LLMs, combines their outputs, and returns a synthesized response (majority voting, chain-of-thought decomposition, debate-style refinement).
- **Augmented pipelines** — retrieval-augmented generation that fetches context from a knowledge base before calling an upstream LLM, then post-processes the response.
- **Transformation models** — deterministic transformations (template expansion, code generation from specs, format conversion) returning results without calling an LLM at all.
- **Caching layers** — semantic caching that finds similar past queries and returns stored responses when the match exceeds a confidence threshold.
- **Evaluation models** — scoring or judging the output of another model, returning structured evaluation results.

### Integration

Custom in-gateway models are registered in the model registry like any other model. They can:

- Be included in tiers and participate in fallback chains.
- Have middleware assigned to them.
- Be rate-limited and budget-tracked.
- Produce streaming or non-streaming responses.
- Report token usage and cost metrics.
- Appear in logs, metrics, and the dashboard.

The system discovers custom model implementations from a designated directory, similar to how middlewares are discovered. Extensions that export a provider plugin are validated against the same contract as built-in providers (manifest validation, required methods check) before being merged into the provider catalog. Invalid extensions are skipped with a warning. Custom in-gateway models receive the same curated gateway service surface as other extensions, which allows orchestration and credential use without coupling those extensions to internal registry or bootstrap state.

## Extension discovery

The extension loader discovers modules from multiple directory conventions under the configured extensions root.

### First-class paths

- `extensions/gateway-hooks/*.hook.mjs` — gateway-scoped hooks
- `extensions/provider-hooks/*.hook.mjs` — provider-scoped hooks
- `extensions/executors/*.executor.mjs` — executor extensions

These paths are wired into the live runtime at startup and on rescans:

- Gateway hooks are adapted into the middleware catalog.
- Provider hooks are registered into the provider-hook catalog.
- Executors are registered into the executor catalog.

The loader cache-busts extension imports with the file mtime, so rescans load changed code rather than reusing stale module instances.

### Compatibility paths

These older conventions are still scanned, but the `src` runtime treats `gateway-hooks`, `provider-hooks`, and `executors` as the first-class model:

- `extensions/middlewares/*.middleware.mjs` — gateway-scoped middleware hooks
- `extensions/wrappers/*.wrapper.mjs` — provider-scoped hooks
- `extensions/search/*.search.mjs` — search executor extensions
- `extensions/models/*.model.mjs` — custom model executor extensions

All paths are scanned in a single pass.

### Runtime metadata

Every discovered extension carries runtime metadata:

- `scope` — `'gateway'` or `'provider'` (hooks only; `null` for executors)
- `type` — `'hook'` or `'executor'`

Legacy path mapping:

- Middlewares are tagged `scope='gateway'`, `type='hook'`.
- Wrappers are tagged `scope='provider'`, `type='hook'`.
- Search and model extensions are tagged `type='executor'`.

Discovery metadata is descriptive only. New executor semantics come from explicit executor manifests, not from directory names.

## Shared hook contract

All processing units — both existing gateway middlewares and provider hooks — conform to a single generic hook contract. A hook module exports metadata (`key`, `name`, `scope`, `phases`, `defaultSettings`) and one or more phase functions: `onRequest` (runs before dispatch), `wrapStream` (wraps the response stream), and `onResponse` (runs after dispatch). The `scope` field is either `'gateway'` (runs once per request, regardless of provider) or `'provider'` (runs around a specific provider's executor). The `phases` array declares which phase functions the hook implements: any combination of `'request'`, `'stream'`, and `'response'`.

Existing built-in middlewares are not rewritten. An adapter layer translates between the legacy middleware format (`pre`/`post` exports) and the shared hook contract (`onRequest`/`onResponse`). The adapter is bidirectional: legacy middlewares can be queried as hooks, and new hook-style modules can run through the existing middleware engine.

## Deprecated: `kind='wrapper'`

The concept of "provider wrappers" as a distinct provider kind (`kind='wrapper'`) is deprecated. Wrapping behavior — custom logic around a provider's request/response cycle — should be implemented as provider hooks. Terminal execution of requests should use executors. The `kind='wrapper'` value is still accepted for backward compatibility but produces a deprecation warning.

When the system loads a provider plugin with `kind='wrapper'`:

- If the module exports hook functions (`onRequest`, `onResponse`, `wrapStream`), it is classified as a provider hook internally.
- If the module only exports executor functions (`execute`, `classifyError`), it is classified as an executor for backward compatibility.

The dashboard no longer exposes `kind='wrapper'` as a creation option. New providers created through management flows use `kind='external_api'` for standard upstream providers or `kind='custom'` for custom pipelines, derived from `provider_mode`.

Legacy wrapper extensions in `extensions/wrappers/*.wrapper.mjs` are still discovered and loaded. They are tagged with `scope='provider'` and `type='hook'` in the extension catalog for compatibility.

## Related specs

- **DS001** — where the pipeline actually runs these layers around each request.
- **DS002** — provider plugins and how they plug into the executor contract.
- **DS004** — tier assignments, which is where gateway middlewares get attached.
- **DS012** — management API for assigning middlewares to tiers/models and composing provider pipelines.
- **DS014** — per-middleware capability descriptions for the 12 built-in gateway middlewares.
