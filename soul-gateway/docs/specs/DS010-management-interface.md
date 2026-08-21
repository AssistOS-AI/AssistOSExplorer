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

### User-key provisioning

An administrator may request a user key only for the verified Ploinky user identity supported by the provisioning route. The returned public value must use the <code>sk-soul-</code> encoded [signed-subject key](../wiki.html#definition-signed-subject-key) format. The API-key table must store the deterministic subject record and policy metadata, not reusable plaintext signing material.

### Provider lifecycle

Provider management may list backend templates, create provider configuration, test connectivity, discover models, synchronize the model catalog, start or poll OAuth flows, delete accounts, and reset quota state. Test and discovery operations must use the backend catalog's lifecycle functions and must not call the public completion path.

### Observability surfaces

Administrators must be able to list and inspect audit logs, sessions, and agent groupings; query cost, usage, error, activity, token, and system metrics; and export logs as JSON or CSV. SSE and WebSocket endpoints must support all-log and soul-specific subscriptions and must apply the same administrator verification before the subscription begins.

### Dashboard and Explorer

The dashboard at <code>/management/</code> must consume the management API and must not embed a second authoritative configuration store. The Ploinky Explorer <code>soul-gateway-settings</code> entry must open the Router-prefixed dashboard URL and must remain administrator-only. A separate settings modal would create an unsupported parallel management path and must not be introduced.
