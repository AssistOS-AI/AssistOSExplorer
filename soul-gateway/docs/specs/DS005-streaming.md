# DS005 — Streaming

## Summary

Soul Gateway streams responses through one canonical event pipeline.

There are two streaming layers:

1. provider-chain streaming inside the runtime
2. route-level SSE egress to the client

Both are shipped on this branch.

## Canonical stream

Transports emit `CanonicalStream` events such as:

- `message_start`
- `text_delta`
- `tool_call_delta`
- `usage`
- `done`
- `error`

Provider protocols are normalized into that shared event stream before route egress or buffering.

For OpenAI Responses-compatible providers, the provider adapter accumulates
`response.output_text.delta` events for normal live delivery. Finalized text in
`response.output_text.done`, `response.output_item.done`, or
`response.completed` is also inspected before the canonical `done` event. If
the finalized text extends the streamed prefix, only the missing text is
emitted as one final `text_delta`; text already delivered through deltas must
not be duplicated. This is response normalization only and does not introduce
an additional provider request or retry.

## Provider-chain streaming

Inside a provider attempt:

- provider middlewares can wrap or transform the canonical stream
- chain-level buffering is optional
- lower `sort_order` wraps outermost

If the client requested buffered output, `bufferingMiddleware()` drains the canonical stream into the buffered completion shape. If the client requested streaming, the provider chain skips that outer buffer and leaves the canonical stream on `ctx.response`.

For audit logging, route-level streaming egress accumulates canonical events as they are written to the client. Text deltas, tool calls, usage, finish reason, and stream errors are captured into `ctx.metadata.responseCapture`, so streamed responses are recorded with the same capped excerpt and normalized payload shape as buffered responses. If the client disconnects mid-stream, the partial response is stored and the completed audit row is marked `status='aborted'`; if the provider emits an error mid-stream, the partial response is kept and the row is marked `status='failed'`.

## Route egress

`respondMiddleware` branches on the response shape:

- `CanonicalStream` -> write SSE
- buffered response envelope -> write one JSON body

`gatewayDispatch` sets `wantStream` from `ctx.request.stream === true`, so the route layer can preserve the stream end to end.

While route egress drains the response, it also records observability metadata:

- streaming responses update `ctx.metadata.usage` from canonical `usage` events
- streaming responses set `ctx.metadata.ttfbMs` on the first SSE write
- streaming responses store response-capture metadata after the stream finishes, aborts, or errors
- buffered responses normalize `ctx.response.usage` onto the same usage shape and set `ttfbMs` to the total buffered duration when no earlier first-byte timing exists

### SSE wire formats

Route egress supports:

- OpenAI Chat Completions chunk frames plus `[DONE]`
- Anthropic Messages named events
- OpenAI Responses named events

The response format is selected from `route.kind`.

If a route error is thrown after headers have already been sent, the error boundary emits the same route-specific terminal error shape that the streaming serializer uses for canonical `error` events:

- OpenAI Chat -> unnamed `data: {"error": ...}` frame
- Anthropic Messages -> `event: error`
- OpenAI Responses -> `event: response.failed`

## Client disconnect handling

The SSE writer listens for socket close, stops iteration, and ends the response cleanly. Back-pressure is honored through the normal `write` / `drain` flow.

## Buffered path

In non-streaming mode the buffered provider result is normalized to:

```json
{
  "message": { "role": "assistant", "content": "..." },
  "content": "...",
  "excerpt": "...",
  "finishReason": "stop",
  "usage": {
    "input_tokens": 0,
    "output_tokens": 0,
    "total_tokens": 0
  },
  "toolCalls": []
}
```

`gatewayDispatch` maps that buffered shape into the route-level OpenAI-style response envelope before `respondMiddleware` serializes it.

## Gateway post-phase caveat

Gateway post-phase middleware does not get a buffered response when the client requested streaming.

In streaming mode:

- `ctx.response` is a `CanonicalStream`
- gateway middlewares that need a buffered body must buffer inline before reading `ctx.response`
- route-level SSE still works because `respondMiddleware` consumes the stream directly

In buffered mode those same middlewares run against the buffered/OpenAI-style response as usual.

## Decisions & Questions

### Question #1: Why is finalized Responses API text used as a fallback?

Response: A Responses-compatible upstream can expose the same generated text
incrementally and in finalized events. The adapter preserves incremental
delivery as the primary path, then uses the finalized representation only to
recover a missing suffix or a response for which no text deltas arrived. This
keeps the canonical stream complete without duplicating output or changing the
gateway retry policy.

## Real-time log streaming

Separate from client-facing LLM streaming, the dashboard supports:

- WebSocket log streaming
- SSE log streaming

Those management streams publish completed request logs, not provider delta events.

## Related specs

- **DS001** — where streaming fits into the request pipeline
- **DS003** — middleware primitives for buffering and stream wrapping
- **DS007** — usage data feeds cost and budgets
- **DS015** — dashboard log streaming and observability
