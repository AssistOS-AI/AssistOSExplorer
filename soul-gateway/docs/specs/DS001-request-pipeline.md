# DS001 — Request Pipeline

## Summary

This spec describes the lifecycle of an LLM request through Soul Gateway, from HTTP ingress to final response. The same pipeline handles `/v1/chat/completions` (OpenAI Chat Completions), `/v1/messages` (Anthropic Messages), and `/v1/responses` (OpenAI Responses) after normalizing each input format to a common internal representation.

## Accepted request formats

The gateway accepts three public request formats on three distinct endpoints:

- **OpenAI Chat Completions** — the canonical internal format; other endpoints are normalized to this shape before the pipeline runs.
- **Anthropic Messages** — converted on ingress into the Chat Completions shape (system message handling, tool-use blocks, stop sequences, etc.) before routing.
- **OpenAI Responses** — converted similarly on ingress, with the `instructions` field mapped to a system message and the Responses-specific event types translated into typed chunks.

From the pipeline's perspective, all three paths land in the same normalized request object.

## Bearer token authentication

Every request requires an `Authorization: Bearer <key>` header. The token identifies the caller and determines their rate limits, budgets, and permissions. The authentication middleware validates the token against the key registry, rejects expired or revoked keys, and attaches the caller identity to the request context for downstream middlewares.

## Identity headers

Each request may carry optional identity headers that group related activity and support cross-agent observability:

- **Soul ID** — identifies the human or system behind the request.
- **Agent name** — identifies the software making the call. When the header is absent, the system infers the agent from the `User-Agent` string, recognizing common AI coding tools (Claude Code, Cursor, Copilot, Aider, Cline, Windsurf, etc.).
- **Session ID** — groups related requests into a conversation. If absent, a session ID is derived from the API key + agent name with an inactivity timeout (see DS015).

All three appear in the audit log, the real-time log stream, and the session/agent hierarchy views.

## Request ID

Every request is assigned a unique ID in an OpenAI-compatible format (`chatcmpl-...`) at ingress. The ID travels with the request through every middleware, through the upstream dispatch, into the audit log, and into every broadcasted log event so a single request can be traced end-to-end.

## Validation

Before the pipeline runs, the gateway validates that required fields are present in the request body:

- `model` — required. Used by the model router (DS004) to resolve the upstream provider and model.
- `messages` — required. An array of message objects.

Unknown fields are passed through untouched; the gateway does not enforce the OpenAI schema beyond these two required fields.

## Streaming vs non-streaming

The pipeline supports both modes:

- **Streaming** (`stream: true`) — incremental text deltas and tool-call deltas are forwarded to the client as they arrive from the upstream provider, via SSE. The stream is simultaneously captured into a buffer for the audit log, cost calculation, and post-dispatch middlewares (see DS005).
- **Non-streaming** (`stream: false` or absent) — the full response is buffered on the gateway side, middlewares see the complete response object, and the client receives a single JSON reply.

Post-dispatch middlewares always run against the buffered final response regardless of client mode, so caching, logging, filtering, token tracking, and budget accounting all see the same data shape.

## Pipeline phases

Once the request is authenticated, identified, and normalized, the pipeline runs in this order:

```
HTTP ingress
  ↓ authentication + identity resolution + request ID
  ↓ validation (model + messages present)
  ↓ gateway request middlewares          (see DS003)
  ↓ model resolution (tier fallback)     (see DS004)
  ↓ concurrency semaphore acquisition    (see DS004)
  ↓ provider request hooks               (see DS003)
  ↓ executor dispatch with HTTP retry    (see DS002, DS009)
  ↓ provider stream hooks                (see DS003)
  ↓ response collection                  (streaming tap + buffer)
  ↓ provider response hooks              (see DS003)
  ↓ gateway response middlewares         (see DS003)
  ↓ cost calculation                     (see DS007)
  ↓ audit log write + real-time broadcast (see DS015)
HTTP response
```

A request can short-circuit at any pre-dispatch point. The rate limiter (DS007) and content blocker (DS008) reject with a structured error; the cache middleware (DS014) can abort with a cached response; the loop detector (DS010) can abort with an intervention message or outright block.

## Related specs

- **DS002** — provider authentication and format converters invoked during executor dispatch.
- **DS003** — middleware, provider hook, and executor abstractions.
- **DS004** — model resolution, tier fallback, cooldown, concurrency control.
- **DS005** — streaming tap and SSE response formatting.
- **DS007** — rate limiting and budget enforcement (run as middlewares in this pipeline).
- **DS009** — error classification and retry semantics for upstream dispatch.
- **DS015** — audit log write and real-time broadcasting at the end of the pipeline.
