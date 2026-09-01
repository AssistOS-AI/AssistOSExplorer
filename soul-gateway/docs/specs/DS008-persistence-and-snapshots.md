---
title: DS008-persistence-and-snapshots
summary: Defines embedded SQLite ownership, schema families, immutable runtime snapshots, refresh behavior, retention, and recovery boundaries.
---

## Introduction

Soul Gateway uses embedded SQLite as the authoritative persistent configuration and operational store. Request processing reads an immutable in-memory snapshot derived from that data so administrative changes cannot partially affect an in-flight request.

## Core Content

### SQLite ownership

The service must open the file named by <code>SQLITE_PATH</code> and initialize it with <code>src/db/schema/sqlite-current.sql</code>. <code>SQLITE_PATH</code>, <code>DATA_DIR</code>, and <code>CREDENTIALS_DIR</code> are required configuration; a direct start without any one of them must fail closed instead of selecting a relative data directory. The Ploinky deployment supplies all three beneath the mounted <code>/data</code> directory. Schema initialization must be idempotent and must fail startup when required tables or constraints cannot be established.

The schema must preserve these data families: provider and provider-account configuration; direct and cascade models, aliases, and children; API-key subjects and limits; middleware definitions and bindings; blacklist rules and model cooldowns; sessions and session state; audit and observability records. Foreign keys, unique indexes, soft-delete rules, and JSON validity checks are part of the data contract.

### Runtime snapshot

The [runtime snapshot](../wiki.html#definition-runtime-snapshot) must load enabled request-time configuration into maps and ordered collections with a generation identifier and load timestamp. Requests must bind one snapshot before normalization and model resolution and must not mix configuration generations during their route chain.

Management mutations, discovery reconciliation, tier seeding, provider synchronization, middleware rescans, and cooldown changes must request the specific runtime or catalog refresh they affect. Refresh coordination may coalesce repeated requests. A failed refresh must preserve the previous usable generation and report the failure rather than install a partial snapshot.

### Model and binding integrity

A [direct model](../wiki.html#definition-direct-model) must reference a provider and provider model identifier. A [cascade model](../wiki.html#definition-cascade-model) must not reference either and must contain non-self child relationships with unique priorities. Aliases must be globally unique. Middleware scope constraints must prevent gateway bindings from carrying a target and must require targets for model and provider bindings.

### Audit retention and sessions

Audit records may use date-partitioned SQLite tables managed through the audit DAO. The scheduler must prepare partitions ahead of time and drop partitions older than <code>LOG_RETENTION_DAYS</code>. Retention work must not overlap with itself and must not terminate the service when one maintenance run fails.

Sessions must retain their API-key owner, grouping identity, sequence, timestamps, and optional soul or agent association. Persistent session state must remain separate from ephemeral middleware caches so a cache reset does not delete the authoritative session record.

### Recovery boundary

The SQLite database, <code>DATA_DIR/encryption.key</code>, and encrypted files under <code>CREDENTIALS_DIR</code> must be backed up and restored as one set. The database alone is insufficient to recover encrypted provider secrets. The gateway must not automatically replace a missing key and then present old encrypted credentials as valid.

The repository does not define multi-process writers, remote database replication, or cross-node snapshot consensus. One Ploinky-managed Soul Gateway process owns the embedded database file for a deployment.
