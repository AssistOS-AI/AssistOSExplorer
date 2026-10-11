---
title: DS003-main-behavior
summary: Defines task and history operations through Explorer with repository-confined storage and explicit errors.
---

# DS003-main-behavior

## Introduction

The [Tasks agent](wiki.html#definition-tasksagent) lets workspace users create, inspect, reorder, update, and complete tasks in repository backlog files through Explorer and [MCP](wiki.html#definition-mcp) tools.

## Core Content

### Main Behavior Components

| Name | Explanation |
| --- | --- |
| [Backlog](wiki.html#definition-backlog) operations through Explorer | Users manage task records and completion history through the owning agent. |
| Repository-confined task storage | Users can change only supported backlog and history files inside the selected repository. |

### Backlog operations through Explorer

An Explorer task action invokes the declared configuration, list, get, create, update, delete, history, or reorder tool. The agent reads the selected Markdown backlog, applies the requested operation, and returns structured JSON. Updates with an `ifMatch` hash reject a changed task unless the caller explicitly requests `force`; completing a task preserves its history through the task storage contract. [DS004-explorer-integration](specsLoader.html?spec=DS004-explorer-integration.md) defines UI ownership and [DS007-mcp-task-lifecycle](specsLoader.html?spec=DS007-mcp-task-lifecycle.md) defines invocation semantics.

### Repository-confined task storage

`repoPath` selects the repository boundary. [Backlog](wiki.html#definition-backlog) and history arguments must be absolute filesystem paths inside that boundary and use `.backlog` or `.history` as appropriate; `/.ploinky/...` virtual paths are rejected. Canonical path checks reject symbolic-link escapes before reading or writing. Invalid input and failed writes return explicit failures. [DS005-path-safety](specsLoader.html?spec=DS005-path-safety.md) defines the complete path policy.
