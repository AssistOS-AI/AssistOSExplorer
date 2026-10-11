---
title: DS000-vision
summary: Defines the gitAgent contract covered by DS000-vision.
---

# DS000-vision

## Introduction

This specification defines the active contract for [gitAgent](wiki.html#definition-gitagent).

## Core Content

### DS01 - Vision

### Role of This Document

This document defines the strategic rules for [`gitAgent`](wiki.html#definition-gitagent) as a [Ploinky](wiki.html#definition-ploinky) agent that mediates between Explorer user interface (UI) flows and Git command execution.

### Agent Context

[`gitAgent`](wiki.html#definition-gitagent) is integrated in [Ploinky](wiki.html#definition-ploinky) and consumed by internal Explorer workflows. The agent is not a UI framework and not a generic shell proxy. The agent exposes a controlled [Model Context Protocol](wiki.html#definition-mcp) ([MCP](wiki.html#definition-mcp)) contract for Git capabilities and centralizes path policy, error normalization, and auth handling.

The repository may host multiple agents in the future. This specification set addresses the current [`gitAgent`](wiki.html#definition-gitagent) scope.

### Vision Direction

The direction is to keep Git process execution behind [MCP](wiki.html#definition-mcp) contracts, with Explorer acting as interaction layer and the agent acting as operational boundary. The agent must keep deterministic contract behavior for unchanged inputs and preserve guardrails that prevent unsafe filesystem reach.

### Agent Expectations

Expectation E1: supported UI clients can trigger Git operations through [MCP](wiki.html#definition-mcp) without direct shell-level Git integration.

Expectation E2: repository path access remains constrained to declared workspace roots.

Expectation E3: remote operations can integrate auth state without leaking token internals to UI layers.

Expectation E4: error outcomes are attributable and suitable for UI handling.

### Requirements

Requirement R1: the agent shall expose Git capabilities only through declared [MCP](wiki.html#definition-mcp) tool contracts.

Requirement R2: the agent shall preserve intermediary behavior between Explorer and Git by converting tool calls into validated Git operations.

Requirement R3: the agent shall enforce workspace-root path restrictions before Git execution.

Requirement R4: the agent shall support auth-assisted remote operations through explicit auth tools and token fallback behavior.

Requirement R5: the agent shall document and preserve the IDE plugin channel used by Explorer integrations.

### Constraints

Constraint C1: direct UI execution of raw Git shell commands is out of scope for this agent.

Constraint C2: tool behavior that bypasses path validation is forbidden.

Constraint C3: changing existing tool semantics is allowed only when contracts, documentation, specifications, and tests are updated in the same change scope.

Constraint C4: hidden side effects outside declared repository paths are forbidden.

### Invariants

Invariant I1: [`gitAgent`](wiki.html#definition-gitagent) remains an intermediary layer between Explorer intent and Git execution.

Invariant I2: [MCP](wiki.html#definition-mcp) tool names are the public agent contract for the current repository state.

Invariant I3: tool failures remain explicit and do not silently report success.

Invariant I4: path policy enforcement remains mandatory for repository operations.

### Validation Criteria

The agent passes vision validation when Explorer-facing workflows can run Git operations through [MCP](wiki.html#definition-mcp), path safety rules are enforced consistently, and contract outcomes stay predictable for unchanged inputs.

[gitAgent](wiki.html#definition-gitagent) must preserve the responsibilities, boundaries, and observable results stated in this specification.
