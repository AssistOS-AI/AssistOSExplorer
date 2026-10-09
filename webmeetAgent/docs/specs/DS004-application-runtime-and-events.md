---
title: DS004-application-runtime-and-events
summary: Defines the WebMeet MCP tools, browser shells, event encoding, chat persistence, resources, Ploinky room-agent metadata, and avatar rendering boundaries.
---

# DS004-application-runtime-and-events

### DS004 - Application Runtime And Events

## Introduction

`webmeetAgent` is a Ploinky application agent with a single MCP process. This specification defines its local runtime surfaces and the authoritative application flows that run through WebMeet rather than through LiveKit.

## Core Content

`scripts/startAgent.sh` starts:

| Process | Default port | Role |
| --- | --- | --- |
| `AgentServer` with `tools/webmeet_tool.mjs` | `7001` | MCP tool server used by Explorer, authenticated plugin calls, and public-protected room links. |

The manifest does not declare a WebMeet product HTTP API. Browser-facing WebMeet traffic enters through Explorer and the generic Ploinky MCP route:

| Surface | Owner | Contract |
| --- | --- | --- |
| `/<webmeetAgent>/roomLoader.html?roomId=<roomId>` | Ploinky core router | Direct room entry. Authenticated users keep their normal identity; unauthenticated visitors receive a public-protected room scope and see only the linked room. |
| Generic MCP route | Ploinky core router | Router-minted invocation identity and scopes are forwarded to WebMeet MCP tools. |

Opening WebMeet from the authenticated Explorer toolbar opens the same-origin `/<webmeetAgent>/roomLoader.html` route directly in a new tab, using the selected plugin agent name when it is aliased. Ploinky Router owns the generic startup response for an admitted browser navigation while the selected no-wait runtime is starting, including readiness polling and reloading the original URL when it becomes ready. WebMeet does not route through Explorer's runtime-wait page or mount an agent-startup overlay inside its dashboard. Once the normal dashboard is mounted, initial room-data failures use its ordinary error reporting. Public room links remain direct room-loader URLs with their `roomId` scope; the static room loader continues to bootstrap the authenticated or public-protected room UI under Ploinky's route policy.

Direct container ports are implementation details. Ploinky core owns public-protected endpoint handling and whitelisting for WebMeet `roomLoader.html`, WebMeet plugin assets, shared UI components, and avatar assets. WebMeet must not add router-level guest asset bypasses or generated pages.

Explorer users and public-protected room visitors call MCP tools through the Explorer host and generic Ploinky MCP route. Tool groups include room listing/creation/join/leave, room events, participant avatar updates, room rename/archive/permanent deletion, chat, AI agents, and resources. MCP tool invocations must be authorized by router-minted Router Request JWTs, except for JSON-RPC metadata methods such as initialize, tool listing, resource listing, cancellation notifications, and ping.

The browser intentionally talks to two systems:

| Browser sends | Receiver | Purpose |
| --- | --- | --- |
| Room list, create, rename, archive | `webmeetAgent` MCP | Application control plane and history-preserving durable mutations. |
| Confirmed permanent room deletion | `webmeetAgent` MCP | Administrator-only `webmeet_room_delete`; strictly invalidates LiveKit and removes the complete WebMeet-owned room record set. |
| Authenticated join and leave | `webmeetAgent` MCP | Authorize entry, update durable membership, and mint a LiveKit token. |
| Public-protected metadata and join | `webmeetAgent` MCP | `webmeet_room_public_get` exposes minimal active guest-room metadata and `webmeet_room_join_guest` returns the admitted participant plus LiveKit join material. |
| Public-protected leave, heartbeat, and avatar | `webmeetAgent` MCP | Shared participant tools bind the requested participant identity to the verified guest session owner. |
| Chat writes | `webmeetAgent` | Authoritative persistence in the encrypted meeting payload. |
| Blackboard final changes | `webmeetAgent` MCP | Authoritative final widget/object mutations, filtered room snapshots, undo/redo, and durable event emission. |
| Room-agent enable/disable/list | `webmeetAgent` MCP | Admin command path and participant-visible metadata for Ploinky-managed room agents persisted in the encrypted room payload. |
| Mic, camera, screen share, participant attributes, room hints | LiveKit | Live media and best-effort in-room realtime state. |

WebMeet event transport uses one encoded event string:

```text
room:type:base64url_payload
```

The `room` segment is the meeting id for meeting-scoped events and the workspace id for workspace-scoped events. The `type` segment is one of the central `WEBMEET_EVENT_TYPES` values. The payload is UTF-8 JSON encoded as base64url and must contain the event `id`, `createdAt`, and event-specific fields.

A `blackboard.updated` event may contain a nested `blackboard:<from>:<to>:<base64(JSON)>` message. The outer WebMeet event supplies room event identity, persistence metadata, deduplication, and LiveKit routing; the inner message supplies the complete public-safe Blackboard or widget projection, a transient presentation, or an `object: null` invalidation. Current Blackboard publishers address the inner message to `ALL`. The receiver verifies the connected room and current board, rejects duplicate message ids and lower revisions, and reloads an authenticated viewer projection when the inner message is an invalidation. The exact payload, equal-revision, destination, and viewer-filtering rules are normative in DS010.

`webmeet-events.js` is the sole event contract module for store and browser UI code. It defines `WEBMEET_EVENT_TYPES`, payload validators, event builders/parsers, and persistence flags. Persistent event logs store encoded event strings directly in `.event` files. New callers must not write ad-hoc JSON event objects.

Persistent event types include room creation/rename/archive, participant membership changes, profile avatar updates, persisted chat notifications, Ploinky room-agent metadata, blackboard updates, and resource metadata events. Realtime-only event types include LiveKit data-channel chat delivery, live avatar projection, blackboard visibility, `/robo` command status, and avatar state requests. Realtime-only event types must not be written to durable meeting or workspace event logs.

Meeting mutation callbacks stage event intents via a `stageEvent(scope, type, data)` closure instead of calling `recordMeetingEvent` directly. Staged events are appended to the event log only after the encrypted payload save succeeds, ensuring the event log never references payload state that was not persisted. Meeting creation writes the meeting record before appending its creation event. Event append failures after a successful save are best-effort and do not roll back the mutation.

The authenticated dashboard shell owns room discovery, room management, profile settings, and admin actions. Room settings places the explicit `Delete room` control on the `Lifecycle` tab, opens the shared confirmation modal, and calls `webmeet_room_delete` only after a `true` confirmation. After the MCP result matches the selected room, the dashboard disconnects an active local session when necessary, invalidates its room cache, reloads the room list, and reports success only when the exact room id is absent. The public-protected room entry shell bootstraps exactly one room session from the `roomId` link and asks only unauthenticated visitors for a display name. Both shells share the common `WebMeetRoom` class for selected-room behavior. `WebMeetRoom` is the central orchestration boundary and must keep room identity (`meetingId`, `workspaceId`, `roomName`, `participantId`, `session`) plus lifecycle methods (`join`, `connectLiveKit`, `disconnectLiveKit`, `leave`, `refreshState`, `destroy`) separated from UI rendering. `WebMeetRoom` emits typed room events to the UI, including chat, participant, blackboard update, blackboard visibility, and blackboard command-status events. `WebMeetRoomLiveKit` owns browser LiveKit connection options and low-level room event hook binding. `WebMeetRoomEvents` owns encoded realtime publish/parse and event normalization. `WebMeetRoomState` owns serializable room state and must stay DOM-free. Dashboard controllers keep media capture controls, media track rendering, participant-card rendering, and UI actions.

New selected-room features should be added to `WebMeetRoom` or its explicit adapters first. Shell-specific code should only choose the session source and allowed controls. Authenticated and public-protected guest sessions both use the generic MCP transport, but the selected API adapter determines the callable tool set. Join responses contain the meeting, participant, LiveKit URL and token material, participant identity, topology material, and Meeting Notes settings; they do not contain a generic capabilities object.

Participant avatars are live rendering projections, not durable room profile state. Local authenticated participants may read their saved AxiFace profile avatar from Explorer's protected avatar settings service, and the current browser may apply a browser-scoped WebMeet avatar override. The dashboard must resolve the active local avatar before connecting LiveKit and before participant cards render: browser-local WebMeet override wins, then saved DPU profile avatar, then an explicit initial-letter fallback. Explorer profile responses with `source.kind="fallback"` or `source.kind="error"` are not saved avatars and must not be projected as generated AxiFace room avatars. Remote participant cards must not read another user's DPU My Space or protected avatar settings. Connected clients render the current LiveKit participant attribute/data-channel projection; unresolved workspace users and guests use only their live projection or deterministic local fallback. Participant cards must receive avatar updates through a dedicated avatar state channel, separate from the general media/card state channel. Media-only participant updates such as microphone publish, mute, unmute, audio subscription, and video track changes must not clear the base avatar projection. When automatic voice expression is enabled, those signals may replace only the transient `profileAvatar.runtimeState` overlay.

The persistent avatar configuration stores `expressionMode` as `audio` or `manual`, defaulting to `audio`. Manual emotion selection publishes the existing full avatar projection and switches the configuration to `manual`. In audio mode, one local controller treats the LiveKit microphone publication, Mute and track lifecycle as authoritative. Browser-local Meyda maintains voice continuity over that available track with a conservative energy gate and supplies the expression candidate; it cannot override an unavailable or muted LiveKit microphone. The effective decision reuses `participant.avatar.projected` and adds only `{ emotion, intensity, speaking }` under `profileAvatar.runtimeState`; it is not copied into the LiveKit participant attribute or Explorer profile settings. A later full manual projection removes the runtime overlay. Receivers accept only the runtime AxiFace states `neutral`, `listening`, `speaking`, `happy`, `confused`, `alert`, and `sleepy`.

WebMeet avatar override settings use the Explorer-hosted `explorer/shared/ui/avatar-settings-form` WebSkel component. The dashboard owns browser-local override storage, quick presets, and room projection publishing, while the shared component owns only source-mode rendering and draft normalization. WebMeet exposes the `generated` and `pack` source modes through the shared component and must not maintain separate handwritten avatar setting inputs for `generated`, `src`, and `packSrc`. Guest access to the shared component and avatar assets is provided by Ploinky core whitelisting on the Explorer shared route, not by WebMeet-specific asset routes.

The avatar pack catalog is the Explorer-generated public asset `/explorer/shared/generated/axi-face-packs.json`. Explorer preinstall owns its generation outside the AxiFace source checkout. Individual pack manifests and rendering assets remain under `/explorer/shared/vendor/axi-face/`, and WebMeet preserves those manifest URLs when projecting the catalog.

Routine meeting-detail refreshes may update durable room data such as chat, resources, and agents, but they must not overwrite the live participant list or recalculate avatars from stale snapshot copies. The initial connected-room roster comes from the LiveKit room snapshot and then changes through LiveKit participant, track, active-speaker, attribute, and data-channel hooks. Workspace polling pauses during joins and resumes afterward to detect directory visibility changes. Workspace roster events for the currently connected room stay on the LiveKit-backed roster path; directory revalidation reads only the protected room list and does not fetch cached detail or roster snapshots. Existing participants must republish avatar projections when new participants connect, and avatar publish failures must not block joining. Changing an avatar while no LiveKit local participant transport is available saves and applies the browser-local selection without attempting a realtime data-channel publish. The normal post-connect avatar flow publishes that effective selection after the participant joins; an expected disconnected state must not surface as an unhandled promise rejection.

Meeting chat has an authoritative persistence path and a best-effort realtime path. Authenticated durable chat writes go through `webmeet_chat_send`; owner-bound guest writes go through `webmeet_chat_send_guest`. The browser may then publish a reliable LiveKit data-channel payload of type `chat` so connected clients update quickly. LiveKit does not store WebMeet chat history. The authenticated schema and browser caller send only `roomId`, `message`, and optional `resourceIds`; the dispatcher derives `authorId` and `authorName` from verified invocation identity. The guest schema requires `roomId`, the joined `participantId`, and `message`; its dispatcher verifies the exact router guest scope, active room state, current membership, and stored participant-owner binding inside the serialized append mutation, then derives the author from that stored participant. Neither path accepts caller-supplied author fields.

Attachment publication stages raw bytes through Explorer's existing blob route, then calls `webmeet_attachment_publish` with the returned Ploinky blob reference (`id`, short `agent`, and logical `localPath`), the explicit destination board, and an optional logical placement. The logical staged path must be exactly `.data/<short-agent-name>/blobs/<blob-id>`; repository-qualified agent names and alternate blob roots are rejected. WebMeet authorizes the participant and mutable room before asking Explorer to validate that reference and resolve its logical path through Explorer's configured workspace. Every file is limited to 15 MB. The canonical SCRIPTA room folder is the single resource root: documents remain direct children of `/WebMeet/<room-slug>-<short-room-id>/`, and all uploaded assets are stored below its `assets/` child. Explorer identifies PNG, JPEG, WebP, GIF, and PDF by content signature rather than trusting the browser MIME header; supported images become editable image widgets with intrinsic dimensions. Other file types become resizable, movable file-card widgets that expose their sanitized real filename, extension, derived MIME type, size, and download action. Each asset has the self-contained shape `assets/<assetId>/<sanitized-original-name.ext>` and the asset directory must contain exactly one regular file. No sidecar metadata, paired file, or synchronization mechanism exists; lookup derives the asset projection from that single file. Both commit and lookup require the room id and the canonical room-folder path; Explorer rejects any asset folder outside the direct `/WebMeet/<room-folder>/assets/` shape. There is no legacy media-root fallback. One serialized room mutation appends the matching chat attachment, creates the Blackboard widget on the named workspace, records one Blackboard history command, updates focus, and emits both chat and Blackboard invalidations. The chat metadata snapshots both the board id and human-readable board title. A failed room authorization never commits the staged blob. A committed asset is referenced by stable asset id and workspace URL rather than duplicated into chat or Blackboard state.

When the chat composer is empty, its primary action is browser-local push-to-talk for RoboTeam. During the shared authenticated/guest room connection path, WebMeet checks the browser microphone permission. A pending or unavailable Permissions API state is resolved with a temporary audio-only `getUserMedia` stream whose tracks are stopped immediately; an already granted state opens no stream, and refusal reports a warning without blocking room entry. Holding the microphone then uses `SpeechRecognition` or `webkitSpeechRecognition`, inserts `/robo ` immediately, and projects interim text into the existing composer. The browser-local `webmeet.mediaSettings.speechRecognitionLanguage` preference is read at the start of every capture: `auto` resolves to `navigator.language` with an `en-US` fallback, while a supported explicit BCP-47 value overrides it. Releasing the pointer or keyboard control finalizes recognition and submits through the same `ChatComponent.sendChat()` and `webmeet_event_command` path as a typed command. Typing non-whitespace content restores the normal Send action. Pointer cancellation, empty recognition, permission denial, unsupported language, and unsupported browsers execute no command and surface a local explanatory error. This feature neither toggles the participant's LiveKit microphone nor sends audio to `webmeetAgent`, `webmeetStt`, or a new WebMeet HTTP/MCP endpoint; any speech processing is controlled by the browser implementation.

The room blackboard has the same authoritative control-plane rule. `webmeet_blackboard_workspace_get` reads the ordered workspace and active board, `webmeet_blackboard_get` reads an explicit board, and `webmeet_event_command` is the sole mutation path. Every mutation command carries its source `boardId`; there is no implicit or fixed RoboTeam board. Canonical board actions create, rename, reorder, delete, activate, and atomically transfer selections between boards. The command also accepts deterministic `/event <allowlisted-action> [JSON object]` and natural text from `/event` and `/robo`. Browser and chat actions use the same canonical event-list contract. Commands never carry revision preconditions or provenance. Workspace and board revisions independently order realtime projections, while serialized writes remain last-edit-wins without `version_conflict`.

Every `/event`, `/robo`, or UI event except the shared navigation-only `board-activate` action creates one durable chat audit entry with `kind: "event"`. Every audit persists the relevant board id and a snapshot of its human-readable workspace title; successful board creation uses the new board, rename, reorder, and delete use the explicitly targeted board, and content or transfer commands use their source board. Every audited entry transitions from `pending` to `success` or `error`; realtime delivery upserts by message id. Chat defaults to Normal and exposes one accessible Full switch. With the switch off, Normal shows participant discussion only; turning it on enables Full and preserves the combined chronological order of discussion and event audit entries. Full renders every canonical event line as `/event <action> [payload] · <workspace title>`, without exposing the opaque board id, transport versions, or other opaque identifiers.

Ploinky room-agent metadata, Blackboard state, resource metadata, SCRIPTA collaboration state, and Meeting Secretary session state are persisted or coordinated by `webmeetAgent` through their declared tool groups. The room-agent tools manage the logical Ploinky RoboTeam record; they do not dispatch a LiveKit Agents worker.

### Decisions & Questions

### Question #1: Why use MCP as the browser control plane?

Response: Explorer plugin actions, direct room links, and public-protected guest sessions can all use the same Ploinky MCP route while preserving router-minted identity and scopes. Keeping WebMeet out of Ploinky server route generation avoids duplicated authorization surfaces and keeps domain authorization inside the agent tools.

### Question #2: Why encode events as `room:type:base64url_payload` instead of appending JSON files?

Response: The encoded string is compact, easy to carry over SSE and LiveKit data channels, and enforces one parser/validator for both store and browser code. It prevents gradual divergence between filesystem events and realtime messages.

### Question #3: Why keep avatars out of durable meeting snapshots?

Response: Profile avatars can come from protected Explorer user settings or browser-local overrides. Persisting them in meeting records would leak stale or cross-user presentation state. LiveKit participant attributes and reliable data-channel messages are the connected-room rendering channel, while the durable meeting store keeps membership and event metadata.

### Question #4: Why stage events instead of appending them directly inside mutators?

Response: Most WebMeet events describe a payload mutation. Appending those events before the encrypted payload write succeeds can leave the event stream pointing at state that never became durable. Staging keeps event emission after the save boundary while allowing the mutation code to declare the intended event next to the state change.

### Question #5: Why omit chat author fields from the MCP schema?

Response: `authorId` and `authorName` are authorization-sensitive values. The registered tool schema omits them, and the dispatcher derives the persisted authenticated author from the verified router invocation so a client cannot claim another participant or a reserved room-agent identity.

### Question #6: Why does direct Blackboard file input use the chat attachment publisher?

Response: A direct drop or paste is still a room attachment publication, not a local widget-only mutation. Routing every entry point through one publisher guarantees that Explorer validation, the durable chat message, the destination-board widget, history, focus, and realtime invalidations succeed as one authoritative operation instead of drifting across separate client flows.

### Workspace feed and browser lifetime

Workspace `webmeet_room_events_list` responses contain `{ events, nextCursor, cursorReset }`. The cursor advances to the final selected raw event even when the slice contains only non-identifying invalidations. A missing nonempty cursor returns `{ events: [], nextCursor: '', cursorReset: true }`; the next blank-cursor read establishes the current tail. Room-specific results and internal raw array readers retain their existing contracts. Empty increments do not scan room records.

The response-only `workspace.rooms.invalidated` type has both persistence flags disabled. The browser accepts it only from the authenticated workspace source. Server and browser assets must be delivered together; old open tabs need a reload because their codec does not recognize the new type.

Workspace polling pauses during joins and resumes for authenticated sessions, including connected sessions, to reconcile directory visibility. First successful polls, cursor resets, and invalidations request a fresh protected list without replaying historical lifecycle events or fetching cached room details. A successful current response removes hidden directory/cache entries and leaves the captured joined session if its room is absent or archived. Activity in another hidden room never evicts a visible session. Failed or stale list responses cannot authorize eviction. Pending reconciliation survives transient failures and retries at the normal five-second polling cadence.

Each dashboard serializes joins, reconnects, and cleanup through one lifecycle transition gate. Nested helpers reuse its context. Cleanup pins the participant, API adapter, session generation, and media resource owner before awaiting; an old cleanup cannot retarget server leave or clear replacement state. New joins, including joins that reuse a room or participant ID, get a new generation. Adapter disconnect callbacks release only their captured room and restore handle. Unload synchronously ends the dashboard lifetime, cancels queued joins and timers, and permits only captured-resource cleanup. It cannot reload the directory, render, write resume state, reconnect, or restart polling. Rejected transitions release the gate.

Explicit panel close clears its resume record and ends the dashboard lifetime synchronously. The close hook never waits for server leave or directory reads; local tracks stop immediately and captured cleanup continues best-effort. Normal leave keeps WebMeet open. Remote subscription, retry, and video-readiness timers belong to their media connection: disconnect or unload cancels them, and already-queued callbacks verify the captured room owner before reading or changing media state.

## Conclusion

`webmeetAgent` remains a coherent application runtime while API, MCP, browser shells, events, chat, resources, Ploinky room-agent metadata, blackboard state, and avatars all preserve the correct persistence and route boundaries.
