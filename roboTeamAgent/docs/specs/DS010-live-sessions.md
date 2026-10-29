---
title: DS010-live-sessions
summary: Publishes running copilot turns, delegated copilot tasks, robot tasks and workflow phases to Explorer's Live Sessions list with signed ownership, private IPC and owner-only messages.
---

## Introduction

Explorer's Live Sessions tool lists backend sessions that keep running after a browser tab closes. RoboTeam is a Live Session source: it lists the agent runs it executes and lets their owner watch, message and stop them, and an administrator watch and stop them. Explorer owns the source contract (its DS004 "Live Session sources"); this specification owns what RoboTeam publishes, who may act on it, and how runs outside the RoboTeam service process reach the listing.

## Core Content

### Source declaration

`IDE-plugins/live-sessions-source/config.json` declares an application contribution (`pluginCategory` `application`) with `id` `roboteam-live-sessions`, `label` `RoboTeam`, `contributionType` `live-sessions-source`, `location` `["live-sessions:source"]` and `liveSessions` `{version: 1, base: "/base-agent-additional-server/roboTeamAgent/3001/api/live-sessions"}`. The base names the server-assigned agent `roboTeamAgent` exactly (agent names are case-sensitive) and the service port 3001 that the manifest's authenticated `routerAccess` route already covers. The declaration has no component and no other keys.

### Run kinds

| Kind | Producer | Message | Stop | Transcript |
| --- | --- | --- | --- | --- |
| `copilot-turn` | A copilot process (WebChat runtime or terminal CLI) over IPC | Owner only, delivered to the running ALA turn | Interrupts the turn | The turn's View Thinking log |
| `copilot-task` | The same copilot, for a task delegated to another agent | None | Pauses the task through its signed cancel call | None |
| `robot-task` | The RoboTeam service, in process | Owner only, through the task's live message channel | Stops the task | The task's own ALA turn, once it started |
| `workflow-phase` | The RoboTeam service, in process | Owner only, through the phase's live prompt | Pauses the whole workflow, which stays resumable | The phase's execution log |

Tasks that a copilot delegates to RoboTeam itself, including RoboFlow launches, are listed once, as robot tasks or workflow phases, and never again as copilot tasks. Robot task processes (`server/robot-task.mjs`) never publish over IPC.

### Ownership

Owner identity is only ever a principal the service verified itself. For HTTP-started work it is the signed `verified.payload.actor.id` (`user:<id>`) of the request; forwarded identity headers and caller-supplied owner fields are ignored. Flows store the signed `ownerPrincipal` of their creator. A schedule's owner is the signed principal of its last saver, written inside the optimistic save transaction; cron launches use it, and run-now uses the run-now actor without changing the schedule's owner. Sub-flows inherit their parent's owner, and resume keeps the original owner. Robot task records keep their owner bound to the service by an HMAC whose key derives from the per-start internal token, because robot containers can write execution records; a tampered, legacy or pre-restart record has no owner.

| Owner state | Meaning | Visible to |
| --- | --- | --- |
| `verified` | The principal is known | The owner and administrators |
| `system` | No recorded owner: internal MCP callers, legacy flows and schedules, records from before a service restart | Administrators, labelled "system" |
| `unverified` | The copilot could not prove an owner for this run | Administrators, labelled "owner unverified" |

A run another user may not see is reported as absent (404) on every route. Messages require the verified owner. Stop requires the verified owner or an administrator. Administrator status comes only from the signed `canAdmin` decision of the same request.

### Registry

The service keeps an in-memory registry. Run records are kept apart from their output rings (1 MiB or 8192 events each, oldest dropped with a `replay-truncated` marker). At most 256 runs are live; a new run is refused when that cap is reached, and a live run is never evicted. Finished runs stay listed for one hour, at most 256 of them; beyond that the run that ended earliest goes first. Each run admits 8 stream viewers and the service 64 in total; viewers are paced, and one that does not drain is dropped. Streams send a heartbeat at least every 20 seconds and end after 25 minutes so that the client reconnects and is authorized again. Every row and stream frame is validated against the Explorer contract before it is sent; an invalid row is dropped and logged. Nothing is persisted: a service restart ends every listing.

### HTTP routes

All routes sit inside the existing signed-entitlement gate on port 3001 and refuse internal-token callers with 403, even when user headers are forwarded or signed. `GET /api/live-sessions` lists rows visible to the signed viewer. `GET /api/live-sessions/<id>/stream` is the event stream. `POST /api/live-sessions/<id>/messages` takes exactly `{message}` and answers 200 `{delivery: "delivered" | "queued"}`, 409 `{error: "rejected" | "run_ended"}` or 504 `{error: "delivery_unknown"}`; a message is never retried. `POST /api/live-sessions/<id>/stop` takes `{}` and answers `{ok: true}`; the run ends when its own lifecycle reports the end. `GET /api/live-sessions/<id>/transcript` authorizes the run first and then reads only server-bound metadata, never container logs or caller paths, as `text/plain` with `nosniff`. `GET /live-sessions/<id>` is a text-only view page that cannot be framed.

### IPC boundary

Copilot processes run outside the service process, so they publish over a same-container Unix socket at `/dev/shm/roboteam-live/registry.sock`. The container's `/dev/shm` is private to the RoboTeam container. Its invisibility from ALA sandboxes was observed on a deployed candidate with a diagnostic harness and a diagnostic listener at the same path, using a fixture coding-agent binary and an extra test bind; the equivalent check against the production listener is still pending. ALA also binds the directory of a coding-agent binary without a reserved-path guard, which leaves a residual risk described under Limitations. At startup the service creates the directory (0700) and the socket (0600) exclusively; it never adopts, replaces or unlinks a preexisting path, and an IPC failure leaves HTTP and the in-process sources running. After a container restart the socket is recreated on a fresh `/dev/shm`.

The protocol is newline-delimited JSON with 1 MiB lines and 4 MiB of buffered input per connection; a violation closes only that connection. A publisher sends `hello` and receives `welcome {publisherId, resumeToken}`; after a disconnect it sends `resume {publisherId, resumeToken, runs}` as its first message. The service assigns every id and binds each run to the publisher incarnation that opened it. Messages for another incarnation's run are rejected. One connection may hold 64 live runs and 16 per owner handle. At most 64 publisher incarnations exist at once. Ploinky runs at most 20 WebChat runtimes per router across all agents and 24 WebTTY shells that can each run a terminal CLI; the remaining margin covers incarnations kept for their 30-second reconnect window. At the bound, a new `hello` evicts the incarnation that has been disconnected longest: its reconnect window ends at once, its live runs end `lost`, its handles are dropped, a later `resume` is rejected, and the service logs the eviction with that incarnation's random publisher id only. The resume window can therefore be shorter than 30 seconds under publisher pressure. Only when all 64 incarnations are connected is the new `hello` refused with `hello-refused`, and both sides log the refusal.

Owner proof is a WebChat claim. On arrival of a Router-forwarded `__webchat_message__` envelope, before the message is queued, prepared or its attachments materialized, the copilot sends `owner-claim {claimId, token, args}` with the raw Router token and the exact signed arguments rebuilt from the raw envelope: `surface`, `tabId`, `pageInstanceId`, `text`, `attachments`, `references` (empty when absent) and `presentation`. The service verifies the token itself (Bearer token, `POST /mcp`, tool `__webchat_message__`, the hash of the full request tuple, its own audience, expiry and a replay cache that covers the clock skew) and accepts only a direct user. It answers `owner-handle` or `owner-rejected`. A handle proves its principal for runs of that incarnation, up to 24 hours, even after the token expired. Unused handles are capped at 16 per principal and 64 per incarnation, evicting the oldest unused one; `owner-release` drops a handle whose message published no run, and a used handle is dropped with its last live run.

`run-start {localRef, kind, title, cwd, robot, ownerHandle?, transcriptUrl?}` answers `run-id` or `run-refused`; a repeated `localRef` returns the same id. `run-event {runId, seq, text, style}` carries output; a sequence gap is shown as a status line. `run-end {runId, status, code?, reason?}` ends a run exactly once. The service sends `control {requestId, runId, action, message?}` and the publisher answers `control-result {requestId, outcome}`; a control is sent once and never replayed. A disconnected publisher's runs show `reconnecting` and their pending controls become `unknown`; a resume within 30 seconds restores them, and otherwise they end as `lost`. A transcript link is bound only when it is the anchored View Thinking path `/base-agent-additional-server/<agent>/<port>/webchat-logs/<sessionId>/<messageId>`.

### Copilot publisher

`server/robot-cli.mjs` sets `ROBOTEAM_LIVE_PUBLISH=copilot`, and only the copilot's `main()` creates a publisher from it (`copilot/src/lib/liveSessions/publisher.mjs`). The variable is removed from the ALA child environment. The publisher connects lazily, on its first claim or run, so a process that publishes nothing opens no socket. Every publisher call is synchronous and never fails or delays a turn; a missing or refusing service means the run is not listed.

Lifecycle messages (claims, releases, run starts and ends) are queued separately from output and are never dropped. Output is a 256 KiB buffer that drops its oldest events and splits text into frames of at most 32 Ki UTF-16 code units, so no line approaches the service's limit. The buffer also keeps events already written, so that after a reconnect it can send again what the service reports it missed, followed by any end written during the outage. Reconnects use bounded backoff and try `resume` first. When the service no longer knows the incarnation, for example after a RoboTeam restart, the publisher starts a new one and does not announce its old runs again; their claims cannot prove an owner to the new service, so later runs of an old claim are `unverified`. A run that ended before it reached the service is not listed. The publisher logs to the copilot diagnostics file. It mirrors records to standard error only when `ROBOTEAM_COPILOT_DIAGNOSTICS=stderr` opts in, because the Router forwards a WebChat process's standard error into the chat. It never logs a token or message content.

### Copilot turns

`alaEngine.executeTurn` publishes a turn after the conversation lease, preparation and `beginTurn` succeeded, before ALA starts. A same-session overlap is still refused at the lease and publishes nothing; its claim is released. The run carries the turn's claim, a title from the first line of the user's message, the working directory, the robot and `transcriptUrl = webchatTurnLogUrl(base, sessionId, assistantMessageId)`, so a failed or stopped turn still links its recorded output. The run ends on every exit path: `finished` with code 0, `stopped` after an interruption, or `failed` with the error's first line and exit code. The end is sent after the turn's task notification channel has drained, so delegated tasks of the turn start before the turn ends.

| ALA event | Rendered as |
| --- | --- |
| `coding-agent-message` | The chunk as is, `assistant` for assistant output and `output` otherwise, with a newline on `outputComplete` |
| `coding-agent-selected`, `progress`, `diagnostic` | `status` |
| `message-accepted`, `message-rejected` | `user` |
| `coding-agent-request` | `status`: "permission requested — answer in WebChat" |

A Live Sessions message is written to the running ALA child as `{type: "message", id: <requestId>, message}` through the same control writer that robot tasks use. It resolves only from the `message-accepted` or `message-rejected` event carrying that id; without one it is `unknown` after 35 seconds, and it is `run_ended` once the child has exited. A message that arrives before the child holds its turn prompt is refused rather than written or held. Stop aborts the turn's operation controller.

### Delegated copilot tasks

When a copilot turn or command launches a task on another agent, the task manager starts a `copilot-task` run inside that turn, with the turn's owner claim. Because the service drops a used handle with its last live run, starting the task run before the turn's run ends keeps the task verified after the turn finished. The existing task polling supplies its log and terminal status: finished, paused (`stopped`) or failed. Stop reuses `pauseTask`, which calls the signed `cancelTask`. Tasks reattached after a copilot restart are not announced again.

### Limitations

Runs whose robot task records predate a RoboTeam restart, including resumes of such tasks, list as `system`. There is no per-user viewer cap beyond the per-run and global caps. RoboTeam declares `webchat.runtimeScope: "principal"`, so Ploinky signs `runtimeScope: "principal"` into every envelope it forwards to a RoboTeam runtime, and the copilot rebuilds that argument from RoboTeam's own manifest. Claims from a principal-scoped Router therefore verify, while an envelope minted by a Router that serves RoboTeam with shared scope fails closed and its turn lists as `unverified`. A guest's token is not a verified direct user, so guest turns list as `unverified`. A claim whose answer was lost in a disconnect cannot be sent again, because its token is single-use, so that turn lists as `unverified`. A message whose signed arguments would exceed the 1 MiB IPC line limit is not claimed at all, so the shared connection is never closed for it; its turn lists as `unverified`. Turns of a terminal CLI, both the interactive REPL and single-shot prompts, have no WebChat claim and list as `unverified`. Under rapid copilot process churn, a disconnected publisher can lose its runs before its 30-second reconnect window ends, because new publishers evict it. The socket's invisibility from sandboxes was observed with a diagnostic harness and listener, not yet against the production listener. ALA binds the directory of a coding-agent binary without a reserved-path guard, so a robot that falls back to a binary in its writable home could, in principle, project `/dev/shm` into a later sandbox. That residual risk is open until it is investigated in ALA and RoboTeam.
