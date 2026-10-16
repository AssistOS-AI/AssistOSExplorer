---
title: DS011-observability-and-lifecycle
summary: Defines audit capture, metrics, sessions, live log delivery, scheduled maintenance, health, and graceful shutdown.
---

## Introduction

Soul Gateway records enough request, routing, policy, provider, usage, and error information for administrators to diagnose and account for model activity. Operational services remain bounded so an observability failure does not normally replace an otherwise valid inference result.

## Core Content

### Audit capture

The route chain must assign a request identifier and initialize audit capture before validation and model dispatch. The final audit record should include authenticated key identity, soul and agent identity when supplied, session, ingress format, requested and resolved models, provider and account identifiers, timing, retry and cascade trace, status, normalized usage, calculated cost, and classified errors where available.

Request and response capture must enforce configured size and excerpt limits. Redaction must remove bearer tokens, provider secrets, OAuth tokens, encryption material, cookies, and other recognized credentials from stored and broadcast payloads. Audit writes may be asynchronous, but shutdown must flush pending updates within its operational boundary.

### Metrics and grouping

Metrics services must derive cost, usage, error, activity, and token views from stored audit data. System metrics must sample process and gateway state at the configured interval. Session grouping must use the verified API-key owner and supported soul or agent identifiers so management views can relate requests without treating caller-supplied identity as authorization.

### Live delivery and export

The broadcast hub must distribute completed or updated audit rows to authenticated SSE and WebSocket subscribers and apply supported filters. It must send heartbeats or pings at configured intervals, remove disconnected subscribers, and stop all subscriptions during shutdown. Exports must page through stored rows using <code>EXPORT_BATCH_SIZE</code> and produce valid JSON or escaped CSV.

### Background jobs

The scheduler must prevent concurrent runs of the same named job. It must clean expired cooldowns, prepare and retain audit partitions, refresh expiring OAuth tokens, restore quota-eligible accounts, clean stale spend-cache entries, and refresh provider model catalogs at configured intervals. A failed run must be logged and must release the job's running latch so a later interval can retry.

Ploinky discovery uses its own timer and must be cleared during shutdown. Disabled refresh intervals must not schedule work where the implementation defines zero as disabled.

### Health

<code>GET /healthz</code> and <code>GET /healthz/</code> must report process liveness, SQLite query reachability, snapshot generation, and uptime. The response may remain HTTP 200 when the process is alive but the <code>db</code> field reports a failed probe, allowing operators to distinguish process and database state.

### Graceful shutdown

On the first termination signal, Soul Gateway must stop accepting new connections, mark the application as draining, stop scheduled and discovery work, close live subscribers, wait for active requests up to <code>SHUTDOWN_GRACE_MS</code>, flush audit writes, shut down backend generations, and close SQLite. A second signal may force process exit. Shutdown errors must be logged and must not prevent later cleanup stages from being attempted where the coordinator can continue safely.

### Failure boundary

Audit, metric, broadcast, and export failures are best-effort unless another specification makes their result part of an authorization, budget, or safety decision. Mandatory policy checks must not silently degrade merely because their evidence is also used for observability.
