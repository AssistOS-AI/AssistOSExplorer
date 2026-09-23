---
title: DS007-roboflow-team-workflow
summary: Global task graphs, generated drafts, SQLite execution records, skillset matching and directed task routing.
---

## Introduction

RoboFlow runs directed graphs of tasks inside RoboTeam. Administrators describe a workflow, generate a draft with the default robot, refine its nodes and connections, and save it globally. The front copilot chooses a saved workflow and supplies the objective and working folder. RoboFlow chooses a matching robot for each task and follows the graph until completion.

## Core Content

### Graph contract and editor

A workflow has an id, name, description, entryTaskId, tasks, edges and layout. Each task has a unique id, name, description, skillsets and one executionType: terminal, desktop or browser. An edge has only id, sourceTaskId and targetTaskId. All referenced nodes must exist. Cycles and self-loops are allowed. Unreachable nodes produce diagnostics. Workflow definitions contain no robot assignments.

The editor starts with a description and Generate action. Generation calls the real Ploinky MCP tool roboflow_generate_workflow through the Router. RoboTeam starts the default robot in terminal mode with a caller-supplied system prompt containing the graph contract and current discovered skillset catalog. It validates the final JSON before returning a draft. Generation never saves automatically. Without a supplied folder, generation uses the managed workspace scratch directory .achilles-cli/roboflow-generation. Cancel stops the generation task; invalid output preserves the current draft. Concurrent edits require confirmation before replacement.

Manual editing uses the same draft. Adding a task immediately adds a named node. Nodes can be dragged, connections drawn between ports, or added through source and destination selectors. The entry node is explicit. Save persists the graph and node positions. Optimistic revision checks reject stale saves; this counter does not create historical workflow revisions.

### Skillsets and coverage

The selector lists named skillsets from repositories discovered at the current Ploinky endpoint, including sets not registered on any robot. Remote sources are prepared through the same Ploinky repository client before reading their descriptors; unavailable repositories return diagnostics. Stable identities combine canonical repository source and skillset name. A robot matches when it has every required skillset enabled in its own catalog; extra sets are allowed. An empty requirement matches any robot and mounts no selected skills.

The server computes coverage for drafts after skillset selection and for saved workflows on reads and robot/catalog mutations. An uncovered task displays: No robot has these matching skillsets, add or edit a robot to ensure the workflow runs correctly. Saved workflows have a yellow warning symbol. Coverage is derived UI data and is never persisted. It blocks neither Save nor Start. A run fails if it actually reaches a task with no matching robot.

### Default workflow and caller instructions

The protected default workflow contains one node and no edges. It always uses the default robot and the builtin copilot skillset. Its node supports terminal, desktop and browser; the caller must choose one executionType when starting this workflow. For every other workflow, mode comes from each node and a run-level executionType is rejected.

The default robot has no hardcoded workflow role based on its name. The caller supplies system instructions for normal conversation, graph generation or branching execution. The front copilot receives the workflow catalog and the launch-workflow skill. It selects an execution mode only for the default workflow.

### Dispatch and transitions

Starting a run captures the saved graph and creates a queued task instance at entryTaskId. RoboFlow chooses randomly from matching available robots. Terminal tasks run concurrently without a container-count limit. Desktop and browser share a FIFO GUI slot per robot; an idle matching GUI-capable robot is preferred, otherwise the task waits in an eligible robot's queue. Current GUI backends are Codex and OpenCode. Matching is checked again before runtime preparation.

Each graph visit creates a distinct task instance and runtime task id. A cycle A -> B -> A therefore records two separate instances of A. A run allows 500 visits by default, configurable with ROBOTEAM_WORKFLOW_MAX_VISITS. Per-run serialized transitions and instance terminal guards prevent duplicate runtime events from advancing twice. Stop cancels active work and prevents further dispatch.

### Task input and routing output

Every task receives the objective, complete captured graph, currentTaskId and ordered previousFinalResponses. Only previous final responses enter this history. Logs, transcript replay, artifacts and file references do not enter task context. Responses stay intact; exceeding the one MiB context limit fails explicitly.

With no outgoing edge, completion ends the run. With exactly one outgoing edge, RoboFlow follows it automatically. Neither case receives routing system instructions or needs an edge choice.

With multiple outgoing edges, the caller supplies a system prompt identifying the current node and full graph and asking for a final response such as:

```markdown
#message
The review passed.
#nextEdgeId
review-to-publish
```

The parser accepts optional message, case-insensitive nextEdgeId, nextEdge or Edge headings, and JSON with the same keys, including a fenced JSON object. An edge choice is required and must identify an outgoing edge of the current node. Missing, conflicting or invalid choices fail the run. An incoming edge never authorizes reverse traversal. Plain final text is valid for automatic transitions and terminal nodes.

### SQLite and output files

RoboFlow embeds SQLite through Node's node:sqlite module. There is no separate database server. The runtime must support node:sqlite; installation checks it. The database is /data/roboflow/roboflow.sqlite in the RoboTeam data volume, uses WAL, foreign keys and a busy timeout, and restricts file permissions. Transactions capture snapshots and advance visits atomically.

Exactly three application tables store JSON records with indexed identifiers:

| Table | Stored data |
| --- | --- |
| workflow_types | Current saved graph, task definitions, layout, timestamps and optimistic save counter. |
| workflow_runs | Run id, workflow id, immutable graph snapshot, objective, working folder, creator, state, timestamps, current instance and failure details. |
| task_instances | Unique instance id, run id, sequence, graph task id, selected robot, mode, runtime id, state, timestamps, selected edge and output file references. |

There are no schema_migrations or workflow_revisions tables. Snapshots belong to individual runs, so edits or deletion of a workflow cannot change an active or historical run. Startup removes legacy workflow JSON definitions without importing them. Robot configuration and unrelated project files remain separate.

Logs and final responses stay in the run's working folder under .achilles-cli/roboflow/<runId>/<instanceId>.log and .result. The database stores references, not response or log bodies. Workflows and run metadata are global; a folder is only an execution context and output location. Missing output files are reported as unavailable. Paths reject substituted symlinks.

### Restart and monitoring

Startup marks unfinished runs failed and unfinished instances interrupted. It does not replay tasks. Completed records remain readable. The authenticated RoboFlow page shows the captured graph and each visit with its robot, mode, state and final response; full logs load on demand. It exposes repeated cycle visits separately.

### HTTP and MCP

The internal MCP tools are roboflow_list_workflows, roboflow_start_flow, roboflow_flow_state and roboflow_stop_flow. Create, update, delete and roboflow_generate_workflow require an authenticated administrator. Generation and start use native asynchronous Ploinky tasks. The retired roboflow_launch_robot and roboflow_finish_flow tools and HTTP routes are removed.

HTTP exposes workflow CRUD, skillset discovery, draft validation, generation, run start/state/stop and logs under /api/roboflow. Browser mutations require the existing Router CSRF proof. Generation uses the real MCP browser client, including task polling and cancellation. Credentials remain in the authenticated transport.

## Decisions & Questions

### Question #1: Does RoboFlow require an external database service?

Response: No. SQLite is embedded in the RoboTeam process and stored in its data volume.

### Question #2: Are historical workflow versions stored separately?

Response: No. workflow_types stores the current definition. Each workflow_runs record captures the definition used by that execution.

### Question #3: Can a task choose any node?

Response: No. Branching tasks may choose only an explicitly outgoing edge. RoboFlow handles zero or one outgoing edge without asking the robot.

### Question #4: Does incomplete coverage prevent editing or starting?

Response: No. It is a server-calculated UI warning. Reaching an uncovered task fails execution.

### Question #5: How are old workflows handled?

Response: Delete their legacy persisted definitions. Do not migrate them.

## Conclusion

RoboFlow owns graph execution, records every task visit, and preserves the graph used by each run. The editor combines generated drafts with manual refinement; robot selection follows the skillsets required by each node.
