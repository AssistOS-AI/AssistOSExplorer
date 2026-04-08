# DS012 — Management API & Dashboard

## Summary

This spec describes the dashboard and management endpoints at a capability level.

The management surface exposes the active dashboard and admin APIs for the current runtime and schema.

## Dashboard authentication

- password-protected admin login
- signed session token
- CSRF protection for state-changing requests
- live-refresh behavior on data-backed tabs

## Provider management

The dashboard and API support:

- create, list, update, delete providers
- provider template catalog
- connectivity tests
- OAuth flow initiation/completion
- account management
- model discovery/sync

`provider_mode` still exposes:

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
- the binding payload is a flat ordered array, sorted by `sort_order`; there is no phase column
- the dashboard composer renders one ordered provider-middleware list, matching the runtime's single provider binding chain
- the provider's terminal backend is selected via `providers.adapter_key`; the snapshot exposes it as `provider.backendKey`. There is no separate `executor_key` or transport key column.

## Model and tier management

The dashboard and API support:

- model CRUD
- cascade-model editing through the Tiers page
- child ordering for cascade models
- enable/disable
- pricing and concurrency configuration

`/management/tiers` remains a compatibility namespace over cascade models backed by `models` + `model_children`.

## Middleware management

The dashboard and API support:

- middleware catalog listing
- middleware metadata updates
- rescan
- binding management

Bindings now write to unified `middleware_bindings`. Legacy tier endpoints are translated to model-scoped bindings targeting cascade models.

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
- **DS004** — cascade-model tiers and routing behavior
- **DS007** — key and budget management
- **DS015** — logs, metrics, and observability endpoints
