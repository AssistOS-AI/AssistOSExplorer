---
title: DS000-vision
summary: Defines AchillesIDE as the Ploinky workspace shell and the ownership boundary between Explorer and domain agents.
---

# DS000 Vision

## Introduction

AchillesIDE provides one browser-based workspace where users can browse files, edit content, inspect previews, and invoke domain workflows without moving between unrelated applications.

## Core Content

[Explorer](wiki.html#definition-explorer) must remain the workspace shell. It must own routing, navigation, shared presentation, preview selection, source editing, and runtime plugin mounting. Domain agents must retain ownership of their domain state, authorization, and mutations.

The product must expose ordinary workspace files and virtual domain resources through coherent [Explorer](wiki.html#definition-explorer) workflows. A domain integration must not duplicate its authorization policy in [Explorer](wiki.html#definition-explorer) or require [Explorer](wiki.html#definition-explorer) to persist the agent's domain data.

The repository must keep the user-facing contract in `README.md`, explanatory pages in `docs/`, and normative requirements in this specification set. Specifications are the source of truth when explanatory prose conflicts with a documented contract.

AchillesIDE is an integrated workspace shell with agent-owned domain boundaries, rather than a monolithic implementation of every workspace operation.
