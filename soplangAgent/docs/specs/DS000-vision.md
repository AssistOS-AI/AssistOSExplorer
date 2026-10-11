---
title: DS000-vision
summary: Defines the soplangAgent contract covered by DS000-vision.
---

# DS000-vision

## Introduction

This specification defines the active contract for [soplangAgent](wiki.html#definition-soplangagent).

## Core Content

### DS01 - Vision

### Role of This Document

This document defines the strategic rules for soplangBuilder as a [Ploinky](wiki.html#definition-ploinky) agent intermediary between user interface (UI) clients and [SOPLang](wiki.html#definition-soplangagent) runtime services. It locks the purpose and the non-negotiable agent boundaries used by [DS02 - Architecture](specsLoader.html?spec=DS002-architecture.md), [DS007-mcp-execution-lifecycle](specsLoader.html?spec=DS007-mcp-execution-lifecycle.md), and [DS04 - UI Bridge and IDE Plugin Integration](specsLoader.html?spec=DS004-ui-bridge.md).

### Agent Context

soplangBuilder is integrated in [Ploinky](https://ploinky.com/) and serves UI workflows that need controlled access to [SOPLang](https://assistos-ai.github.io/soplang/) capabilities. This repository is not a generic agent host and not a frontend framework. The [Ploinky](wiki.html#definition-ploinky) agent is a stable contract surface that allows UI layers to trigger workspace synchronization, build execution, skill execution, and data inspection through [Model Context Protocol](wiki.html#definition-mcp) ([MCP](wiki.html#definition-mcp)) tools.

The current UI consumer path includes the internal AssistOSExplorer repository. A public URL is not required for this role; the requirement is reliable contract alignment with Explorer integration points.

### Vision Direction

The direction is to keep soplangBuilder as an explicit boundary, not a transparent pass-through. UI layers must consume a constrained tool surface. [SOPLang](wiki.html#definition-soplangagent) internals must stay encapsulated behind [MCP](wiki.html#definition-mcp) tool contracts. Agent behavior must be stable across plugin evolution, provided contract names and semantics are unchanged.

### Agent Expectations

Expectation E1: any supported UI client can discover and call the same named tools through [MCP](wiki.html#definition-mcp) without direct [SOPLang](wiki.html#definition-soplangagent) runtime coupling.

Expectation E2: tool calls produce attributable and deterministic outcomes at contract level, even when internal plugin implementations evolve.

Expectation E3: agent behavior remains restart-safe and persistence-safe so workspace changes survive process termination.

Expectation E4: skills discovered through AchillesAgentLib become callable through the same command model used by other [SOPLang](wiki.html#definition-soplangagent) commands.

### Requirements

Requirement R1: soplangBuilder shall expose a finite [MCP](wiki.html#definition-mcp) tool set defined by configuration, and each tool shall represent a meaningful agent operation, not a transport primitive.

Requirement R2: the agent shall always execute tool requests through the wrapper entrypoint and shall not allow alternate execution paths that bypass wrapper validation and shutdown behavior.

Requirement R3: the agent shall preserve its intermediary role by translating UI requests into [SOPLang](wiki.html#definition-soplangagent) operations and returning normalized responses suitable for UI consumption.

Requirement R4: the agent shall preserve persistence guarantees after state-changing operations, including explicit save and graceful shutdown semantics.

Requirement R5: the agent shall keep extension capability through skills and plugins while preserving a stable outer [MCP](wiki.html#definition-mcp) contract.

### Constraints

Constraint C1: direct UI invocation of [SOPLang](wiki.html#definition-soplangagent) internals is out of scope for this agent.

Constraint C2: adding tools that leak provider-specific runtime internals is forbidden.

Constraint C3: changing existing tool semantics is allowed only when the declared contracts, documentation, specifications, and tests are updated in the same change scope, and test validation runs through `npm test` from `soplangAgent/`.

Constraint C4: coupling agent guarantees to a single UI implementation detail is forbidden.

### Invariants

Invariant I1: soplangBuilder remains an integration layer between UI and [SOPLang](wiki.html#definition-soplangagent), never a replacement for either side.

Invariant I2: [MCP](wiki.html#definition-mcp) tool names are the public agent contract for the current repository state.

Invariant I3: state-changing flows must end in persistence-safe termination behavior.

Invariant I4: skill availability may vary by environment, but the `execute_skill` contract remains part of the agent surface.

### Validation Criteria

The [Ploinky](wiki.html#definition-ploinky) agent passes vision-level validation when [MCP](wiki.html#definition-mcp) clients can execute documented operations without direct [SOPLang](wiki.html#definition-soplangagent) internals, when state survives tool lifecycle boundaries, and when replacing internal plugin implementations does not change the expected contract behavior for unchanged inputs.

[soplangAgent](wiki.html#definition-soplangagent) must preserve the responsibilities, boundaries, and observable results stated in this specification.
