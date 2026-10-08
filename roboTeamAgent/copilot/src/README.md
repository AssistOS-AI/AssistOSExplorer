# AchillesCLI runtime

AchillesCLI provides a workspace copilot through a terminal or Ploinky WebChat. All model-backed work runs through Advanced Language Agent (ALA); the host owns UI state, durable conversations, scoped launcher capabilities and task records. See the [repository setup guide](../../README.md) and [HTML documentation](../docs/index.html).

## Setup

Install RoboTeam's package dependencies with npm. The wrapper resolves the real Node entry from the `advanced-language-agent` dependency, including when Ploinky mounts a dependency cache through symlinks. No ALA checkout in the workspace or global CLI installation is required. RoboTeam selects the installed package entry and passes it internally to the wrapper. Runtime settings are constants, not user environment options. Native execution requires Linux Bubblewrap and configured coding-agent accounts. Coding-agent CLIs are prepared separately in RoboTeam's shared tool cache.

```sh
export ACHILLES_ALA_COMMAND=/absolute/path/to/AdvancedLanguageAgent/bin/ala.mjs
node src/cli.mjs --dir /absolute/path/to/project
```

Run this command from `achilles-cli/`. Under RoboTeam, `ACHILLES_ALA_HOME` is the robot home, mounted writable and shared by every conversation so credentials and coding-agent state stay with the robot. The ALA home holds `.ala/config.json`, which names the robot's coding agent and one model and effort per agent, and the coding agents' own state; conversations are not stored there. A standalone run without `ACHILLES_ALA_HOME` uses the user's home directory; `ACHILLES_ALA_HOME` may select an existing administrator-provisioned home. Configure native login there rather than copying credentials from another user or robot.

## Commands

```text
/list robots
/exec bash /usr/bin/pwd
/model
/model default
/permissions ask-for-approval
/session
/session new
/session resume <id>
/tasks
/task view <id>
/task continue <id> <prompt>
/task pause <id>
/help
```

`--dir` selects the project and `--permissions ask-for-approval|full-access` overrides the saved mode for that process. Existing rendering/debug flags remain available through `--help`. `/tier`, `--fast`, `--deep` and the legacy authoring/generation/refinement/test commands are not supported.

A prompt argument runs once:

```sh
node src/cli.mjs --dir /absolute/path/to/project "Explain this project's entry points."
```

`/model` lists native models and their supported efforts. `/model <id> [effort|default]` stores the conversation's model and effort in `modelOverride` inside `<cwd>/.roboteam/sessions/<sessionId>/config.json`; the folder's `.roboteam/settings.json` holds no coding-agent models. A session override is passed directly through `--model` and `--effort`; `--effort default` clears inherited effort. Without overrides, ALA reads the robot home configuration directly. RoboTeam writes no intermediate ALA config. `/model default` removes the session override and inherits the current robot defaults. Full-access remains inside ALA's sandbox. Codex and OpenCode support forwarded native approval requests; Pi supports full-access only and requires version 0.85.1 or a verified compatible RPC release. The UI does not cache approvals.

## Product skills

The automatic catalog contains exactly `bash` and `launch-gpt-researcher`. Each folder owns Anthropic `SKILL.md`, `scripts/action.mjs`, `scripts/run.mjs` and local supporting material. Scripts import their local `scripts/ploinkyInvocation.mjs`, which imports Ploinky's `/Agent/client/AgentMcpClient.mjs`, never hidden host source. The `copilot` skillset contains `bash` and `launch-gpt-researcher`. The builtin copilot repository is available only to the default robot, which mounts that skillset automatically. Every robot opened in WebChat (`server/robot-cli.mjs`) also receives `list-workflows` and `launch-workflow` as required, read-only skills, mounted like the bundled skills. Neither belongs to the `copilot` skillset, and robot tasks and workflow phases do not receive them.

Bash preserves argv/glob semantics without interpreting shell operators. Coding launchers preserve literal prompts and their fixed worker payloads. `list-workflows` calls `roboflow_list_workflows` and returns each workflow's id, name, description and tasks with their execution types, plus the `executionType` choices for a workflow such as `default` that needs one. `launch-workflow` only starts a RoboFlow task flow and rejects the former `list-workflows` action. The WebChat prompt carries no workflow catalog; the front copilot calls `list-workflows` when it needs the ids. `/exec launch-workflow {"action":"start","workflowTypeId":"default","executionType":"terminal","objective":"<task>"}` starts the startup-created default workflow. The RoboFlow decision tools are an MCP capability injected only into the decision robot's task, not a skill.

## Sessions and tasks

Conversations, settings, input history and delegated task records belong to the opened folder under `.roboteam/`. Opening a folder creates it with a `.gitignore` containing `*`, and each folder has its own session list. ALA is the only writer and reader of conversation text. The engine starts it with `ALA_SESSIONS=<cwd>/.roboteam/.ala`, `--turn-id` and `--control-stdin`, then writes the turn prompt as the first stdin record `{type:'prompt',prompt,displayText}`, where `displayText` is the user's own text. ALA appends the user messages, intermediate coding-agent output, final answers, turn ends and native continuation to `.roboteam/.ala/sessions/<sessionId>.jsonl`. `lib/execution/alaTranscript.mjs` reads that file only through ALA's exported transcript module. `.roboteam/sessions/<sessionId>/config.json` uses the same id and holds RoboTeam metadata: turn identities, attachments, references, slash-command turns, task cards, skill policy, the engine binding, and the user text or error of a turn that failed before ALA recorded it. `loadSession()` merges both files into the message list WebChat receives. Robots own native accounts and ALA homes, not conversation or task records; the shared registry keeps project locations only, so records survive robot deletion. Every connection pins its own selection while all authenticated workspace users can inspect saved sessions. Different sessions can run concurrently; the same session's execution lease prevents duplicate turns.

Stable message IDs retain task placement. While a turn runs, the wrapper publishes transient WebChat progress records that drive a single auto-replacing status line beside the typing dots: connecting to the robot, starting ALA, routing to the selected coding agent, then the ALA activity reasons. None of these are persisted, so the transcript keeps only the final answer and stored message progress is ignored. When ALA recorded intermediate output for a completed WebChat turn, the wrapper stores a `thinkingUrl` on the turn and appends a `[View Thinking](...)` markdown link to the final answer. The link is `/webchat-logs/<sessionId>/<assistantMessageId>`; the agent maps the message to its turn and renders what ALA recorded for it: follow-up messages as `you> ...`, agent messages and tool reasons. The rendered log never enters the session payload. Native continuation is validated against the last `continuation` record of the transcript. UI transcripts restore presentation, while native continuation restores conversational context. UI transcripts are never replayed as native prompt context, including legacy transcripts. ALA alone constructs skill instructions from its mounted catalog. Missing native continuation or changed home/cwd/backend fails without replacing history.

Delegated workers retain their own credentials and native sessions. The parent observes Router-mediated task metadata through immutable turn origin, persists logs without duplicate or stale events, and reattaches ongoing work after restart. Closing the UI does not stop a remote task; use its explicit task control.

## Source ownership

| Path | Responsibility |
| --- | --- |
| `cli.mjs`, `index.mjs` | Trusted startup and surface selection. |
| `lib/execution/alaEngine.mjs` | Owned ALA execution, continuation, native events and transcript outcome. |
| `lib/skills/anthropicSkillCatalog.mjs` | Deterministic parser-backed catalog and enablement snapshot. |
| `lib/ploinky/ploinkyTaskContext.mjs`, skill-local `scripts/ploinkyInvocation.mjs` | Prepared read-only Ploinky runtime, direct SDK calls and acknowledged Unix-socket task notifications for chat observation. |
| `lib/storage/workspaceStateLock.mjs` | Short interprocess transactions and execution leases. |
| `lib/execution/alaTranscript.mjs` | Loads ALA's exported transcript reader and resolves `.roboteam/.ala` for a folder. |
| `lib/storage/conversationSessionStore.mjs`, `lib/tasks/workspaceTasks.mjs` | RoboTeam turn metadata merged with the ALA transcript, and delegated task persistence. |
| `repl/`, `ui/`, `permissions/` | Deterministic commands, terminal presentation and native interaction choices. |
| `skills/` | The three portable product skills. |

## Troubleshooting

An unresolved ALA wrapper requires the real `bin/ala.mjs` path in `ACHILLES_ALA_COMMAND`. An incompatible Pi or OpenCode installation requires a supported executable override, not silent full-access fallback. Native login and provider quota errors remain provider prerequisites. A busy session must finish or be cancelled before another turn uses its UUID. Corrupt state and ambiguous lock recovery retain evidence for reconciliation instead of overwriting it.

Run `node tests/run-all.mjs` from the repository root. ALA has its own protocol/sandbox suite; real native-model, WebChat and RoboTeam GUI verification additionally requires authorized services and credentials.

## Summary references

Every robot, including default and existing robots, always receives the required human-report skill from DocumentationSkills. Ploinky resolves the workspace checkout or prepares its internal repository copy. The required skill is shown as view-only in Manage skills and cannot be disabled through the skill selection API. An unavailable required source prevents execution.

Every user prompt, including a continuation, requires the entire final response between identical <<human-report>> markers on separate lines, following the human-report skill. WebChat has no View Summary button. Each workflow phase exposes a human-report tab that lists complete reports without their markers and refreshes during execution. A conversation's reports are read on demand from the agent messages and final answers that ALA recorded in its transcript. Workflow output uses byte ranges, which the endpoint reads instead of searching all output; historical workflow results are indexed lazily, and historical raw logs without output provenance are excluded. No separate summary text file is written. Continuing a workflow phase appends to its existing result file and retains references to earlier results, while normal result reads return the latest response.

Workflow phase executions receive the internal, required, view-only `report-task-blocked` skill. WebChat and standalone tasks do not receive it. The skill is mounted read-only for each execution, never installed in the robot home or linked permanently into the project. When resources or capabilities prevent following the requested plan, its script accepts `{ "message": "where work stopped and why" }` and terminates ALA with that error. The workflow phase becomes failed directly. Other phases are not stopped, and the workflow retains its existing status priority. The skill is not a selectable skillset member.
