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
- `POST /management/providers/:providerId/test` returns `{ ok, detail, latencyMs }`; `detail` is passed through from the backend module without translation to `message`/`error`
- `POST /management/providers/:providerId/discover-models` returns the raw backend discovery descriptors (`modelId`, `displayName`, `contextWindow`, `supportsTools`, `supportsStreaming`, `supportsVision`, optional `pricing`, ...)

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

## Model management

The dashboard and API support:

- direct-model CRUD
- tier CRUD over cascade models
- enable/disable
- pricing and concurrency configuration

Current contract details:

- the `Models` dashboard tab edits direct models only, even though `GET /management/models` still returns unified model rows from the database
- the `Tiers` dashboard tab edits cascade models through `GET/POST/PATCH/DELETE /management/tiers` plus `POST /management/tiers/:tierId/enable|disable`
- tier create/update requests use camelCase fields: `tierKey`, `displayName`, `enabled`, `maxAttempts`, `childModelIds`
- tier responses use a dashboard-specific view model:
  `{ id, tierKey, displayName, enabled, maxAttempts, children: [{ bindingId, modelId, modelKey, displayName, enabled, priority }] }`
- the tier management surface is an editor over `models(strategy_kind='cascade')` plus `model_children`; it does not reintroduce a separate tier runtime abstraction

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
