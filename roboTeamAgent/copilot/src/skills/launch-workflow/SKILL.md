---
name: launch-workflow
description: Start one RoboFlow task flow for a user objective on the workspace workflow types, and return its final result. Use when the user asks for work that a workflow team should carry out.
---

# Launch Workflow

## Description
You are the workspace copilot. You can only choose which workflow to run and start it. A RoboFlow task flow owns its own execution: a decision robot inside the workflow picks participating robots, launches them and decides when the objective is complete. You do not run tasks yourself, do not delegate to individual robots, and do not control the flow after starting it.

The workflow catalog is supplied in your turn context. Each entry has an id, a name, a description, and its participating robots with their role and execution type. Use it to choose a workflow; never invent an id.

## Input Format
Pass one JSON object, or a short command line, through `--input`:

- `{"action":"list-workflows"}`
- `{"action":"start","workflowTypeId":"<id>","objective":"<self-contained task>","folder":"<workspace path>"}`

Command lines: `list-workflows`, `start <workflowTypeId> :: <objective>`.

## Output Format
`start` returns the task flow's final result and a Markdown link to the monitoring page, which opens in the WebChat side panel. The whole run appears as a background task in the conversation.

## Constraints
- Match the user's request to one workflow from the catalog; prefer the `default` workflow when nothing more specific fits.
- Pass the user's objective as a self-contained task. The workflow team does not see this conversation.
- Do not attempt to choose robots, execution modes, skillsets, or steps; the decision robot inside the workflow does that.
- Start one workflow per user objective. If the user asks for follow-up work after a flow finished, start a new flow.

## Example
1. The catalog lists `default` with members `default/terminal` (decision), `default/browser`, `default/desktop`.
2. `{"action":"start","workflowTypeId":"default","objective":"Summarize the repository README into a new file","folder":"/workspace/project"}` starts the flow.
3. The tool returns the final result and the monitoring link.
