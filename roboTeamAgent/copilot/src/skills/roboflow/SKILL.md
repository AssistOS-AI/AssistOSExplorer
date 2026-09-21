---
name: roboflow
description: Manage a RoboFlow task flow: pick a workflow type, create a flow for a user objective, invoke its configured member robots, read their final summaries, and close the flow.
---

# RoboFlow

## Description
RoboFlow coordinates a team of robots for one user objective. A workflow type declares which robots may participate, which skillsets or skills each may use, and whether each runs as a terminal, desktop or browser task. A task flow is one concrete objective. Prefer a matching workflow type when the user's request fits an existing team configuration instead of delegating ad hoc. The default copilot is the manager: it reads each robot's final summary and decides the next invocation, and only it decides when the flow is complete.

## Input Format
Pass one JSON object, or a short command line, through `--input`:

- `{"action":"list-workflows"}`
- `{"action":"create-flow","workflowTypeId":"<id>","objective":"<text>","folder":"<workspace path>"}`
- `{"action":"invoke","flowId":"flow_...","member":"<member id or robot name>","instruction":"<self-contained task>"}`
- `{"action":"get","flowId":"flow_..."}`
- `{"action":"list-flows","folder":"<workspace path>"}`
- `{"action":"finish","flowId":"flow_...","result":"<final outcome>"}`
- `{"action":"stop","flowId":"flow_..."}`

Command lines: `list-workflows`, `create-flow <workflowTypeId> :: <objective>`, `invoke <flowId> <member> <instruction>`, `get <flowId>`, `finish <flowId> [result]`, `stop <flowId>`.

## Output Format
`list-workflows` returns the available workflow types with their member robots and execution types. `create-flow` returns the flow id and a Markdown link to the monitoring page. `invoke` returns the invoked robot and its **final summary only**. `get` returns the flow status with each robot's final summary. The user sees the complete logs of every run on the monitoring page, which is opened from the returned Markdown link.

## Constraints
- Use `list-workflows` before creating a flow; never invent a workflow type or a member.
- A member may be invoked only with the configuration captured in its workflow type. RoboFlow rejects any robot, execution type or skill outside it.
- Each invocation is a separate delegated robot task. Supply a self-contained instruction with the context and expected result; a robot does not inherit your conversation.
- The monitoring page always shows every robot's complete log. Your own context shows only each robot's final summary; if you need more detail to decide, ask the user to inspect the page or invoke another member.
- Invoke one member at a time, read its summary, then choose the next member. A terminal or desktop or browser member runs through the existing RoboTeam queue, so the same robot serializes GUI work.
- Finish the flow with `finish` when the objective is fully met, or `stop` to cancel the flow and its active robot run.

## Example
1. `{"action":"list-workflows"}` shows the workflow type `software-change` with members `implementer/terminal` and `reviewer/desktop`.
2. `{"action":"create-flow","workflowTypeId":"software-change","objective":"Add OAuth login","folder":"/workspace/project"}` returns a flow id and monitor link.
3. `{"action":"invoke","flowId":"flow_...","member":"implementer","instruction":"Implement OAuth login in /workspace/project and report the changed files."}` returns the implementer summary.
4. `{"action":"invoke","flowId":"flow_...","member":"reviewer","instruction":"Review the OAuth login change in /workspace/project and report issues."}` returns the reviewer summary.
5. `{"action":"finish","flowId":"flow_...","result":"OAuth login implemented and reviewed."}` closes the flow.
