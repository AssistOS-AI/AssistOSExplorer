---
title: DS006-integration
summary: Defines the DS006-integration contract for WebAssist.
---

# DS006-integration

## Introduction

This specification defines the active DS006-integration contract for WebAssist.

## Core Content

### DS003 - webAssist Integration and Loading

`webAssist` is a Node.js Ploinky agent with CLI, MCP, and embedded chat entry points.

### CLI
- Entry: `webAssist/src/index.mjs`.
- Required: `--site-id <siteId>`.
- Optional: `--session-id <id>`, `--json`.
- `-mcp` runs one request and exits.

### MCP Tools
- `web_cli_chat`: requires `siteId` and `message`; accepts optional `sessionId`, `sessionSecret`, and `json`. Requires a verified guest or direct user caller.
- `web_cli_history`: requires `siteId` and `sessionId`; accepts optional `sessionSecret`. Returns history only to the session owner, a caller with the session secret, or an admin; everyone else receives the missing-session shape (DS004 Session Ownership).
- `register-events`: requires `siteId`, `visitorId`, and `eventType`; accepts optional `sessionId`, `referrer`, `country`, `openedChat`, and `details`.
- `list-sites`: returns `{ sites, count }` with known site IDs from `$WEBASSIST_DATA_ROOT` to an admin or a user holding the `explorer.access` capability. Every other caller is denied before storage is read. The data root path is never returned.

The caller is resolved only from the verified grant AgentServer places in `envelope.metadata.invocation`, never from tool input. Delegated agent calls and malformed grants are denied. Errors are public only for access denials and input validation; other failures reach non-admin callers as `webAssist request failed.` unless `ACHILLES_DEBUG` is enabled.

### Runtime Flow
1. Require and validate the managed root from `process.env.WEBASSIST_DATA_ROOT`. Chat and standalone writers initialize its `data` child themselves. Read-only site/history requests return empty when only that child is absent and never depend on an earlier chat initialization.
2. Resolve `$WEBASSIST_DATA_ROOT/sites/<siteId>/.aku/`.
3. Resolve the effective session before any context is loaded: continue the requested session for its owner or secret holder, otherwise create a new owned session (DS004 Session Ownership).
4. `loadAkuContext` loads session state, relevant AKU search results, and event-driven conversation history for the effective session only.
5. `webassist-session` and `webassist-lead` persist to the site AKU, for the site and session supplied in the trusted execution context.

The data-root initializer does not create site AKUs or bypass their provisioning contract. An event or session write to an uninitialized site fails explicitly even after the application-owned data child has been created.

### Embedded Chat
The iframe URL must include `siteId`. If `siteId` is missing, chat is disabled and a user-facing message is shown.

`web_cli_chat` returns `{ siteId, sessionId, message }` with the effective session id, plus `sessionSecret` only when the call created a new owned session.

## Conclusion

WebAssist must preserve the responsibilities and boundaries stated by this specification.
