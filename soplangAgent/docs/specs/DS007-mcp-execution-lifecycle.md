---
title: DS007-mcp-execution-lifecycle
summary: Defines declared SOPLang MCP contracts, invocation validation, result emission, and persistence before process exit.
---

# DS007-mcp-execution-lifecycle

## Introduction

This specification defines declared SOPLang MCP contracts, invocation validation, result emission, and persistence before process exit.

## Core Content



### Role of This Document

This document specifies what the [Model Context Protocol](wiki.html#definition-mcp) ([MCP](wiki.html#definition-mcp)) tool surface must guarantee and what each tool invocation lifecycle must enforce.

### Contract Surface

The [Model Context Protocol](wiki.html#definition-mcp) ([MCP](wiki.html#definition-mcp)) contract surface is defined by named tools, input schemas, and declared execution properties. Tool names are public agent contracts. A tool name is not an implementation hint; it is the externally visible agent operation.

The current contract set includes document synchronization, workspace build execution, variable inspection, command and type inspection, and skill execution. Additional tools may be introduced, but existing contract semantics must remain stable for unchanged names.

### Lifecycle Rules

Lifecycle Rule L1: each tool invocation starts as a new process lifecycle with fresh input payload context.

Lifecycle Rule L2: the lifecycle must perform preflight validation before operation dispatch, including mandatory metadata required for safe routing.

Lifecycle Rule L3: plugin and skill registration are invocation-scoped preparation stages and must complete before target method execution.

Lifecycle Rule L4: operation result emission must be deterministic at contract level and must return machine-readable output suitable for [MCP](wiki.html#definition-mcp) clients.

Lifecycle Rule L5: lifecycle completion must include persistence-safe finalization, including explicit save behavior where required by operation semantics and shutdown closure behavior before exit.

### Failure Semantics

Failure Rule F1: unsupported tool names produce explicit contract failures.

Failure Rule F2: invalid input schemas produce explicit contract failures and do not trigger partial execution side effects.

Failure Rule F3: plugin bootstrap or execution errors remain attributable and visible to [MCP](wiki.html#definition-mcp) clients.

Failure Rule F4: failed tool execution does not silently report success states.

### Constraints

Constraint M1: a tool call cannot bypass invocation mapping and call private plugin methods directly.

Constraint M2: agent behavior cannot depend on undocumented payload fields.

Constraint M3: lifecycle finalization cannot be skipped for successful state-changing operations.

### Invariants

Invariant T1: each [MCP](wiki.html#definition-mcp) tool request has one declared contract identity and one resolved execution path.

Invariant T2: successful contract completion returns serialized output through [MCP](wiki.html#definition-mcp) response content.

Invariant T3: lifecycle boundaries are strict; invocation state is not guaranteed to persist as shared in-memory runtime state across calls.

### Validation Criteria

Validation is satisfied when independent [MCP](wiki.html#definition-mcp) clients can call the same tool names and obtain contract-consistent outcomes, when unsupported tools fail explicitly, and when state-changing operations persist changes after lifecycle completion.

[soplangAgent](wiki.html#definition-soplangagent) must preserve the responsibilities, boundaries, and observable results stated in this specification.
