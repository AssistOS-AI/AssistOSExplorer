---
title: DS002-architecture
summary: Defines the tasksAgent contract covered by DS002-architecture.
---

# DS002-architecture

## Introduction

This specification defines the active contract for [tasksAgent](wiki.html#definition-tasksagent).

## Core Content

### DS02 - Architecture

### Role of This Document

This document defines mandatory architecture rules for [`tasksAgent`](wiki.html#definition-tasksagent) as a [Ploinky](wiki.html#definition-ploinky) [Model Context Protocol](wiki.html#definition-mcp) ([MCP](wiki.html#definition-mcp)) agent.

### Architectural Boundary

The architecture boundary starts at [Model Context Protocol](wiki.html#definition-mcp) ([MCP](wiki.html#definition-mcp)) tool invocation and ends at serialized operation response. Explorer user interface (UI) rendering and host interactions remain outside this boundary. [Backlog](wiki.html#definition-backlog) file execution logic remains inside the agent.

### Architecture Shape

The architecture is organized into contract, wrapper, dispatch, markdown-persistence, and plugin-integration layers.

The contract layer declares tools in `mcp-config.json`. The wrapper layer executes `tools/tasks_tool.sh` for each call. The dispatch layer in `tasks_tool.mjs` parses envelopes, normalizes input, and routes tool handlers. The markdown-persistence layer in `tools/backlog_markdown.mjs` parses and serializes `.backlog` and `.history` files. The plugin-integration layer exposes Explorer UI extension artifacts through `IDE-plugins/tasks-tool-button`.

### Architectural Requirements

Requirement A1: tool declaration shall remain configuration-driven through `mcp-config.json`.

Requirement A2: each invocation shall run through wrapper and dispatcher layers before any backlog mutation.

Requirement A3: tool resolution shall be explicit and fail on unsupported tool names.

Requirement A4: repository-root and path-extension validation shall execute before file operations.

Requirement A5: task mutation flows shall route through the shared Markdown persistence functions and return serialized outcomes.

Requirement A6: Explorer integration shall call [MCP](wiki.html#definition-mcp) tools and shall not embed private backlog runtime operations.

### Constraints

Constraint K1: invocation paths that bypass wrapper parsing and validation are forbidden.

Constraint K2: backlog operations outside allowed path boundaries are forbidden.

Constraint K3: architecture changes that move mutation authority into Explorer UI are forbidden.

Constraint K4: contract behavior cannot depend on undocumented envelope fields.

### Invariants

Invariant V1: one [MCP](wiki.html#definition-mcp) tool request maps to one declared operation path.

Invariant V2: path and extension policy remain mandatory for backlog and history files.

Invariant V3: responses remain machine-readable and include explicit error outcomes when failing.

Invariant V4: IDE plugin channel remains integration surface, while backend semantics remain in the agent.

### Architecture Validation Criteria

Architecture validation succeeds when declared tools execute through wrapper and dispatcher flow, path and file-type constraints are enforced, backlog persistence behavior remains consistent, and Explorer integration remains decoupled from backend internals.

[tasksAgent](wiki.html#definition-tasksagent) must preserve the responsibilities, boundaries, and observable results stated in this specification.
