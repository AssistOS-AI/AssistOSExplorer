---
title: DS005-runtime-and-mcp
summary: Defines the dpuAgent contract covered by DS005-runtime-and-mcp.
---

# DS005-runtime-and-mcp

## Introduction

This specification defines the active contract for dpuAgent.

## Core Content

### DS05 - Runtime and Model Context Protocol Interface

### Summary

`dpuAgent` exposes its domain through Model Context Protocol (MCP) tools declared in `mcp-config.json`. The agent runs under the bundled Ploinky `AgentServer.mjs`; it does not maintain a custom standalone HTTP MCP runtime.

### Background / Problem Statement

Explorer and related plugins need a stable way to call the confidential domain. They should not depend on internal storage files or guess how actor identity should be resolved. The runtime layer therefore needs to do two things reliably:

- normalize the incoming request envelope
- dispatch into the domain layer with validated inputs and auth context

### Dispatch Boundary

Each Model Context Protocol tool entry in `mcp-config.json` points to `tools/dpu_tool.sh`, which launches `tools/dpu_tool.mjs`. The tool dispatcher:

1. parses the Model Context Protocol envelope
2. reads the verified `metadata.invocation` grant
3. normalizes the input object
4. validates required fields and enum-like values
5. dispatches into `lib/dpu-store.mjs`

The bundled Ploinky `AgentServer.mjs` loads `mcp-config.json`, registers the tools, verifies router-issued secure-wire requests, and routes execution through the same wrapper and dispatcher.

The DPU Research WebChat entry point is a second first-party surface for the same research operations. It verifies the router-minted `__webchat_message__` request against the exact message envelope using the agent's per-agent runtime secret, derives the actor from the verified grant, and then exposes the research tool definitions from `mcp-config.json` to the conversational planner. The planner handlers and MCP dispatcher share `lib/dpu-research-tools.mjs`, so argument validation, invocation-scope enforcement, audit and domain dispatch do not diverge. The model never receives the invocation token and cannot supply an actor identifier.

The manifest declares `webchat.auth: "static"`, so DPU Research WebChat borrows the workspace's static-agent (Explorer) SSO session and Explorer's required capability (`explorer.access`); guests and users without that capability never reach the agent. It also declares `webchat.runtimeScope: "principal"`: the router keeps a separate WebChat runtime for every authenticated user, never broadcasts one user's output or history to another, refuses a principal-scoped runtime request without an authenticated user, and limits each user to three DPU WebChat runtimes (the oldest idle one is replaced; with none idle, a fourth is refused). The router signs `runtimeScope: "principal"` into the `__webchat_message__` arguments, and the CLI always includes that field when it recomputes the request hash, so a token from a router without per-user runtimes fails verification before any LLM or tool call. The process is pinned to the first verified user principal; a request from a different principal, or a grant without a user principal, is refused with the generic WebChat error before planning. Identity comes only from the verified grant: `--sso-*` launch flags, `SSO_*` environment values and query parameters never select the actor, and the browser session cookie is never passed to the agent. Administrators receive no implicit resource access through WebChat, and the planner exposes no `dpu_secret_*` tool.

Planner decisions use the Achilles Markdown decision envelope. For a DPU tool call, the `prompt` section must contain exactly one fenced `json` block and no surrounding text. The fenced value must decode to one JSON object and then pass the tool's declared input validation before dispatch. Raw JSON, prose around the fence, untyped fences, arrays, malformed JSON and unknown tool names fail closed. `final_answer` and `cannot_complete` remain user-facing Markdown/text rather than tool-argument JSON. Research searches omit `sourceIds` unless the planner obtained exact DPU source UUIDs from a DPU result; provider types and names are rejected as source IDs.

For routed callers, the trusted auth context is carried by a router-issued DS013 Router Request JWT in the HTTP `Authorization: Bearer <jwt>` header. Direct agent calls present a DS013 Agent Assertion to the router as `Authorization: Bearer <assertion>`; the router verifies the source agent, applies MCP policy, and mints a fresh DPU-audience Router Request for the target tool. When the source agent also presents a router-issued User Delegation Grant, the router may allow that source-bound, tool-bound call to an authenticated DPU tool such as `dpu_secret_put`, and the resulting Router Request carries both the source agent and delegated user context. Only canonical `dpu_secret_*` operations exist; this release has no `dpu_agent_secret_*` compatibility aliases. The MCP runtime must verify `typ`, `iss`, `aud`, `tool`, `rch`, `exp`, and `jti` before exposing delegated user or caller-agent data to the domain layer. Legacy `x-ploinky-invocation`, `x-ploinky-caller-jwt`, `x-ploinky-caller-assertion`, `x-ploinky-user-context`, and `x-ploinky-auth-info` headers are not trusted.

The auth payload may also include optional agent context, for example:

```json
{
  "usr": { "id": "local:admin", "username": "admin" },
  "caller": "agent:AssistOSExplorer/gitAgent",
  "aud": "agent:AssistOSExplorer/dpuAgent"
}
```

Agent principals are derived by Ploinky from the installed agent ref as `agent:<repo>/<agent>`; manifests no longer declare their own `identity` block. When both `user` and `agent` are present, DPU keeps ownership and user-space resolution anchored to the authenticated user principal while access control list evaluation may match either the user principal or the agent principal directly — short-name aliases like `agent:gitAgent` are no longer recognized.

When DPU grants a secret role to an agent principal, it validates the requested role against DPU-owned policy stored in `permissions.manifest.json -> agentPolicies[<principalId>].secrets.allowedRoles`. No agent manifest is consulted. If no policy exists for the principal, the grant is rejected. Admins configure these policies through the `dpu_agent_policy_get` / `dpu_agent_policy_set` tools.

### Tool Families

The current tool families are:

- actor identity and roots
- fixed audit policy and audit file access
- secrets
- confidential objects
- confidential comments
- grants, revokes, and access checks

This is a domain surface, not a storage-debug surface. The caller asks for secret or confidential operations, not for direct reads and writes of internal DPU files.

### Audit-Specific Contract

`dpuAgent` exposes dedicated audit tools instead of treating audit logs as generic confidential files:

- `dpu_audit_config_get`
- `dpu_audit_list`
- `dpu_audit_get`
- `dpu_audit_search`
- `dpu_audit_event_append`

Audit file writes happen through two controlled paths:

- internal DPU domain auditing for secret and confidential operations
- the dedicated `dpu_audit_event_append` ingest tool for non-AI Explorer-side events such as file open, file update, plugin usage, and UI actions

Browser clients and other agents must not write audit files directly. They can only submit events through the dedicated ingest tool, and DPU remains the component that materializes JSONL files on disk.

Audit viewing is restricted to trusted actors:

- a local authenticated `admin` user
- or actors with role `admin`
- or actors with role `security`

The runtime must enforce this before listing or reading `/Confidential/Audit`.

Audit collection is permanently enabled. DPU operations, file access, Explorer actions, and plugin usage are captured. AI, LLM, and Copilot events are rejected and prompt or response content is never stored. There is no audit-configuration mutation tool.

### Practical Guarantees

`dpuAgent/manifest.json` requests `lite-sandbox: true`, so Ploinky should prefer the host sandbox runtime for the agent when the host supports it and use the container image only when host sandboxing is disabled.

`mcp-config.json` sets `maxParallelTasks` to `1`. Mutating operations also run under the DPU file lock. This gives the runtime a simple single-writer discipline even though the agent is file-backed.

Authorization is enforced before sensitive material is returned. In practical terms, a caller may receive an object or secret record with limited fields while the encrypted secret value or confidential file content remains hidden because the resolved role does not allow it.

## Conclusion

dpuAgent must preserve the responsibilities, boundaries, and observable results stated in this specification.
