---
title: DS006-secrets-product-model
summary: Defines the dpuAgent contract covered by DS006-secrets-product-model.
---

# DS006-secrets-product-model

## Introduction

This specification defines the active contract for [dpuAgent](wiki.html#definition-dpuagent).

## Core Content

### DS06 - Explorer-Facing DPU Model

### Summary

This page describes how the [DPU](wiki.html#definition-dpuagent) domain appears to Explorer. The important point is that Explorer may render [DPU](wiki.html#definition-dpuagent) records in file-like views, but the underlying contract remains DPU-specific.

### Background / Problem Statement

Explorer needs to present confidential content in a way that users can navigate, preview, comment on, and manage. At the same time, the [DPU](wiki.html#definition-dpuagent) domain should not collapse back into ordinary filesystem semantics just because the UI looks file-like in places.

### Explorer Boundary

The current contract exposed by [`dpuAgent`](wiki.html#definition-dpuagent) gives Explorer four virtual confidential roots:

- `/Confidential/My Space`
- `/Confidential/Shared`
- `/Confidential/Secrets`
- `/Confidential/Audit`

These roots come from `getWorkspaceRoots()`. They are not directories on disk.

Secrets are represented as [DPU](wiki.html#definition-dpuagent) secret records. Confidential files and folders are represented as confidential object records. Audit logs are represented as read-only JSONL file records. Explorer consumes these records through the [DPU](wiki.html#definition-dpuagent) tool surface and through the [DPU](wiki.html#definition-dpuagent) runtime-support plugins rather than through direct filesystem access.

### How Explorer Uses The Model

Explorer uses the model through these supported operations:

- Explorer can ask [DPU](wiki.html#definition-dpuagent) for visible secret records and confidential object records
- Explorer can ask [DPU](wiki.html#definition-dpuagent) for audit configuration and visible audit log files when the actor is allowed to view them
- Explorer can use the returned capability flags such as `canRead`, `canComment`, and `canWrite`
- Explorer permissions flows use the [DPU](wiki.html#definition-dpuagent) runtime-support modal
- Explorer comments flows use the [DPU](wiki.html#definition-dpuagent) comments popover plugin

This means Explorer remains the presentation layer, but the [DPU](wiki.html#definition-dpuagent) agent remains the source of truth for:

- who the current actor is
- which virtual confidential roots exist
- which records are visible
- whether content, comments, and access control list ([ACL](wiki.html#definition-acl)) details should be materialized

For secrets, [ACL](wiki.html#definition-acl) principals are not limited to end users. [DPU](wiki.html#definition-dpuagent) also supports agent-scoped principals derived by [Ploinky](wiki.html#definition-ploinky) as `agent:<repo>/<agent>` (for example `agent:AssistOSExplorer/gitAgent`), recorded in `permissions.manifest.json` the same way canonical user principals are recorded. This lets a system agent read or update a specific secret without changing the default owner semantics for every secret in the workspace. DPU-owned `agentPolicies` (managed through `dpu_agent_policy_set`) declare the maximum roles each agent principal may receive for secrets; the [ACL](wiki.html#definition-acl) still records which concrete secret actually granted the role.

For audit, Explorer may also submit client-side event records through the dedicated ingest tool. Typical event classes include `file.open`, `file.update`, `explorer.action`, `plugin.used`, `copilot.prompt`, and `copilot.response`. Even in that flow, [DPU](wiki.html#definition-dpuagent) remains the only component that persists audit files.

### Practical Boundary

The file-like presentation in Explorer should not be confused with normal workspace persistence. Secret values do not go through ordinary filesystem save flows. Confidential file content is not stored in the regular workspace tree. Access control list updates are [DPU](wiki.html#definition-dpuagent) operations, not Explorer-local metadata changes.

The same applies to `/Confidential/Audit`: Explorer may preview audit logs like files, but only [DPU](wiki.html#definition-dpuagent) may append records or enable and disable audit collection.

That boundary is the main reason [DPU](wiki.html#definition-dpuagent) exists as a separate agent instead of as a thin UI helper inside Explorer.

[dpuAgent](wiki.html#definition-dpuagent) must preserve the responsibilities, boundaries, and observable results stated in this specification.
