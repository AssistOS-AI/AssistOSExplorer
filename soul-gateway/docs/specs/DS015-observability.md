# DS015 — Observability

## Summary

This spec describes the audit log, the real-time log broadcasting layer, the metrics dashboards, session and agent tracking, and data export. Soul Gateway treats observability as a first-class feature: every request is recorded in a persistent audit log with full context, the same events are streamed to dashboard subscribers in real time, and aggregated metrics are available across multiple dimensions.

## Audit logging

Every request (success or failure) is recorded in a persistent audit log. Each log entry includes:

- **Identity** — soul ID, agent name, session ID, API key ID, request ID
- **Routing** — requested model, resolved model, tier name, provider id
- **Request** — full request body (unless truncated for size), messages array, parameters
- **Response** — full response body, finish reason, token counts (input / output / total), cost components
- **Timing** — overall latency, time-to-first-byte, HTTP retry durations
- **Retry details** — structured array of retry attempts with status, error type, delay, account used
- **Flags** — `cached`, `blocked`, `truncated`, `slow`, `oversized`, `loop_detected`, `content_blocked`
- **Error** — HTTP status, error type, error message (redacted if response filter matched)

Logs are retained for a configurable period (default 90 days) and automatically purged after expiration via a background partition-maintenance job. The audit_logs table is partitioned by month for query performance and retention management (see DS006).

### Redaction

When the response filter middleware (DS014) matches a pattern in the final response content, the matched span is replaced with the configured replacement before the log entry is written. The audit log stores the redacted content, not the raw upstream response, so operators can't inadvertently read PII by scrolling through logs.

### Truncation

Very large requests and responses are truncated at a configurable size threshold before being stored, and the `truncated` flag is set on the log entry. A small excerpt is preserved so the entry is still useful for debugging.

## Real-time log streaming

The system broadcasts completed request logs to connected subscribers in real time via two protocols. Both protocols deliver the same log entries — the choice is purely about client connectivity constraints.

### WebSocket

- Full-duplex RFC 6455 WebSocket at the management API.
- Supports optional filtering by soul ID and model.
- Subscribers can update their filters without reconnecting by sending a filter message over the existing connection.
- A heartbeat keeps connections alive through network proxies and tunnels (default 15-second interval, tuned to survive Cloudflare tunnel timeouts).
- Authentication uses the same admin session token as the management API.

### Server-Sent Events

- One-way stream for environments where WebSocket is unavailable.
- Same filtering support as the WebSocket path.
- Periodic keepalive comments prevent timeout on long-lived connections.

### Soul-specific stream

A dedicated stream provides unredacted logs (including full request/response content and pre-redaction matches) for a single soul ID. Useful for debugging individual users or agents. Access is gated by the management API's auth and typically reserved for troubleshooting sessions.

## Metrics dashboards

Metrics are aggregated across configurable time ranges and dimensions:

- **Cost metrics** — aggregated spending by model, API key, agent, and soul, with daily/monthly breakdowns and trend data.
- **Usage metrics** — request counts and token totals, broken down by any dimension.
- **Error metrics** — error rates by type with timestamps and affected models.
- **Activity metrics** — request timeline with success/failure breakdown.
- **Token metrics** — token usage distribution across models and time periods.
- **System metrics** — operational health indicators including queue depths, active streams, and resource usage.

Each metric dashboard on the management UI is backed by an aggregate query over the audit log. For high-volume deployments, the aggregate queries rely on the partitioned audit_logs table (see DS006) hitting only the relevant monthly partitions.

## Session and agent tracking

The system groups requests into sessions based on API key, agent name, and a configurable inactivity timeout (default 30 minutes). Sessions can be browsed and their request logs retrieved, including through a dedicated session-scoped log listing.

An agent hierarchy view shows:

```
souls → agents → sessions → individual requests
```

This view is useful for understanding cross-request activity: which humans are using which tools, which tools are running which sessions, which sessions are producing which requests.

### Session state

Beyond the audit log, session state (rolling response fingerprints, cumulative token counts, session context summaries) is persisted in a separate session state table (see DS006) that the loop detector (DS010) and the session context middleware (DS014) read and write.

## Data export

Audit logs can be exported in bulk as CSV or JSON, with filters for time range, soul ID, model, and status. The export runs as a streaming query so very large exports don't pin the dashboard process on memory.

## Background jobs

The runtime starts these observability-related background jobs on startup (see DS013):

- **Partition maintenance** — creates next month's audit log partition in advance and drops partitions older than the retention period.
- **Log retention purge** — runs alongside partition maintenance to delete any rows in retained partitions that are older than the retention cutoff.
- **Metrics aggregation** — (if caching is enabled) pre-computes some dashboard aggregates to reduce query load for frequently-viewed dashboards.

## Related specs

- **DS001** — the request pipeline phase where audit log entries are written and broadcast.
- **DS005** — the same real-time broadcasting layer used for WebSocket/SSE is described in streaming context.
- **DS006** — the `audit_logs`, `session_state`, and `sessions` tables that back this spec.
- **DS007** — per-key spend tracking that reads from the audit log.
- **DS009** — retry fields in the audit log.
- **DS013** — the background jobs for partition maintenance and log retention.
