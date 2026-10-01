---
title: DS004-monitoring-and-history
summary: Defines metric aggregation, per-runtime series, threshold recording, bucketization, and history limits.
---

# DS004 Monitoring And History

## Introduction

This specification defines how collected resource observations become queryable history.

## Core Content

The collector must derive workspace CPU and memory from available runtime metrics, with a fallback to total metrics minus Router metrics when runtime details are absent. Router CPU and memory must be recorded as separate series. Each available runtime must receive encoded CPU and memory series keyed by repository and agent identity when those fields exist, or by the runtime container identity.

The current-snapshot projection must omit Router process identifiers and any unrecognized top-level, Router, runtime, state, or metrics fields. A read must return no snapshot before collection begins, return freshness metadata with a valid projection, and distinguish a stale projection from a current one. Explorer must not graph the same sampling instant more than once.

Recognized hardware fields are bounded `limits.cpu` (cores, assurance), `limits.memory` (bytes, assurance) and `limits.gpu` (smPercent, vramBytes, assurance), plus the specified current-instance hardware availability and bounded causal problem. CPU/memory assurance is kernel or none; GPU assurance is best-effort or none. Missing hardware fields preserve the existing projection. Problems retain direct dependency and originating refusal with bounded reason/fix text and explicit omitted-path counts. Refused and blocked instances never contribute to the ready count, even if an older source reports process liveness or readiness.

A persistence checkpoint must be tracked independently per series and must use the ten-second cadence. A failed persistence call must not advance that checkpoint. Invalid series keys, non-finite values, and non-finite thresholds must be rejected before SQLite commit.

History queries must accept a selected set of aggregate or supported runtime series and return bucketed values, peak timestamps, peak thresholds, and latest bucket thresholds. A request must contain a later to instant, remain within thirteen months, and return at least two and at most 50,000 points per series.

The Explorer history view must recover from transient gateway failures (HTTP 502, 503, or 504, including origin_bad_gateway) and browser network failures with at most three retries after 300, 900, and 1,800 milliseconds. This retry budget includes existing session-generation recovery attempts. Gateway and network retries must be limited to the read-only history query; tool validation and authorization failures must not trigger them, and monitor mutations must not gain these retries.

After an unsuccessful history load, the dashboard must show a concise, actionable message and a Retry history control without exposing a raw gateway response. Live resource polling remains independent of history recovery. A new runtime selection or history interval, a cleared selection, a tab change, or dashboard unload must cancel pending retry delays and invalidate obsolete results and errors, including when the replacement interval is invalid. The shared MCP transport may finish an already-issued request, but its abandoned response must not update the interface or schedule another attempt.

## Conclusion

History preserves enough metric and threshold context for administrators to compare resource peaks with the settings that were active when they were recorded.
