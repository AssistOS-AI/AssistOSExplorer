---
title: DS001-coding-style
summary: Defines local source layout, documentation, test, validation, and runtime style for webmeetAgent.
---

# DS001-coding-style

### DS001 - Coding Style

## Introduction

This specification is the local coding-style authority for [`webmeetAgent`](wiki.html#definition-webmeetagent). It extends the AssistOSExplorer repository conventions with the source layout, validation expectations, and documentation rules needed by the [WebMeet](wiki.html#definition-webmeetagent) application agent.

## Core Content

[`webmeetAgent`](wiki.html#definition-webmeetagent) uses Node.js ES modules. JavaScript files should follow the surrounding style: four-space indentation, `async`/`await`, native Node APIs where practical, camelCase filenames, and small modules kept beside related logic. Shell scripts must remain portable for the container image that runs them and should fail early on missing required runtime configuration.

The local source layout is contract-bearing:

| Path | Purpose |
| --- | --- |
| `manifest.json` | [Ploinky](wiki.html#definition-ploinky) agent command, network, dependency edges, volumes, Router access policy, and profile env. |
| `scripts/startAgent.sh` | Starts the [MCP](wiki.html#definition-mcp) AgentServer. |
| `lib/` | Store, crypto, event append files, secrets helpers, and workspace path resolution. |
| `tools/` | [MCP](wiki.html#definition-mcp) tool dispatcher and shell entrypoint. |
| `IDE-plugins/webmeet-tool-button/` | Explorer and direct room-entry [WebMeet](wiki.html#definition-webmeetagent) browser UI, [LiveKit](wiki.html#definition-livekit) client integration, media settings, participant cards, and local vendored assets. |
| `tests/unit/` | Focused regression tests for auth routing, events, media controls, runtime APIs, and UI service helpers. |
| `docs/specs/` | Authoritative DS contracts. |

The blackboard panel composes small method modules by responsibility. `webmeet-blackboard-rendering.js` owns only the generic render lifecycle and widget dispatch; graphics, Poll/Bullets collaboration, [SCRIPTA](wiki.html#definition-scripta) commands, and [SCRIPTA](wiki.html#definition-scripta) document rendering live in adjacent dedicated modules. Repeated UI structure belongs in inert templates in the WebSkel component HTML. Renderers clone those templates, assign untrusted workspace values through `textContent`, and set live state through properties or `data-*` attributes; they must not interpolate workspace content through `innerHTML`. Click actions use WebSkel `data-local-action` descriptors and presenter methods, with string context carried in descriptor arguments or `dataset`. Explicit DOM listeners are reserved for interactions that are not WebSkel click actions, including pointer gestures, keyboard/blur editing, and semantic custom-component events.

Documentation, specifications, and comments must be written in English. Any source change that affects behavior, interfaces, architecture, security boundaries, route shape, storage, runtime configuration, or validation must update the relevant DS files and the local HTML documentation in the same change set.

[`webmeetAgent`](wiki.html#definition-webmeetagent) must avoid dependency creep in the base meeting service. There is intentionally no `webmeetAgent/package.json` for external AI worker dependencies, and `webmeetAgent/scripts/startAgent.sh` must not run npm install or import `@livekit/agents`.

All request-time LLM inference must go through `achillesAgentLib` helpers, not direct provider HTTP. Meeting chat must not introduce inline provider dispatch.

Runtime paths must be derived from `PLOINKY_WORKSPACE_ROOT`, `WORKSPACE_ROOT`, `PLOINKY_CWD`, `ASSISTOS_FS_ROOT`, the configured [WebMeet](wiki.html#definition-webmeetagent) data directory, the agent root, or declared volumes. Source must not hardcode workstation-specific absolute paths or expose host paths in browser responses.

Validation should start with the narrowest check that covers the edited surface. Useful local checks include:

- `node --check tools/webmeet_tool.mjs`
- `node --check IDE-plugins/webmeet-tool-button/webmeet-tool-button.js`
- `node --test tests/unit/*.test.mjs` when behavior or browser-service helpers change.

Auth, guest-route, [LiveKit](wiki.html#definition-livekit) token, or runtime topology changes also require a [Ploinky](wiki.html#definition-ploinky) smoke path that starts [WebMeet](wiki.html#definition-webmeetagent) through Explorer or a clear note explaining why that runtime check was not run.

### Decisions & Questions

### Question #1: Why keep `DS001-coding-style.md` local when AssistOSExplorer already defines coding conventions?

Response: The parent conventions define the shared Explorer baseline. [`webmeetAgent`](wiki.html#definition-webmeetagent) adds local constraints around room-scoped public entry, browser-vendored media assets, [Ploinky](wiki.html#definition-ploinky) room-agent behavior, and validation commands. Future edits from this directory need those rules without searching across the workspace.

### Question #2: Why is dependency ownership part of coding style?

Response: Dependency placement changes startup behavior. [WebMeet](wiki.html#definition-webmeetagent) room agents are modeled inside [`webmeetAgent`](wiki.html#definition-webmeetagent) as Ploinky-managed room metadata and tool behavior; [LiveKit](wiki.html#definition-livekit) remains the media/runtime transport, not an AI worker runtime. The source-layout rule prevents a local implementation detail from becoming a runtime availability regression.

[`webmeetAgent`](wiki.html#definition-webmeetagent) code remains maintainable while it follows the existing ES module style, keeps runtime responsibilities in their established directories, updates DS contracts with behavior changes, and validates the exact surface being changed.
