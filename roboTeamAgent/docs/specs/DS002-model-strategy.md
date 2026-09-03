---
title: DS002-model-strategy
id: DS002
status: accepted
owner: RoboTeamAgent
summary: Separates deterministic robot lifecycle from ALA-selected coding-agent and model execution.
---

## Introduction

RoboTeam's current robot and container control path does not require an LLM.

## Core Content

Robot creation, listing, browser or desktop start, stop, log retrieval, authorization, persistence, HTTP proxying, and WebSocket proxying work without a model provider.

RoboTeam does not hard-code providers, pricing, or tiers. It starts ALA with the selected `--ca` backend and may forward an optional `--model` hint. The robot's persistent `--home` owns authentication and backend configuration; RoboTeam injects only task-local MCP URL overrides.

## Decisions & Questions

### Question #1: Where does coding-agent execution run?

Response: RoboTeam starts ALA in the outer runtime. ALA selects and runs the configured coding agent; RoboTeam remains responsible for deterministic robot and container lifecycle.

### Question #2: Where does Codex configuration live?

Response: The Codex executable is shared through a persistent current-version cache, while each robot's persistent home owns its saved account and configuration state.

## Conclusion

Graphical workstation availability is independent of model availability.
