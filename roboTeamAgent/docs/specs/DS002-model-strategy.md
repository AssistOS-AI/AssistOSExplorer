---
title: DS002-model-strategy
summary: Separates deterministic robot lifecycle from ALA-selected coding-agent and model execution.
---

## Introduction

RoboTeam's current robot and container control path does not require an LLM.

## Core Content

Robot creation, listing, browser or desktop start, stop, log retrieval, authorization, persistence, HTTP proxying, and WebSocket proxying work without a model provider.

Advanced Language Agent, abbreviated ALA, is RoboTeam's LLM execution layer. RoboTeam owns deterministic robot, task, container, and proxy lifecycle. ALA reads the task prompt, selects a coding-agent backend, runs it inside ALA's Bubblewrap sandbox, and gives it any task-local MCP server configuration.

ALA currently supports `codex`, `opencode`, `pi`, and `auto`. The `auto` choice uses ALA's configured backend priority. RoboTeam resolves the current official npm package for each backend, installs it in a separate shared tool-cache generation, validates its CLI, and places the requested backend on ALA's `PATH`. Automatic selection prepares all three so ALA can apply its configured priority. The executable cache is workspace-wide, while account and configuration state comes only from the robot home supplied through `--home`.

The current ALA `--MCPServers` adapter injects task-local URL configuration into Codex. Desktop and Browser automation must therefore select Codex. OpenCode and Pi may execute Simple tasks, but RoboTeam must not claim that they control the GUI until their adapters implement the same MCP injection contract.

RoboTeam does not hard-code providers, pricing, or tiers. It starts ALA with the selected `--ca` backend and may forward an optional `--model` override. The robot's persistent `--home` owns authentication and backend configuration; RoboTeam injects only task-local MCP URL overrides.
