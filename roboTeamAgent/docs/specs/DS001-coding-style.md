---
title: DS001-coding-style
summary: Defines source structure, JavaScript conventions, runtime configuration, AchillesAgentLib rules, security practices, and modular test organization.
---

## Introduction

This specification is the canonical coding-style and test-organization authority for RoboTeamAgent. Source changes must preserve the single-agent architecture, Router-mediated access, profile ownership, and explicit boundary between desktop management and task execution.

## Core Content

Runtime JavaScript must use ECMAScript modules. Server modules and command entry points should use the `.mjs` extension, named exports for testable units, Node.js built-in APIs where they are sufficient, and small modules organized by one primary responsibility. Browser modules may use `.js` when loaded as modules by the public HTML pages.

Source code must use four-space indentation in JavaScript and shell continuations that remain easy to audit. Identifiers must name concrete actors and operations. Public errors must avoid secrets and cross-owner existence disclosure. Comments must explain a non-obvious invariant, security boundary, or failure behavior and must not restate syntax.

The root `fileSizesCheck.sh` check defines the repository's portable file-size and line-length baseline. A source file that becomes difficult to review must be split by responsibility before adding unrelated behavior. Markdown and HTML prose must remain unwrapped in source so the renderer uses the full content width.

Configuration must be resolved at process startup and passed into constructors or factory functions. Environment variables provide deployment defaults; tests and embedding code must be able to supply explicit manual overrides without mutating global environment state. Secrets must remain in environment or Ploinky-generated secret channels and must never appear in manifests as literal values, logs, test fixtures, browser code, documentation examples, or thrown errors.

AchillesAgentLib is authorized for orchestration code. Any LLM interaction added to RoboTeam must use the AchillesAgentLib `LLMAgent` class and a runtime configuration object that can override environment-derived defaults. Direct provider SDK calls and hard-coded provider or model identifiers are prohibited. Routing-sensitive Achilles work must apply task metadata tags that identify documentation, specification work, orchestration, bootstrap, or testing as applicable.

The HTTP service must treat Router-injected `x-ploinky-auth-info` as the only browser-user identity source. Browser state mutations must remain behind the Ploinky mutation-proof gate. MCP command processes may reach the loopback service only with the generated internal token and the authenticated user id provided by AgentServer metadata.

Filesystem operations must validate profile identifiers before path construction, resolve paths beneath an established root, use restrictive modes for sensitive state, and use atomic replacement for metadata. Code must not follow a client-controlled path outside the selected profile. Destructive profile deletion is not part of the public interface.

Tests must use Node's built-in test runner unless a separate integration need is specified. Unit tests must isolate persistent data in a temporary directory, avoid real credentials, and cover owner separation, invalid identifiers, storage layout, authentication boundaries, and deterministic desktop command construction. Tests that require X11, Chromium, VNC, container routing, or an authenticated browser must be separate integration tests and must state their runtime prerequisites.

Implementation changes that alter product behavior, public interfaces, routing, persistence, security, or architecture must update the affected HTML documentation and DS specifications in the same change. DS numbering must remain contiguous, and `DS003-main-behavior.md` must be regenerated only from the accepted behavior analysis.
