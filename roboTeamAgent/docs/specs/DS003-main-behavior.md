---
title: DS003-main-behavior
summary: Defines workspace robot administration, retained visible workstations, and queued observable ALA execution.
---

## Introduction

RoboTeam lets workspace administrators maintain durable robots and lets internal workspace agents submit visible or non-GUI work by unique robot name. The robot keeps its account state and at most one graphical container while its ALA tasks execute serially.

## Core Content

### Main Behavior Components

| Name | Explanation |
| --- | --- |
| Workspace robot administration | Administrators create and delete shared robot records, while internal workspace agents list and run them by a workspace-unique name. |
| Retained visible workstation | A Desktop or Browser container exposes the same Selkies session to ALA and a human, retains the final screen after task completion, and is reused or replaced according to mode and cwd. |
| Queued observable ALA execution | Native asynchronous MCP start tools queue work per robot, stream ALA messages through Ploinky task logs, and reach a terminal state when the ALA process exits. |

### Workspace robot administration

An authenticated administrator uses `robot_create` and `robot_delete` to manage workspace-scoped [robots](../wiki.html#definition-robot). `robot_list` lets an internal workspace agent discover the same shared catalog. Names must remain unique across the workspace, robots must not belong to individual users, and legacy `ownerUserId` metadata must not restrict access. Each robot owns a persistent home used as `/config` in a GUI container and as ALA `--home`, together with workspace, runtime, log, and download directories. Deletion must require the robot to have no active or queued work and no running container.

The MCP interface consists of `robot_create`, `robot_list`, `robot_delete`, `openDesktopForRobot`, `startDesktopTaskForRobot`, `stopDesktopTaskForRobot`, `startBrowserTaskForRobot`, `stopBrowserTaskForRobot`, `startSimpleALATaskForRobot`, `stopSimpleALATaskForRobot`, `getTaskStatusForRobot`, `getSessionUrlForRobotDesktop`, `getSessionUrlForRobotBrowser`, `stopDesktopContainerForRobot`, and `stopBrowserContainerForRobot`. Ploinky policy must keep administrator mutations separate from internal workspace-agent operations.

### Retained visible workstation

A user can call `openDesktopForRobot` or use the dashboard to configure coding-agent accounts in the persistent robot home without starting ALA. Desktop and Browser tasks mount the caller-selected absolute workspace-contained `cwd` at `/workspace`, and ALA controls the same graphical state shown through the authenticated [Selkies session](../wiki.html#definition-selkies-session). `getSessionUrlForRobotDesktop` and `getSessionUrlForRobotBrowser` return the Router-relative link only after the matching container is ready.

While a GUI session is ready, the dashboard must display its complete authenticated URL on the robot card so the user can reopen a closed session window. Browser and Desktop start or stop actions remain in the card's primary action row. A separate `Logs` toggle below that row must reveal only the active GUI container's `podman logs` output and refresh the latest 200-line snapshot once per second. It must not substitute or combine ALA task output. Closing the panel must stop polling. New output must remain in view when the reader is at the bottom, while an upward scroll must preserve the reader's position. The dashboard must not render Take Control or Resume buttons; their programmatic task-control operations remain outside this dashboard contract.

RoboTeam must retain at most one GUI container per robot. A completed or stopped graphical task leaves that container running so a user can inspect the result. A later graphical task must reuse it when its mode and resolved cwd match. If the queued task requires another mode or cwd, RoboTeam must remove the idle retained container by its exact managed name and create one replacement before starting ALA. A Simple task must not start a graphical container and must not remove an existing retained container. Container stop tools remain separate from ALA task stop tools.

### Queued observable ALA execution

`startDesktopTaskForRobot`, `startBrowserTaskForRobot`, and `startSimpleALATaskForRobot` must use Ploinky's native asynchronous tool contract with full task-log retention and no fixed 30-second execution timeout. The initial MCP response returns the Ploinky task metadata. The tool process must remain alive while its RoboTeam task waits in the queue and while ALA runs. It must write readable intermediate ALA messages to standard error, reserve standard output for the final result, and exit only after ALA completes, fails, stops, or the native task is cancelled. The Ploinky task status is the caller-facing completion contract; `getTaskStatusForRobot` remains an internal view of RoboTeam queue position and execution state.

Each robot must have one active ALA process and one FIFO [robot task queue](../wiki.html#definition-robot-task-queue) shared by Desktop, Browser, and Simple requests. A new task must enter that queue when another task is queued, starting, running, or stopping. RoboTeam must not reject it merely because the robot is busy. After a task reaches `completed`, `failed`, or `stopped`, RoboTeam must start the next queued task. Tasks for different robots may run concurrently within the configured global active-container limit.

Before a graphical task starts ALA, RoboTeam must prepare the required tool-cache generation, create or reuse the matching container, and wait for Selkies and its MCP bridge. The robot home becomes ALA `--home`; the selected work tree becomes `--cwd`; the private prompt file becomes `--taskFile`; coding-agent, model, skill-set, and MCP values become explicit ALA arguments. RoboTeam must enable ALA's structured event stream and convert `coding-agent-message` events into task progress while keeping final ALA standard output separate.

AchillesCLI's `launch-robot` skill must call the matching start tool with `callToolWithoutWait` so its background-task observer owns continued Ploinky status polling and log persistence. The skill must poll only the matching session-URL tool until the GUI is ready, return the authenticated Selkies link, and leave task completion reporting to the observer. `list-robots` must continue to call `robot_list` through the Ploinky Router.

Take Control and explicit stop operations must terminate only the selected ALA work and preserve a GUI container. Resume must enqueue a new request that tells ALA to inspect the current visible state before it continues. Cancelling one queued task must not interrupt the active task ahead of it.
