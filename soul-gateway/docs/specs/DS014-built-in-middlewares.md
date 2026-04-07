# DS014 — Built-in Middlewares

## Summary

This spec catalogs the 12 gateway middlewares that ship with Soul Gateway out of the box. Each one is a hook module loaded at startup, registered into the middleware catalog, and available for assignment to tiers or models via the management API.

The middleware framework itself (hook contract, assignment semantics, execution order, abort mechanics) lives in DS003. This spec only documents **what** each middleware does at a capability level.

## Middleware catalog

### 1. Response cache

**Phase:** pre-dispatch (can abort with cached response)

Returns a stored response for identical prompts, avoiding redundant LLM calls. Keyed by a hash of the messages and model name. When the cache hits, the middleware aborts the pipeline with the cached response as if the upstream had just returned it — downstream post-dispatch middlewares (logging, token tracking) still see a normal response and record the cache hit in the audit log with a `cached: true` flag.

Configurable settings: cache TTL, maximum cache size, which message roles are included in the hash, optional namespace for multi-tenant cache isolation.

### 2. Rate limiter

**Phase:** pre-dispatch (can abort with 429)

Enforces per-key RPM limits in a sliding 60-second window. Reads the effective RPM limit by walking per-model override → per-tier override → per-key default (see DS007). When the limit is exceeded, rejects the request with `429 rate_limit_error` and retry guidance.

Configurable settings: override the limit, override the window size.

### 3. Budget enforcer

**Phase:** pre-dispatch (can abort with 429) **and** post-dispatch (updates spend tracking)

Checks daily and monthly spending limits before dispatch and tracks spend after. Reads current daily spend from the spend cache (DS007) and blocks the request if adding the estimated cost of the pending request would exceed the budget. Post-dispatch, adds the actual cost of the completed request to the cache. Free models are exempt.

Configurable settings: override daily budget, override monthly budget.

### 4. Content blocker

**Phase:** pre-dispatch (can abort with 400)

Scans incoming messages against the blacklist rule set (see DS008). On match, rejects the request with a `content_blocked` error including the matching rule description. Matching rules are recorded in the audit log for review.

Configurable settings: (none — the middleware reads the shared blacklist rules from the DB).

### 5. Loop detector

**Phase:** both (pre-dispatch and post-dispatch)

Detects agent loops via response fingerprinting and growth-with-repetition heuristics (see DS010 for the detection algorithm). On detection, the middleware can intervene (inject a warning system message), block (reject the request), or log-only (observation mode). Detection state is session-scoped and persisted in the session state store.

Configurable settings: similarity window, similarity threshold, growth token threshold, growth repetition threshold, minimum responses, mode (`intervene` / `block` / `log`), intervention message.

### 6. Context compressor

**Phase:** pre-dispatch (mutates the request)

Summarizes older messages when the conversation exceeds the model's context window limit. Uses a character-based heuristic (4 characters per token by default) to estimate token usage and preserves a configurable number of recent messages verbatim. Older messages are replaced with a condensed summary generated inline.

Configurable settings: context window limit, number of recent messages to preserve, summarization prompt template.

### 7. System prompt injector

**Phase:** pre-dispatch (mutates the request)

Prepends or appends a configurable system message to every request. Useful for enforcing a global persona, a compliance disclaimer, or environment-specific guidance.

Configurable settings: content, position (`prepend` / `append`), role (`system` / `developer`).

### 8. Session context

**Phase:** both (pre-dispatch and post-dispatch)

Maintains a rolling summary of key facts from the conversation, injected into each request for continuity. Unlike the context compressor (which shrinks the current message array in place), the session context middleware persists summary state in the session state table across requests and injects it as additional context on subsequent calls in the same session.

Configurable settings: summary length, which facts to track, summary update frequency.

### 9. Token tracker

**Phase:** post-dispatch (records metrics)

Records tokens-per-minute usage after each response. Feeds the TPM soft-limit tracking (see DS007) and the token metrics dashboards (see DS015). This middleware is passive — it never blocks or modifies requests.

Configurable settings: (none — it always tracks).

### 10. Request logger

**Phase:** both (pre-dispatch and post-dispatch)

Logs request/response metadata for debugging. Writes detailed structured log entries including the request body, resolved model, provider, any middleware mutations, upstream errors, retry sequence, and final response. Used for post-incident analysis and development troubleshooting.

Configurable settings: log level, which fields to include, maximum log entry size (for truncation of very large bodies).

### 11. Response filter

**Phase:** post-dispatch (mutates the response)

Applies regex-based redaction to response content. Configurable patterns (see DS008) are applied in order, each pattern operating on the output of the previous one. Used for masking emails, API keys, phone numbers, or other sensitive data that might leak through an upstream LLM.

Configurable settings: pattern list (each entry: `pattern`, `replacement`, `flags`, `description`).

### 12. Output compressor

**Phase:** pre-dispatch (mutates the request)

Truncates verbose tool output or CLI results in messages to stay within token limits. Applies to tool-role, function-role, and array-style multimodal content. Unlike the context compressor (which summarizes older messages), the output compressor targets specific content types known to produce pathologically long outputs (e.g. a `grep -r` result or a directory listing).

Configurable settings: maximum length per tool output, truncation marker string, which tool names to apply to (whitelist/blacklist).

## Middleware assignment

Any of these middlewares can be assigned to a tier (applies to every request routed through the tier) or a specific model (applies only when that model is resolved). Per-assignment settings override the middleware's defaults.

Execution order is: tier-level middlewares → model-level middlewares, with each level sorted by the assignment's configured `sort_order`.

## Related specs

- **DS003** — the middleware framework that defines the hook contract and assignment model.
- **DS007** — rate limiting and budget enforcement that the rate limiter and budget enforcer middlewares apply.
- **DS008** — content blocking rules and response filter pattern configuration.
- **DS010** — the loop detection algorithm.
- **DS014** — this file (meta-reference).
- **DS015** — metrics and audit log fields the token tracker and request logger populate.
