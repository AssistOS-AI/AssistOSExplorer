---
title: DS006-runtime-invariants
summary: Defines the soplangAgent contract covered by DS006-runtime-invariants.
---

# DS006-runtime-invariants

## Introduction

This specification defines the active contract for [soplangAgent](wiki.html#definition-soplangagent).

## Core Content

### DS06 - Ploinky Runtime Invariants

### Introduction

This specification makes the [Ploinky](wiki.html#definition-ploinky) runtime and security invariants local to [`soplangAgent`](wiki.html#definition-soplangagent). Future work from inside this agent directory must not rely on external memory of [Ploinky](wiki.html#definition-ploinky) core behavior; the local specs must carry the same high-level constraints that [Ploinky](wiki.html#definition-ploinky) defines in its routing and security model.

The authoritative upstream contracts are [Ploinky](wiki.html#definition-ploinky) `docs/specs/DS007-routing-and-web-surfaces.md` and `docs/specs/DS013-security-model.md`. This file restates only the invariants that affect this agent's implementation and documentation.

### Core Content

[`soplangAgent`](wiki.html#definition-soplangagent) must treat the [Ploinky](wiki.html#definition-ploinky) router as the browser and [MCP](wiki.html#definition-mcp) trust broker. Browser surfaces, first-party [MCP](wiki.html#definition-mcp) calls, delegated [MCP](wiki.html#definition-mcp) calls, uploads, blobs, and manifest-declared HTTP services are expected to enter through the router so route authentication, session handling, invocation minting, and audit behavior can apply. Direct agent ports are implementation details even when they are bound to localhost.

Executable [MCP](wiki.html#definition-mcp) operations must be authorized by router-minted request JWTs. The launcher/router may derive per-agent request secrets from `PLOINKY_MASTER_KEY`, but the agent runtime must receive only its own `PLOINKY_AGENT_ID`, `PLOINKY_AGENT_SECRET`, and compatibility `PLOINKY_AGENT_PRINCIPAL`. Agents must never receive, derive, or require `PLOINKY_MASTER_KEY` or the legacy `PLOINKY_DERIVED_MASTER_KEY`. Code must not invent alternate bearer-token, client-secret, or caller-header authorization paths around the router's secure-wire model.

Ploinky-owned generated secrets are resolved by the launcher before agent code runs. Agent-owned generated secrets use `generatedSecret: true` for manifest env entries or `{{generatedSecret:NAME}}` for runtime-resource templates; both are scoped to the current agent identity and ignore operator-supplied values. Shared generated credentials that must be identical across agents use `sharedGeneratedSecret: true` and derive from the source env name. Agents consume the resolved values but do not hold the master derivation key. Agents must not invent random persistent agent secrets or require manual configuration for workspace-owned LiveKit, TURN, OnlyOffice, DPU, recording, webhook, or data-encryption secrets. External third-party credentials remain explicitly configured.

The compact `x-ploinky-auth-info` header is not a secure grant by itself. Any HTTP service that receives that header must trust it only when it arrived through a declared [Ploinky](wiki.html#definition-ploinky) HTTP service route and, for guest services, only after validating the router-issued invocation token and the expected guest role or scope. Caller-supplied copies of identity headers must be rejected as authoritative input.

Guest access must remain scoped to the route shape declared by the owning manifest. Manifest-level `guest: true` exposes the agent as a normal guest agent and should still enforce limitations from `usr.roles`. A `routerAccess.httpRoutes` entry with `access: "guest"` exposes only the declared agent-owned path and mints or reuses a route-scoped guest session according to the [Ploinky](wiki.html#definition-ploinky) router's current guest policy. Product-specific public paths must be declared in the agent manifest rather than hard-coded in [Ploinky](wiki.html#definition-ploinky) core.

Agent code must enforce its own domain authorization. [Ploinky](wiki.html#definition-ploinky) route authentication identifies the caller and signs the invocation, but it does not grant every domain operation. Sensitive actions must check the verified user, roles, scopes, target resource, workspace path, and agent-local policy before reading or mutating state.

Runtime isolation is defense in depth, not a hostile multi-tenant guarantee. Containers, bubblewrap, and Seatbelt reduce host exposure, but enabled agent code remains trusted operator-controlled code inside one workspace. Manifest volumes, runtime resources, lifecycle hooks, and network access are intentional grants and must be reviewed as part of the agent contract.

File and static-content handling must stay workspace-confined. Paths must be resolved relative to the workspace root, agent root, configured data directory, or explicit runtime volume. Code must not assume host-specific absolute paths, follow symlink escapes, or place secrets in static roots, plugin assets, HTML documentation, logs, transcripts, screenshots, or test fixtures.

Logs and user-facing errors must not expose secrets, cookies, bearer tokens, invocation JWTs, API keys, raw prompts, hidden policy text, or internal payloads. Detailed diagnostics belong behind explicit debug modes and must still redact sensitive values before persistence.

Agent-local contract:

- Manifest: `soplangAgent/manifest.json`
- Role: [SOPLang](wiki.html#definition-soplangagent) runtime and build contract boundary exposed through [MCP](wiki.html#definition-mcp) and IDE plugin channels.
- Authentication: [SOPLang](wiki.html#definition-soplangagent) operations must use verified invocation context and preserve local tool contract validation. Manifest guest: none.
- HTTP route surface: No public HTTP route is declared; [SOPLang](wiki.html#definition-soplangagent) operations are routed through [MCP](wiki.html#definition-mcp) or local plugin integration.
- Persistent state: State-changing [SOPLang](wiki.html#definition-soplangagent) flows must preserve workspace persistence and avoid hidden writes outside declared paths. Manifest volumes: none.
- Runtime storage: Tool persistence, logs, and audit data resolve below the Ploinky-mounted agent home by default, while explicit environment overrides remain supported. `last-tool.log` and `achilles-debug.log` both live under `LOGS_FOLDER`, defaulting to `$HOME/.soplang/logs`; source and current-working-directory log files are forbidden. Legacy unmounted root paths are not part of the runtime contract.
- Workspace scanning: Active Markdown discovery excludes private `.data` trees while retaining the explicitly public root `.ploinky/repos` source mount.
- Model selection: The agent must use the runtime-provided Achilles model configuration and must not maintain local aliases for Soul Gateway models.
- Tool isolation: Builder and variable tools must not initialize the Achilles skill bridge or an LLM workflow. The bridge is loaded only for an Achilles-owned tool invocation.
- Documentation: `docs/index.html`
- Validation: `npm test` in [soplangAgent](wiki.html#definition-soplangagent).

### Decisions & Questions

### Question #1: Why duplicate Ploinky invariants inside every agent spec set?

Response: Coding work often starts from an individual agent directory, where only local guidance may be read before changes are made. Keeping these [Ploinky](wiki.html#definition-ploinky) invariants in the local specification set prevents agents from accidentally treating router auth, guest mode, direct ports, or invocation headers as agent-specific implementation details that can be bypassed.

### Question #2: Why is route authentication not enough for domain authorization?

Response: [Ploinky](wiki.html#definition-ploinky) establishes who the caller is and signs the invocation path, but domain ownership remains inside the agent. The agent knows which files, records, rooms, leads, secrets, repositories, media objects, or infrastructure controls are safe for that caller. Each agent must therefore enforce its own resource policy after reading verified auth context.

[`soplangAgent`](wiki.html#definition-soplangagent) remains compatible with [Ploinky](wiki.html#definition-ploinky) only while it preserves router-mediated entry, secure-wire invocation, scoped guest behavior, explicit manifest-declared HTTP services, workspace-confined storage, redacted logging, and local domain authorization. Any source change that affects these contracts must update this specification, the local docs, and the local guide files in the same change set.

[soplangAgent](wiki.html#definition-soplangagent) must preserve the responsibilities, boundaries, and observable results stated in this specification.
