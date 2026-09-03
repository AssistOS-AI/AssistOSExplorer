---
title: DS006-ala-task-boundary
id: DS006
status: accepted
owner: RoboTeamAgent
summary: Defines the outer ALA process, persistent home, cwd, MCP injection, cancellation, and resume boundary.
---

## Introduction

ALA is the task executor started by RoboTeam; it is not responsible for creating desktop or browser containers.

## Core Content

RoboTeam launches ALA from the outer agent runtime after the required GUI, tool-cache generation, and MCP bridge are ready, or after coding-agent preparation for a simple task. It passes `--home` using the robot's persistent home, `--cwd` using the caller-selected workspace directory, `--taskFile` using a private runtime prompt file, and `--ca` using the selected coding agent. Optional `--skillSets` and `--model` values are forwarded.

For GUI work RoboTeam passes `--MCPServers name=http://127.0.0.1:<random>/mcp`. The random port is the outer loopback mapping of fixed inner port `8100`. ALA translates that value into transient Codex configuration overrides. Saved configuration and authentication under the robot home remain authoritative and are not rewritten.

The ALA child is cancellable. Stopping a task or taking control sends termination to ALA while preserving the GUI container. Resume replays the original request as a new task with an explicit fresh-observation instruction. Only one active task is allowed per robot.

When `--ca` selects Codex or automatic selection, RoboTeam prepares the current cached Codex generation and prepends its binary directory to the ALA child `PATH`. The executable cache is shared, while Codex account and configuration state remains under the robot-specific `--home`.

## Decisions & Questions

### Question #1: Where does the controller run?

Response: ALA runs in the outer RoboTeam container, parallel to the inner GUI container. The coding agent itself remains isolated by ALA Bubblewrap.

### Question #2: How is MCP exposed?

Response: Streamable HTTP on fixed inner port `8100`, published to a random outer loopback port and never routed publicly.

### Question #3: What remains interchangeable?

Response: The `--ca` boundary keeps Codex, OpenCode, and Pi selectable; Codex is the default and receives URL-based MCP overrides.

### Question #4: Does RoboTeam install Codex into every robot?

Response: No. RoboTeam shares one validated executable generation and keeps only authentication and configuration in each robot home.

## Conclusion

The task boundary keeps orchestration, GUI lifetime, coding-agent state, filesystem scope, and MCP transport explicit and independently controllable.
