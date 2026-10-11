---
title: DS004-ui-bridge
summary: Defines the soplangAgent contract covered by DS004-ui-bridge.
---

# DS004-ui-bridge

## Introduction

This specification defines the active contract for [soplangAgent](wiki.html#definition-soplangagent).

## Core Content

### DS04 - UI Bridge and IDE Plugin Integration

### Role of This Document

This document defines agent rules for the user interface (UI) integration role of soplangBuilder, including IDE plugin insertion and [Model Context Protocol](wiki.html#definition-mcp) ([MCP](wiki.html#definition-mcp)) communication behavior.

### User Interface Bridge Position

soplangBuilder exposes UI-facing extension artifacts through `IDE-plugins` and operational application programming interfaces (APIs) through [MCP](wiki.html#definition-mcp) tools. This defines a two-channel bridge. The presentation channel inserts UI components in Explorer host surfaces. The operation channel executes [MCP](wiki.html#definition-mcp) tools against agent contracts.

The bridge must keep concerns separate: UI components trigger agent operations, while tool execution and persistence semantics remain server-side responsibilities.

### Integration Requirements

Requirement U1: IDE plugin artifacts must be discoverable and injectable by host UI systems without requiring private runtime imports.

Requirement U2: UI actions that mutate or inspect workspace state must call [MCP](wiki.html#definition-mcp) tools and must not depend on direct [SOPLang](wiki.html#definition-soplangagent) runtime binding in browser code.

Requirement U3: long-running operations must expose progress through [MCP](wiki.html#definition-mcp) task-state updates so UI components can represent queued, running, completed, and failed states.

Requirement U4: UI integration must support internal Explorer repository workflows even when there is no public Explorer URL.

Requirement U5: agent-provided UI actions must remain mapped to documented contract operations.

Requirement U6: SOPLang-specific document plugin bundles for variable editing and script execution must remain agent-owned under `soplangAgent/IDE-plugins` so Explorer base UI can stay decoupled from [SOPLang](wiki.html#definition-soplangagent) implementation details.

Requirement U7: the SCRIPTA variants plugin remains the Advanced Editor adapter, but its generic variants presentation is loaded from Explorer's whitelisted `shared/ui/scripta-variants-view` component. The adapter owns Advanced Editor document lookup, stable owner identity, and persistence; the shared component emits semantic `scripta-p-variant-*` UI events and owns no persistence path. Every participant may vote on a variant, while edit and delete controls are available only when the current user owns that variant.

### Constraints

Constraint Q1: browser components are not allowed to bypass [MCP](wiki.html#definition-mcp) and call private plugin internals.

Constraint Q2: host UI layout details are not allowed to change backend contract semantics.

Constraint Q3: visual plugin insertion points may evolve, but operation contracts must stay stable.

### Invariants

Invariant I1: UI-to-runtime communication path is MCP-based.

Invariant I2: IDE plugin channel remains optional for agent execution; [MCP](wiki.html#definition-mcp) contracts remain primary integration boundary.

Invariant I3: integration keeps soplangBuilder as intermediary between UI intent and [SOPLang](wiki.html#definition-soplangagent) runtime operations.

### Validation Criteria

Validation is satisfied when UI plugin actions trigger [MCP](wiki.html#definition-mcp) tools successfully, when task updates are observable for asynchronous operations, when SOPLang-specific bundles (`edit-variables`, `run-script`) are loaded from `soplangAgent/IDE-plugins`, when the SCRIPTA adapter consumes the Explorer shared variants component without moving persistence into shared UI, and when backend behavior remains aligned with declared contracts regardless of host UI refactors.

[soplangAgent](wiki.html#definition-soplangagent) must preserve the responsibilities, boundaries, and observable results stated in this specification.
