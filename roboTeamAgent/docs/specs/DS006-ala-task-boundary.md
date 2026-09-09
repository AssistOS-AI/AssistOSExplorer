---
title: DS006-ala-task-boundary
summary: Defines the outer ALA process, persistent home, cwd, MCP injection, cancellation, and resume boundary.
---

## Introduction

ALA is the task executor started by RoboTeam; it is not responsible for creating desktop or browser containers.

## Core Content

The robot command catalog must accept an optional conversation `sessionId` and discover model completions through ALA using that robot's home and selected conversation. A missing session id must use a non-persisted preview, not another saved conversation. Model discovery must not bind a backend or create conversation state. Discovery errors must be returned explicitly. WebChat must refresh the catalog when the selected conversation or backend changes and must not let an earlier request replace a later conversation's catalog.

Graphical launch scripts must publish their ready session as structured `liveSession` metadata with `mode` and a bounded same-router `url` through the existing task receipt channel. The parent must verify the task through the authenticated MCP client before persisting or publishing its presentation. Duplicate or reordered receipts must not reset task lifecycle or create duplicate observers. Task polling and snapshot reads must preserve the metadata. The stdout result supplied to the coding agent must include startup confirmation, task id and the exact live-session Markdown link. WebChat owns the fixed English live-session button labels and validates the URL independently; no optional agent identity may be hardcoded in Ploinky for this feature.

The bundled copilot catalog must contain bash, launch-gpt-researcher, launch-open-interpreter, launch-web-search and launch-robot. Codex, OpenCode and Pi are ALA backends, not standalone Ploinky workers. Provider names in ordinary prompts must not force selection of removed launcher skills. Existing task catalog snapshots remain unchanged for continuation.

Copilot startup must suppress routine tool-cache diagnostics on its conversation output channels. Cache preparation, reuse, and fallback behavior remain unchanged; preparation failures must still propagate as errors rather than being hidden.

Every new task must resolve its requested `skillSets`, `skillset` alias, and qualified `skills` against that robot's administrator-managed catalog before enqueueing. MCP values are comma-separated strings; HTTP accepts strings or arrays. Whole sets and individual `skillset/skill` entries form a deduplicated union. Omission selects the bundled copilot skillset for default and no additional skills for other robots. Unknown or forbidden names and conflicting native skill names must fail before enqueueing. Each selected skill must be self-contained in its own folder; nested descriptors and dependencies outside that folder are unsupported.

The task request must retain a private `skillSelection` containing the original selectors, expanded qualified names, source revisions, catalog ID, and content digest. RoboTeam must copy the selected folders into a task-owned catalog before enqueueing and pass `--skill-catalog <directory>` to ALA. An empty selection still passes an empty exclusive catalog. ALA must replace configured and environment-provided task repositories and overlay the workspace's `.agents/skills` with only the selected read-only mounts, without editing host descriptors. This controls task-skill registration, not arbitrary access to files already authorized through cwd or home.

Resume and custom continuation must reuse the saved catalog and ALA session without rereading the robot's available list or expanding its selection. Removing or re-adding a robot skillset affects new tasks only. Catalog tampering or missing snapshot files must fail explicitly. Task catalogs and private selection records remain until robot deletion, so completed tasks can continue after service recreation. Legacy task records without a snapshot keep their original execution contract; no implicit migration may infer a new selection.

Successful completion must remain structured task status, not a synthetic sentence in the task log or assistant response. The final `outputText` must contain only ALA's result, with no generated completion fallback when that result is empty.

The copilot wrapper must attach delegated tasks to their originating assistant message using the session returned inside the task-insertion result. Child progress and final output belong to the delegated task record, not the parent's intermediate-message history. Once the task record is persisted, failure to attach or publish its chat presentation must emit a diagnostic but must not prevent status polling, task-start notification, or terminal-result persistence. The observer must never relaunch the remote task to recover its presentation.

Every ALA invocation must include `--session-id <uuid> --control-stdin`. A continuation must preserve the original session UUID and add `--resume-session`. RoboTeam must persist the task-to-session mapping and request settings privately under the robot runtime directory so a service restart does not require reconstruction from logs. ALA owns the native session reference, pins the first selected backend, and requires the same home and cwd. Stop must not delete this metadata. Missing state must produce an explicit failure, including for tasks created before persistent sessions were supported.

The internal `sendMessageToRobotTask` tool must accept a validated task handle and a nonempty bounded prompt. It must report `delivered` only after ALA acknowledges native steering, or `queued` for execution-local follow-up. Codex and Pi use their native control protocols; the current OpenCode adapter queues messages until its active invocation finishes. Stop discards pending messages. A message received after task termination must be rejected with an instruction to continue the task instead. Simple continuation must not add screen instructions.

RoboTeam launches ALA from the outer agent runtime after the required GUI, tool-cache generation, and MCP bridge are ready, or after coding-agent preparation for a simple task. It passes `--home` using the robot's persistent home, `--cwd` using the caller-selected workspace directory, `--taskFile` using a private runtime prompt file, and `--ca` using the selected coding agent. `--skill-catalog` selects the saved task catalog, and optional `--model` is forwarded.

A Desktop task must produce an invocation equivalent to `ala --home /data/robots/<robot-id>/home --cwd /workspace/<project> --taskFile /data/robots/<robot-id>/runtime/<task-id>.prompt --ca codex --MCPServers desktop=http://127.0.0.1:<port>/mcp`. A Browser task uses the `browser` MCP name. A Simple task omits `--MCPServers`. Concrete robot ids, cwd values, task ids, coding-agent choices, and loopback ports vary per request.

`--home` selects persistent coding-agent authentication and configuration. `--cwd` selects the writable work tree and disables ALA's temporary workspace. `--taskFile` supplies the prompt without placing its full text in process arguments. `--ca` selects `auto`, `codex`, `opencode`, or `pi`. `--MCPServers` supplies task-local Streamable HTTP MCP endpoints. RoboTeam resolves MCP `skillSets` and `skills` into `--skill-catalog`; they are not passed through as ALA's legacy `--skillSets` name filter. `--model` optionally overrides the selected backend's native model.

For GUI work RoboTeam passes `--MCPServers name=http://127.0.0.1:<random>/mcp`. The random port is the outer loopback mapping of fixed inner port `8100`. ALA translates that value into transient Codex configuration overrides. Saved configuration and authentication under the robot home remain authoritative and are not rewritten. Desktop and Browser tasks must use Codex until the OpenCode and Pi adapters implement equivalent MCP URL injection.

The ALA child is cancellable. Cancelling a graphical native task for human takeover sends termination to ALA while preserving the GUI container and puts that robot into manual-control mode. The explicit MCP stop tools stop ALA without entering manual-control mode. No queued graphical ALA request may start for that robot while a human controls the visible session; independent CLI conversations remain available. Resume must use the opaque continuation handle returned by the cancelled native task, select the exact interrupted request, place its replacement ahead of existing queued work, and clear manual-control mode. The replacement prompt must contain the custom continuation or a short Continue instruction and an explicit instruction to inspect the current visible state with the available MCP tools, discard stale element or focus assumptions, preserve the human's changes, and continue. Only one graphical ALA process may run per robot. Desktop and Browser share one FIFO queue; independent Simple/CLI conversations run concurrently, and cancelling one queued request must not terminate the active request.

The three start tools must be native asynchronous Ploinky tools. Their command processes must remain active while the corresponding RoboTeam request waits and while ALA runs. RoboTeam must set `ALA_EVENT_STREAM=1`, parse `coding-agent-message` records from ALA standard error, and forward their message text to the command's standard error. Ploinky records that channel as live task progress. RoboTeam must collect ALA standard output separately and return it as the command's final `outputText`; ALA process exit determines whether the native task completes or fails. Desktop, Browser, and Simple starts, together with `resumeTaskForRobot`, must declare `resumeTaskForRobot` as their continuation tool. Every start and continuation must publish a validated version-1 handle during execution and return it on completion or cancellation. The handle supports completed, stopped, or failed Desktop, Browser, and Simple tasks. Live prompts use the declared sendMessageToRobotTask tool.

When `--ca` selects a concrete backend, RoboTeam prepares that backend's current cached generation and prepends its binary directory to the ALA child `PATH`. Automatic selection prepares Codex, OpenCode, and Pi and places all three on `PATH`, allowing ALA to apply its priority. Executables are shared across robots. Account and configuration state for every backend remains under the robot-specific `--home`.

ALA owns the coding-agent sandbox even when it runs inside RoboTeam's outer container. It must first probe its normal user-namespace and private-procfs path. The current bounded nested runtime rejects the procfs mount inside that additional user namespace, so ALA may use its capability-assisted private-proc path: Bubblewrap omits the extra user namespace, retains private PID, IPC, and UTS namespaces and the private procfs, constructs the mounts using the outer admitted capability, and drops all capabilities before starting Codex. Codex must disable its redundant native sandbox inside this boundary. Neither this Codex setting nor ALA's private-proc fallback permits execution outside the ALA Bubblewrap filesystem and environment boundary.

## Decisions & Questions

### Question #1: Can a robot run several conversations?

Response: Independent Simple/CLI conversations run concurrently. Desktop and Browser retain one shared graphical queue and container. One conversation uses one ALA session and permits only one active turn. The shared copilot wrapper persists UI messages under the robot's copilot directory and invokes ALA with that robot's home.

### Question #2: Does this change migrate AchillesCLI state?

Response: No. The default robot starts with its own state. Existing robot homes are retained, and old AchillesCLI files are left untouched.

## Conclusion

RoboTeam owns robot and GUI lifecycle; the shared conversational wrapper preserves session and task state, and ALA owns native coding-agent execution.
