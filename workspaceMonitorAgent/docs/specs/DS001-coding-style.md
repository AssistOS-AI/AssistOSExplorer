---
title: DS001-coding-style
summary: Defines local module, storage, security, UI, and test conventions for Workspace Monitor.
---

# DS001 Coding Style

## Introduction

This specification defines the implementation rules for the [Workspace Monitor](wiki.html#definition-workspace-monitor) agent and its Explorer plugin.

## Core Content

The agent must use ES modules, four-space indentation, native Node.js APIs where they cover the requirement, and explicit async control flow. Persistent state must be written under the configured data root and must not depend on process memory surviving a supervisor restart.

The MCP wrapper must derive identity from verified invocation metadata and must apply administrator authorization before dispatching a tool. Logs and errors must not expose secrets or private assertion values. The Explorer plugin must use the shared WebSkel lifecycle and must not read agent storage directly.

Tests must remain under workspaceMonitorAgent/tests/ and must cover settings normalization, authorization, collection cadence, SQLite history, and Ploinky log calls. The local package test command is npm test.

AchillesAgentLib use is authorized when supplied by the Ploinky runtime. Any LLM interaction must use the runtime-configured LLMAgent class and environment-based settings with repository-level manual overrides. [Workspace Monitor](wiki.html#definition-workspace-monitor) currently has no LLM interaction and must not add one without an explicit contract.

Small modules, verified authorization, durable storage, and colocated tests keep [Workspace Monitor](wiki.html#definition-workspace-monitor) safe to operate.
