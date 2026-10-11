---
title: DS003-main-behavior
summary: Defines structured document synchronization, explicit workspace builds, and invocation-safe persistence.
---

# DS003-main-behavior

## Introduction

The [SOPLang](wiki.html#definition-soplangagent) agent lets workspace users synchronize structured Markdown documents and execute the workspace build through declared [MCP](wiki.html#definition-mcp) operations.

## Core Content

### Main Behavior Components

| Name | Explanation |
| --- | --- |
| Document synchronization and workspace builds | Users synchronize structured documents and explicitly start the build that executes workspace skills. |
| Invocation validation and persistence | [MCP](wiki.html#definition-mcp) clients receive a declared result or an explicit failure, and state changes survive process completion. |

### Document synchronization and workspace builds

A `sync_markdown_documents` call scans supported Markdown documents and synchronizes them into the [SOPLang](wiki.html#definition-soplangagent) workspace without running the build pipeline. A separate `execute_workspace_build` call runs the build after synchronization. Variable, command, and type inspection expose the workspace information used by Explorer. Synchronization and execution must remain distinct actions so inspecting or importing documents does not silently execute their skills. [DS002-architecture](specsLoader.html?spec=DS002-architecture.md) defines the participating plugins.

### Invocation validation and persistence

Each request starts through `soplang-tool.sh`, validates its input and routing metadata, and registers the required plugins before dispatch. Successful state-changing operations must save the affected state and complete shutdown before exit. Unsupported operations and execution failures must not report success. [DS007-mcp-execution-lifecycle](specsLoader.html?spec=DS007-mcp-execution-lifecycle.md) preserves the detailed lifecycle contract; [DS006-runtime-invariants](specsLoader.html?spec=DS006-runtime-invariants.md) governs runtime authorization.
