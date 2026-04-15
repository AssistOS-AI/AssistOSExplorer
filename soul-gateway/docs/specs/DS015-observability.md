# DS015 — Observability

## Summary

Soul Gateway treats observability as a first-class feature through:

- persistent audit logs
- real-time dashboard log streams
- metrics dashboards
- session and agent grouping
- bulk export

## Audit logging

Every public completion request is recorded in `audit_logs` via the `auditLog` route middleware. The middleware runs after authentication, identity binding, and ingress normalization. It calls `AuditLogWriter.start()` on entry to create the initial row, then calls `AuditLogWriter.finalize(startedAt, logId, fields)` after downstream completes or throws. Both success and error outcomes are captured.

Log entries include:

- identity fields such as soul id, agent, session, API key, request id
- routing fields such as requested model, resolved model, resolved provider, and serving account
- token counts, price-derived costs, queue wait, and latency metadata
- retry trace and cascade metadata
- response excerpt when a buffered assistant message is available
- outcome flags such as cached, blocked, cascaded, and streaming

The current hot path does not persist full request bodies or full streamed transcripts in `audit_logs`; it stores structured metadata plus a buffered response excerpt when available.

`ttfb_ms` records the time from `ctx.startedAt` to the first SSE chunk written for streaming responses. For buffered responses, where nothing is written to the socket until the full body is serialized, `ttfb_ms` is set equal to `latency_ms` — there is no earlier "first byte" to record on that code path.

### Failure policy (best-effort)

Audit writes are explicitly best-effort and are an intentional exception to the project-wide fail-fast rule. Rationale:

- The audit system is observability, not request-serving state. Failing a user request because the audit database is unreachable would turn an observability outage into a user-visible outage.
- `AuditLogWriter.start()` and `finalize()` are still awaited inline on the request path, so database slowness can add latency. The best-effort policy only changes failure propagation: write errors are logged and the request continues.

Concretely, `auditLogMiddleware()` in `src/runtime/route/audit-log.mjs`:

- catches errors from `writer.start()` and logs at `error` level, but allows `next()` to proceed (the log row is absent; `audit.logId` is null and finalize is skipped);
- catches errors from `writer.finalize()` and logs at `error` level, but does not fail the request;
- re-throws any error caught from `next()` after finalize runs, so downstream errors still propagate to the error boundary.

When `appCtx.services.auditLogWriter` is absent (null/undefined — typically only in narrowly-scoped unit tests), the middleware skips audit recording without throwing. The production bootstrap in `src/bootstrap/service-installers.mjs` always installs the writer, so this branch does not execute in deployed environments.

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
