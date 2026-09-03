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

Advanced Language Agent, abbreviated ALA, is RoboTeam's LLM execution layer. RoboTeam owns deterministic robot, task, container, and proxy lifecycle. ALA reads the task prompt, selects a coding-agent backend, runs it inside ALA's Bubblewrap sandbox, and gives it any task-local MCP server configuration.

ALA currently supports `codex`, `opencode`, `pi`, and `auto`. The `auto` choice uses ALA's configured backend priority. A selected backend is usable only when its CLI executable is available and its account and configuration state can be read from the robot home supplied through `--home`. RoboTeam prepares Codex in its shared tool cache. OpenCode and Pi require separate provisioning in the outer runtime.

The current ALA `--MCPServers` adapter injects task-local URL configuration into Codex. Desktop and Browser automation must therefore select Codex. Provisioned OpenCode and Pi backends may execute Simple tasks, but RoboTeam must not claim that they control the GUI until their adapters implement the same MCP injection contract.

RoboTeam does not hard-code providers, pricing, or tiers. It starts ALA with the selected `--ca` backend and may forward an optional `--model` override. The robot's persistent `--home` owns authentication and backend configuration; RoboTeam injects only task-local MCP URL overrides.

## Decisions & Questions

### Question #1: Where does coding-agent execution run?

Response: RoboTeam starts ALA in the outer runtime. ALA selects and runs the configured coding agent; RoboTeam remains responsible for deterministic robot and container lifecycle.

### Question #2: Where does Codex configuration live?

Response: The Codex executable is shared through a persistent current-version cache, while each robot's persistent home owns its saved account and configuration state.

### Question #3: Does `--home` install a coding-agent CLI?

Response: No. It selects the persistent directory that contains backend configuration and authentication state. The executable must also exist in the outer runtime; RoboTeam currently prepares Codex automatically.

## Conclusion

Graphical workstation availability is independent of model availability.
