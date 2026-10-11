---
title: DS010-confidential-objects
summary: Users browse and edit confidential files through Explorer without exposing a normal filesystem tree.
---

# DS010-confidential-objects

## Introduction

This specification defines the confidential file and folder model, actor-aware access rules, and protected persistence used by Explorer.

## Core Content



### Summary

Confidential objects are the file and folder records behind Explorer’s `/Confidential` surface. They support ownership, access control lists (ACLs), encrypted file content, and comments.

### Background / Problem Statement

Explorer needs folder-style navigation and file-style interaction for confidential content, but the underlying records still need actor-aware access control and encrypted persistence. That requires a model that feels file-like at the UI boundary without becoming a normal filesystem tree underneath.

### Object Model

The agent stores confidential objects in `state.confidentialObjects`. Each object is either:

- a `folder`
- a `file`

Folder records are metadata-only. File records keep metadata in `state.confidentialObjects` and store their content in encrypted blob storage addressed by object id.

The agent also maintains a per-user `My Space` root through `ensureUserRecord()`. Shared content is not a real top-level folder on disk. It is a filtered view computed from access control list visibility.

### Roles and Serialization

For confidential objects, the serialized result exposes capabilities such as:

- `canRead`
- `canComment`
- `canWrite`

This is important because Explorer should not infer collaboration rules on its own. It should use the capabilities returned by [DPU](wiki.html#definition-dpuagent).

Comments are also actor-filtered. `serializeConfidentialObject()` includes comments only when the current request asks for content and the actor is allowed to read that object.

### Practical Operation

`listConfidential()` builds views such as:

- the user’s own `My Space`
- the shared list
- a nested folder listing by `parentId`

`getConfidentialById()` returns one confidential object with actor-filtered content and comment visibility.

`createConfidential()`, `updateConfidential()`, and `deleteConfidential()` mutate the metadata tree and confidential blobs under the storage lock. Recursive delete removes child objects and deletes blob files for confidential files. Confidential operations are recorded under the fixed, always-enabled [DPU](wiki.html#definition-dpuagent) audit policy defined in [DS007-audit-model](specsLoader.html?spec=DS007-audit-model.md).

The `/Confidential/Audit` path is a special virtual root managed by the agent, accessible only to actors with `admin` or `security` roles. It provides read-only access to audit logs in JSON Lines (JSONL) format (see [DS007-audit-model](specsLoader.html?spec=DS007-audit-model.md)).

The `My Space` root has these enforced invariants:

- it is created or repaired automatically for authenticated users
- it cannot be renamed directly
- it cannot be deleted directly
- it cannot be shared directly

[dpuAgent](wiki.html#definition-dpuagent) must preserve the responsibilities, boundaries, and observable results stated in this specification.
