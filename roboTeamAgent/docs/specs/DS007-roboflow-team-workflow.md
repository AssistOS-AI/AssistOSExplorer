---
title: DS007-roboflow-team-workflow
summary: Defines RoboFlow workflow types, the default workflow, decision-robot task flows, member robot launches and the monitoring view. RoboFlow owns execution; the front copilot only chooses and starts a workflow.
---

## Introduction

RoboTeam already runs one task on one robot and exposes each run through the shared CLI/WebChat wrapper. RoboFlow adds team workflows on top of those existing tasks. A workflow type declares which robots may work on an objective, what each may use, and how each runs, plus exactly one decision member. The front copilot no longer drives a flow: it receives a catalog of workflow types and can only choose one and start it. RoboFlow then owns the whole execution: it starts the decision robot, launches the member robots the decision robot requests, re-invokes the decision robot after each step, and completes or fails the flow. RoboFlow wraps each member launch around an existing `RuntimeManager` task; it never changes task storage or identity.

## Core Content

### Terminology

| Term | Meaning |
| --- | --- |
| Workflow type | A reusable team configuration created by an administrator: participating robots, their skillsets/skills and their terminal, desktop or browser execution type, plus exactly one decision member. |
| Default workflow | The workflow type guaranteed at startup. It contains the default robot as a terminal decision member, plus a browser member and a desktop member, all with the `copilot` skillset. |
| Task flow | One concrete objective created from a workflow type. It captures the workflow configuration at creation and owns decision steps and member runs. |
| Decision robot | The one member selected as `decisionMemberId`. RoboFlow starts it each step; it inspects the flow state, launches members through MCP tools, and decides when the objective is complete. |
| Decision step | One invocation of the decision robot. It records the runtime task id, state, summary and the member runs launched during that step. |
| Member run | One request to a configured member robot with an instruction. It wraps exactly one existing RoboTeam runtime task. |
| Runtime task | The existing `RuntimeManager` task that actually runs ALA. RoboFlow records its id but never changes its storage or semantics. |

### Workflow types

A workflow type has a stable id, a name, an optional description, one to thirty-two members and exactly one `decisionMemberId`. Each member declares a robot name, an execution type (`terminal`, `desktop` or `browser`), an optional role description, and optional skillsets or qualified skills. A member id is unique inside its workflow type.

Workflow types are configuration artifacts stored as versioned JSON records under the RoboTeam data root. Creating, updating or deleting one requires the authenticated administrator role, and member robots must exist. An update replaces the whole definition while preserving the workflow id and creation time. The default workflow is read-only and cannot be edited or deleted. A desktop or browser member declares a visible GUI task; RoboTeam's current GUI automation uses Codex, so such a member requires its robot to have Codex enabled when the task actually runs. The workflow builder requires at least one member and a decision-maker selection. Existing task flows keep the configuration they captured at creation, so deleting or editing a workflow type never changes a running flow.

### Default workflow

Startup ensures the workflow type with id `default` exists, reusing an existing record unchanged. It is read-only: it cannot be edited or deleted. Its definition is:

- `default-terminal`: the default robot, terminal execution, decision member.
- `default-browser`: the default robot, browser execution.
- `default-desktop`: the default robot, desktop execution.

Every member selects the builtin `copilot` skillset (`bash` and `launch-gpt-researcher`). The terminal member is also the decision member, so it can decide and, when needed, launch the default robot again as a browser or desktop member.

### Task flows, decision steps and member runs

A task flow records its workflow type id, the workflow name, the decision member, the workspace folder, the objective, the creator, timestamps, a status, and the captured members. `startFlow` creates the flow, sets it to `running`, and starts the first decision step.

Flow status is `start`, `running`, `completed`, `failed` or `stopped`. `start` is the creation state before the first decision step; RoboFlow moves immediately to `running`.

Each decision step starts one runtime task on the decision member's robot with the member's configured skillsets plus the internal RoboFlow MCP capability injected into the task. The decision capability is not a skill or skillset; RoboFlow passes the agent MCP server descriptor only to decision tasks. The decision robot acts only through the internal MCP tools:

- `roboflow_flow_state` returns the objective, members and every step with each member run's instruction, state, summary and error.
- `roboflow_launch_robot` validates that the requested member belongs to the flow's captured workflow type, starts that member's existing runtime task through the same skillset resolution and `RuntimeManager.startTask` path used elsewhere, records the run against the current step, and returns immediately.
- `roboflow_finish_flow` completes the flow with a final result.
- `roboflow_stop_flow` stops the flow and cancels its active decision or member runs.

A member run records its robot, execution type, instruction, working directory, runtime task id, state, step, timestamps, final summary and full log location. Runtime invocation states are `queued`, `starting`, `running`, `completed`, `failed`, `stopped` and `interrupted`; the first three are not terminal. A retry or a second instruction creates a new run, so history is never rewritten.

### Decision loop

RoboFlow serializes all transitions for one flow. After a decision step's runtime task reaches a terminal state, RoboFlow waits for every member run of that step to become terminal, then starts the next decision step with the updated state. If a decision step launches nothing, RoboFlow re-invokes the decision robot up to a bounded number of idle turns before failing the flow; it also fails the flow at a bounded maximum number of steps. A failed decision task fails the flow. When the decision robot calls `roboflow_finish_flow`, the flow becomes `completed` and RoboFlow stops advancing it.

### Observation and logs

RoboFlow observes runtime tasks through an optional `taskObserver` hook. The hook only forwards progress text and lifecycle transitions; it does not own task storage. RoboFlow appends every progress chunk to the decision step's or member run's full log and records the runtime task's final result as its summary. The decision robot reads bounded summaries through `roboflow_flow_state`; a human audits the full logs on the monitoring page.

### Scheduling and resource rules

RoboFlow adds no separate scheduler or lease broker. A member run uses the existing per-robot behaviour: terminal tasks run concurrently, while desktop and browser tasks share the robot's single GUI container and FIFO queue. The decision robot always runs as a non-GUI (terminal) task so it never occupies the graphical slot.

### Failure, stop and restart

A failed, stopped or interrupted run is terminal and keeps its error. `roboflow_stop_flow` marks the flow `stopped` and cancels its active decision and member runtime tasks. Runtime tasks live only in memory, so when the service restarts every non-terminal flow is marked `failed` and its active steps and runs are marked terminal; there is no migration of in-flight work.

### MCP surface

`roboflow_list_workflows`, `roboflow_start_flow`, `roboflow_flow_state`, `roboflow_launch_robot`, `roboflow_finish_flow` and `roboflow_stop_flow` are internal workspace-agent tools. `roboflow_create_workflow`, `roboflow_update_workflow` and `roboflow_delete_workflow` require the authenticated administrator role, and the default workflow cannot be edited or deleted. `roboflow_start_flow` keeps the native asynchronous Ploinky task contract and is called by the front copilot's only skill, `launch-workflow`. `roboflow_flow_state`, `roboflow_launch_robot` and `roboflow_finish_flow` are called natively by the decision robot through the injected MCP capability.

### Front copilot

The default robot's direct conversation receives only the workflow catalog (workflow id, name, description, participating robots and roles, and the decision member) instead of the robot and skillset catalog. Its bundled catalog exposes the single `launch-workflow` skill; `bash` and `launch-gpt-researcher` are available to workflow members, and the decision robot additionally receives the RoboFlow MCP capability injected into its task. The front copilot cannot run tasks, delegate to individual robots, choose execution modes or skillsets, or control a flow after starting it.

### Monitoring view

The RoboFlow page is served by RoboTeam on its authenticated Router route. It lists task flows and workflow types, opens one flow, shows each decision step and member run with the robot, execution type, state, timestamps and summary, and loads any run's full log on demand. The view is read-only. The front copilot returns a Markdown link to the page; the generic WebChat side panel opens it through its existing embedded-link handling, so Ploinky needs no agent-specific change.

## Decisions & Questions

### Question #1: Is RoboFlow a scheduler?

Response: No. This version omits schedules, priority ageing, leases, dependencies and rework graphs. It provides a workflow type registry, task flows with a decision loop, validated member launches through the existing runtime, observation, and a read-only monitoring page.

### Question #2: Does RoboFlow own robot tasks?

Response: No. A member run references an existing `RuntimeManager` task and adds configuration validation and an observation record. Task storage, task identity and ALA execution remain owned by the existing runtime.

### Question #3: Is RoboFlow a separate server?

Response: No. It stays a decoupled module inside the RoboTeam service, exposed through the existing authenticated HTTP routes and internal MCP tools. Splitting it into its own process is deferred.

### Question #4: Why does the front copilot not drive the flow?

Response: The design centralizes execution in RoboFlow. The front copilot only selects and starts a workflow; RoboFlow starts the decision robot, which owns every next step. This removes the previous manager-copilot loop and the ad-hoc delegation catalog from the front copilot.

## Conclusion

RoboFlow is the execution owner for team workflows. Administrators define workflow types with a decision member; the default workflow covers the default robot in every execution mode; the front copilot only chooses and starts a workflow; the decision robot launches member robots and decides when the objective is complete; and the full logs stay visible on the RoboFlow monitoring page.
