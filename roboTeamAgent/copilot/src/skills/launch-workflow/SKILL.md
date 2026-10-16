---
name: launch-workflow
description: Start one RoboFlow task flow by workflow name with an optional prompt, and return immediately. Use when the user asks for work that a workflow team should carry out. Get the workflow names from list-workflows first.
---

# Launch Workflow

## Description
Starts one RoboFlow task flow. A task flow owns its own execution: RoboFlow matches each task to an available robot and traverses the directed graph. Branching tasks choose an outgoing edge; terminal nodes finish the workflow. This skill only starts a flow. It does not run tasks, does not delegate to individual robots, and does not control the flow after it starts.

This skill does not list workflows. Run the list-workflows skill to get the current workflow names, descriptions and tasks, then choose one.

## Input Format
Pass the workflow name and an optional prompt through `--input`, either as JSON or as a short line:

- `{"workflow":"<id>","prompt":"<self-contained task>"}`
- `{"workflow":"default","prompt":"<self-contained task>","executionType":"browser"}`
- `<id> :: <self-contained task>`
- `<id>` runs the workflow with its saved default prompt.

`executionType` is optional and is used only with the `default` workflow: `terminal` (the default when omitted), `desktop` or `browser`. Every other workflow rejects it, because its tasks decide their own execution modes. There are no other fields; the flow runs in the conversation folder.

## Output Format
Starts the flow and returns immediately; it never waits for the flow to finish. The run keeps running as a background task in the conversation. That task carries the link to the flow page, which opens in the WebChat side panel and shows the graph, the phases and their live logs.

## Constraints
- Use only a workflow name returned by list-workflows; never invent one. Prefer `default` when nothing more specific fits.
- Pass the user's request as a self-contained prompt when it specifies work or changes the saved workflow's scope. The workflow team does not see this conversation. Omit the prompt only when the user wants to run the selected workflow unchanged using its saved default. `default` and `code-development` require a prompt; do not invent work for them.
- Set `executionType` only for `default`, and only when the task needs a graphical desktop or a browser; otherwise omit it. Never set it for any other workflow. Never choose robots, skillsets or graph transitions.
- Start one workflow per user objective. If the user asks for follow-up work after a flow finished, start a new flow.

## Example
1. list-workflows lists `default` — Standard development.
2. `{"workflow":"default","prompt":"Summarize the repository README into a new file"}` starts the flow.
3. The tool acknowledges that the flow started and returns; the link to the flow page lives on the background task.
