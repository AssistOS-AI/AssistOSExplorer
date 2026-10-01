---
title: DS009-workspace-monitoring
summary: Defines the Workspace Monitor integration as an agent-owned operational view mounted in Explorer.
---

# DS009 Workspace Monitoring

## Introduction

Workspace monitoring is surfaced in Explorer as an integration while the Workspace Monitor agent owns collection, persistence, and its operational APIs.

## Core Content

Explorer may mount the Workspace Monitor plugin only when the runtime plugin policy enables it. The plugin must show agent-provided operational data and actionable failure states without assuming that browser data is authoritative.

The Workspace Monitor agent must own collection intervals, stored observations, access checks, and MCP operations. Explorer must not write monitoring state directly or present a healthy status when the monitor has not supplied a verified result.

Explorer must obtain current resource snapshots through the administrator-authorized Workspace Monitor MCP tool. The agent must derive that snapshot from Ploinky's signed private metrics stream, expose only its allowlisted projection with freshness metadata, and report unavailable or stale data explicitly. Runtime process liveness and semantic readiness are distinct: Explorer may show both, but its ready total and healthy presentation must use Ploinky's current-run readiness result rather than raw container liveness. Explorer must not use the Router's localhost-only status endpoint as a deployment-dependent browser data source.

When Ploinky supplies applied hardware limits, Workspace Monitor shows CPU and memory usage against those limits and reports GPU shares as configured best-effort values. It never edits policy; editing belongs to Settings → Hardware limits. It distinguishes runtime liveness, semantic readiness, direct refusal and blocked dependency. Optional no-wait failures do not block their parent unless it explicitly waits on the result.

## Conclusion

The monitoring surface extends the workspace shell without merging operational state into Explorer.
