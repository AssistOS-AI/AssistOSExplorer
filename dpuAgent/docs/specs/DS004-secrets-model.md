---
title: DS004-secrets-model
summary: Defines the dpuAgent contract covered by DS004-secrets-model.
---

# DS004-secrets-model

## Introduction

This specification defines the active contract for dpuAgent.

## Core Content

### DS03 - Secrets Model

### Summary

In `dpuAgent`, a secret is not just a key-value pair. It is a metadata record, an access control list (ACL)-controlled object, and an encrypted value stored outside the metadata registry.

### Background / Problem Statement

Secrets need two things that should not be merged casually:

- operational metadata that Explorer can list and inspect
- sensitive values that should only be materialized for actors with the right role

If the value lived directly inside the metadata record, the metadata store would stop being safe to inspect or serialize broadly.

### Domain Split

The secret model is split across three places:

- metadata in `state.secrets`
- access control list state in `permissions.manifest.json`
- encrypted values in `secrets.json`

The public tool surface then serializes the result according to the caller’s role instead of dumping raw storage state.

### Secret Keys and Roles

Secret keys are normalized through `normalizeSecretKey()` and must use environment-variable-style names.

Secret roles are:

- `access`
- `write-access`
- `read`
- `write`

These roles are not equivalent. An actor with `access` can be authorized operationally without seeing the plaintext value. An actor with `write-access` can update the value without seeing the current value. An actor with `read` can see the value. An actor with `write` can update the value, see the value, and inspect access control list details.

When a new secret is created, the creator is treated as having the `write-access` role for that secret through ownership resolution. This means the owner can update the secret and manage its ACL without automatically materializing the current plaintext value. Delegated principals may still receive `read` or `write` when the workflow requires value visibility. Router-preserved user identity is authoritative for ownership; if the verified Ploinky user context contains an email principal, DPU may record the owner as that bare email instead of a `user:<id>` string.

Secret ACL entries are principal-based. The same secret may therefore grant roles to user principals such as `user:local:admin`, email principals, and agent principals such as `agent:AssistOSExplorer/gitAgent`. Agent principals use the canonical Ploinky-derived `agent:<repo>/<agent>` form and are recorded in the identity registry inside `permissions.manifest.json`. The maximum role an agent may receive on any secret is validated against DPU-owned policy in `permissions.manifest.json -> agentPolicies[<principalId>].secrets.allowedRoles`, not against the agent's manifest. New data roots seed the same-repository `gitAgent` policy with `read` so Git remote operations can use a user-owned GitHub token without granting the agent write access.

### Practical Operation

`putSecret()` resolves the authenticated actor, normalizes the key, creates or updates secret metadata, writes the encrypted value through `upsertSecretsFileValue()`, and returns the actor-filtered serialized secret.

`listSecrets()` and `getSecretByKey()` resolve the actor first and only expose secret entries whose role allows `access`. Plaintext value materialization only happens when the role allows `read`. `listSecrets()` reads and decrypts the secrets map at most once per call (lazily, on the first readable entry) inside the locked operation and shares that request-local map across entries; nothing is cached across requests.

`deleteSecret()` removes:

- the metadata entry
- the access control list entry
- the encrypted value from `secrets.json`

This keeps secret lifecycle state explicit instead of spreading it across Explorer-side caches or filesystem semantics.

## Conclusion

dpuAgent must preserve the responsibilities, boundaries, and observable results stated in this specification.
