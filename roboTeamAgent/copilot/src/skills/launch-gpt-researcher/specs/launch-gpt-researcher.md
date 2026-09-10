# Launch GPTResearcher Specification

## Core Content

The `launch-gpt-researcher` Anthropic skill delegates a research request to the workspace
`GPTResearcher` agent by calling its `start_research` MCP tool.

The public input is plain research query text or JSON containing `query`,
optional `context`, optional `reportType`, and optional `useLocalDocs`. The
skill maps these to the agent payload as `query`, `context`, `reportType`, and
`useLocalDocs`.

`query` is the main research query used for web research. `context` contains
optional instructions or data for the research task.

The skill always sends the current AchillesCLI working directory as the
GPTResearcher `workingDir`. This is derived from `invocation.workingDir`, mapped
to the canonical worker directory by the parent bridge, and is not a caller-controlled parameter.

Supported `reportType` values are `research_report`, `resource_report`,
`outline_report`, `custom_report`, `subtopic_report`, and `deep`. Omitted
`reportType` defaults to `research_report`.

`useLocalDocs` controls whether GPTResearcher receives the working directory as
local document context. Missing `useLocalDocs` defaults to local documents
enabled, so the GPTResearcher agent runs hybrid research. `useLocalDocs: false`
runs web-only research.

The skill returns plain text only. Successful runs return
`GPTResearcher task completed.` and append the generated `report` when present.
If no report is present, it falls back to `outputText`, `result`, or the compact
JSON payload. Failed runs return the agent error text or an MCP failure message.

The call path uses the runtime bridge backed by parent-process `AgentMcpClient` and invokes
its `callToolWithoutWait` capability. Before invoking research, it checks Marketplace status
and starts optional workers in dependency order: first `proxies/searchAgent`,
then `AchillesCLI/GPTResearcher`. Each worker receives `enable_agent` only when
it is not already running, each activation explicitly requests `global` mode,
and the tool call waits for both runtimes to become
ready. Async task metadata is offered to the process-local
background-task observer, which owns subsequent router-mediated status polling
and log reporting. Detached or otherwise asynchronous calls return the generic
acknowledgement `Task started.` because the task module shows the agent id and description.

`SKILL.md` routes to `node scripts/run.mjs --input <task text or JSON>`. The wrapper loads the real Ploinky SDK from /workspace/ploinky-runtime and calls the Router with the supplied RoboTeam identity. RoboTeam prepares this private folder and ALA mounts it read-only through --folder. Version-2 context.json supplies the outer working directory and SDK configuration. Task notifications use the authenticated tasks.sock Unix socket with acknowledgements and deduplicated retries. The socket carries notifications only, never MCP requests. All skill helpers remain in this folder.
