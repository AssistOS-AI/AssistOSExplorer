---
name: launch-robot
description: Start a separate asynchronous CLI, desktop, or browser task on a workspace robot. The task has its own conversation and task ID; WebChat displays its progress and result.
---

# Launch Robot

## Description
Start a RoboTeam CLI, Desktop, or Browser task for one robot in the current conversation's workspace. Use CLI for text/code work and Desktop or Browser when the task needs a visible GUI.

## Input Format
Use `desktop <robot name>: <task>` or `browser <robot name>: <task>`. Omit the name with `desktop: <task>` or `browser: <task>` to select the ordinary workspace robot named `default`. A JSON object with `mode`, `task`, optional `robotName`, and optional `ca`, `model`, or `skillSets` is also accepted. Only an omitted JSON `robotName` selects `default`; explicit blank or non-string names are errors. Explicit unknown names remain errors and never fall back.

Each launch starts a separate delegated task, not another message in your own conversation. Supply a self-contained task description with the relevant context and expected result; the child does not inherit your conversation history. A startup confirmation or GUI link means the task has started, not that its work is complete. Retain the returned task ID to identify it.

## Output Format
Plain text confirming startup with the native Ploinky task id and a Markdown link to the ready live session. Preserve the returned URL exactly. The script also publishes structured task metadata so WebChat can show its live-session button independently. Intermediate ALA messages and the terminal result appear in the task view.

## Constraints
Discover available robot skillsets and skills with `scripts/list.mjs` before selecting them. JSON launch input accepts `skillSets` or its alias `skillset` for the skillset IDs returned by discovery. Choose skillsets by their descriptions, which explain when to use them. A skillset is a combination declared in a repository’s skillsets.md, not the whole repository. Use `skills` for qualified `repository-id/skill` names. Values may be comma-separated strings or arrays. Selected skillsets and individual skills form a union; omission mounts no skills in delegated tasks, including tasks targeting default. The copilot skillset is available but must be explicitly selected for a delegated task. For repositories without declared skillsets, discovery supplies individual SKILL.md names and descriptions under their repository ID; select them with skills. Never invent names or pass filesystem paths as selectors. RoboTeam validates the allowed catalog, saves the selected directory paths in a task manifest. Resume and custom continuation reuse that manifest after removing paths for deleted skills; they do not select replacements.

Modes are `cli`, `desktop`, and `browser`. `cli analyst: review the project` calls `startSimpleALATaskForRobot` and returns the task ID without starting a GUI container. Each CLI task has a separate conversation; subsequent messages continue that conversation. The task uses the current conversation's workspace as `cwd`. Calls use RoboTeam's internal workspace-agent tools through the Ploinky Router. The start call is detached through the native asynchronous task contract; GUI launches wait only for the matching session URL. A robot has one shared GUI container and GUI queue, while independent CLI conversations may run concurrently. Do not delegate a GUI task back to its own robot while its GUI task is running.

## Help
Example JSON: `{"mode":"desktop","robotName":"analyst","task":"Review the report","skillSets":["<skillset-id-from-discovery>"]}`. Use only names returned by robot discovery. MCP receives comma-separated strings after normalization.

Example: `desktop analyst: inspect the application and prepare a usability report`.

## Execution

Run `node scripts/run.mjs --input 'desktop: inspect the application'` or `node scripts/run.mjs --input '{"mode":"browser","task":"compare the two pages"}'` from this skill directory. The default coding agent is `codex`; `ca` also accepts `auto`, `opencode`, and `pi`. The launcher never creates a robot. RoboTeam startup creates the ordinary `default` robot only when absent; launching while it is absent reports the normal unknown-robot error.

For discovery, run `node scripts/list.mjs --input ''`. This helper lists workspace robot names, specializations, and mode/state through `robot_list`. It is part of this folder, not another registered skill.

`scripts/action.mjs` preserves asynchronous task IDs, failure/cancellation checks, and up to ten minutes of polling for the authenticated ready-session link. `scripts/roboTeamClient.mjs` and its local activation helper preserve Ploinky result/error handling.

Launcher scripts load the real Ploinky client from `/workspace/ploinky-runtime/sdk/client/AgentMcpClient.mjs`. RoboTeam prepares the SDK, its JWT dependencies, the unchanged signed Router descriptor and private version-2 `context.json` in a temporary folder. It passes `--folder <directory> as ploinky-runtime` to ALA for one read-only mount. Scripts use RoboTeam's MCP identity and any supplied user-delegation grant; Router policy remains authoritative. No master key or user-session token is forwarded. Worker tasks use the configured outer working directory. Task-start and live-session notifications travel through `tasks.sock` as authenticated JSON messages with IDs. RoboTeam confirms each notification after authenticated observation and deduplicates retries. Scripts retry notification delivery only, never the MCP launch. The socket carries no MCP requests or task logs. Standalone use inside a Ploinky agent still loads `/Agent/client/AgentMcpClient.mjs` directly.
