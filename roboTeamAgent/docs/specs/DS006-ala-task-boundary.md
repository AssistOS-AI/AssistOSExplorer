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

A Desktop task must produce an invocation equivalent to `ala --home /data/robots/<robot-id>/home --cwd /workspace/<project> --taskFile /data/robots/<robot-id>/runtime/<task-id>.prompt --ca codex --MCPServers desktop=http://127.0.0.1:<port>/mcp`. A Browser task uses the `browser` MCP name. A Simple task omits `--MCPServers`. Concrete robot ids, cwd values, task ids, coding-agent choices, and loopback ports vary per request.

`--home` selects persistent coding-agent authentication and configuration. `--cwd` selects the writable work tree and disables ALA's temporary workspace. `--taskFile` supplies the prompt without placing its full text in process arguments. `--ca` selects `auto`, `codex`, `opencode`, or `pi`. `--MCPServers` supplies task-local Streamable HTTP MCP endpoints. `--skillSets` optionally restricts skills found under `<cwd>/.agents/skills`, and `--model` optionally overrides the selected backend's native model.

For GUI work RoboTeam passes `--MCPServers name=http://127.0.0.1:<random>/mcp`. The random port is the outer loopback mapping of fixed inner port `8100`. ALA translates that value into transient Codex configuration overrides. Saved configuration and authentication under the robot home remain authoritative and are not rewritten. Desktop and Browser tasks must use Codex until the OpenCode and Pi adapters implement equivalent MCP URL injection.

The ALA child is cancellable. Stopping a task or taking control sends termination to ALA while preserving the GUI container. Resume replays the original request as a new task with an explicit fresh-observation instruction. Only one active task is allowed per robot.

When `--ca` selects Codex or automatic selection, RoboTeam prepares the current cached Codex generation and prepends its binary directory to the ALA child `PATH`. The executable cache is shared, while Codex account and configuration state remains under the robot-specific `--home`.

ALA owns the coding-agent sandbox even when it runs inside RoboTeam's outer container. It must first probe its normal user-namespace and private-procfs path. The current bounded nested runtime rejects the procfs mount inside that additional user namespace, so ALA may use its capability-assisted private-proc path: Bubblewrap omits the extra user namespace, retains private PID, IPC, and UTS namespaces and the private procfs, constructs the mounts using the outer admitted capability, and drops all capabilities before starting Codex. Codex must disable its redundant native sandbox inside this boundary. Neither this Codex setting nor ALA's private-proc fallback permits execution outside the ALA Bubblewrap filesystem and environment boundary.

## Decisions & Questions

### Question #1: Where does the controller run?

Response: ALA runs in the outer RoboTeam container, parallel to the inner GUI container. The coding agent itself remains isolated by ALA Bubblewrap.

### Question #2: How is MCP exposed?

Response: Streamable HTTP on fixed inner port `8100`, published to a random outer loopback port and never routed publicly.

### Question #3: What remains interchangeable?

Response: The `--ca` boundary keeps Codex, OpenCode, and Pi selectable; Codex is the default and receives URL-based MCP overrides.

### Question #4: Does RoboTeam install Codex into every robot?

Response: No. RoboTeam shares one validated executable generation and keeps only authentication and configuration in each robot home.

### Question #5: Does the nested-runtime fallback remove coding-agent containerization?

Response: No. RoboTeam remains isolated from the host by its outer Podman boundary, and Codex remains inside ALA's Bubblewrap boundary. The fallback removes only an additional UID namespace that cannot mount private procfs in the current nested environment; all capabilities are dropped before Codex starts, and failure to create private procfs remains fatal.

### Question #6: Which component owns LLM decisions?

Response: ALA owns prompt execution, coding-agent selection, model forwarding, skill exposure, and MCP injection. RoboTeam owns robot records, task state, GUI containers, and bridge lifetime.

## Conclusion

The task boundary keeps orchestration, GUI lifetime, coding-agent state, filesystem scope, and MCP transport explicit and independently controllable.
