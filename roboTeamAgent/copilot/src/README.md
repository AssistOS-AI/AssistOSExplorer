# AchillesCLI runtime

AchillesCLI provides a workspace copilot through a terminal or Ploinky WebChat. All model-backed work runs through Advanced Language Agent (ALA); the host owns UI state, durable conversations, scoped launcher capabilities and task journals. See the [repository setup guide](../../README.md) and [HTML documentation](../docs/index.html).

## Setup

Install package-local dependencies and make the real ALA Node entry available through `ACHILLES_ALA_COMMAND`, installed `ala` on PATH, or the managed `/workspace/AdvancedLanguageAgent/bin/ala.mjs` entry. Native coding-agent execution requires Linux Bubblewrap and compatible authenticated backend configuration. The managed installer requires Node.js 22.19.0 or newer and installs pinned native CLIs into container-owned prefixes, without modifying user-global packages.

```sh
export ACHILLES_ALA_COMMAND=/absolute/path/to/AdvancedLanguageAgent/bin/ala.mjs
node src/cli.mjs --dir /absolute/path/to/project
```

Run this command from `achilles-cli/`. The dedicated native home defaults to `<privateDataRoot>/ala/home`; `ACHILLES_ALA_HOME` may select an existing administrator-provisioned home. Configure native login there rather than copying credentials from another user or robot.

## Commands

```text
/list skills
/read bash
/exec bash /usr/bin/pwd
/skills
/skill disable launch-web-search
/skill enable launch-web-search
/list repos
/add repo <git-url>
/update repos
/remove repo <name>
/model
/model default
/permissions ask-for-approval
/session
/session new
/session resume <id>
/tasks
/task view <id>
/task continue <id> <prompt>
/task stop <id>
/help
```

`--dir` selects the project, `--skill-root` adds an approved root, and `--permissions ask-for-approval|full-access` overrides the saved mode for that process. Existing rendering/debug flags remain available through `--help`. `/tier`, `--fast`, `--deep` and the legacy authoring/generation/refinement/test commands are not supported.

A prompt argument runs once:

```sh
node src/cli.mjs --dir /absolute/path/to/project "Explain this project's entry points."
```

`/model` uses the selected backend's native model catalog and stores a backend-specific override. Full-access remains inside ALA's sandbox. Codex and OpenCode support forwarded native approval requests; Pi supports full-access only and requires version 0.85.1 or a verified compatible RPC release. The UI does not cache approvals.

## Product skills

The automatic catalog contains exactly `bash`, `launch-gpt-researcher`, `launch-open-interpreter`, `launch-web-search` and `launch-robot`. Each folder owns Anthropic `SKILL.md`, `scripts/action.mjs`, `scripts/run.mjs` and local supporting material. Scripts import their local `scripts/ploinkyInvocation.mjs`, which imports Ploinky's `/Agent/client/AgentMcpClient.mjs`, never hidden host source.

Bash preserves argv/glob semantics without interpreting shell operators. Coding launchers preserve literal prompts and their fixed worker payloads. Open Interpreter retains its guarded transport and non-cacheable result. Web search intentionally returns unavailable without external calls. Robot discovery is `launch-robot/scripts/list.mjs`; compact `/exec launch-robot desktop: <task>` selects the ordinary startup-created robot `default` only when a name is omitted.

## Sessions and tasks

Conversations, settings, input history, task journals and deterministic memory remain workspace-scoped under `.data/achilles-cli`. In Ploinky, the validated workspace root owns this state even for a nested project. Every connection pins its own selection while all authenticated workspace users can inspect saved sessions. Different sessions can run concurrently; the same session's execution lease prevents duplicate turns.

Stable message IDs retain task/progress placement. UI transcripts restore presentation, while native continuation restores conversational context. A legacy transcript is supplied once, excluding presentation-only records. Missing native continuation or changed home/cwd/backend fails without replacing history.

Delegated workers retain their own credentials and native sessions. The parent observes Router-mediated task metadata through immutable turn origin, persists logs without duplicate or stale events, and reattaches ongoing work after restart. Closing the UI does not stop a remote task; use its explicit task control.

## Source ownership

| Path | Responsibility |
| --- | --- |
| `cli.mjs`, `index.mjs` | Trusted startup and surface selection. |
| `lib/alaEngine.mjs` | Owned ALA execution, continuation, native events and transcript outcome. |
| `lib/anthropicSkillCatalog.mjs` | Deterministic parser-backed catalog and enablement snapshot. |
| `lib/ploinkyTaskContext.mjs`, skill-local `scripts/ploinkyInvocation.mjs` | Explicit Ploinky SDK configuration, direct script calls, and one-way task receipts for chat observation. |
| `lib/workspaceStateLock.mjs` | Short interprocess transactions and execution leases. |
| `lib/conversationSessionStore.mjs`, `lib/workspaceTasks.mjs` | Authoritative UI history and delegated task persistence. |
| `repl/`, `ui/`, `permissions/` | Deterministic commands, terminal presentation and native interaction choices. |
| `skills/` | The five portable product skills. |

## Troubleshooting

An unresolved ALA wrapper requires the real `bin/ala.mjs` path in `ACHILLES_ALA_COMMAND`. An incompatible Pi or OpenCode installation requires a supported executable override, not silent full-access fallback. Native login and provider quota errors remain provider prerequisites. A busy session must finish or be cancelled before another turn uses its UUID. Corrupt state and ambiguous lock recovery retain evidence for reconciliation instead of overwriting it.

Run `node tests/run-all.mjs` from the repository root. ALA has its own protocol/sandbox suite; real native-model, WebChat and RoboTeam GUI verification additionally requires authorized services and credentials.
