---
title: DS008-persistence-and-snapshots
summary: Defines embedded SQLite ownership, schema families, immutable runtime snapshots, refresh behavior, retention, and recovery boundaries.
---

## Introduction

Soul Gateway uses embedded SQLite as the authoritative persistent configuration and operational store. Request processing reads an immutable in-memory snapshot derived from that data so administrative changes cannot partially affect an in-flight request.

## Core Content

### SQLite ownership

The service must open the file named by <code>SQLITE_PATH</code> and initialize it with <code>src/db/schema/sqlite-current.sql</code>. <code>SQLITE_PATH</code>, <code>DATA_DIR</code>, and <code>CREDENTIALS_DIR</code> are required configuration; a direct start without any one of them must fail closed instead of selecting a relative data directory. The Ploinky deployment supplies all three beneath the mounted <code>/data</code> directory. Schema initialization must be idempotent and must fail startup when required tables or constraints cannot be established.

The schema must preserve these data families: provider and provider-account configuration; direct and cascade models, aliases, and children; API-key subjects and limits; middleware definitions and bindings; blacklist rules and model cooldowns; deleted synced models in <code>model_tombstones</code>; sessions and session state; audit and observability records; one-time initialization markers in <code>gateway_bootstrap_state</code>. Foreign keys, unique indexes, soft-delete rules, and JSON validity checks are part of the data contract.

### One-time initialization

<code>gateway_bootstrap_state</code> records one-time initialization steps that must not repeat, and the per-item progress of a step that has items. Each row holds a <code>bootstrap_key</code> primary key, a positive <code>version</code>, a <code>completed_at</code> timestamp, and JSON <code>metadata</code>.

The first-start free model defaults use <code>bootstrap_key='free-model-defaults'</code> at version 1 as their [bootstrap marker](../wiki.html#definition-bootstrap-marker). The install opens one <code>BEGIN IMMEDIATE</code> transaction, checks the marker, writes the provider, encrypted account, baseline models, tier cascades and children, and the marker row, and commits. A start interrupted before the commit leaves neither records nor marker, and the next start runs the install again. Neither one-time step depends on whether the database file existed before the process started, because a crash after the file was created would otherwise skip the step permanently. The marker's JSON metadata lists the tiers the install created (<code>tiersCreated</code>) and kept because a record already held the name (<code>tiersKept</code>). A later start creates only requested tiers missing from both lists: a name added to <code>LLM_DEFAULT_TIERS</code>, or a tier left pending because none of its children was an enabled model of the <code>openrouter-free</code> provider. It does so in the same kind of transaction and extends the two lists before committing. The provider, account, and baseline models are never installed again and a listed tier is never created again, so records that an administrator later disables, edits, or deletes are not recreated by the installer; catalog syncs honour model deletions through tombstones (below). The install runs on any database that lacks the marker, including an existing deployment with its own providers, so such a deployment sets <code>FREE_MODELS_ENABLED=false</code> when it does not want the free defaults. When <code>FREE_MODELS_ENABLED=false</code>, the install is skipped without writing the marker, so enabling it on a later start installs the defaults then, keeping any tier, alias, or provider an administrator created in the meantime.

The auto tag-tier bootstrap uses <code>bootstrap_key='initial-tag-tiers'</code>. It runs after the provider catalog refresh, creates and fills the auto tag tiers, and writes its marker only after the tiers exist. A start interrupted before the marker is written runs the bootstrap again, which is safe because it is idempotent; once the marker exists, later starts never rewrite tag tiers that an administrator has edited. After the free defaults are installed, the enabled models of the <code>openrouter-free</code> provider are appended once to the matching auto tag tiers, recorded by the <code>free-model-defaults-tag-tiers</code> marker. This covers tag tiers created before the install (for example after a start with <code>FREE_MODELS_ENABLED=false</code>); a start interrupted before that marker repeats the join, and later starts never re-add a model an administrator removed from a tag tier. The marker is written only after models joined: while the provider has no enabled model, for example after a catalog that disabled every row, the join stays pending and a later start joins the re-enabled models. A failure of the tag-tier bootstrap is logged and retried on the next start instead of aborting startup. Both markers are read and written through <code>src/db/dao/bootstrap-state-dao.mjs</code>.

### Model tombstones

Model rows are hard-deleted, so a catalog sync that still lists a deleted model would otherwise recreate it. <code>model_tombstones</code> records every [model tombstone](../wiki.html#definition-model-tombstone): one row per <code>(provider_id, model_key)</code> primary key with a <code>deleted_at</code> timestamp. The table is part of the current schema file and is created by the schema's <code>CREATE TABLE IF NOT EXISTS</code> on the next open of an existing database.

| Event | Effect |
| --- | --- |
| An administrator deletes a model through <code>DELETE /management/models/:modelId</code> whose <code>discovery_source</code> is not <code>manual</code> | The model row is deleted and its tombstone recorded in one <code>BEGIN IMMEDIATE</code> transaction, so a crash cannot leave the model deleted but recreatable. Deleting a manual model or a cascade records nothing. |
| A catalog sync (startup, periodic, manual, key replacement, OAuth completion, or caller-supplied discoveries) lists a tombstoned key that no row holds | The key is skipped and never created. The skip happens after admission, so a tombstoned model never makes a healthy catalog look policy-filtered. |
| A catalog sync lists a tombstoned key that a row currently holds | The tombstone is suspended, not cleared: the row is synchronized normally, and the tombstone stays recorded and applies again as soon as no row holds the key. Without the suspension the sync would skip the discovery and then disable the row for being missing from the catalog; without keeping the record, moving a row onto the key and off it again would silently undo the administrator's deletion. |
| An administrator creates the same model key manually through <code>POST /management/models</code> | The tombstone of the created row's provider and key is cleared; the model is manual from then on. A manual create is the only action that clears a tombstone; an update never does. |
| The provider is deleted | Its tombstones are removed by <code>ON DELETE CASCADE</code>. |

The data-access functions live in <code>src/db/dao/model-tombstones-dao.mjs</code>.

### Runtime snapshot

The [runtime snapshot](../wiki.html#definition-runtime-snapshot) must load enabled request-time configuration into maps and ordered collections with a generation identifier and load timestamp. Execution defaults owned by a provider are resolved while the snapshot loads: a direct model of a [free-only provider](../wiki.html#definition-free-only-provider) carries the free-model execution policy for every retry-policy field its row does not set (DS002), so retry, deadlines, and cooldowns read one effective policy. Requests must bind one snapshot before normalization and model resolution and must not mix configuration generations during their route chain.

Management mutations, discovery reconciliation, tier seeding, provider synchronization, middleware rescans, and cooldown changes must request the specific runtime or catalog refresh they affect. Refresh coordination may coalesce repeated requests. A failed refresh must preserve the previous usable generation and report the failure rather than install a partial snapshot.

### Model and binding integrity

A [direct model](../wiki.html#definition-direct-model) must reference a provider and provider model identifier. A [cascade model](../wiki.html#definition-cascade-model) must not reference either and must contain non-self child relationships with unique priorities. Aliases must be globally unique. Middleware scope constraints must prevent gateway bindings from carrying a target and must require targets for model and provider bindings.

### Audit retention and sessions

Audit records may use date-partitioned SQLite tables managed through the audit DAO. The scheduler must prepare partitions ahead of time and drop partitions older than <code>LOG_RETENTION_DAYS</code>. Retention work must not overlap with itself and must not terminate the service when one maintenance run fails.

Sessions must retain their API-key owner, grouping identity, sequence, timestamps, and optional soul or agent association. Persistent session state must remain separate from ephemeral middleware caches so a cache reset does not delete the authoritative session record.

### Recovery boundary

The SQLite database, <code>DATA_DIR/encryption.key</code>, and encrypted files under <code>CREDENTIALS_DIR</code> must be backed up and restored as one set. The database alone is insufficient to recover encrypted provider secrets. The gateway must not automatically replace a missing key and then present old encrypted credentials as valid.

The repository does not define multi-process writers, remote database replication, or cross-node snapshot consensus. One Ploinky-managed Soul Gateway process owns the embedded database file for a deployment.
