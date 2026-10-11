---
title: DS005-configuration
summary: Defines the soplangAgent contract covered by DS005-configuration.
---

# DS005-configuration

## Introduction

This specification defines the active contract for [soplangAgent](wiki.html#definition-soplangagent).

## Core Content

### DS05 - Configuration and Operational Guarantees

### Role of This Document

This document specifies the mandatory operational guarantees derived from manifest, environment, and extension configuration.

### Configuration Scope

The operational scope is defined by agent manifest rules, [Model Context Protocol](wiki.html#definition-mcp) ([MCP](wiki.html#definition-mcp)) configuration, plugin registration behavior, and runtime environment variables. Configuration is not a documentation artifact only; it is the executable policy boundary for agent behavior.

### Operational Requirements

Requirement O1: the agent manifest shall define container/runtime profile information required by [Ploinky](https://ploinky.com/) lifecycle management.

Requirement O2: the [MCP](wiki.html#definition-mcp) tool configuration shall remain the authoritative declaration for exposed tool contracts.

Requirement O3: required environment inputs for debugging and LLM access shall remain explicit and externally configurable.

Requirement O4: persistence, logs, and audit paths used during tool execution shall be available as runtime environment context.

Requirement O5: local skills in the `skills` folder shall remain discoverable and registrable as [SOPLang](wiki.html#definition-soplangagent) command-capable assets, even if current agent flows do not actively use each skill.

Requirement O6: repository test validation shall run with `npm test` from `soplangAgent/`.

Requirement O7: the logger supplied to Achilles subsystems shall implement `log`, `debug`, `info`, `warn`, and `error`, so failure reporting never replaces the original operational error with a logger interface error.

### Constraints

Constraint R1: introducing hidden required environment dependencies is forbidden.

Constraint R2: changing declared tool names in configuration is allowed only when `mcp-config.json`, documentation, specifications, and tests are updated together.

Constraint R3: removing persistence path semantics from runtime context is forbidden.

### Invariants

Invariant G1: configuration remains the source of truth for what operations are publicly exposed.

Invariant G2: operational debugging capability can be enabled without changing tool contracts.

Invariant G3: extension assets may grow, but intermediary agent role between user interface (UI) flows and [SOPLang](wiki.html#definition-soplangagent) remains unchanged.

Invariant G4: the logger contract preserves the original operational error when an upstream request fails.

### Validation Criteria

Validation is satisfied when the agent starts under declared manifest constraints, exposes the declared tools from configuration, respects declared environment semantics, preserves contract behavior across normal operational restarts, and passes `npm test` from `soplangAgent/` after code changes.

[soplangAgent](wiki.html#definition-soplangagent) must preserve the responsibilities, boundaries, and observable results stated in this specification.
