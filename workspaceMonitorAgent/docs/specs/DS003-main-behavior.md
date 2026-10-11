---
title: DS003-main-behavior
summary: Defines the three essential Workspace Monitor behaviors: live collection, bounded history, and administrator operations.
---

# DS003 Main Behavior

## Introduction

[Workspace Monitor](wiki.html#definition-workspace-monitor) lets an administrator observe Ploinky workspace resources over time and inspect the related Router and Policy logs without granting those operations to ordinary participants.

## Core Content

### Main Behavior Components

| Name | Explanation |
| --- | --- |
| Live resource collection and persistence | The collector preserves Ploinky's semantic runtime readiness, turns snapshots into aggregate and per-runtime CPU and memory series, and stores them durably. |
| Historical resource queries and thresholds | Administrators retrieve bounded, bucketed history with the threshold values recorded alongside observations. |
| [Administrator](wiki.html#definition-administrator) settings and log access | Verified administrators can read or update settings and list, read, or search Ploinky-owned logs. |

### Live resource collection and persistence

The affected actor is an administrator who needs current and durable resource observations. Ploinky's private metrics stream triggers the collector to parse each snapshot, preserve the distinction between a live process and a runtime that passed current-run readiness, derive workspace and Router aggregates, and identify available runtime series. The collector atomically stores an allowlisted current projection for the administrator-only snapshot tool, persists each historical series at most once per ten seconds in SQLite, and retries either output independently after a failure. The observable result is a fresh current view whose ready count cannot include a no-wait runtime that is still starting or failed, plus durable CPU or memory history for the workspace, Router, and each available runtime. The governing boundary is that live metrics and semantic readiness come only from the signed private Ploinky stream; Explorer must use the agent tool rather than a Router control endpoint.

### Historical resource queries and thresholds

The affected actor is an administrator reviewing resource behavior across a bounded time range. The history tool validates ISO-8601 from and to values, rejects ranges longer than thirteen months, caps maxPoints at 50,000, and buckets samples using the requested series. The observable result contains peak values, the threshold attached to each peak, and the latest threshold for each bucket. Workspace and Router thresholds come from settings; runtime series use a zero threshold because no runtime-specific threshold is configured.

### Administrator settings and log access

The affected actor is an administrator managing monitoring policy or investigating Ploinky operations. Each of the seven MCP tools first resolves the verified invocation actor and applies the administrator check. Snapshot reads report availability, age, and staleness with the allowlisted resource projection; settings reads and updates operate on normalized settings.json; log list, get, and search operations call Ploinky's signed private log route for Router or Policy sources. The observable result is current resources, normalized settings, bounded history, or Ploinky log data. The boundary is that client-declared roles and ordinary participant access cannot authorize a request.

The product succeeds when administrators can inspect durable workspace resource evidence and Ploinky logs through the configured tools while the private Router and agent authorization boundaries remain intact.
