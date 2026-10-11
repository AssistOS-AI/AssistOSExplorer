---
title: DS007-ploinky-runtime-invariants
summary: Captures WebMeet's runtime-v5 routing, private-service, security, and fail-closed rootless reachability invariants.
---

# DS007-ploinky-runtime-invariants

### DS007 - Ploinky Runtime Invariants

## Introduction

This specification makes the [Ploinky](wiki.html#definition-ploinky) runtime and security invariants local to [`webmeetAgent`](wiki.html#definition-webmeetagent). Future work from inside this agent directory must not rely on external memory of [Ploinky](wiki.html#definition-ploinky) core behavior; the local specs must carry the constraints that affect the agent's implementation and documentation.

The authoritative upstream contracts are [Ploinky](wiki.html#definition-ploinky) `docs/specs/DS007-routing-and-web-surfaces.md` and `docs/specs/DS013-security-model.md`. This file restates only the invariants that affect [WebMeet](wiki.html#definition-webmeetagent).

Private service activation for the default managed-bridge [WebMeet](wiki.html#definition-webmeetagent) runtime fails closed. On the verified rootless Podman topology, the required `host.containers.internal:host-gateway` mapping reaches the box outer-facing interface instead of loopback or an assigned managed-bridge address. [WebMeet](wiki.html#definition-webmeetagent) must not substitute public Router, direct service targets, a wider listener, host mode, or a forwarding sidecar; private [LiveKit](wiki.html#definition-livekit) Twirp and TURN broker operations remain unavailable through that lane.

## Core Content

[`webmeetAgent`](wiki.html#definition-webmeetagent) must treat the [Ploinky](wiki.html#definition-ploinky) router as the browser and [MCP](wiki.html#definition-mcp) trust broker. Browser surfaces, first-party [MCP](wiki.html#definition-mcp) calls, delegated [MCP](wiki.html#definition-mcp) calls, uploads, blobs, and convention-routed agent HTTP traffic are expected to enter through the router so route authentication, session handling, invocation minting, and audit behavior can apply. Direct agent ports are implementation details even when bound to localhost.

Executable [MCP](wiki.html#definition-mcp) operations must be authorized by router-minted request JWTs. The launcher/router may derive per-agent request secrets from `PLOINKY_MASTER_KEY`, but the agent runtime must receive only its own `PLOINKY_AGENT_ID`, `PLOINKY_AGENT_SECRET`, and compatibility `PLOINKY_AGENT_PRINCIPAL`. Agents must never receive, derive, or require `PLOINKY_MASTER_KEY` or the legacy `PLOINKY_DERIVED_MASTER_KEY`. Code must not invent alternate bearer-token, client-secret, or caller-header authorization paths around the router's secure-wire model.

Ploinky-owned generated secrets are resolved by the launcher before agent code runs. Agent-owned generated secrets use `generatedSecret: true` for manifest env entries or `{{generatedSecret:NAME}}` for runtime-resource templates; both are scoped to the current agent identity and ignore operator-supplied values. Shared generated credentials that must be identical across agents use `sharedGeneratedSecret: true` and derive from the source env name. Agents consume the resolved values but do not hold the master derivation key. Agents must not invent random persistent agent secrets or require manual configuration for workspace-owned [LiveKit](wiki.html#definition-livekit), TURN, OnlyOffice, DPU, webhook, or data-encryption secrets. External third-party credentials remain explicitly configured.

The compact `x-ploinky-auth-info` header is not a secure grant by itself. [WebMeet](wiki.html#definition-webmeetagent) domain authorization must use router-minted invocation identity, roles, and scopes. Caller-supplied copies of identity headers must not become authoritative input.

[WebMeet](wiki.html#definition-webmeetagent) must not expose its own internal HTTP API port as a product surface. The browser UI calls [WebMeet](wiki.html#definition-webmeetagent) through the generic [Ploinky](wiki.html#definition-ploinky) [MCP](wiki.html#definition-mcp) route. Direct room links use the agent-owned static loader `/<webmeetAgent>/roomLoader.html?roomId=<roomId>` and whitelisted static assets; they are not backed by a WebMeet-specific router bridge or generated server page.

Guest access must remain scoped to a single room. Public room access is exposed through `/<webmeetAgent>/roomLoader.html?roomId=<roomId>`. [Ploinky](wiki.html#definition-ploinky) core owns public-protected routing, anonymous token/session handling, and UI/assets whitelisting; [WebMeet](wiki.html#definition-webmeetagent) receives the verified invocation context and authorizes room operations against the room scope.

[Ploinky](wiki.html#definition-ploinky) route authentication identifies the caller, but [`webmeetAgent`](wiki.html#definition-webmeetagent) still owns domain authorization. Sensitive actions must check verified user identity, roles, scopes, room id, participant id, workspace path, and local policy before reading or mutating state. Admin-only actions include room creation, rename, archive, confirmed permanent deletion, AI attach/detach, and other management surfaces. `webmeet_room_delete` accepts only the router-minted administrator principal, an exact room id, and a literal boolean confirmation; ordinary users, guests, caller-supplied identity headers, and room-scoped public invocations cannot authorize it.

Runtime isolation is defense in depth, not a hostile multi-tenant guarantee. Containers, bubblewrap, and Seatbelt reduce host exposure, but enabled agent code remains trusted operator-controlled code inside one workspace. Manifest volumes, runtime resources, lifecycle hooks, and network access are intentional grants and must be reviewed as part of the agent contract.

File and static-content handling must stay workspace-confined. Paths must resolve relative to the workspace root, agent root, configured data directory, or explicit runtime volume. Code must reject absolute caller paths, traversal, NUL bytes, and symlink escapes where user input can influence path resolution. Browser responses must not leak host absolute paths.

Logs and user-facing errors must not expose secrets, cookies, bearer tokens, invocation JWTs, [LiveKit](wiki.html#definition-livekit) participant JWTs, API keys, raw prompts, hidden policy text, internal payloads, SDP, ICE credentials, screenshots, or DOM dumps. Trace sanitization recognizes dynamic participant JWTs, TURN usernames/credentials, arbitrary Playwright cookie objects, compound cookie fields, named query/form values, router assertions, and CSRF values even when those values were not supplied through the runner environment. It transforms JSON and Playwright NDJSON structurally, preserves record parseability, and post-scans textual archive members before attachment. Detailed diagnostics belong behind explicit debug modes and must still redact sensitive values before persistence.

Media topology is box-owned runtime state. Each join reads the current unversioned media/publication state, uses the same-origin [LiveKit](wiki.html#definition-livekit) convention path, and obtains short-lived relay credentials from the private broker under an exact current-generation assertion. Browser-facing addresses are never declared as manifest environment or synthesized from a workstation address. See DS004 for credential lifetime, controlled rejoin, and network-lane invariants.

Agent-local contract:

- Manifest: `manifest.json`.
- Role: Meeting application agent for workspace team rooms and invite-scoped public meetings.
- Authentication: Workspace room operations require authenticated route/MCP context. Public room entry requires a [Ploinky](wiki.html#definition-ploinky) public-protected invocation scoped to the target room.
- Router surface: [WebMeet](wiki.html#definition-webmeetagent) does not publish a product-specific additional-server route. Browser calls use the generic [Ploinky](wiki.html#definition-ploinky) [MCP](wiki.html#definition-mcp) route, and direct room entry uses the whitelisted `roomLoader.html` plus plugin/assets routing owned by [Ploinky](wiki.html#definition-ploinky) core.
- Persistent state: Room data lives under `/data`; [LiveKit](wiki.html#definition-livekit) secrets stay server-side.
- Volumes: `.data/webmeetAgent/data:/data`; `WEBMEET_DATA_DIR` is required and path resolution has no fallback.
- Dependencies: Base startup uses [Ploinky](wiki.html#definition-ploinky)'s shared prepared dependency cache. [WebMeet](wiki.html#definition-webmeetagent) must not add native external AI worker dependencies.
- Secret handling: `PLOINKY_WEBMEET_MASTER_KEY` is an agent-scoped generated secret. [LiveKit](wiki.html#definition-livekit) API key/secret are shared generated inputs for participant JWTs and the media runtime, but public/private transport is still selected by the active topology generation. The external TURN long-term secret is never present in the [WebMeet](wiki.html#definition-webmeetagent) environment: [Ploinky](wiki.html#definition-ploinky) core returns only short-lived credentials to this exact current-enable-generation consumer through the private broker. Router assertions are request-bound runtime credentials, not shared environment secrets or user/admin credentials.
- Documentation: `docs/index.html` and `docs/specs/matrix.md`.
- Validation: Run proxy/plugin syntax checks and a [Ploinky](wiki.html#definition-ploinky) guest invite smoke test for auth or route changes.

Browser realtime refreshes driven by meeting/workspace events are best effort. They must catch transient [MCP](wiki.html#definition-mcp) client resets, session refreshes, and stale-room races without creating unhandled promise rejections or console error loops. Direct user-initiated actions must continue to surface actionable failures through the [WebMeet](wiki.html#definition-webmeetagent) UI.

### Decisions & Questions

### Question #1: Why duplicate Ploinky invariants inside the agent spec set?

Response: Coding work often starts from an individual agent directory, where only local guidance may be read before changes are made. Keeping these [Ploinky](wiki.html#definition-ploinky) invariants local prevents agents from treating router auth, guest mode, direct ports, or invocation headers as bypassable implementation details.

### Question #2: Why is route authentication not enough for WebMeet authorization?

Response: [Ploinky](wiki.html#definition-ploinky) establishes who the caller is and signs the invocation path. [`webmeetAgent`](wiki.html#definition-webmeetagent) knows which room, participant, resource, or AI-control action is safe for that caller. Each operation must therefore enforce local resource policy after reading verified auth context.

### Question #3: Why use generated and brokered credentials instead of local defaults?

Response: [WebMeet](wiki.html#definition-webmeetagent) encryption and [LiveKit](wiki.html#definition-livekit) signing need stable workspace-owned values without committing plaintext defaults, while external relay credentials must be short-lived and scoped to one current runtime generation. [Ploinky](wiki.html#definition-ploinky) therefore generates the per-agent and intentionally shared [LiveKit](wiki.html#definition-livekit) values and brokers TURN material on demand. There is no compatibility derivation, static TURN password, environment fallback, or alternate credential reader.

### Question #4: Why does the rootless private-Router blocker remain fail-closed?

Response: Reachability is part of the approved interface boundary, not an authorization detail. Binding `8081` to the box outer-facing interface or bypassing Router would make an internal transport externally reachable or skip the coordinated generation and assertion flow. [WebMeet](wiki.html#definition-webmeetagent) therefore keeps the affected selectors inactive until an approved rootless transport can reach the private listener without changing its interface class.

[`webmeetAgent`](wiki.html#definition-webmeetagent) remains compatible with [Ploinky](wiki.html#definition-ploinky) only while it preserves router-mediated entry, secure-wire invocation, scoped guest behavior, explicit Router route policy, workspace-confined storage, redacted logging, derived secrets, and local domain authorization. The rootless private-service lane remains inactive unless the approved managed-bridge reachability contract passes end to end.
