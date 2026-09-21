---
title: DS010-management-interface
summary: Defines the Router-protected dashboard, administrative APIs, resource mutations, live streams, and Explorer integration.
---

## Introduction

The management interface gives Ploinky administrators one protected surface for configuring gateway resources and inspecting runtime operation. The dashboard and API use the same authentication and persistence boundaries.

## Core Content

### Access boundary

Every <code>/management</code> HTTP route and management WebSocket route must pass the Ploinky administrator verifier before its handler runs. Verification must require a signed protected-route invocation, replay protection, and the <code>admin</code> role. Static dashboard assets beneath <code>/management/css/*</code> and <code>/management/js/*</code> are part of the protected surface.

<code>GET /management/me</code> must return the verified management identity used by the dashboard. Soul Gateway must not create a parallel password, cookie-signing, or local administrator session flow.

### Resource management

The management API must expose operations for API-key subjects; direct and cascade models; cascade children and ordering; compatibility tiers; providers and provider accounts; OAuth flows; provider discovery and synchronization; backend and middleware catalogs; gateway, model, and provider middleware bindings; blacklist rules; and cooldown clearing.

Create and update handlers must validate identifiers, ownership constraints, strategy-specific fields, settings shapes, and referential integrity before persistence. A mutation that changes request-time configuration must request the relevant [runtime snapshot](../wiki.html#definition-runtime-snapshot), backend catalog, or [middleware catalog](../wiki.html#definition-middleware-catalog) refresh. Deletes must respect dependent records and soft-delete semantics owned by the DAO.

Deleting a model that a catalog sync created records a [model tombstone](../wiki.html#definition-model-tombstone) in the same transaction as the delete, so provider synchronization does not recreate it; creating a model manually with the same key clears that tombstone, and no update clears one (DS008).

### User-key provisioning

An administrator may request a user key only for the verified Ploinky user identity supported by the provisioning route. The returned public value must use the <code>sk-soul-</code> encoded [signed-subject key](../wiki.html#definition-signed-subject-key) format. The API-key table must store the deterministic subject record and policy metadata, not reusable plaintext signing material.

### Provider lifecycle

Provider management may list backend templates, create provider configuration, test connectivity, discover models, synchronize the model catalog, start or poll OAuth flows, delete accounts, and reset quota state. Test and discovery operations must use the backend catalog's lifecycle functions and must not call the public completion path. Key replacement and manual synchronization follow the same catalog rules as the periodic refresh (DS009): an empty catalog never disables stored models.

<code>POST /management/providers/:providerId/sync-models</code> answers with <code>synced</code>, <code>discovered</code>, <code>created</code>, <code>updated</code>, <code>disabled</code>, <code>emptySkipped</code>, and the resulting models. <code>emptySkipped</code> is <code>true</code> when the upstream catalog was empty and the provider holds synchronized rows, so an administrator who syncs during an upstream outage sees that the catalog was ignored instead of reading all-zero counters as "nothing changed".

### SuperGrok account setup

The provider template list must include <code>xAI SuperGrok</code> with OAuth authentication and no API-key requirement. After creation, administrators use <code>Manage</code> and <code>Add Account</code> to obtain a verification URL and user code. Successful authorization persists the account and triggers the existing model synchronization workflow. Terminal polling errors must stop the dashboard's waiting indicator and display the failure so the administrator can start a new authorization.

### Observability surfaces

Administrators must be able to list and inspect audit logs, sessions, and agent groupings; query cost, usage, error, activity, token, and system metrics; and export logs as JSON or CSV. SSE and WebSocket endpoints must support all-log and soul-specific subscriptions and must apply the same administrator verification before the subscription begins.

### Dashboard and Explorer

The management interface must consume the management API and must not embed a second authoritative configuration store. The Ploinky Explorer <code>soul-gateway-settings</code> settings entry and the admin-only <code>soul-gateway-tool-button</code> toolbar button must ensure the agent runs and open the agent-served dashboard in a maximized, administrator-only Explorer modal that embeds the Router-prefixed <code>/management/</code> URL in an iframe. It must not introduce a parallel management store, a duplicate dashboard, or a second settings implementation.

The embedded dashboard reuses Explorer's shared UI assets and theme (light or dark) and must not keep a second theme store or a dashboard-local theme toggle. <code>/management/*</code> remains the single management API contract.
