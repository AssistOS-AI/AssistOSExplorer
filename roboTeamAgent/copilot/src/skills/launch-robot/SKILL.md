---
name: launch-robot
description: Delegate CLI, desktop, or browser work to a workspace robot; GUI tasks return an authenticated live session link.
---

# Launch Robot

## Description
Start a RoboTeam CLI, Desktop, or Browser task for one robot in the current conversation's workspace. Use CLI for text/code work and Desktop or Browser when the task needs a visible GUI.

## Input Format
Use `desktop <robot name>: <task>` or `browser <robot name>: <task>`. Omit the name with `desktop: <task>` or `browser: <task>` to select the ordinary workspace robot named `default`. A JSON object with `mode`, `task`, optional `robotName`, and optional `ca`, `model`, or `skillSets` is also accepted. Only an omitted JSON `robotName` selects `default`; explicit blank or non-string names are errors. Explicit unknown names remain errors and never fall back.

## Output Format
Plain text containing the native Ploinky task id and a Markdown link to the live Selkies session after the GUI and its MCP bridge are ready. AchillesCLI reports intermediate ALA messages and the terminal result through its background-task view.

## Constraints
Discover available robot skillsets and skills with `scripts/list.mjs` before selecting them. JSON launch input accepts `skillSets` or its alias `skillset` for whole registered repositories and `skills` for qualified `skillset/skill` names. Values may be comma-separated strings or arrays. Whole sets and individual skills form a union; omission mounts no extra robot skills. Never invent names or pass filesystem paths as selectors. RoboTeam validates the allowed catalog, snapshots the selection and keeps it for Resume and custom continuation even if the administrator later removes the skillset.

Modes are `cli`, `desktop`, and `browser`. `cli analyst: review the project` calls `startSimpleALATaskForRobot` and returns the task ID without starting a GUI container. Each CLI task has a separate conversation; subsequent messages continue that conversation. The task uses the current conversation's workspace as `cwd`. Calls use RoboTeam's internal workspace-agent tools through the Ploinky Router. The start call is detached through the native asynchronous task contract; GUI launches wait only for the matching session URL. A robot has one shared GUI container and GUI queue, while independent CLI conversations may run concurrently. Do not delegate a GUI task back to its own robot while its GUI task is running.

## Help
Example JSON: `{"mode":"desktop","robotName":"analyst","task":"Review the report","skillSets":["documents"],"skills":["research/verify-sources"]}`. Use only names returned by robot discovery. MCP receives comma-separated strings after normalization.

Example: `desktop analyst: inspect the application and prepare a usability report`.

## Execution

Run `node scripts/run.mjs --input 'desktop: inspect the application'` or `node scripts/run.mjs --input '{"mode":"browser","task":"compare the two pages"}'` from this skill directory. The default coding agent is `codex`; `ca` also accepts `auto`, `opencode`, and `pi`. The launcher never creates a robot. RoboTeam startup creates the ordinary `default` robot only when absent; launching while it is absent reports the normal unknown-robot error.

For discovery, run `node scripts/list.mjs --input ''`. This helper lists workspace robot names, specializations, and mode/state through `robot_list`. It is part of this folder, not another registered skill.

`scripts/action.mjs` preserves asynchronous task IDs, failure/cancellation checks, and up to ten minutes of polling for the authenticated ready-session link. `scripts/roboTeamClient.mjs` and its local activation helper preserve Ploinky result/error handling.

Launcher scripts import their local `scripts/ploinkyInvocation.mjs`, which loads Ploinky's `/Agent/client/AgentMcpClient.mjs` and calls workers directly. ALA receives `--ploinky-task <directory>` to expose read-only SDK dependencies and per-turn configuration at `/run/ploinky-task/context.json`. This explicitly grants the native agent AchillesCLI's own MCP identity and any supplied user-delegation grant; router policy remains authoritative. No master key or user-session token is forwarded. Scripts use the configured outer working directory for worker tasks. One-way JSON receipts under `/run/ploinky-task/events` let AchillesCLI attach authenticated task observers to the original chat turn and persist provider results. Receipts never carry MCP requests. There is no AchillesCLI socket or MCP proxy.
