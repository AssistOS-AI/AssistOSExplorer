---
title: DS004-explorer-integration
summary: Defines the tasksAgent contract covered by DS004-explorer-integration.
---

# DS004-explorer-integration

## Introduction

This specification defines the active contract for [tasksAgent](wiki.html#definition-tasksagent).

## Core Content

### DS04 - Explorer Integration and IDE Plugin Channel

### Role of This Document

This document defines integration rules for Explorer-facing usage of [`tasksAgent`](wiki.html#definition-tasksagent) and its IDE plugin channel.

### Integration Position

Explorer is the user interface (UI) host and interaction layer. [`tasksAgent`](wiki.html#definition-tasksagent) is the backend operation layer for backlog files. IDE plugin assets under `tasksAgent/IDE-plugins/tasks-tool-button/` provide the integration bridge from Explorer UI events to [Model Context Protocol](wiki.html#definition-mcp) ([MCP](wiki.html#definition-mcp)) tool calls.

### Integration Requirements

Requirement U1: Explorer task interactions shall invoke [`tasksAgent`](wiki.html#definition-tasksagent) [MCP](wiki.html#definition-mcp) tools instead of direct backend file mutations.

Requirement U2: plugin toolbar entry at `file-exp:toolbar` shall remain documented and operational.

Requirement U3: plugin components shall remain declaratively registered through plugin configuration.

Requirement U4: UI state transitions for task create/update/delete/reorder shall be based on [MCP](wiki.html#definition-mcp) outcomes.

Requirement U5: conflict and create-file modal flows shall remain agent-contract-driven.

### Constraints

Constraint Q1: UI code cannot bypass [MCP](wiki.html#definition-mcp) and directly mutate backlog files as backend authority.

Constraint Q2: host UI refactors cannot alter [MCP](wiki.html#definition-mcp) contract semantics.

Constraint Q3: plugin metadata changes cannot break declared integration points without coordinated docs/spec updates.

### Invariants

Invariant I1: Explorer-to-agent communication remains MCP-based.

Invariant I2: IDE plugin channel remains integration surface, while task semantics remain backend-owned.

Invariant I3: intermediary role of [`tasksAgent`](wiki.html#definition-tasksagent) between UI intent and backlog operations remains unchanged.

### Validation Criteria

Validation is satisfied when plugin actions call [`tasksAgent`](wiki.html#definition-tasksagent) tools successfully, contract outputs drive expected UI behavior, and backend task semantics remain isolated from UI internals.

[tasksAgent](wiki.html#definition-tasksagent) must preserve the responsibilities, boundaries, and observable results stated in this specification.
