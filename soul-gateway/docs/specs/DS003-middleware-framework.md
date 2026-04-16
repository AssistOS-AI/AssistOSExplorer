# DS003 — Middleware, Backends, and Extensions

## Summary

Soul Gateway has one execution model: middleware. Route handling, gateway policy, provider-specific shaping, and upstream execution all compose through the same kernel in `src/runtime/kernel/`.

This spec describes:

- the kernel contract
- the shared runtime context
- gateway, provider, and backend scopes
- extension discovery

## Kernel contract

The kernel exports:

- `compose([...middlewares])`
- `createKernelContext(input)`
- `forkKernelContext(parent, overrides)`
- `abortSuccess()` / `abortError()` / `createAbortApi(name)`
- `bufferingMiddleware()` / `wrappingStreamMiddleware(wrap)` / `bufferCanonicalStream(stream)`
- `createCanonicalStream(source, meta)` / `isCanonicalStream(value)` / `tapStream` / `mapStream`

The core middleware shape is:

```js
async function middleware(ctx, next) {
  await next();
}
```

A middleware can:

- mutate `ctx.request`
- mutate `ctx.response`
- short-circuit by skipping `next()`
- throw a classified gateway error
- wrap a canonical response stream
- act as the terminal handler

## Runtime context

Every layer sees the same kernel context shape:

- `ctx.requestId`
- `ctx.request`
- `ctx.response`
- `ctx.auth`
- `ctx.identity`
- `ctx.session`
- `ctx.snapshot`
- `ctx.target`
- `ctx.attempt`
- `ctx.services`
- `ctx.state`
- `ctx.metadata`
- `ctx.signal`
- `ctx.log`
- `ctx.abort`
- `ctx.invokeModel`
- `ctx.appCtx`

`ctx.response` may be:

- a `CanonicalStream`
- a stream envelope
- a buffered completion
- a route-level OpenAI-style response envelope

## Scopes

### Route scope

The outermost route chain lives in `src/runtime/route/` and handles:

- body parsing
- auth
- identity
- snapshot binding
- ingress normalization
- validation
- model resolution
- session resolution
- gateway dispatch
- response serialization

### Gateway scope

Gateway middlewares run once per incoming request.

They are resolved from unified `middleware_bindings`:

- `scope='gateway'` -> global request policies
- `scope='model'` -> policies for the resolved model id (includes cascade models)

Built-in gateway middlewares export the native module contract:

- `meta`
- `factory(settings) => async (ctx, next) => {}`

### Provider scope

Provider middlewares run inside one provider attempt, around the terminal backend.

They are resolved from `middleware_bindings(scope='provider')` and compiled through `providerMiddlewareRegistry`.

The registry accepts one module shape:

- native provider middlewares: `{ meta, factory(settings) }`

The built-in provider middlewares are native kernel middlewares in `src/runtime/middleware/provider-builtin/`.

There is no separate `ProviderHookCatalog` or `provider_hook_assignments` table; provider middleware lives entirely in `middleware_bindings(scope='provider')`. The management API exposes provider middleware under middleware-named endpoints (`/management/provider-middlewares`, `/management/providers/:id/middlewares`).

Provider composition is fail-fast:

- provider create/update rejects unknown backend keys and backend-invalid provider config
- provider-middleware create rejects unknown provider middleware keys
- runtime snapshot load rejects enabled providers whose `backendKey` is not present in the loaded backend catalog
- runtime snapshot load rejects enabled provider bindings whose `middlewareKey` is not present in the loaded provider middleware registry
- request-time provider binding compilation throws on unknown provider middleware keys; bindings are not silently skipped

### Backend scope (terminal middleware)

A backend is the terminal middleware in the provider chain. It is the only request-time concept the runtime has for talking to an external system.

It reads:

- `ctx.request`
- `ctx.target.model`
- `ctx.target.provider`
- `ctx.target.credentialLease`
- `ctx.signal`

It writes `ctx.response` as a canonical stream (or a stream envelope) and does not call `next()`.

A backend module is loaded from `src/runtime/backends/builtin/*.backend.mjs` (or extension `backends/*.backend.mjs`) and exports a `backendModule` object whose shape is declared in `src/runtime/backends/backend-interface.mjs`. Required: `manifest`, `execute(executionCtx)`, `classifyError(err, ctx)`. Optional: `init`, `shutdown`, `validateProviderRecord`, `validateModelRecord`, `discoverModels`, `testConnection`.

The runtime registers each module in the unified `BackendCatalog`. At register time the catalog wraps the module's `execute()` once via `createBackendTerminal(module)` and stores the resulting kernel terminal middleware. There is no per-request adapter step. Lookups:

- `backendCatalog.acquireGeneration()` / `releaseGeneration()` — bracket request-time use of one catalog generation
- `backendCatalog.getTerminalForGeneration(key, generation)` — returns the precompiled terminal middleware from a pinned generation (used by the request hot path)
- `backendCatalog.getTerminal(key)` — returns the latest precompiled terminal middleware (used by compatibility callers)
- `backendCatalog.getBackend(key)` — returns the BackendModule (used by lifecycle/admin code)

The request hot path pins one backend-catalog generation before terminal lookup. Buffered responses release that generation as soon as the backend returns. Streaming responses release it only after the canonical stream finishes draining, so background refresh/shutdown can retire old generations without tearing down a backend that is still serving bytes to a client.

The backend terminal classifies late stream failures through the same backend `classifyError()` hook as execute-time failures. If a backend stream throws while draining, or yields a canonical `{ type: 'error' }` event, the terminal converts that failure into the backend's typed `GatewayError` before the buffering middleware or route error boundary sees it.

There is no separate `ProviderCatalog` / `TransportCatalog` split, no `ProviderPlugin` / `TransportPlugin` interfaces, and no `adaptProviderToTransport` / `adaptProviderPluginToTransport` adapter — those concepts collapsed into the single backend catalog during the middleware-first cleanup pass.

## Model execution chain

`gatewayDispatchMiddleware()` ends with `modelExecutionMiddleware()`, which reads `ctx.target.model` and branches on `model.strategyKind`. Both branches are kernel middleware composition — there is no helper function that returns a result envelope.

### Direct-model chain

`composeDirectModelChain()` returns:

```text
[
  bindDirectTargetMiddleware,         // normalize model + provider records onto ctx.target
  concurrencyMiddleware,              // outer slot lifecycle (held across retries)
  retryMiddleware({ attemptChain }),  // wraps the per-attempt subchain
  finalizeDirectResultMiddleware,     // shape into chat-completion envelope
]
```

The `attemptChain` runs in a forked kernel context per attempt:

```text
[
  attemptContextMiddleware,    // clones ctx.request, resets ctx.response
  timeoutMiddleware,           // installs ctx.signal for the attempt
  credentialLeaseMiddleware,   // leases provider credentials, releases in finally
  providerBindingsMiddleware,  // terminal: compiles provider middleware + backend dispatch
]
```

`providerBindingsMiddleware` is the per-attempt terminal: it compiles `middleware_bindings(scope='provider')` for the resolved provider against `providerMiddlewareRegistry` and runs:

```text
non-streaming: [ bufferingMiddleware, ...providerMiddlewares, backendDispatchMiddleware ]
streaming:     [ ...providerMiddlewares, backendDispatchMiddleware ]
```

`backendDispatchMiddleware()` is the absolute terminal: it acquires a backend-catalog generation, resolves the precompiled terminal for that generation, and invokes it. Backend selection is part of middleware execution, not pre-composition orchestration — each attempt picks up the current snapshot/catalog state, but once the attempt starts it stays pinned to one backend generation until the buffered result returns or the stream completes.

Ordering rules for provider middleware:

- lower `sort_order` is outer
- higher `sort_order` is inner
- provider middlewares unwind in reverse order
- chain-level buffering is skipped for client streaming

### Cascade chain

A cascade model is not a separate execution system. It is a model whose `strategyKind` is `cascade`.

`composeCascadeModelChain()` returns:

```text
[
  finalizeDirectResultMiddleware,       // preserve child envelope/stream or shape buffered leaf result
  invokeModelCapabilityMiddleware,      // installs ctx.invokeModel(...)
  cascadeAdapterMiddleware,             // terminal: runs cascadeMiddleware over children
]
```

`cascadeMiddleware` iterates the cascade model's children and dispatches each candidate through `ctx.invokeModel(child)`. Each invocation composes a fresh direct or cascade chain in a forked child kernel context and returns that finished child ctx, so the parent's `ctx.target`, `ctx.attempt`, and `ctx.response` stay isolated until the leaf attempt succeeds.

## Provider composition model

A provider record in the runtime is now visibly a composition concept:

- **provider config** — DB row in `providers` (display name, base URL, auth, settings)
- **ordered provider middlewares** — `middleware_bindings(scope='provider', target_id=<provider_id>)`, sorted by `sort_order`
- **one terminal backend key** — `provider.backend_key` (stored as `adapter_key` in the DB column for migration compatibility; surfaced in the snapshot as `provider.backendKey`)

Lifecycle/admin operations (`testConnection`, `discoverModels`) also resolve providers strictly through `provider.backendKey`; they do not fall back to `provider_key` or display name.

Adding a same-family vendor (e.g. NVIDIA, Groq, Fireworks for OpenAI-compatible) is a configuration change: a new entry in `provider-presets.mjs` pointing at the existing `openai-api` backend module. Vendor-specific request-shape quirks still stay within that shared backend. For example, the OpenAI-compatible backend omits upstream `stream_options` for NVIDIA by default, and any OpenAI-compatible provider can override that behavior explicitly with `provider.settings.supports_stream_options` / `provider.settings.supportsStreamOptions`.

Adding a vendor that genuinely speaks a custom protocol means writing one backend module under `runtime/backends/builtin/` (or shipping it as a backend extension under `extensions/backends/`). Everything else remains middleware bindings + config.

## Provider mode

Providers expose `provider_mode` in management:

- `external_api` -> standard backend dispatch
- `custom` -> the provider points at a custom backend module via `backend_key`

In both cases the terminal is the same backend dispatch path through the unified `BackendCatalog`. There is no separate execution path for "custom" providers.

## Extension discovery

The extension loader scans three canonical directories under the configured extensions root:

- `extensions/middlewares/*.middleware.mjs` — gateway-scope middleware (`{ meta, factory }` shape)
- `extensions/provider-middlewares/*.middleware.mjs` — provider-scope middleware (`{ meta, factory }` shape)
- `extensions/backends/*.backend.mjs` — terminal backend extensions (must export `backendModule`, or a bare `execute()` plus optional lifecycle methods alongside a `manifest` / `meta` object)

There is no separate "wrapper", "executor", "hook", or "transport" extension kind. Discovery metadata tags every entry with `scope` (`gateway` or `provider` for middlewares; `null` for backends) and `type` (`middleware` or `backend`).

## Related specs

- **DS001** — where these layers run in the request lifecycle
- **DS004** — how cascade models invoke child model attempts
- **DS005** — stream wrapping and buffering behavior
- **DS012** — management APIs for bindings, providers, tiers, and observability endpoints
- **DS014** — built-in gateway middleware catalog
