---
title: DS003-main-behavior
summary: Defines the five project-wide behaviors that let callers use governed models and let operators control and observe the gateway.
---

## Introduction

Soul Gateway lets Ploinky agents and authenticated users call stable model interfaces while the gateway owns authentication, policy, provider routing, credentials, persistence, and operational control. The following components are the defining behaviors confirmed by public routes, runtime composition, Ploinky discovery, management handlers, SQLite services, and their automated tests.

## Core Content

### Main Behavior Components

| Name | Explanation |
| --- | --- |
| Authenticated protocol ingress | Callers use OpenAI Chat, Anthropic Messages, OpenAI Responses, embeddings, and model-list routes through one signed-subject security boundary. |
| Policy-governed model execution | The gateway applies middleware, concurrency, retry, timeout, credentials, and Achilles-backed provider execution before returning a canonical result. |
| Model catalog, cascade routing, and Ploinky reconciliation | Operators and agents use stable direct, alias, and tier names while discovery, snapshots, cascades, and cooldowns keep eligible targets synchronized. |
| Router-protected management | Ploinky administrators configure keys, providers, models, middleware, policy, and operational data through a verified dashboard and API. |
| Durable state and operational visibility | SQLite, audit capture, metrics, sessions, live streams, background maintenance, health, and graceful shutdown preserve and expose gateway operation. |

### Authenticated protocol ingress

Ploinky agents and authenticated users need one model interface that accepts their existing client protocol and rejects forged identity. A caller triggers this behavior with <code>POST /v1/chat/completions</code>, <code>POST /v1/messages</code>, <code>POST /v1/responses</code>, <code>POST /v1/embeddings</code>, or <code>GET /v1/models</code> through the Router's Soul Gateway [agent-port path](../wiki.html#definition-agent-port-path).

The gateway must verify the caller's [signed-subject key](../wiki.html#definition-signed-subject-key), bind its deterministic API-key policy row, normalize a completion body into the [canonical request](../wiki.html#definition-canonical-request), validate it, and serialize the result in the selected protocol. Agent keys remain raw signed subjects; user keys require the <code>sk-soul-</code> wrapper. Revoked, expired, malformed, or invalidly signed identities must not reach model execution. <code>ALLOW_UNAUTHENTICATED=true</code> is an explicit development-only boundary and must never be a production default.

### Policy-governed model execution

Callers need model results that obey the same configured policy regardless of provider. After model resolution, Soul Gateway must compose gateway and model middleware, choose direct or cascade execution, enforce concurrency and timeouts, run classified retries, lease provider credentials, compile provider middleware, and return a buffered response or [canonical stream](../wiki.html#definition-canonical-stream).

The [credential lease](../wiki.html#definition-credential-lease) must be released on every attempt outcome. Request-time vendor LLM inference must cross the [AchillesAgentLib](../wiki.html#definition-achilles-agent-lib) boundary; the gateway may provide credentials, base URLs, headers, and settings and may normalize output, but it must not create a second vendor generation transport. The Ploinky-agent backend may sign and send an exact-byte Router capability request. Classified errors determine retry, cascade, cooldown, and client-visible error behavior; unclassified failures must not silently advance through a cascade.

### Model catalog, cascade routing, and Ploinky reconciliation

Agents and users need stable model names even when providers, discovered agents, or individual models change. Operators trigger catalog changes through management operations, provider synchronization, startup reconciliation, or periodic discovery; callers trigger routing by naming a direct model, alias, or [compatibility tier](../wiki.html#definition-compatibility-tier).

Soul Gateway must load the enabled catalog into an immutable [runtime snapshot](../wiki.html#definition-runtime-snapshot), resolve names without per-stage configuration queries, and execute [cascade models](../wiki.html#definition-cascade-model) in child priority order. Cooldowns must remove failing children from later selection until expiry or administrative clearing. Ploinky discovery must reconcile agent-owned provider and model records before the initial snapshot and at the discovery interval. Reconciliation must be idempotent and must preserve operator-owned records outside its ownership boundary.

### Router-protected management

Ploinky administrators need one control plane for provider accounts, public subjects, models, tiers, middleware, safety rules, cooldowns, logs, metrics, sessions, and exports. An administrator triggers this behavior by opening <code>/management/</code>, using the Explorer <code>soul-gateway-settings</code> entry, or calling a <code>/management/*</code> route.

Soul Gateway must accept management identity only from a Ploinky protected-route invocation that verifies the request method, path, query, and body hash, passes replay protection, and names a user with the <code>admin</code> role. A management mutation must persist through the relevant DAO and request runtime refresh when it changes hot-path configuration. The dashboard and management API share this boundary; no legacy password or independent dashboard session may bypass Router verification.

### Durable state and operational visibility

Operators need configuration and evidence to survive restarts and need failures to remain diagnosable. Startup must initialize the embedded SQLite schema, retain the database and encryption key under the Ploinky data mount, install audit and metric services, and expose <code>/healthz</code> with database reachability and snapshot generation.

The request path must capture audit status, identity, routing, timing, usage, cost, errors, and bounded request or response data according to the observability contract. Administrators must be able to inspect and export records and subscribe to live logs. Background maintenance must clean cooldowns and caches, maintain retention, refresh eligible credentials and catalogs, and avoid overlapping runs of the same job. Shutdown must stop ingress and schedulers, close live subscribers, drain active requests within <code>SHUTDOWN_GRACE_MS</code>, flush audits, release backend generations, and close SQLite. Observability failures are best-effort unless the affected security or policy specification states a fail-closed rule.
