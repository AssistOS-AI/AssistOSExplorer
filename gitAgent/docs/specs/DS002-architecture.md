---
title: DS002-architecture
summary: Defines the gitAgent contract covered by DS002-architecture.
---

# DS002-architecture

## Introduction

This specification defines the active contract for [gitAgent](wiki.html#definition-gitagent).

## Core Content

### DS02 - Architecture

### Role of This Document

This document defines mandatory architecture rules for [`gitAgent`](wiki.html#definition-gitagent) as a [Ploinky](wiki.html#definition-ploinky) [Model Context Protocol](wiki.html#definition-mcp) ([MCP](wiki.html#definition-mcp)) agent.

### Architectural Boundary

The agent boundary starts at [Model Context Protocol](wiki.html#definition-mcp) ([MCP](wiki.html#definition-mcp)) tool invocation and ends at normalized result emission to [MCP](wiki.html#definition-mcp) clients. Explorer-side rendering, host layout, and interaction concerns remain outside this boundary. Raw Git command execution internals are encapsulated in agent services.

### Architecture Shape

The architecture has a contract layer, wrapper layer, dispatch layer, Git service layer, auth layer, and user interface (UI)-extension layer.

The contract layer declares tools in `mcp-config.json`. The wrapper layer executes `tools/git_tool.sh` for each invocation. The dispatch layer in `git_tool.mjs` parses envelopes, validates arguments, and routes operations. The Git service layer executes subprocess commands with timeout and structured parsing. The auth layer manages GitHub device flow and token storage integration. The UI-extension layer exposes IDE plugin artifacts for Explorer. Dependency installation remains outside the tool boundary and is orchestrated by `ploinky`; the manifest requests `lite-sandbox: true` and performs only runtime-appropriate Git availability checks or container package installation before startup.

### Architectural Requirements

Requirement A1: tool declaration shall remain configuration-driven through `mcp-config.json`.

Requirement A2: invocation dispatch shall resolve one tool operation per request and fail explicitly for unsupported tools.

Requirement A3: each invocation shall run in an isolated process lifecycle started from the wrapper script.

Requirement A4: repository path validation shall run before any Git subprocess execution.

Requirement A5: remote operations shall support token fallback from auth context or stored auth state.

Requirement A6: UI integration shall use [MCP](wiki.html#definition-mcp) calls and shall not require private runtime imports from Git services.

Requirement A7: manifest startup configuration shall not duplicate generic Node dependency installation already orchestrated by `ploinky`; it may validate the host Git executable for host sandbox startup or install Git packages in container startup.

Requirement A8: Git helper flows that use LLM assistance shall request the Achilles `fast` model explicitly through `executePrompt({ model: "fast" })`; legacy `mode` options are not part of the Achilles invocation contract.

Requirement A9: commit-message generation shall use one synthesis request when the selected diff fits the direct prompt budget. Larger changes shall include every selected file, group them into bounded semantic batches, and reduce them into one complete commit message so implementation, UI, configuration, tests, and documentation remain connected without one provider request per file. No global file-count limit may silently discard selected changes.

Requirement A10: commit-message generation shall discard empty or failed batch results and synthesize from the valid summaries that remain. If final synthesis is empty or fails, the agent shall return a deterministic message derived from the valid summaries, or from the complete affected-file inventory when no valid summary exists.

### Constraints

Constraint K1: invocation paths that bypass wrapper parsing and validation are forbidden.

Constraint K2: subprocess execution without timeout guardrails is forbidden.

Constraint K3: architecture changes that move Git execution into Explorer UI are forbidden.

Constraint K4: auth flows that expose raw token values to UI components as persistent state are forbidden.

### Invariants

Invariant V1: one [MCP](wiki.html#definition-mcp) tool request maps to one declared contract operation.

Invariant V2: path-policy enforcement remains active regardless of tool type.

Invariant V3: response payloads remain machine-readable and error-attributable.

Invariant V4: IDE plugin integration remains a client channel, not the source of backend execution semantics.

### Architecture Validation Criteria

Architecture validation succeeds when declared tools execute through the wrapper and dispatcher layers, path constraints are enforced, auth-assisted remote operations behave predictably, and Explorer integration remains decoupled from Git subprocess internals.

[gitAgent](wiki.html#definition-gitagent) must preserve the responsibilities, boundaries, and observable results stated in this specification.
