---
title: DS015-ploinky-runtime-invariants
summary: Defines the DS015-ploinky-runtime-invariants contract for WebAssist.
---

# DS015-ploinky-runtime-invariants

## Introduction

This specification defines the active DS015-ploinky-runtime-invariants contract for WebAssist.

## Core Content

### DS012 - Ploinky Runtime Invariants

### Introduction

This specification makes the Ploinky runtime and security invariants local to `webAssist`. Future work from inside this agent directory must not rely on external memory of Ploinky core behavior; the local specs must carry the same high-level constraints that Ploinky defines in its routing and security model.

The authoritative upstream contracts are Ploinky `docs/specs/DS005-routing-and-web-surfaces.md` and `docs/specs/DS011-security-model.md`. This file restates only the invariants that affect this agent's implementation and documentation.

### Core Content

`webAssist` must treat the Ploinky router as the browser and MCP trust broker. Browser surfaces, first-party MCP calls, delegated MCP calls, uploads, blobs, and manifest-declared HTTP services are expected to enter through the router so route authentication, session handling, invocation minting, and audit behavior can apply. Direct agent ports are implementation details even when they are bound to localhost.

Executable MCP operations must be authorized by router-minted request JWTs. The launcher/router may derive per-agent request secrets from `PLOINKY_MASTER_KEY`, but the agent runtime must receive only its own `PLOINKY_AGENT_ID`, `PLOINKY_AGENT_SECRET`, and compatibility `PLOINKY_AGENT_PRINCIPAL`. Agents must never receive, derive, or require `PLOINKY_MASTER_KEY` or the legacy `PLOINKY_DERIVED_MASTER_KEY`. Code must not invent alternate bearer-token, client-secret, or caller-header authorization paths around the router's secure-wire model.

Ploinky-owned generated secrets are resolved by the launcher before agent code runs. Agent-owned generated secrets use `generatedSecret: true` for manifest env entries or `{{generatedSecret:NAME}}` for runtime-resource templates; both are scoped to the current agent identity and ignore operator-supplied values. Shared generated credentials that must be identical across agents use `sharedGeneratedSecret: true` and derive from the source env name. Agents consume the resolved values but do not hold the master derivation key. Agents must not invent random persistent agent secrets or require manual configuration for workspace-owned LiveKit, TURN, OnlyOffice, DPU, recording, webhook, or data-encryption secrets. External third-party credentials remain explicitly configured.

The compact `x-ploinky-auth-info` header is not a secure grant by itself. Any HTTP service that receives that header must trust it only when it arrived through a declared Ploinky HTTP service route and, for guest services, only after validating the router-issued invocation token and the expected guest role or scope. Caller-supplied copies of identity headers must be rejected as authoritative input.

Guest access must remain scoped to the route shape declared by the owning manifest. Manifest-level `guest: true` exposes the agent as a normal guest agent and should still enforce limitations from `usr.roles`. A `routerAccess.httpRoutes` entry with `access: "guest"` exposes only the declared agent-owned HTTP path and mints or reuses a route-scoped guest session according to the Ploinky router's current guest policy. Product-specific public paths must be declared in the agent manifest rather than hard-coded in Ploinky core.

Agent code must enforce its own domain authorization. Ploinky route authentication identifies the caller and signs the invocation, but it does not grant every domain operation. Sensitive actions must check the verified user, roles, scopes, target resource, workspace path, and agent-local policy before reading or mutating state.

Runtime isolation is defense in depth, not a hostile multi-tenant guarantee. Containers, bubblewrap, and Seatbelt reduce host exposure, but enabled agent code remains trusted operator-controlled code inside one workspace. Manifest volumes, runtime resources, lifecycle hooks, and network access are intentional grants and must be reviewed as part of the agent contract.

File and static-content handling must stay workspace-confined. Paths must be resolved relative to the workspace root, agent root, configured data directory, or explicit runtime volume. Code must not assume host-specific absolute paths, follow symlink escapes, or place secrets in static roots, plugin assets, HTML documentation, logs, transcripts, screenshots, or test fixtures.

Logs and user-facing errors must not expose secrets, cookies, bearer tokens, invocation JWTs, API keys, raw prompts, hidden policy text, or internal payloads. Detailed diagnostics belong behind explicit debug modes and must still redact sensitive values before persistence.

Agent-local contract:

- Manifest: `webAssist/manifest.json`
- Role: Visitor-facing guest assistant and lead-conversion agent.
- Authentication: Manifest-level `guest: true` means normal Ploinky guest policy applies; the agent must enforce visitor-only scope from roles and session context. Manifest guest: true. Generated-local credentials and Router transport values are Ploinky-owned, supplied through the mounted verified Router descriptor, and absent from protected legacy manifest overrides. Remote production gateways are configured as providers inside the local Soul Gateway, not as replacement credentials for webAssist.
- HTTP route surface: Manifest `routerAccess.httpRoutes` declares `/IDE-plugins/web-assist-chat/*` with `access: "guest"`. `/webAssist/mcp` is guest-authenticated through manifest-level `guest: true`, not through an HTTP route policy entry.
- Domain authorization: the caller is resolved only from the verified grant in `envelope.metadata.invocation` (a direct guest or user actor whose id equals the signed subject, never a delegated call). `list-sites` requires an admin or the `explorer.access` capability and is denied before storage is read. Chat reuse and history reads are bound to the session owner record (DS004 Session Ownership); site-wide AKU search excludes other visitors' session and lead records, and skills take the site and session only from the trusted execution context.
- Session secret: `sessionSecret` is a session-continuity capability layered on a Router-verified caller, not an alternative to Router authentication; calls without a verified grant are still denied. Its plaintext is consumed only when deciding session reuse or history access and is generated only when a new owned session is created. It is never placed in the runtime prompt, the execution context or skill arguments, debug captures, error messages, AKU state or events, or the owner record (which keeps only its SHA-256 digest). The argument name must stay `sessionSecret`: AgentServer's tool debug logging (`PLOINKY_AGENT_TOOL_DEBUG_LOGS=1`) redacts argument keys by name, and only a key matching `/secret/i` is redacted. Both `web_cli_chat` and `web_cli_history` must declare it as an optional string in `mcp-config.json`, because AgentServer's schema and the Router's argument canonicalization drop undeclared arguments.
- Persistent state: Visitor/session/lead data must remain under the configured data store and must not leak to static plugin assets or logs. Manifest volumes: {".data/webAssist/debuglogs":"/code/debuglogs"}.
- Documentation: `docs/index.html`
- Validation: `node tests/runAll.mjs` in `webAssist/` when visitor flow behavior changes. Router guest changes must also run the headless smoke spec `tests/smoke/specs/15-webassist-guest.spec.mjs`.

### Decisions & Questions

### Question #1: Why duplicate Ploinky invariants inside every agent spec set?

Response: Coding work often starts from an individual agent directory, where only local guidance may be read before changes are made. Keeping these Ploinky invariants in the local specification set prevents agents from accidentally treating router auth, guest mode, direct ports, or invocation headers as agent-specific implementation details that can be bypassed.

### Question #2: Why is route authentication not enough for domain authorization?

Response: Ploinky establishes who the caller is and signs the invocation path, but domain ownership remains inside the agent. The agent knows which files, records, rooms, leads, secrets, repositories, media objects, or infrastructure controls are safe for that caller. Each agent must therefore enforce its own resource policy after reading verified auth context.

### Conclusion

`webAssist` remains compatible with Ploinky only while it preserves router-mediated entry, secure-wire invocation, scoped guest behavior, explicit manifest-declared route policy and HTTP-service boundaries, workspace-confined storage, redacted logging, and local domain authorization. Any source change that affects these contracts must update this specification, the local docs, and the local guide files in the same change set.

## Conclusion

WebAssist must preserve the responsibilities and boundaries stated by this specification.
