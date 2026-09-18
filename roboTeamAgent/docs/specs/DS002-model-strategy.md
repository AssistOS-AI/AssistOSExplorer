---
title: DS002-model-strategy
summary: Separates deterministic robot lifecycle from ALA-selected coding-agent and model execution.
---

## Introduction

RoboTeam's current robot and container control path does not require an LLM.

## Core Content

Robot creation, listing, browser or desktop start, stop, log retrieval, authorization, persistence, HTTP proxying, and WebSocket proxying work without a model provider.

Advanced Language Agent, abbreviated ALA, is RoboTeam's LLM execution layer. RoboTeam owns deterministic robot, task, container, and proxy lifecycle. ALA reads the task prompt, selects a coding-agent backend, runs it inside ALA's Bubblewrap sandbox, and gives it any task-local MCP server configuration.

ALA currently supports `codex`, `opencode`, `pi`, and `auto`. The `auto` choice uses ALA's configured backend priority. RoboTeam resolves the current official npm package for each backend, installs it in a separate shared tool-cache generation, validates its CLI, and places the requested backend on ALA's `PATH`. Automatic selection prepares only the robot's configured coding agents so ALA can apply its priority among available executables. New robots configure only Codex. Explicit backend requests must name an enabled agent; the server retains support for multiple enabled agents. The executable cache is workspace-wide, while account and configuration state comes only from the robot home supplied through `--home`.

The current ALA `--MCPServers` adapter injects task-local URL configuration into Codex. Desktop and Browser automation must therefore select Codex. OpenCode and Pi may execute Simple tasks, but RoboTeam must not claim that they control the GUI until their adapters implement the same MCP injection contract.

RoboTeam starts ALA with the selected `--ca` backend and may forward an optional `--model` override. The robot's persistent `--home` owns personal authentication and backend configuration. RoboTeam injects task-local MCP URL overrides and the local Soul Gateway provider for OpenCode. Model names, tiers and prices must come from the gateway catalog rather than a vendor-specific list in RoboTeam.

### Soul Gateway model catalog

RoboTeam must install the same repository-owned JavaScript plugin in each robot's global OpenCode plugin directory. OpenCode's asynchronous `config` hook must fetch the local Soul Gateway `/v1/models` catalog and populate `provider.soul-gateway.models` in memory. No generated `opencode.json` or wrapper-supplied `OPENCODE_CONFIG_CONTENT` is required for the gateway. Existing unrelated provider and permission settings must remain intact.

Discovery occurs when native OpenCode initializes its provider configuration, including a new model-list process or execution. There must be no periodic polling or 60-second catalog cache. Existing native instances retain their initialized model list until reinitialization; a new OpenCode process reads the current catalog. Discovery failures must produce an explicit service-unavailable error rather than silently selecting another provider.

Exact gateway model IDs, available context/output limits and token prices must map to OpenCode metadata. Absent limits and reasoning-effort choices must not be invented. Manual terminal launches, Desktop launches, WebChat autocomplete and ALA execution must use the same installed plugin from the robot home. WebChat model discovery must run OpenCode in the same canonical cwd/home sandbox as execution so the working-home gateway socket link resolves; a model-list process must not use a sandbox that hides the robot home. The selector presents `soul-gateway/<gateway-model-id>`; inference forwards the exact gateway ID. Reading the currently selected model must not fetch the catalog. This integration must not switch the coding backend or add gateway entries to a Codex or Pi catalog.

### Model and effort selection

The robot chat `/model <model-id> [effort|default]` command validates effort against ALA native model metadata before saving. A native model ID may contain spaces; the command resolves the longest known ID and treats a single trailing token as the effort. `/model` lists models and their supported efforts; WebChat autocomplete first offers models as subcommands, then the selected model's supported efforts and `default` as argument completions, and the terminal picker asks for effort when supported. The selection is persisted atomically in the dedicated robot home `.ala/config.json` under `codingAgents.models` and `codingAgents.efforts`. An absent native config falls back to legacy workspace selections without deleting them; once the native config exists, its model and effort maps are authoritative. `/model default` clears both overrides for the current backend. Selecting a model without effort clears its old effort. Every execution snapshots this configuration; a running turn keeps its captured selection.

Models without effort metadata must not open an effort menu. Selecting an effort must insert `/model <model-id> <effort>`; the autocomplete catalog must not enumerate model/effort combinations at the model-selection stage.

WebChat runtime state must carry the model and optional effort together at startup, session selection, model changes, and turn selection. The header must display a configured effort beside the model in the same badge. Resetting effort must clear the previous displayed value. Turn-selection events must use the effort captured for that execution, not a later configuration read.
