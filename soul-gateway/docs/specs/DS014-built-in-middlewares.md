# DS014 — Built-in Middlewares

## Summary

Soul Gateway ships twelve built-in gateway middlewares. They are loaded into the middleware catalog and can be bound through `middleware_bindings`.

Built-in modules export the native `{ meta, factory(settings) }` contract and execute directly through the shared kernel.

## Catalog

1. **Response cache**
   Returns cached buffered responses for matching prompts and can short-circuit before dispatch.

2. **Rate limiter**
   Enforces per-key RPM in a sliding window. Uses `overrideRpmLimit` from the binding when present, otherwise the API-key default.

3. **Budget enforcer**
   Enforces daily/monthly spend limits and records cost back into the shared spend cache after successful buffered responses.

4. **Content blocker**
   Rejects requests that match blacklist rules before any upstream call.

5. **Loop detector**
   Tracks recent response fingerprints and cumulative token growth in in-memory per-session state, then logs, intervenes, or blocks.

6. **Context compressor**
   Shrinks long conversations before dispatch.

7. **System prompt injector**
   Adds a configured system/developer message before dispatch.

8. **Session context**
   Injects persisted session summary/context when configured.

9. **Token tracker**
   Records usage metrics after buffered responses.

10. **Request logger**
   Records request/response details for observability.

11. **Response filter**
   Applies regex replacements to buffered response content. In client-streaming mode it usually no-ops because the response is still a stream.

12. **Output compressor**
   Truncates oversized tool/function output before dispatch.

## Assignment model

Built-in gateway middlewares can be bound at:

- gateway scope
- direct-model scope
- cascade-model scope

The dashboard exposes tier endpoints as a management/editor surface over cascade models, and those routes still write model-scoped bindings targeting cascade models.

Execution order is:

1. gateway-scope bindings
2. model-scope bindings for the resolved model

Within each scope, lower `sort_order` runs earlier on the way in and later on the way out.

## Related specs

- **DS003** — middleware contract and kernel runtime
- **DS007** — rate limiting and budgets
- **DS008** — content blocker and response filter behavior
- **DS010** — loop detector behavior
- **DS012** — management APIs for listing/binding middlewares
