---
title: DS001-coding-style
summary: Defines source layout, JavaScript conventions, WebSkel UI rules, and verification requirements for AchillesIDE changes.
---

# DS001 Coding Style

## Introduction

This specification defines the repository-wide coding and verification rules that preserve reliable agent boundaries and a consistent [Explorer](wiki.html#definition-explorer) interface.

## Core Content

JavaScript must use ES modules, `async` and `await` for asynchronous control flow, four-space indentation, and native platform facilities before new dependencies. JSON and YAML must use two-space indentation. Modules must be placed beside the feature they serve, and durable state must not depend on process memory because [Ploinky](wiki.html#definition-ploinky) may restart an agent.

Path handling must resolve from an agent root, configured data directory, or active workspace root. Code must not embed workstation-specific absolute paths. Logs and user-facing failures must not disclose credentials, tokens, system prompts, hidden reasoning, or private storage locations.

[Explorer](wiki.html#definition-explorer) [UI](wiki.html#definition-ui) changes must use the [WebSkel](wiki.html#definition-webskel) component and presenter lifecycle, shared [Explorer](wiki.html#definition-explorer) tokens, shared controls, standard modal behavior, and existing reusable components before adding local styles or controls. Local CSS must be limited to feature-specific structure and responsive behavior. Client code must present state and invoke tools; authorization and domain mutation must remain in the owning agent.

Browser UUID generation must work on direct HTTP LAN origins, where `crypto.randomUUID()` may be unavailable. Use [WebSkel](wiki.html#definition-webskel)'s shared `createSecureUuid` export, which uses native UUID generation or `crypto.getRandomValues()` and fails explicitly if secure randomness is unavailable. Preserve existing document identifiers, prefixes and retry idempotency keys. Do not use timestamp/`Math.random()` ID fallbacks or replace browser security APIs globally. [WebSkel](wiki.html#definition-webskel) fixes belong in its source repository; rebuild its ESM/UMD distributions before copying them into [Explorer](wiki.html#definition-explorer).

Documentation uses one primary navigation system in the header. Every destination must appear inside a subject-based submenu, including Wiki and Specifications. Sidebars may contain page-local section anchors only. Each index must contain a Documentation Map table that exactly matches the header groups, labels, targets, and order. Header colors, submenu behavior, active states, body width, and responsive breakpoints must remain visually consistent across the root site and agent sites.

Tests must be colocated under the owning agent's `tests/` tree. A change must run the narrowest relevant test first and then the affected agent suite. [Explorer](wiki.html#definition-explorer) changes must run `npm test` from `explorer/`; [DPU](wiki.html#definition-dpu) changes must run `npm test` from `dpuAgent/`.

AchillesAgentLib use is authorized only from the one source selected and supplied by the [Ploinky](wiki.html#definition-ploinky) runtime. Agent packages must not declare, install, or clone another AgentLib copy. Runtime configuration must support repository-level manual overrides in addition to environment defaults. All LLM interactions must use the runtime-configured `LLMAgent` class and its environment variables. Routing-sensitive documentation, specification, orchestration, bootstrap, and testing work must carry task metadata tags.

Consistent module boundaries, safe data handling, and shared [WebSkel](wiki.html#definition-webskel) conventions keep the workspace maintainable across independently deployed agents.
