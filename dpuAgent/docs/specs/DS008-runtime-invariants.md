---
title: DS008-runtime-invariants
summary: Defines the dpuAgent contract covered by DS008-runtime-invariants.
---

# DS008-runtime-invariants

## Introduction

This specification defines the active contract for dpuAgent.

## Core Content

### DS08 - Ploinky Runtime Invariants

### Introduction

This specification makes the Ploinky runtime and security invariants local to `dpuAgent`. Future work from inside this agent directory must not rely on external memory of Ploinky core behavior; the local specs must carry the same high-level constraints that Ploinky defines in its routing and security model.

The authoritative upstream contracts are Ploinky `docs/specs/DS005-routing-and-web-surfaces.md` and `docs/specs/DS011-security-model.md`. This file restates only the invariants that affect this agent's implementation and documentation.

### Core Content

`dpuAgent` must treat the Ploinky router as the browser and MCP trust broker. Browser surfaces, first-party MCP calls, delegated MCP calls, uploads, blobs, and manifest-declared HTTP services are expected to enter through the router so route authentication, session handling, invocation minting, and audit behavior can apply. Direct agent ports are implementation details even when they are bound to localhost.

Executable MCP operations must be authorized by DS013 router-minted Router Request JWTs verified by the bundled Ploinky `AgentServer.mjs` with this agent's `PLOINKY_AGENT_SECRET`. The agent runtime may receive only its own per-agent runtime secret and resolved generated secrets, but it must never receive or require `PLOINKY_MASTER_KEY`. Code must not invent alternate bearer-token, client-secret, or caller-header authorization paths around the router's secure-wire model.

Generated secrets are resolved by Ploinky before agent launch. Agent-owned generated secrets use `generatedSecret: true` for manifest env entries or `{{generatedSecret:NAME}}` for runtime-resource templates; both resolve for the current agent identity and ignore operator-supplied values. Shared generated credentials that must be identical across agents use `sharedGeneratedSecret: true` and resolve from the source env name. Agents must not invent random persistent agent secrets or require manual configuration for workspace-owned LiveKit, TURN, OnlyOffice, DPU, recording, webhook, or data-encryption secrets. External third-party credentials remain explicitly configured.

The compact `x-ploinky-auth-info` header is not a secure grant by itself. Any HTTP service that receives that header must trust it only when it arrived through a declared Ploinky HTTP service route and, for guest services, only after validating the router-issued invocation token and the expected guest role or scope. Caller-supplied copies of identity headers must be rejected as authoritative input.

Guest access must remain scoped to the route shape declared by the owning manifest. Manifest-level `guest: true` exposes the agent as a normal guest agent and should still enforce limitations from `usr.roles`. A `routerAccess.httpRoutes` entry with `access: "guest"` exposes only the declared agent-owned path and mints or reuses a route-scoped guest session according to the Ploinky router's current guest policy. Product-specific public paths must be declared in the agent manifest rather than hard-coded in Ploinky core.

Agent code must enforce its own domain authorization. Ploinky route authentication identifies the caller and signs the invocation, but it does not grant every domain operation. Sensitive actions must check the verified user, roles, scopes, target resource, workspace path, and agent-local policy before reading or mutating state.

Runtime isolation is defense in depth, not a hostile multi-tenant guarantee. Containers, bubblewrap, and Seatbelt reduce host exposure, but enabled agent code remains trusted operator-controlled code inside one workspace. Manifest volumes, runtime resources, lifecycle hooks, and network access are intentional grants and must be reviewed as part of the agent contract.

File and static-content handling must stay workspace-confined. Paths must be resolved relative to the workspace root, agent root, configured data directory, or explicit runtime volume. Code must not assume host-specific absolute paths, follow symlink escapes, or place secrets in static roots, plugin assets, HTML documentation, logs, transcripts, screenshots, or test fixtures.

Logs and user-facing errors must not expose secrets, cookies, bearer tokens, invocation JWTs, API keys, raw prompts, hidden policy text, or internal payloads. Detailed diagnostics belong behind explicit debug modes and must still redact sensitive values before persistence.

Agent-local contract:

- Manifest: `dpuAgent/manifest.json`
- Role: Confidential storage and DPU boundary for Explorer and related agents.
- Authentication: DPU operations must derive actor identity from verified invocation metadata and enforce ACLs locally. Manifest guest: none.
- WebChat: `webchat.auth: "static"` borrows Explorer SSO and its `explorer.access` capability; `webchat.runtimeScope: "principal"` requires a separate router runtime per authenticated user. The CLI accepts only `__webchat_message__` tokens whose signed arguments include `runtimeScope: "principal"`, pins the process to the first verified user principal, and never derives identity from `--sso-*` flags, `SSO_*` environment values or query parameters. No browser session cookie reaches the agent.
- HTTP route surface: No public HTTP route is declared; confidential data must not be exposed through static or anonymous routes.
- Persistent state: Persistent DPU data lives in the manifest runtime storage and must remain encrypted or access controlled according to local specs. Manifest volumes: none.
- Documentation: `docs/index.html`
- Validation: `npm test` in dpuAgent.

### Decisions & Questions

### Question #1: Why duplicate Ploinky invariants inside every agent spec set?

Response: Coding work often starts from an individual agent directory, where only local guidance may be read before changes are made. Keeping these Ploinky invariants in the local specification set prevents agents from accidentally treating router auth, guest mode, direct ports, or invocation headers as agent-specific implementation details that can be bypassed.

### Question #2: Why is route authentication not enough for domain authorization?

Response: Ploinky establishes who the caller is and signs the invocation path, but domain ownership remains inside the agent. The agent knows which files, records, rooms, leads, secrets, repositories, media objects, or infrastructure controls are safe for that caller. Each agent must therefore enforce its own resource policy after reading verified auth context.

### Conclusion

`dpuAgent` remains compatible with Ploinky only while it preserves router-mediated entry, secure-wire invocation, scoped guest behavior, explicit manifest-declared HTTP services, workspace-confined storage, redacted logging, and local domain authorization. Any source change that affects these contracts must update this specification, the local docs, and the local guide files in the same change set.

## Conclusion

dpuAgent must preserve the responsibilities, boundaries, and observable results stated in this specification.
