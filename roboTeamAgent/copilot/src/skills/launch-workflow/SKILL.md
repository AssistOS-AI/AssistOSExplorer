---
name: launch-workflow
description: Start one RoboFlow task flow for a user objective on the workspace workflow types, and return immediately. Use when the user asks for work that a workflow team should carry out.
---

# Launch Workflow

## Description
You are the workspace copilot. You can only choose which workflow to run and start it. A RoboFlow task flow owns its own execution: RoboFlow matches each task to an available robot and traverses the directed graph. Branching tasks choose an outgoing edge; terminal nodes finish the workflow. You do not run tasks yourself, do not delegate to individual robots, and do not control the flow after starting it.

The workflow catalog is supplied in your turn context. Each entry has an id, a name, a description, and task names, prompts and execution types. The default workflow lists its supported execution modes. Use it to choose a workflow; never invent an id.

## Input Format
Pass one JSON object, or a short command line, through `--input`:

- `{"action":"list-workflows"}`
- `{"action":"start","workflowTypeId":"<id>","objective":"<self-contained task>","folder":"<workspace path>"}`

Command lines: `list-workflows`, `start <workflowTypeId> :: <objective>` for ordinary graphs. Use JSON with executionType for default.

## Output Format
`start` starts the flow and returns immediately; it never waits for the flow to finish. The run keeps running as a background task in the conversation. That task carries the link to the flow page, which opens in the WebChat side panel and shows the graph, the phases and their live logs.

## Constraints
- Match the user's request to one workflow from the catalog; prefer the `default` workflow when nothing more specific fits.
- Pass the user's objective as a self-contained task. The workflow team does not see this conversation.
- Choose executionType terminal, desktop or browser when starting workflow default. For every other workflow, omit executionType: the graph owns execution modes. Never choose robots, skillsets or graph transitions.
- Start one workflow per user objective. If the user asks for follow-up work after a flow finished, start a new flow.

## Example
1. The catalog lists `default` as a single-node graph supporting terminal, browser and desktop.
2. `{"action":"start","workflowTypeId":"default","executionType":"terminal","objective":"Summarize the repository README into a new file","folder":"/workspace/project"}` starts the flow.
3. The tool acknowledges that the flow started and returns; the link to the flow page lives on the background task.
