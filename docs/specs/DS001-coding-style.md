---
title: DS001-coding-style
summary: Defines source layout, JavaScript conventions, WebSkel UI rules, and verification requirements for AchillesIDE changes.
---

# DS001 Coding Style

## Introduction

This specification defines the repository-wide coding and verification rules that preserve reliable agent boundaries and a consistent Explorer interface.

## Core Content

JavaScript must use ES modules, `async` and `await` for asynchronous control flow, four-space indentation, and native platform facilities before new dependencies. JSON and YAML must use two-space indentation. Modules must be placed beside the feature they serve, and durable state must not depend on process memory because Ploinky may restart an agent.

Path handling must resolve from an agent root, configured data directory, or active workspace root. Code must not embed workstation-specific absolute paths. Logs and user-facing failures must not disclose credentials, tokens, system prompts, hidden reasoning, or private storage locations.

Explorer UI changes must use the WebSkel component and presenter lifecycle, shared Explorer tokens, shared controls, standard modal behavior, and existing reusable components before adding local styles or controls. Local CSS must be limited to feature-specific structure and responsive behavior. Client code must present state and invoke tools; authorization and domain mutation must remain in the owning agent.

Browser UUID generation must work on direct HTTP LAN origins, where `crypto.randomUUID()` may be unavailable. Use WebSkel's shared `createSecureUuid` export, which uses native UUID generation or `crypto.getRandomValues()` and fails explicitly if secure randomness is unavailable. Preserve existing document identifiers, prefixes and retry idempotency keys. Do not use timestamp/`Math.random()` ID fallbacks or replace browser security APIs globally. WebSkel fixes belong in its source repository; rebuild its ESM/UMD distributions before copying them into Explorer.

Documentation uses one primary page-navigation model per site. Multi-page agent documentation places explanatory page links in its sidebar and keeps only the `Reference` submenu with `Wiki` and `Specifications` in the header. A single-page agent uses its sidebar for section anchors and keeps the same reference-only header. Explorer's root documentation may place page destinations in grouped header submenus when no parallel page sidebar is present. Header colors, submenu behavior, active states, body width, and responsive breakpoints must remain visually consistent across the root site and agent sites.

Tests must be colocated under the owning agent's `tests/` tree. A change must run the narrowest relevant test first and then the affected agent suite. Explorer changes must run `npm test` from `explorer/`; DPU changes must run `npm test` from `dpuAgent/`.

AchillesAgentLib use is authorized only from the one source selected and supplied by the Ploinky runtime. Agent packages must not declare, install, or clone another AgentLib copy. Runtime configuration must support repository-level manual overrides in addition to environment defaults. All LLM interactions must use the runtime-configured `LLMAgent` class and its environment variables. Routing-sensitive documentation, specification, orchestration, bootstrap, and testing work must carry task metadata tags.

## Conclusion

Consistent module boundaries, safe data handling, and shared WebSkel conventions keep the workspace maintainable across independently deployed agents.
