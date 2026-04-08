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

## Provider-chain streaming

Inside a provider attempt:

- provider middlewares can wrap or transform the canonical stream
- chain-level buffering is optional
- lower `sort_order` wraps outermost

If the client requested buffered output, `bufferingMiddleware()` drains the canonical stream into the buffered completion shape. If the client requested streaming, the provider chain skips that outer buffer and leaves the canonical stream on `ctx.response`.

## Route egress

`respondMiddleware` branches on the response shape:

- `CanonicalStream` -> write SSE
- buffered response envelope -> write one JSON body

`gatewayDispatch` sets `wantStream` from `ctx.request.stream === true`, so the route layer can preserve the stream end to end.

### SSE wire formats

Route egress supports:

- OpenAI Chat Completions chunk frames plus `[DONE]`
- Anthropic Messages named events
- OpenAI Responses named events

The response format is selected from `route.kind`.

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
