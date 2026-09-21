---
title: DS007-roboflow-team-workflow
summary: Defines RoboFlow workflow types, task flows, member invocations and the monitoring view that lets a manager copilot coordinate several robots on one objective.
---

## Introduction

RoboTeam already runs one task on one robot and exposes each run through the shared CLI/WebChat wrapper. RoboFlow adds a thin configuration and observation layer on top of those existing tasks: a workflow type declares which robots may form a team, what each may use, and how each runs; a task flow is one objective built from that team; a member invocation wraps exactly one existing robot task. RoboFlow does not change how robot tasks are stored or what they mean.

## Core Content

### Terminology

| Term | Meaning |
| --- | --- |
| Workflow type | A reusable team configuration created by an administrator: participating robots, their skillsets/skills and their terminal, desktop or browser execution type. It declares no states and no fixed order. |
| Task flow | One concrete objective created from a workflow type. It captures the workflow configuration at creation and owns an append-only list of member invocations. |
| Member invocation | One request to a configured member robot with an instruction. It wraps exactly one existing RoboTeam runtime task. |
| Runtime task | The existing `RuntimeManager` task that actually runs ALA. RoboFlow records its id but never changes its storage or semantics. |
| Schedule | Not part of this specification. |

### Workflow types

A workflow type has a stable id, a name, an optional description and one to thirty-two members. Each member declares a robot name, an execution type (`terminal`, `desktop` or `browser`), an optional role description, and optional skillsets or qualified skills. A member id is unique inside its workflow type.

Workflow types are configuration artifacts stored as versioned JSON records under the RoboTeam data root. Creating or deleting one requires the authenticated administrator role. Member robots must exist. A desktop or browser member declares a visible GUI task; RoboTeam's current GUI automation uses Codex, so such a member requires its robot to have Codex enabled when the task actually runs. Existing task flows keep the configuration they captured at creation, so deleting or editing a workflow type never changes a running flow.

### Task flows and member invocations

A task flow records its workflow type id, the workflow name, the workspace folder, the objective, the creator, timestamps, a status of `active`, `done` or `stopped`, and the captured members. A manager copilot creates the flow, then invokes members one at a time.

`roboflow_invoke_member` validates that the requested robot, execution type, skillsets and skills belong to a member of the flow's captured workflow type. It then starts the existing runtime task through the same skillset resolution and `RuntimeManager.startTask` path used by the direct launch tools. Configuration outside the workflow type is rejected; there is no membership discovery at invoke time.

An invocation records its robot, execution type, instruction, working directory, runtime task id, state, timestamps, final summary and full log location. Runtime states are `queued`, `starting`, `running`, `completed`, `failed`, `stopped` and `interrupted`; the first four are not terminal. A retry or a second instruction creates a new invocation, so history is never rewritten.

### Observation and logs

RoboFlow observes runtime tasks through an optional `taskObserver` hook. The hook only forwards progress text and lifecycle transitions; it does not own task storage. RoboFlow appends every progress chunk to the invocation's full log and records the runtime task's final result as the invocation summary.

The manager copilot reads only each invocation's summary. The monitoring view shows the complete logs of every run. A manager therefore decides the next invocation from bounded summaries while a human can audit the full history.

### Scheduling and resource rules

RoboFlow adds no separate scheduler, lease broker or preemption. A member invocation uses the existing per-robot behaviour: terminal tasks run concurrently, while desktop and browser tasks share the robot's single GUI container and FIFO queue. Invoking one member at a time and reading its summary before the next step keeps the manager loop deterministic.

### Failure, stop and restart

A failed, stopped or interrupted invocation is terminal and keeps its error. `roboflow_stop_flow` marks the flow stopped and cancels its active runtime task. Runtime tasks live only in memory, so when the service restarts every non-terminal invocation of an active flow is marked `interrupted` and the manager decides whether to invoke the member again.

### Monitoring view

The RoboFlow page is served by RoboTeam on its authenticated Router route. It lists task flows and workflow types, opens one flow, shows each invocation's robot, execution type, state, timestamps and summary, and loads any invocation's full log on demand. The view is read-only. The manager copilot returns a Markdown link to the page; the generic WebChat side panel opens it through its existing embedded-link handling, so Ploinky needs no agent-specific change.

### MCP surface

`roboflow_list_workflows`, `roboflow_create_flow`, `roboflow_list_flows`, `roboflow_get_flow`, `roboflow_invoke_member`, `roboflow_finish_flow` and `roboflow_stop_flow` are internal workspace-agent tools. `roboflow_create_workflow` and `roboflow_delete_workflow` require the authenticated administrator role. `roboflow_invoke_member` keeps the native asynchronous Ploinky task contract and accepts no member outside the workflow type. The bundled copilot catalog gains the `roboflow` skill, whose scripts call these tools.

## Decisions & Questions

### Question #1: Is RoboFlow a scheduler?

Response: No. This version deliberately omits schedules, priority ageing, leases, dependencies and rework graphs. It provides a workflow type registry, task flows, validated member invocation through the existing runtime, observation, and a read-only monitoring page.

### Question #2: Does RoboFlow own robot tasks?

Response: No. An invocation references an existing `RuntimeManager` task and adds configuration validation and an observation record. Task storage, task identity and ALA execution remain owned by the existing runtime.

## Conclusion

RoboFlow is a configuration and observation layer for team workflows. Administrators define which robots may work on an objective and how; a manager copilot creates a flow, invokes only configured members, reads their bounded summaries and decides when the objective is complete; and the full logs stay visible on the RoboFlow monitoring page.
