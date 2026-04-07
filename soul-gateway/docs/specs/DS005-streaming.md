# DS005 — Streaming

## Summary

This spec describes how Soul Gateway handles streaming LLM responses — both SSE pass-through to clients and the internal tap that captures the stream for logging, cost calculation, and post-dispatch middlewares — and how non-streaming requests are buffered on the gateway side. It also covers the real-time log broadcasting layer that streams audit events to dashboard subscribers.

## Streaming response path

When a client sends `stream: true`, the pipeline forwards incremental chunks from the upstream provider to the client as Server-Sent Events while simultaneously capturing the full response into an internal buffer.

- Upstream providers emit typed chunks through the shared transport layer (`achillesAgentLib`): `text_delta`, `tool_calls_delta`, `usage`, `done`, `error`. This is the same chunk shape regardless of whether the upstream speaks OpenAI SSE, Anthropic named events, AWS binary event streams, or Copilot's Responses API — the format converter normalizes everything to the shared shape before the chunks enter the pipeline.
- Each chunk is re-encoded as an OpenAI SSE event and written to the client connection.
- Each chunk is also appended to a buffer that captures the final content, tool calls, finish reason, and token usage for the audit log and for post-dispatch middlewares.
- Client disconnection aborts the upstream call via an `AbortController` so the gateway doesn't keep fetching tokens nobody will see.
- The stream terminates with an OpenAI-shaped `data: [DONE]` sentinel when the upstream `done` chunk arrives.

## Non-streaming response path

When a client sends `stream: false` (or omits the field), the pipeline collects the full response into a buffer before returning. The same streaming tap machinery runs internally, but instead of forwarding chunks to the client, the complete buffered response is serialized as a single JSON object and returned once the stream completes.

Post-dispatch middlewares always run against this buffered response regardless of the client's streaming preference, so caching, logging, filtering, token tracking, and budget accounting see the same data shape in both modes.

## Tool-call streaming

Tool calls are streamed the same way text content is, through `tool_calls_delta` chunks that carry the incremental function name, arguments, and index. The collector accumulates these into the final `choices[0].message.tool_calls` array in the buffered response. Providers that emit complete tool calls in a single chunk (rather than streaming them token-by-token) still produce a single `tool_calls_delta` event with the full payload.

## Usage and finish reason

The `usage` chunk carries token counts (`prompt_tokens`, `completion_tokens`, `total_tokens`) for cost calculation (see DS007). Upstream providers vary in when they emit usage: some stream it as a final event before `done`, some include it in `done` itself, and some (notably Kiro) don't provide usage data at all — in which case the `usage` object is null and cost reporting falls back to per-request pricing or estimated counts.

The `done` chunk carries the finish reason (`stop`, `length`, `tool_calls`, `content_filter`, etc.), which is mapped to the OpenAI finish-reason vocabulary regardless of the upstream's native terminology.

## Real-time log broadcasting

In addition to client-facing SSE, the gateway broadcasts completed request logs to connected dashboard subscribers in real time via two protocols:

### WebSocket

A full-duplex connection exposed at the management API. Subscribers can apply optional filters by soul ID and model, update their filters without reconnecting, and receive a heartbeat that keeps the connection alive through network proxies and tunnels (default heartbeat interval 15 seconds, tuned to survive Cloudflare tunnel timeouts). The server implementation follows RFC 6455 and supports text frames only.

### Server-Sent Events (SSE)

A one-way stream for environments where WebSocket is unavailable. Same filtering support as the WebSocket path. Periodic keepalive comments prevent timeout on long-lived connections.

### Soul-specific stream

A dedicated endpoint provides unredacted logs (including full request/response content) for a single soul ID. Useful for debugging individual users or agents. Access is gated by the management API's auth.

## Related specs

- **DS001** — where streaming slots into the request pipeline.
- **DS002** — format converters that normalize upstream responses into the shared chunk shape.
- **DS007** — usage data from streaming is what feeds cost calculation.
- **DS015** — audit log + metrics that are populated after the stream completes.
