---
title: DS002-architecture
summary: Defines the soplangAgent contract covered by DS002-architecture.
---

# DS002-architecture

## Introduction

This specification defines the active contract for [soplangAgent](wiki.html#definition-soplangagent).

## Core Content

### DS02 - Architecture

### Role of This Document

This document defines the architecture for soplangBuilder as a [Ploinky](wiki.html#definition-ploinky) agent. The architecture description is rule-oriented and focuses on mandatory behavior, constraints, and invariants, independent of low-level implementation details.

### Architectural Boundary

soplangBuilder lives between [Ploinky](https://ploinky.com/) AgentServer [Model Context Protocol](wiki.html#definition-mcp) ([MCP](wiki.html#definition-mcp)) routing and [SOPLang](https://assistos-ai.github.io/soplang/) plugin/runtime services. The agent boundary starts at [MCP](wiki.html#definition-mcp) tool invocation and ends at normalized response emission after persistence-safe finalization.

The architecture is intentionally intermediary. User interface (UI) concerns remain in Explorer interface systems. [SOPLang](wiki.html#definition-soplangagent) language semantics remain in [SOPLang](wiki.html#definition-soplangagent) runtime and plugins. soplangBuilder owns orchestration, contract mapping, and lifecycle guarantees.

### Architecture Shape

The architecture is composed of five logical layers. The contract layer defines tools and schemas in `mcp-config.json`. The invocation layer maps tool names to plugin method calls. The runtime bootstrap layer initializes required plugins and skill bridges for the current call scope. The execution layer performs the target operation. The finalization layer enforces persistence and shutdown guarantees.

Each layer has one agent-level purpose and must not absorb responsibilities from adjacent layers. This separation is mandatory to keep contract behavior stable while allowing internal evolution.

### Architectural Requirements

Requirement A1: [MCP](wiki.html#definition-mcp) tool declaration shall be configuration-driven and shall resolve to one wrapper command entrypoint.

Requirement A2: tool-name to method resolution shall be explicit and deterministic, with unsupported tool names producing attributable failures.

Requirement A3: every invocation shall run in an isolated process lifecycle that performs bootstrap, execution, and finalization in one bounded flow.

Requirement A4: [SOPLang](wiki.html#definition-soplangagent) and skill-related capabilities shall be registered through plugin contracts, not hardcoded ad-hoc call paths.

Requirement A5: after execution, the architecture shall apply persistence-safe termination behavior before process exit.

Requirement A6: the architecture shall support UI-driven asynchronous tool usage through [MCP](wiki.html#definition-mcp) task behavior without redefining tool semantics.

### Constraints

Constraint K1: direct tool execution that bypasses invocation mapping is forbidden.

Constraint K2: architecture changes that remove the intermediary role and expose raw [SOPLang](wiki.html#definition-soplangagent) internals to UI clients are forbidden.

Constraint K3: persistence finalization shortcuts that can lose committed workspace changes are forbidden.

Constraint K4: plugin-specific assumptions are not allowed to alter [MCP](wiki.html#definition-mcp) contract semantics for unchanged tool names and inputs.

### Invariants

Invariant V1: a valid tool request always maps to exactly one declared contract operation.

Invariant V2: bootstrap and registration happen per invocation scope; cross-invocation shared mutable plugin state is not an agent guarantee.

Invariant V3: state-changing paths end with persistence-safe closure semantics.

Invariant V4: UI integrations call [MCP](wiki.html#definition-mcp) contracts and do not depend on private [SOPLang](wiki.html#definition-soplangagent) runtime APIs.

### Architecture Validation Criteria

For unchanged input payloads and unchanged tool configuration in the current repository state, architecture-level behavior remains contract-aligned. Unsupported tool requests fail with explicit error outcomes. State-changing operations survive lifecycle completion. UI clients can trigger the same contract operations independently of internal plugin refactoring.

[soplangAgent](wiki.html#definition-soplangagent) must preserve the responsibilities, boundaries, and observable results stated in this specification.
