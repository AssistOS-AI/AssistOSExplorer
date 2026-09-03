---
title: DS001-coding-style
id: DS001
status: accepted
owner: RoboTeamAgent
summary: Defines source structure, runtime configuration, security practices, and tests for the nested robot runtime.
---

## Introduction

This specification is the coding and test authority for RoboTeamAgent.

## Core Content

Runtime JavaScript uses ECMAScript modules, four-space indentation, named exports for testable units, and Node.js built-ins where sufficient. Configuration is resolved at startup and passed to constructors; tests may supply explicit overrides.

Identifiers and public interfaces use `robot`, never `profile`. Public errors avoid secrets and cross-owner existence disclosure. Secrets remain in environment or Ploinky-generated channels and never enter manifests, browser code, examples, or logs.

Browser identity comes from Router-injected `x-ploinky-auth-info`. MCP commands call the loopback service only with the generated internal token and AgentServer-authenticated user id. Filesystem operations validate robot ids, stay beneath the data root, use restrictive modes, and replace metadata atomically.

Inner Podman commands use argument vectors. Container operations target exact names and managed labels; broad pruning and public engine sockets are prohibited. Only the allowlisted `browser` and `desktop` modes select images.

Runtime dependency preparation belongs in `server/tool-cache.mjs`. Cache updates must use unique staging directories, executable validation, immutable generations, and atomic descriptor replacement. Runtime code must accept injected cache and process implementations so tests never require network access or a real nested engine.

Tests use Node's built-in runner and temporary data roots. They cover owner isolation, validation, exact Podman arguments, lifecycle serialization, ALA execution, cache reuse and fallback, authentication, and proxy paths. Real nested Podman, upstream registry, and Selkies checks remain deployment smoke tests.

## Decisions & Questions

### Question #1: How are runtime responsibilities separated?

Response: Persistence, container lifecycle, tool-cache preparation, transport, and workstation control stay in separate modules.

### Question #2: What documentation accompanies behavior changes?

Response: Source behavior, HTML documentation, tests, and DS contracts change together.

## Conclusion

The codebase favors small deterministic modules and exact authority boundaries.
