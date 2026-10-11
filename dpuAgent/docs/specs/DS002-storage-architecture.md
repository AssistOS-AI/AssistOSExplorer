---
title: DS002-storage-architecture
summary: Defines the dpuAgent contract covered by DS002-storage-architecture.
---

# DS002-storage-architecture

## Introduction

This specification defines the active contract for [dpuAgent](wiki.html#definition-dpuagent).

## Core Content

### DS02 - Storage Architecture

### Summary

[`dpuAgent`](wiki.html#definition-dpuagent) stores confidential state in a dedicated storage root and keeps metadata, permissions, secret values, and confidential file content in separate files or directories.

### Background / Problem Statement

The [DPU](wiki.html#definition-dpuagent) domain has conflicting storage requirements. Lists and navigation need lightweight metadata. Permission checks need a canonical access control list ([ACL](wiki.html#definition-acl)) model. Secret values and confidential file bodies need encrypted persistence. A single flat store would make those responsibilities harder to reason about and easier to misuse.

### Storage Layout

The storage root is supplied explicitly through required `DPU_DATA_ROOT`. [Ploinky](wiki.html#definition-ploinky) mounts the managed host storage `.data/dpu-data` at `/dpu-data`:

```text
/dpu-data/
  state.json
  permissions.manifest.json
  secrets.json
  blobs/
  .lock/
```

The layers have separate roles:

- `state.json` stores users, secret metadata, and confidential object metadata
- `permissions.manifest.json` stores canonical principal identities, access control list entries for both users and agents, and DPU-owned agent role ceilings
- `secrets.json` stores encrypted secret values
- `blobs/` stores encrypted confidential file content
- `.lock/` is used by the file lock

Agent secret-role policy lives inside `permissions.manifest.json` under `agentPolicies[<principalId>].secrets.allowedRoles`. [DPU](wiki.html#definition-dpuagent) does not consult an agent manifest when deciding whether an agent may receive a secret role. Fresh storage roots seed the same-repository `gitAgent` principal with `["read"]`; existing manifests are never overwritten or backfilled automatically.

### Structural Separation

`lib/dpu-store.mjs` does not write storage files directly. It relies on `lib/dpu-store-internal/storage.mjs` for:

- storage root resolution
- state load and save
- permissions manifest load and save
- encrypted secret map handling
- encrypted confidential blob handling
- single-writer coordination through `withFileLock()`

This keeps the domain layer focused on object rules and access control list semantics instead of persistence details.

### Practical Operation

Mutating operations run inside `withLockedState()`. That helper loads `state.json` and `permissions.manifest.json`, executes the requested mutation, and persists only the files whose in-memory state was marked dirty. Confidential file bodies and secret values use their own helpers instead of being embedded in metadata objects.

Storage-root resolution requires a non-empty `DPU_DATA_ROOT`. The runtime fails closed when that variable is absent and does not derive a sibling workspace directory.

Workspace-root resolution is:

1. `DPU_WORKSPACE_ROOT`
2. `ASSISTOS_FS_ROOT`
3. `WORKSPACE_ROOT`
4. `process.cwd()`

[dpuAgent](wiki.html#definition-dpuagent) must preserve the responsibilities, boundaries, and observable results stated in this specification.
