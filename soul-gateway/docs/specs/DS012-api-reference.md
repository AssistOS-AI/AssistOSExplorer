# DS012 — Management API & Dashboard

## Summary

This spec describes the dashboard and management endpoints at a capability level.

The management surface exposes the active dashboard and admin APIs for the current runtime and schema.

## Dashboard authentication

- password-protected admin login (rate-limited: 5 attempts/minute/IP)
- HMAC-signed stateless session token (format: `{exp}.{csrfToken}.{hmac}`)
- CSRF protection for every state-changing management request via `X-CSRF-Token` matching the `csrfToken` embedded in the validated session token (no conditional bypass)
- signing key resolved from `ADMIN_SESSION_SIGNING_KEY` or `ENCRYPTION_KEY` (no fallback — throws if both are missing)
- timing-safe HMAC comparison to prevent side-channel attacks
- live-refresh behavior on data-backed tabs

## Provider management

The dashboard and API support:

- create, list, update, delete providers
- provider template catalog
- connectivity tests
- OAuth flow initiation/completion
- account management
- model discovery/sync

Current contract details:

- provider create/update requests use canonical camelCase fields such as `providerKey`, `displayName`, `adapterKey`, `authStrategy`, `providerMode`, `oauthAdapterKey`, `baseUrl`, and `apiKey`
- provider responses are DB-row shaped snake_case objects from `provider-view.mjs` (for example `provider_key`, `display_name`, `adapter_key`, `auth_strategy`)
- provider create/update rejects unknown `adapterKey` values and backend-invalid provider config before the row is written
- provider create with usable credentials performs initial model discovery synchronously; if the initial sync fails, the request fails and the newly-created provider row is removed
- provider create rollback also removes any partially inserted discovered model rows for that provider before deleting the provider record, so failed initial sync returns the create error instead of a foreign-key `500`
- provider update with `apiKey` performs the same strict model sync before the request reports success; if that sync fails, the PATCH returns an error
- provider delete removes provider-seeded direct models (`discovery_source != 'manual'`) before deleting the provider row; delete still rejects when manual models remain attached to the provider
- `POST /management/providers/:providerId/test` returns `{ ok, detail, latencyMs }`; `detail` is passed through from the backend module without translation to `message`/`error`
- `POST /management/providers/:providerId/discover-models` returns the raw backend discovery descriptors (`modelId`, `displayName`, `contextWindow`, `supportsTools`, `supportsStreaming`, `supportsVision`, optional `pricing`, ...)
- provider create/update/delete performs a synchronous runtime snapshot refresh before returning success

`provider_mode` exposes:

- `external_api`
- `custom`

## Provider pipeline composer

The Providers page exposes a pipeline composer backed by backend- and middleware-named endpoints:

- `GET /management/backends` — backend module inventory from the unified backend catalog. Each entry exposes `{ key, name, kind }`.
- `GET /management/provider-middlewares` — registered provider middleware modules
- `GET /management/providers/:providerId/middlewares` — flat ordered list of provider-scope bindings
- `POST /management/providers/:providerId/middlewares` — create a provider-scope binding
- `PATCH /management/providers/:providerId/middlewares/:bindingId` — update a binding (sort order, settings, enabled)
- `DELETE /management/providers/:providerId/middlewares/:bindingId` — delete a binding

Current implementation details:

- provider middleware bindings live in unified `middleware_bindings` with `scope='provider'`
- the binding payload is a flat ordered array, sorted by the DB `sort_order` and exposed through the API as `sortOrder`; there is no phase column
- the dashboard composer renders one ordered provider-middleware list, matching the runtime's single provider binding chain
- the provider's terminal backend is selected via `providers.adapter_key`; the snapshot exposes it as `provider.backendKey`. There is no separate `executor_key` or transport key column.
- create rejects unknown provider middleware keys before writing `middleware_bindings`
- create/update/delete performs a synchronous runtime snapshot refresh before returning success

## Model management

The dashboard and API support:

- direct-model CRUD
- tier CRUD over cascade models
- enable/disable
- pricing and concurrency configuration

Current contract details:

- the `Models` dashboard tab edits direct models only, even though `GET /management/models` still returns unified model rows from the database
- the `Models` page remains DB-backed; it does not list live provider catalogs directly in the main table
- `GET /management/models` overlays missing pricing, context, and tags through the shared `enrichModelMetadata()` pipeline (provider value > pricing directory > local classifier — see DS002 §Auto-provisioning and DS004 §"Model metadata and tagging"), so older DB rows still render enriched metadata without a manual resync; classifier provenance lands in `row.metadata.classifier`
- `GET /management/models/providers` lists all enabled providers, not just providers that already have persisted model rows
- `GET /management/models/providers/:key/models` is a recovery path for the Add Model modal: it performs live discovery for that provider, runs the same `enrichModelMetadata()` pipeline, and returns model-option rows shaped for the modal (`provider_model_id`, `display_name`, pricing fields, capabilities, tags, metadata)
- `GET /management/models/tags` returns `PREDEFINED_MODEL_TAGS ∪ distinct stored tags`, sorted — the predefined taxonomy (capability-signal tags plus curated family/domain tags) keeps the dashboard tag-filter vocabulary stable even when the DB has no tagged rows yet
- the Add Model modal now persists the discovered `capabilities`, `tags`, and `metadata` fields along with pricing when it creates a manual direct-model row
- the Models page search matches `model_key`, `display_name`, `provider_key`, `provider_model_id`, and any of the model's `tags`
- the `Tiers` dashboard tab edits cascade models through `GET/POST/PATCH/DELETE /management/tiers` plus `POST /management/tiers/:tierId/enable|disable`
- tier create/update requests use camelCase fields: `tierKey`, `displayName`, `enabled`, `maxAttempts`, `childModelIds`
- tier responses use a dashboard-specific view model:
  `{ id, tierKey, displayName, enabled, maxAttempts, children: [{ bindingId, modelId, modelKey, displayName, enabled, priority }] }`
- the tier management surface is an editor over `models(strategy_kind='cascade')` plus `model_children`; it does not reintroduce a separate tier runtime abstraction

Provider model sync semantics:

- `POST /management/providers/:providerId/sync-models` uses the same discovery-and-sync path as provider create and OAuth completion
- sync inserts new discovered rows, updates previously auto-discovered rows, preserves `discovery_source='manual'` rows, and disables missing previously-discovered rows instead of deleting them

## Middleware management

The dashboard and API support:

- middleware catalog listing
- middleware metadata updates
- rescan
- binding management via `/management/models/:modelId/middlewares`

Bindings write to unified `middleware_bindings` with `scope='model'` and `target_id` pointing to the model.

## Other management surfaces

- API key management
- blacklist management
- cooldown management
- logs
- metrics dashboards
- export

Mutations that affect routing or policy trigger runtime refresh so later requests observe the new state.

## Related specs

- **DS003** — middleware, provider middleware, backend, and extension runtime model
- **DS004** — cascade model routing behavior
- **DS007** — key and budget management
- **DS015** — logs, metrics, and observability endpoints
