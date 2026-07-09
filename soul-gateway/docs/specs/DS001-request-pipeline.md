# DS001 — Request Pipeline

## Summary

Soul Gateway runs every public completion request through one kernel-composed route chain. The same chain handles `/v1/chat/completions`, `/v1/messages`, and `/v1/responses` after ingress normalization. OpenAI-compatible embeddings are exposed separately at `/v1/embeddings` because they use an `input` payload and return vector data instead of chat/message `choices`.

The route handler in `src/public-api/register-routes.mjs` calls `runRouteRequest({ req, res, appCtx, routeKind })` from `src/runtime/route/run-route-request.mjs`. That function builds the route chain and runs it against a unified kernel context.

## Accepted request formats

The gateway accepts three public completion request formats:

- OpenAI Chat Completions
- Anthropic Messages
- OpenAI Responses

`normalizeIngressMiddleware` converts each route kind to the canonical internal request shape before validation and dispatch.

The gateway also accepts OpenAI-compatible embeddings requests at `POST /v1/embeddings`:

- request body: `model`, `input`, and optional OpenAI-compatible `encoding_format`, `dimensions`, and `user`
- response body: OpenAI-compatible embedding list payload from the selected upstream provider

The embeddings route authenticates with the same API-key middleware, resolves the requested model through `snapshot.models`, supports cascade tiers whose children are embeddings-tagged direct models, leases provider credentials for the request, and dispatches through a backend embedding capability. It intentionally does not enter the completion route chain because completion validation requires `messages` and completion egress serializes `choices`.

## Authentication and identity

Every request requires `Authorization: Bearer <key>`.

The route chain authenticates the API key and then resolves optional identity headers:

- soul id
- agent name
- session id

Those values are attached to the kernel context and later recorded in logs and session views.

## Request ID

Every request gets a unique `chatcmpl-...` style request id at ingress. The route layer also writes it to `X-Request-Id`.

## Validation

`validateRequestMiddleware` enforces only the minimum required fields:

- `model`
- `messages`

Unknown fields pass through untouched.

## Streaming vs non-streaming

The pipeline supports both client modes end to end:

- `stream: true` keeps the provider result as a `CanonicalStream`. `respondMiddleware` writes SSE frames in the route-kind-specific wire format.
- `stream: false` or absent installs chain-level buffering in the provider path. `gatewayDispatch` maps the buffered result to a chat-completion envelope and `respondMiddleware` writes one JSON body.

Gateway post-phase middleware still runs in both modes. In streaming mode `ctx.response` is a stream instead of a buffered OpenAI-style response, so middlewares that require buffered content must buffer inline before they inspect the body.

## Route chain

`buildRouteChain()` in `src/runtime/route/run-route-request.mjs` composes this chain for completion-style routes:

```text
errorBoundary
  parseBody
  authenticate
  identity
  bindSnapshot
  normalizeIngress
  auditLog
  validateRequest
  resolveModel
  resolveSession
  respond
  gatewayDispatch
```

`auditLog` runs after authentication and ingress normalization. It inserts the initial `audit_logs` row only after the route has an authenticated API key, resolved identity headers, and a canonical requested model. It then finalizes the row after downstream completes or throws with status, timing, usage, cost, and routing metadata.

`respond` is placed before `gatewayDispatch` so its post phase runs after dispatch has populated `ctx.response`.

## Dispatch path

Inside `gatewayDispatch` (terminal middleware):

1. The middleware catalog resolves the gateway plan from unified bindings:
   - gateway-scope bindings
   - model-scope bindings for the resolved model id
2. The catalog instantiates native kernel middlewares from each bound module's `factory(settings)`.
3. The gateway chain is composed around `modelExecutionMiddleware()` and run on the same `ctx`.

`modelExecutionMiddleware()` reads `ctx.target.model` and branches on `strategyKind`:

- `direct` -> `composeDirectModelChain()` (target binding → concurrency → retry-with-attempt-subchain → finalize)
- `cascade` -> `composeCascadeModelChain()` (finalize → invoke-model capability → cascade adapter)

For each direct attempt, the inner attempt subchain runs in a forked kernel context:

```text
attemptContext     // clones ctx.request, resets attempt-local state
timeout            // installs ctx.signal for one attempt
credentialLease    // leases provider credentials, releases in finally
providerBindings   // terminal: resolves providerMiddlewares + backendDispatch

  bufferingMiddleware?       // skipped for client streaming
  provider middlewares       // from middleware_bindings(scope='provider')
  backendDispatchMiddleware  // terminal: backendCatalog.getTerminal(provider.backendKey)
```

`backendDispatchMiddleware` is the absolute terminal: it resolves the precompiled terminal middleware from the backend catalog per attempt and invokes it. The dispatch path acquires a backend-catalog generation lease before lookup and holds that lease until the buffered response has been materialized or the response stream has been fully drained, so backend reloads do not shut down a generation that is still serving an in-flight request.

See **DS003** for the full middleware composition contract and the unified backend layer.

## Full request lifecycle

```text
HTTP ingress
  -> parse/auth/identity/snapshot binding
  -> ingress normalization + validation
  -> model resolution
  -> session resolution
  -> gateway middleware chain
    -> modelExecutionMiddleware()
      -> direct model attempt OR cascade model loop
      -> provider middleware chain
      -> backend terminal
  -> respond middleware
HTTP response
```

Any middleware can short-circuit before dispatch by setting `ctx.response` or throwing a classified gateway error.

`src/public-api/embeddings-route.mjs` owns the embeddings route. It shares authentication, snapshot model resolution, provider credential leasing, and backend error classification with the rest of the gateway, but it returns the upstream embeddings JSON directly instead of converting through canonical text streams.

## Related specs

- **DS003** — middleware contract, provider middleware, and the unified backend layer
- **DS004** — model normalization, direct vs cascade routing, cooldowns, concurrency
- **DS005** — canonical streams and SSE egress
- **DS007** — rate limiting and budget enforcement in the gateway chain
- **DS009** — retry and error classification
- **DS015** — logging, sessions, and observability surfaces
