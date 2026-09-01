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

Tests use Node's built-in runner and temporary data roots. They cover owner isolation, migration, validation, exact Podman arguments, lifecycle serialization, authentication, and proxy paths. Real nested Podman and Selkies checks are deployment smoke tests. Any future LLM call must use AchillesAgentLib `LLMAgent`; current control remains deterministic.

## Decisions & Questions

1. **Decision:** persistence, container lifecycle, and transport stay in separate modules.
2. **Decision:** behavior, HTML documentation, and DS contracts change together.

## Conclusion

The codebase favors small deterministic modules and exact authority boundaries.
