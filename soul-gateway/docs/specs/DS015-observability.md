# DS015 — Observability

## Summary

Soul Gateway treats observability as a first-class feature through:

- persistent audit logs
- real-time dashboard log streams
- metrics dashboards
- session and agent grouping
- bulk export

## Audit logging

Completed requests are recorded in `audit_logs`.

Log entries include:

- identity fields such as soul id, agent, session, API key, request id
- routing fields such as requested/resolved model and provider
- request/response payload excerpts or full content depending on size limits
- token counts and cost
- latency and retry metadata
- outcome flags such as cached/blocked/content-blocked/loop-detected

Large payloads can be truncated before storage.

Historical import note:

- `soul-gateway/src/db/import/import-main-branch-data.mjs --include-call-logs` can backfill `main`-branch `call_logs` into `audit_logs`
- that same import pass also derives closed `sessions` rows from the imported log stream so historical session browsing continues to work in the current dashboard

## Real-time log streaming

The dashboard supports:

- WebSocket log streams
- SSE log streams
- soul-specific log streams

These streams publish completed log records, not raw provider delta events.

## Metrics

The management UI exposes aggregate views for:

- cost
- usage
- errors
- activity
- tokens
- system health

Those queries are backed primarily by `audit_logs` and related runtime state.

## Session and agent grouping

Requests are grouped into sessions and agents for browsing and filtering in the dashboard.

Current runtime note:

- active loop-detector and session-context working state is kept in memory by the built-in middlewares
- the schema still includes `session_state`, but it is not the primary hot-path backing store for those built-ins on this branch

## Export

Audit logs can be exported as CSV or JSON with filters.

## Background jobs

Observability-related background work includes audit-log partition maintenance and retention-related cleanup.

## Related specs

- **DS005** — dashboard log streaming protocols
- **DS006** — `audit_logs`, `sessions`, and `session_state` schema
- **DS007** — spend and usage data derived from request outcomes
- **DS013** — startup/shutdown and background-job lifecycle
