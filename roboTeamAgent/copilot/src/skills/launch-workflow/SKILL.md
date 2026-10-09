---
name: launch-workflow
description: Start one RoboFlow task flow for a user objective on a workspace workflow type, and return immediately. Use when the user asks for work that a workflow team should carry out. Get the workflow ids from list-workflows first.
---

# Launch Workflow

## Description
Starts one RoboFlow task flow. A task flow owns its own execution: RoboFlow matches each task to an available robot and traverses the directed graph. Branching tasks choose an outgoing edge; terminal nodes finish the workflow. This skill only starts a flow. It does not run tasks, does not delegate to individual robots, and does not control the flow after it starts.

This skill does not list workflows. Run the list-workflows skill to get the current workflow ids, descriptions, tasks and execution modes, then choose one.

## Input Format
Pass one JSON object, or a short command line, through `--input`:

- `{"action":"start","workflowTypeId":"<id>","objective":"<self-contained task>","folder":"<workspace path>"}`
- `{"action":"start","workflowTypeId":"<id>"}` uses that workflow's saved default objective and the conversation folder.
- `{"action":"start","workflowTypeId":"default","executionType":"terminal","objective":"<self-contained task>"}`

Command line: `start <workflowTypeId> :: <objective>` for workflows that do not need an execution type. Use JSON with `executionType` for a workflow that list-workflows marks as needing one, such as `default`.

## Output Format
`start` starts the flow and returns immediately; it never waits for the flow to finish. The run keeps running as a background task in the conversation. That task carries the link to the flow page, which opens in the WebChat side panel and shows the graph, the phases and their live logs.

## Constraints
- Use only a workflow id returned by list-workflows; never invent an id. Prefer the `default` workflow when nothing more specific fits.
- Pass the user's objective as a self-contained task when the request specifies work or changes the saved workflow's scope. The workflow team does not see this conversation. Omit objective only when the user wants to execute the selected workflow unchanged using its saved default. Generic default and code-development workflows require an explicit objective; do not invent work for them.
- Choose `executionType` terminal, desktop or browser only for a workflow that needs one, such as `default`. For every other workflow, omit it: the graph owns execution modes. Never choose robots, skillsets or graph transitions.
- Start one workflow per user objective. If the user asks for follow-up work after a flow finished, start a new flow.

## Example
1. list-workflows lists `default` as a single-task workflow that needs an execution type of terminal, desktop or browser.
2. `{"action":"start","workflowTypeId":"default","executionType":"terminal","objective":"Summarize the repository README into a new file","folder":"/workspace/project"}` starts the flow.
3. The tool acknowledges that the flow started and returns; the link to the flow page lives on the background task.
