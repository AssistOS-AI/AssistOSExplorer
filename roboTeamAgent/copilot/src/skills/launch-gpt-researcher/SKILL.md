---
name: launch-gpt-researcher
description: Delegate research to GPTResearcher to produce a researched report from the current workspace.
---

# Launch GPTResearcher

Delegate a research task to the `GPTResearcher` Ploinky agent.
Use when GPTResearcher or GPT Researcher is mentioned to produce a researched report.

## Input Format
Accepts plain text describing the main research query.

The input may also be JSON containing:

- `query`: main research query, required. This is the main query used for web
  research.
- `context`: optional instructions or data for the research task.
- `reportType`: GPT Researcher report type, optional. Defaults to
  `research_report`. Valid values:
  - `research_report`: standard researched report. Prefer this unless the user
    asks for a different output shape.
  - `resource_report`: bibliography or resource recommendation report.
  - `outline_report`: structured outline instead of a full report.
  - `custom_report`: use the prompt as custom report-writing instructions.
  - `subtopic_report`: report focused on a subtopic; only use when the task is
    explicitly about a subtopic of a larger topic.
  - `deep`: deeper multi-step research; only use when the user asks for deep or
    exhaustive research because it is slower and more expensive.
- `useLocalDocs`: optional boolean. Defaults to `true`. When set to `false`,
  GPTResearcher does not use local files in research.

The skill always sends the current AchillesCLI working directory to
GPTResearcher. Callers cannot override it.

## Output Format
Returns plain text `Task started.` for asynchronous execution or a completed result for blocking execution; treat both as success.

## Execution

Run `node scripts/run.mjs --input '<query or JSON>'` from this skill directory. JSON also accepts `task` or `taskDescription` as query aliases, `report_type`, and `use_local_docs`. Boolean strings `true`, `1`, `yes`, `on`, `false`, `0`, `no`, and `off` are case-insensitive. An explicit `false` is preserved. The worker owns omitted report-type and local-document defaults.

`scripts/action.mjs` contains parsing, payload construction, and report formatting. The local activation helper preserves dependency order: `proxies/searchAgent` then `AchillesCLI/GPTResearcher`. Details remain in [the local specification](specs/launch-gpt-researcher.md).

Launcher scripts import their local `scripts/ploinkyInvocation.mjs`, which loads Ploinky's `/Agent/client/AgentMcpClient.mjs` and calls workers directly. ALA receives `--ploinky-task <directory>` to expose read-only SDK dependencies and per-turn configuration at `/run/ploinky-task/context.json`. This explicitly grants the native agent AchillesCLI's own MCP identity and any supplied user-delegation grant; router policy remains authoritative. No master key or user-session token is forwarded. Scripts use the configured outer working directory for worker tasks. One-way JSON receipts under `/run/ploinky-task/events` let AchillesCLI attach authenticated task observers to the original chat turn and persist provider results. Receipts never carry MCP requests. There is no AchillesCLI socket or MCP proxy.
