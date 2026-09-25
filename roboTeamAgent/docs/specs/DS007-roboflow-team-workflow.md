---
title: DS007-roboflow-team-workflow
summary: Global task graphs, generated drafts, SQLite execution records, skillset matching and directed task routing.
---

## Introduction

RoboFlow runs directed graphs of tasks inside RoboTeam. Administrators describe a workflow, generate a draft with the default robot, refine its nodes and connections, and save it globally. The front copilot chooses a saved workflow and supplies the objective and working folder. RoboFlow chooses a matching robot for each task and follows the graph until completion.

## Core Content

### Graph contract and editor

A workflow has an id, name, description, entryTaskId, tasks, edges and layout. Each task has a unique id, name, prompt, skill selections and one executionType: terminal, desktop or browser. The `skillsets` array holds exact selection IDs that are either named skillsets or individual skills. An edge has id, sourceTaskId, targetTaskId and optional sourcePort/targetPort values of left or right. Older edges without port values normalize to right-to-left. All referenced nodes must exist. Cycles and self-loops are allowed in stored/generated graphs; the manual editor does not create a same-node self-loop. Unreachable nodes produce diagnostics. Workflow definitions contain no robot assignments.

The workflow editor keeps the task list in a left sidebar and shows one right-side page at a time. General contains the workflow name and description. Generate contains the generation prompt and action. Graph contains the drawing board. Selecting a task opens its editable details; + opens the add-task form with name, prompt, terminal/desktop/browser execution type and skill selection. Save task adds that task to the draft. Sidebar navigation preserves form values. A missing workflow name is reported on Save and opens General so it can be corrected.

Creating a flow type is a two-step flow. The generation step is the dedicated page /flow-types/generate-new: it shows only the caller's description, the Generate, Skip and Cancel actions on one line, and a log box below that streams the running task's log tail. Skip skips generation and opens the manual editor. The page starts generation with POST /api/roboflow/generations, which returns a generation id immediately, then polls GET /api/roboflow/generations/<id> every two seconds for the status and the current task log tail, and cancels with DELETE on the same path. RoboTeam starts the default robot in terminal mode with a caller-supplied system prompt containing the graph contract and current discovered skillset catalog, validates the final JSON and opens the editor page at /flow-types/new with the generated draft. The MCP tool roboflow_generate_workflow keeps its blocking behavior for other callers by running the same generation and waiting for the result. Without a supplied folder, generation uses the managed workspace scratch directory .achilles-cli/roboflow-generation. Cancel stops the generation task; invalid output leaves the description in place. Concurrent edits require confirmation before replacement. The editor at /flow-types/new and /flow-types?id=<workflowId> keeps only General and Graph; generation appears only in the separate first step. Existing flow types at /flow-types?id=<workflowId> load directly into the editor and have no generation step. Nothing saves automatically.

On Graph, nodes can be dragged and have centered ports on their left and right sides. Dragging a port previews an edge; releasing over a port on another node creates an edge directed from the dragged port to the destination port, while releasing elsewhere cancels the preview. A same-node drop does nothing. Clicking an edge selects it; Delete or Backspace removes the selected edge while Graph is open. Double-clicking a node sets it as the entry node, which is visibly highlighted. The editor has no separate entry selector, endpoint selectors, add-connection control, or edge removal list. Save workflow persists the graph and node positions. Optimistic revision checks reject stale saves; this counter does not create historical workflow revisions. The protected default workflow is read-only; its pages can be inspected, while task creation and mutations are disabled.

### Skillsets and coverage

The selector lists selections from repositories discovered at the current Ploinky endpoint, including repositories not registered on any robot. A repository that declares skillsets.md contributes its named skillsets; a repository without one contributes its individual skills. In the editor it is a picker: a trigger bar opens a menu grouped by repository, with repositories as headers and their selections beneath. Choosing a selection adds it as a removable pill in the task form; the pill's × removes it. Already-selected entries are marked in the menu. Remote sources are prepared through the same Ploinky repository client before reading their descriptors; unavailable repositories return diagnostics. Stable identities combine canonical repository source and skillset or skill name. A robot matches when it has every required selection available in its own catalog; extra selections are allowed. An empty requirement matches any robot and mounts no selected skills. A task resolves skillset selections through robot-local skillset IDs and individual skills through repository-qualified names, then mounts both when the task starts.

The server computes coverage for drafts after skillset selection and for saved workflows on reads and robot/catalog mutations. An uncovered task displays: No robot has these matching skillsets, add or edit a robot to ensure the workflow runs correctly. Saved workflows have a yellow warning symbol. Coverage is derived UI data and is never persisted. It blocks neither Save nor Start. A run fails if it actually reaches a task with no matching robot.

### Default workflow and caller instructions

The protected default workflow contains one node and no edges. It always uses the default robot and the builtin copilot skillset. Its node supports terminal, desktop and browser; the caller must choose one executionType when starting this workflow. For every other workflow, mode comes from each node and a run-level executionType is rejected.

The default robot has no hardcoded workflow role based on its name. The caller supplies system instructions for normal conversation, graph generation or branching execution. The default robot automatically mounts the builtin `bash`, `launch-gpt-researcher` and `launch-workflow` skills; `launch-workflow` is an individual skill, not a skillset, and the builtin copilot repository is available only to the default robot. The front copilot receives the workflow catalog and uses the launch-workflow skill. It selects an execution mode only for the default workflow.

A run's working folder is the WebChat workspace directory that started it: the WebChat runtime resolves `workspace-dir` relative to the Ploinky workspace root and passes it as the copilot's working directory. The launch-workflow skill always submits that folder and the server rejects a start without one. Every task in the run executes with that folder as its cwd; there is no fallback to the process directory.

### Dispatch and transitions

Starting a run captures the saved graph and creates a queued task instance at entryTaskId. RoboFlow chooses randomly from matching available robots. Terminal tasks run concurrently without a container-count limit. Desktop and browser share a FIFO GUI slot per robot; an idle matching GUI-capable robot is preferred, otherwise the task waits in an eligible robot's queue. Current GUI backends are Codex and OpenCode. Matching is checked again before runtime preparation.

Each graph visit creates a distinct task instance and runtime task id. A cycle A -> B -> A therefore records two separate instances of A. A run allows 500 visits by default, configurable with ROBOTEAM_WORKFLOW_MAX_VISITS. Per-run serialized transitions and instance terminal guards prevent duplicate runtime events from advancing twice. Stop cancels active work and prevents further dispatch.

### Phase control

Every phase owns its ALA session and can be driven from the flow page independently of graph traversal. A running phase accepts a live prompt, which is appended to its log as a user line and sent to the agent without changing the graph. A stopped, completed or failed phase can be continued with a prompt: RoboFlow resumes that phase's exact saved ALA session, and on completion the run continues from the same node, so continuing phase B of A -> B -> C still proceeds to C. Stopping a phase stops the whole run.

A run has exactly one derived status. It is running when any phase is queued, starting or running; otherwise failed when any phase failed; otherwise stopped when any phase was stopped or interrupted; otherwise completed. Running wins over every other phase state, so a run with both running and stopped phases is running and there is no partially stopped run.

Phase stop, live prompt and continue are exposed only through the RoboTeam HTTP API and the flow page; they are not RoboTeam MCP tools.

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

There are no schema_migrations or workflow_revisions tables. Snapshots belong to individual runs, so edits or deletion of a workflow cannot change an active or historical run. Startup removes legacy workflow JSON definitions without importing them. A one-time guarded cleanup clears recorded runs the first time a database is opened after the page route change; it does not repeat. Robot configuration and unrelated project files remain separate.

Logs and final responses stay in the run's working folder under .achilles-cli/roboflow/<runId>/<instanceId>.log and .result. The database stores references, not response or log bodies. Workflows and run metadata are global; a folder is only an execution context and output location. Missing output files are reported as unavailable. Paths reject substituted symlinks.

### Restart and monitoring

Startup marks unfinished runs failed and unfinished instances interrupted. It does not replay tasks. Completed records remain readable. RoboTeam is a set of separately navigated pages whose header contains breadcrumbs. The dashboard at `/` lists robots, flow types and a Flows history link. The flows list page at `/flows` lists executions by workflow name and a human-friendly date, and each entry opens the flow page at `/flows?flowId=<runId>`. The flow type editor is a dedicated page at `/flow-types/new` and `/flow-types?id=<workflowId>` instead of a dialog. The flow page shows a single run and splits into a left phase list and a right stage: the phase list shows every graph task, marking tasks that have not started as pending and each visit with its robot, mode, state and duration, while the stage renders the captured graph on demand or the selected phase's log. Running graph nodes pulse; clicking a node opens that task. Opening a phase shows its prompt, execution type, skillsets and, when assigned, the robot that ran it, above a bounded log panel that scrolls as new output arrives and highlights the final response. Task logs use the same token highlighting as the WebChat task view, including paths, inline code and links. Browser and desktop phases with a live session show Logs and a live GUI session tab that embeds the session in a frame instead of opening another page. Tasks that have not started can be opened too; they show the same details with an empty log. The page stops the whole flow or one running phase. It exposes repeated cycle visits separately. The start tool declares this page as the background task's details link, so the conversation task opens it directly.

### HTTP and MCP

The internal MCP tools are roboflow_list_workflows, roboflow_start_flow, roboflow_flow_state and roboflow_stop_flow. Create, update, delete and roboflow_generate_workflow require an authenticated administrator. Generation and start use native asynchronous Ploinky tasks. The retired roboflow_launch_robot and roboflow_finish_flow tools and HTTP routes are removed.

The launch-workflow skill starts a flow and returns as soon as the native task is registered; it never waits for or processes the final result. The roboflow_start_flow tool process remains alive and owns the run until it reaches a terminal state, so stopping the native task stops the flow. Early in its standard error it emits a task control record that declares the flow page as the task's detail link, labelled Open workflow page, with the raw task log as a secondary View workflow logs link. The conversation's background task renders both from that metadata, so the model never receives the flow URL.

HTTP exposes workflow CRUD, skillset discovery, draft validation, generation, run start/state/stop, per-phase stop, live prompt, continue and logs under /api/roboflow. Browser mutations require the existing Router CSRF proof. Generation uses the real MCP browser client, including task polling and cancellation. Credentials remain in the authenticated transport.

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
