---
title: DS001-coding-style
summary: Defines source layout, runtime configuration, security, and test conventions for tasksAgent.
---

# DS001 Coding Style

## Introduction

This specification defines the local engineering rules for [tasksAgent](wiki.html#definition-tasksagent).

## Core Content

The agent must use the module and language conventions already established by its source tree, keep persistent state under configured runtime storage, and avoid workstation-specific absolute paths. Authorization must derive from verified [Ploinky](wiki.html#definition-ploinky) invocation context. Secrets, tokens, assertions, and private storage locations must not appear in logs or browser state.

Explorer-facing UI must use the shared WebSkel lifecycle and existing controls. Agent tests must remain under the owning tests directory and must run with the local package test command. AchillesAgentLib use is authorized when supplied by [Ploinky](wiki.html#definition-ploinky); any LLM interaction must use the runtime-configured LLMAgent class with environment settings and repository-level manual overrides.

Small modules, explicit runtime boundaries, and colocated tests keep [tasksAgent](wiki.html#definition-tasksagent) maintainable and safe.
