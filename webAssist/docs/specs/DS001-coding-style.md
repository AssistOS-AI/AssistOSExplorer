---
title: DS001-coding-style
summary: Defines source layout, runtime configuration, LLM conventions, and test rules for WebAssist.
---

# DS001 Coding Style

## Introduction

This specification defines the local engineering rules for [WebAssist](wiki.html#definition-webassist).

## Core Content

[WebAssist](wiki.html#definition-webassist) must keep durable session state under configured data paths, derive access from verified [Ploinky](wiki.html#definition-ploinky) invocation context, and keep browser-facing code separate from agent-owned mutations. AchillesAgentLib use is authorized when supplied by [Ploinky](wiki.html#definition-ploinky). All LLM interactions must use the runtime-configured LLMAgent class and environment variables, with repository-level manual overrides available for core runtime configuration. Routing-sensitive documentation, orchestration, bootstrap, and testing tasks must carry task metadata tags. Tests must remain under webAssist/tests/.

Explicit runtime configuration and colocated tests preserve [WebAssist](wiki.html#definition-webassist) behavior across sessions.
