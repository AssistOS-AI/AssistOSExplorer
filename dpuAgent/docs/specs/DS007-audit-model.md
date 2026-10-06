---
title: DS007-audit-model
summary: Defines the dpuAgent contract covered by DS007-audit-model.
---

# DS007-audit-model

## Introduction

This specification defines the active contract for dpuAgent.

## Core Content

### DS07 - Audit Model and Persistence

### Summary

DPU maintains an always-enabled append-only audit for security operations, file access, Explorer actions, and plugin usage. It never records AI, LLM, or Copilot prompts or responses. Daily files are retained for 90 days by default; deployments may set `DPU_AUDIT_RETENTION_DAYS` to another positive number of days. Retention runs at most once per UTC day per data root across processes: after a successful prune DPU records the day in `<auditRoot>/.retention-day`, written through a uniquely named temporary file. The marker is best-effort. An unreadable or corrupt marker counts as absent, and a marker read or write error is logged and never fails an audit append. A marker only defers pruning, so lowering `DPU_AUDIT_RETENTION_DAYS` takes effect on the next UTC day.

### Architecture

Audit events originate from DPU domain mutations or the dedicated `dpu_audit_event_append` MCP tool. DPU sanitizes metadata and writes one JSON object per line to append-only daily JSONL files in its private persistent data root, exposed through the virtual `/Confidential/Audit` view.

### Fixed Policy

- DPU operations: enabled
- file access: enabled
- Explorer actions: enabled
- plugin usage: enabled
- AI activity: disabled

This policy is not user-configurable. `dpu_audit_config_get` exposes the effective read-only policy and access capability. There is no configuration mutation tool.

### Data Model

Records contain an ISO timestamp, event or operation name, sanitized actor, target, metadata, status, and a redacted error where applicable. Values, document bodies, messages, prompts, and responses are removed by the DPU boundary.

### Access Control

Only authenticated users with `admin` or `security` roles, including `local:admin`, may list or read audit files. Audit files cannot be edited or deleted through MCP tools.

## Conclusion

dpuAgent must preserve the responsibilities, boundaries, and observable results stated in this specification.
