# Design Spec - Provider Model Catalog Refresh

Date: 2026-06-29
Status: Design approved - pending implementation plan
Repos touched: `proxies/soul-gateway`

## Summary

When an operator adds an upstream provider to the local Soul Gateway, all
discoverable upstream models should become local Soul Gateway model rows
automatically. Those rows must then stay current as the upstream provider adds
or removes models, so the local Models page, tier picker, and request runtime
all see the same catalog.

The implementation should wrap the existing provider discovery and sync code
with a provider model refresh service. Provider creation/update keeps strict
initial sync. Startup and background refreshes are best-effort: they update the
local catalog when discovery succeeds, and preserve the last known catalog when
discovery fails.

Missing upstream models are disabled, not deleted. Rows disabled by the sync
path are marked as sync-disabled in metadata, so a later refresh may re-enable
them if they reappear. Rows manually disabled by an operator remain disabled.

## Current Behavior

Provider lifecycle already has most of the sync primitive:

1. Provider create/update with a static API key runs strict discovery and model
   auto-provisioning before reporting success.
2. OAuth completion uses the same discovery-and-sync path.
3. `POST /management/providers/:providerId/sync-models` exists and persists
   discovered models, but the dashboard does not expose it as the primary
   provider action.
4. `POST /management/providers/:providerId/discover-models` returns live
   discovery results for the provider modal, but it does not persist them.
5. Startup only reconciles enabled providers with usable credentials and zero
   model rows.

This creates a split view: the provider modal can show live upstream models
that have not been persisted, while the Models page and tier picker only show
database-backed local models.

## Goals

| Goal | Detail |
| --- | --- |
| Fresh local catalog | New upstream models become local model rows without manual add-one-by-one work. |
| Safe removal handling | Upstream removals disable local discovered rows while preserving IDs, history, and tier references. |
| Manual control preserved | Manual model rows and operator-disabled rows are not overwritten by automatic refresh. |
| Runtime visibility | Any sync that changes models refreshes the runtime snapshot so routing sees the updated catalog. |
| Failure resilience | Automatic refresh never takes down startup or serving after a provider has already been configured. |

## Non-Goals

| Non-goal | Reason |
| --- | --- |
| Auto-adding new models into tiers | Tier membership remains an operator policy decision. Sync only makes models available. |
| Deleting missing models | Deletion can break model children, logs, and historical references. |
| Webhook-driven upstream updates | This needs upstream event support and auth plumbing; polling is enough for this issue. |
| New request-time transport | Discovery remains lifecycle/catalog work. Request-time LLM inference still goes through Achilles. |

## Decisions

| Decision | Detail |
| --- | --- |
| Missing-model policy | Disable missing non-manual rows instead of deleting them. |
| Re-enable policy | Only re-enable a returning model if sync metadata says the refresh service disabled it. |
| Initial provider sync | Keep create/update/OAuth sync strict so a newly configured provider is usable or clearly rejected. |
| Startup refresh | Refresh eligible enabled providers before the initial runtime snapshot loads. |
| Background refresh | Add a scheduled provider catalog refresh job with an env-controlled interval. |
| Empty discovery guard | Automatic refresh must not mass-disable an existing catalog from a zero-model result. |

## Architecture

### Provider Catalog Refresh Service

Add a dedicated refresh module under `src/runtime/providers/`, for example
`provider-catalog-refresh.mjs`.

The service owns provider-level orchestration:

1. List enabled providers.
2. Skip providers that cannot be discovered because there is no backend
   catalog, no `discoverModels` lifecycle method, no usable credential, or no
   `auth_strategy='none'` exemption.
3. Run `autoProvisionModels(appCtx, provider, provider.oauth_adapter_key, ...)`
   with non-strict options.
4. Aggregate `scanned`, `eligible`, `refreshed`, `discovered`, `created`,
   `updated`, `disabled`, `skipped`, and `failed`.
5. Log per-provider failures and continue with the remaining providers.

The service should be reusable from startup and from the interval scheduler.
It should not own low-level model normalization, enrichment, upsert, or runtime
refresh logic; those stay in `auto-provisioner.mjs`.

### Sync Metadata

The existing `enabled` flag is not enough to distinguish an upstream removal
from an operator disable. Automatic refresh needs that distinction.

When sync disables a missing discovered row, it should preserve existing
metadata and add a sync marker such as:

```json
{
  "syncDisabled": {
    "reason": "missing-from-discovery",
    "source": "provider.model-refresh",
    "at": "2026-06-29T00:00:00.000Z"
  }
}
```

When a later discovery includes that model key again, sync may update and
re-enable the row only if that marker is present. Re-enabling should remove the
marker or mark it as resolved. If the marker is absent, the row is treated as
operator-disabled and remains disabled.

Manual rows keep their existing contract: discovery sync does not update,
disable, or re-enable rows whose `discovery_source` is `manual`.

### Sync Behavior Changes

`syncProviderModels()` should support automatic refresh semantics without
breaking manual sync:

| Case | Behavior |
| --- | --- |
| New discovered model | Create enabled row with discovery source `synced` or `auto_provisioned`. |
| Existing discovered enabled model | Update metadata, pricing, capabilities, tags, and provider model id. |
| Existing discovered sync-disabled model | Update and re-enable it. |
| Existing discovered operator-disabled model | Update metadata but leave disabled. |
| Missing discovered model | Disable and mark sync-disabled. |
| Manual row | Preserve as-is. |

The existing manual `sync-models` endpoint should keep using the shared path.
It can opt into the same sync-disabled marker because manual sync is still a
catalog reconciliation operation, not a user toggle.

If an upstream proxy removes a sub-provider, the local gateway will usually see
that as model IDs disappearing from the parent provider discovery result. Those
rows follow the same missing-model disable path.

### Startup Flow

Replace or extend the current `reconcileProvidersOnStartup()` behavior.
Instead of only handling providers with zero model rows, startup should run the
refresh service for every eligible enabled provider. Startup refresh remains
best-effort:

1. It logs failures.
2. It does not abort startup after the gateway already has local catalog state.
3. It runs before `installSnapshotServices(appCtx)`, so the initial snapshot
   includes any successful writes.

Provider create/update/OAuth completion remain strict and may still reject a
new provider if initial discovery fails.

### Background Scheduler

Add `PROVIDER_MODEL_REFRESH_INTERVAL_MS` to env parsing. Recommended default:
`900000` (15 minutes). A value of `0` disables the interval.

The scheduler starts a `provider-model-refresh` job when:

1. `appCtx.pool` exists.
2. `appCtx.services.backendCatalog` exists.
3. `PROVIDER_MODEL_REFRESH_INTERVAL_MS > 0`.

The existing scheduler already skips overlapping runs for a named job. The
refresh service should still process providers serially or with a very small
concurrency limit so a slow upstream does not stampede credentials or APIs.

### Empty Discovery Guard

Automatic refresh should not interpret a zero-model result as "disable
everything" when the provider previously had rows. This protects against
temporary upstream list bugs, proxy auth oddities, and "listing unsupported but
API reachable" fallbacks.

For automatic refresh:

1. If discovery throws, make no model changes.
2. If discovery returns zero models and existing non-manual model rows exist,
   log a warning and skip disable/update for that provider.
3. If discovery returns zero models and no rows exist, allow the no-op result.

Manual sync can keep stricter operator-driven behavior, because an admin is
explicitly asking to reconcile now.

### Dashboard

The Providers page should make persistence explicit:

1. Add or rename the provider action to `Sync models`.
2. Call `POST /management/providers/:providerId/sync-models`.
3. Show discovered, created, updated, and disabled counts.
4. Refresh the local provider/model state after sync.

The live discovery modal may remain useful for inspecting upstream data, but
the dashboard should not imply that live discoveries are already available to
tiers until they are synced.

## Data Flow

```text
Provider added or credential updated:
  management route
    -> strict autoProvisionModels()
       -> discoverProviderModels()
       -> syncProviderModels()
       -> runtime snapshot refresh

Startup:
  bootstrap
    -> provider catalog refresh service
       -> best-effort per eligible provider sync
    -> installSnapshotServices()

Background:
  scheduler interval
    -> provider catalog refresh service
       -> best-effort per eligible provider sync
       -> runtime snapshot refresh when rows change

Tier edit:
  dashboard
    -> GET /management/models
       -> sees persisted enabled direct rows from latest successful sync
```

## Error Handling

| Error | Behavior |
| --- | --- |
| New provider strict discovery failure | Reject create/update/OAuth completion and preserve current strict rollback behavior. |
| Startup refresh provider failure | Log warning, continue startup, preserve existing rows. |
| Background refresh provider failure | Log warning, continue other providers, preserve existing rows. |
| Credential unavailable or reauth required | Skip provider and log at info/warn level. |
| Backend has no discovery lifecycle | Skip provider; do not treat as failure. |
| Zero-model automatic result with existing rows | Skip disable/update for that provider and log suspicious empty discovery. |

## Tests

Unit tests should cover:

1. `syncProviderModels()` marks missing discovered rows as sync-disabled.
2. `syncProviderModels()` re-enables returning rows only when the sync-disabled
   marker is present.
3. `syncProviderModels()` leaves operator-disabled discovered rows disabled.
4. Manual rows are still preserved.
5. Provider refresh service scans enabled providers, skips ineligible providers,
   and aggregates summary counts.
6. Provider refresh service preserves rows on discovery failure.
7. Provider refresh service applies the automatic zero-model guard.
8. Scheduler starts `provider-model-refresh` only when the interval is greater
   than zero and skips overlapping runs through the existing scheduler helper.
9. Management sync endpoint returns created/updated/disabled counts and
   refreshes the dashboard-facing model list.

Focused integration or management tests should verify that a provider with
newly discovered upstream models makes those models visible through
`GET /management/models`, and therefore visible to the tier picker.

## Acceptance Criteria

1. Adding a provider with a valid credential creates local model rows for every
   discovered upstream model.
2. A provider whose upstream later adds a model gets a new enabled local row
   without manual add-one-by-one work.
3. A provider whose upstream removes a model has the local discovered row
   disabled, not deleted.
4. A removed model that later reappears is re-enabled only if sync disabled it.
5. A model disabled manually by an operator stays disabled across refreshes.
6. The tier picker lists refreshed local model rows after sync.
7. Background refresh failures preserve the previous usable catalog.
8. `PROVIDER_MODEL_REFRESH_INTERVAL_MS=0` disables the periodic job.
9. The relevant Soul Gateway unit tests pass.

## Implementation Follow-Ups

After implementation lands, update the normative DS specs:

| Spec | Update |
| --- | --- |
| DS002 | Document periodic provider catalog refresh and sync-disabled re-enable semantics. |
| DS006 | Document model metadata used for sync-disabled state. |
| DS012 | Document the dashboard/manual sync behavior as the persistent provider catalog action. |
| DS013 | Document `PROVIDER_MODEL_REFRESH_INTERVAL_MS` and startup/background refresh behavior. |
| DS016 | Note that the local hub keeps upstream provider catalogs fresh in addition to Ploinky agent discovery. |

## Verification Commands

```bash
cd proxies/soul-gateway
npm test
node --experimental-test-module-mocks --test src/test/unit/auto-provisioner.test.mjs
node --experimental-test-module-mocks --test src/test/unit/service-installers.test.mjs
```
