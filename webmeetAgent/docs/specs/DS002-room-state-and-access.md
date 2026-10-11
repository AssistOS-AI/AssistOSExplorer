---
title: DS002-room-state-and-access
summary: Defines WebMeet room records, team and guest room behavior, durable storage, encryption, and roomId-scoped access checks.
---

# DS002-room-state-and-access

### DS002 - Room State And Access

## Introduction

The [WebMeet](wiki.html#definition-webmeetagent) UI says "room". The backend stores a durable room record and derives a [LiveKit](wiki.html#definition-livekit) room name from that record. This specification defines the application data model and the access contract for authenticated team rooms and public guest rooms.

## Core Content

A [WebMeet](wiki.html#definition-webmeetagent) room is two related objects:

| Concept | Meaning | Stored where |
| --- | --- | --- |
| [WebMeet](wiki.html#definition-webmeetagent) room record | Durable application object with a `room_<uuid>` id, title, `roomType`, derived `roomName`, status, expiration, wrapped data-encryption key, and encrypted payload. | `/data/rooms/*.json`, backed by `.data/webmeetAgent/data/rooms/*.json`. |
| [LiveKit](wiki.html#definition-livekit) room | Media room name derived from the [WebMeet](wiki.html#definition-webmeetagent) `roomId`, sanitized and capped for [LiveKit](wiki.html#definition-livekit). | [LiveKit](wiki.html#definition-livekit) runtime state, coordinated through Redis while active. |

The encrypted [WebMeet](wiki.html#definition-webmeetagent) payload contains members, chat messages, resources, [Ploinky](wiki.html#definition-ploinky) room-agent metadata, [Blackboard](wiki.html#definition-blackboard) state, and collaboration state. Durable room and workspace events are stored separately as encoded `.event` files. [Blackboard](wiki.html#definition-blackboard) state is authoritative and contains widgets, properties, geometry, groups, connections, revision ordering, shared interaction context, and bounded undo/redo history. Runtime-only browser fields such as DOM nodes, widget ordinals, command status, viewport, zoom, scroll, and drag previews are not persisted. Room payloads use AES-256-GCM with per-room data keys wrapped by `PLOINKY_WEBMEET_MASTER_KEY`. That key is an agent-scoped generated secret declared with `generatedSecret: true`. The store does not support automatic legacy key fallback.

[WebMeet](wiki.html#definition-webmeetagent) store operations are asynchronous. Meeting records, workspace records, and event logs are read and written through promise-based filesystem APIs. Record writes keep the temp-file plus rename pattern for atomic replacement. Meeting payload writes, meeting deletion, expired-meeting purge, and [LiveKit](wiki.html#definition-livekit) participant reconciliation are serialized in two layers: an in-process per-meeting promise queue prevents interleaving within one Node process, and a cross-process filesystem lock (`<meetingLocksDir>/<meetingId>.lock`) prevents interleaving across concurrent [MCP](wiki.html#definition-mcp) tool subprocesses. The lock is acquired by atomically creating the lock file with `open(..., "wx")`, writing pid, hostname, timestamp, meeting id, and a random token into the file, retrying with jittered backoff, and cleaning up stale locks only after the lock file itself is older than the configured stale TTL (`WEBMEET_LOCK_TIMEOUT_MS`, `WEBMEET_LOCK_STALE_TTL_MS`) and the recorded same-host owner process is not alive. Release verifies token ownership before removing the lock file. Event-log reads are incremental: a poll with an `afterId` cursor locates the cursor from the sorted file names and reads only the event files after it (see DS004).

[`webmeetAgent`](wiki.html#definition-webmeetagent) supports two room types:

| `roomType` | UI meaning | Access model |
| --- | --- | --- |
| `team` | Normal room. | Authenticated Explorer users enter through protected [MCP](wiki.html#definition-mcp) paths. |
| `guest` | Public link-enabled room. | An admin-created invite URL carries only `/<webmeetAgent>/roomLoader.html?roomId=<roomId>`. The router creates a guest session scoped to `webmeet:room:<roomId>` for unauthenticated visitors. |

Admin users create, rename, archive, permanently delete, expose room links, configure [RoboTeam](wiki.html#definition-roboteam), attach or detach the persisted [Ploinky](wiki.html#definition-ploinky) room agent, and view administrative room data. Admin-only room-agent attach and detach authorize the caller before any presence cleanup or other room write, so a rejected caller leaves the room record unchanged. Normal authenticated users can see and join active rooms allowed by policy, including public link rooms reached directly by URL. A room-scoped guest invocation can join the linked guest room, leave, heartbeat, and publish the joined participant's avatar through operations that explicitly carry the verified guest-owner binding.

Workspace room listing (`webmeet_room_list`) and the workspace room feed (`webmeet_room_events_list` with an id that does not start with `room_`) are directory reads. They are decided only on the router-signed actor copied from the AgentServer-verified grant: a direct `user` actor whose id is a non-empty `user:` principal equal to the invocation subject and the resolved principal, with no delegation. After trimming and lower-casing roles, the actor must not hold `guest` and must hold `admin` or the signed `explorer.access` capability. Usernames, the `local:admin` id alias and unsigned user fields grant nothing. A guest receives the existing sign-in rejection; any other authenticated caller without that entitlement, including delegated calls, receives exactly `rooms: []`. Entitled callers see open rooms that the existing room policy allows, including signed room-scope restrictions; archived rooms are listed only for a verified non-guest `admin`. Results use the room view field allowlist. `canManageRooms` is true only for a verified non-guest `admin`. The workspace feed rejects callers without the entitlement with `Access denied: Explorer access is required.` and accepts only workspace ids matching `^[A-Za-z0-9_-]+$`, such as `rooms`, whose resolved directory stays inside the workspace event root. Opening or joining a room by its known id remains a separate boundary and is not directory authorization.

Archive and permanent deletion are distinct contracts. Archive marks the room as `archived`, removes durable members, hides the room from non-admin callers, and retains its encrypted payload and history. The dashboard treats archived rooms as read-only; the store does not implement one global archived-state mutation guard, so individual mutation services remain responsible for rejecting unsupported archived-room changes. Permanent deletion requires a router-authenticated administrator, an exact `room_<uuid>` identifier, and `confirmed: true`. Under the cross-process room lock, [WebMeet](wiki.html#definition-webmeetagent) first asks [LiveKit](wiki.html#definition-livekit) to delete the derived media room through the private generation-bound route. A structured [LiveKit](wiki.html#definition-livekit) `not_found` response means the runtime state is already invalidated; a generic HTTP 404, route error, identity error, or other control-plane failure aborts deletion and leaves the durable room intact.

After media invalidation succeeds, [WebMeet](wiki.html#definition-webmeetagent) stages same-filesystem moves for the room record, its room event directory, its WebMeet-local resource directory, and every workspace event whose decoded `meetingId` or `roomId` exactly matches the room. It separately stages the stored canonical `/WebMeet/<room>-<room-id-prefix>` directory on the workspace filesystem and removes that directory shell only when it is an ordinary empty directory whose room-id suffix matches the deleting record. A mismatched path, symlink, non-directory, or non-empty directory aborts deletion and preserves Explorer-owned content. A staging failure restores both the workspace directory and durable moves before returning an error; a successful stage is purged before success is returned. Removing the encrypted record removes durable participant membership, chat, [Ploinky](wiki.html#definition-ploinky) room-agent metadata, [Blackboard](wiki.html#definition-blackboard) history, and [SCRIPTA](wiki.html#definition-scripta) attachment metadata together. Explorer-owned [SCRIPTA](wiki.html#definition-scripta) documents and Explorer media are not recursively deleted through direct filesystem access because Explorer remains their authoritative storage owner.

Guest room creation does not store a separate invite token. The public URL has the form `/<webmeetAgent>/roomLoader.html?roomId=<roomId>`. Possession of the roomId link is necessary but not sufficient: unauthenticated requests must have a router-created guest session scoped exactly to `webmeet:room:<roomId>`, and [WebMeet](wiki.html#definition-webmeetagent) [MCP](wiki.html#definition-mcp) validates that invocation scope before issuing a [LiveKit](wiki.html#definition-livekit) participant JWT.

Guest [MCP](wiki.html#definition-mcp) access is intentionally room-scoped. The public [MCP](wiki.html#definition-mcp) surface exposes minimal active-room metadata through `webmeet_room_public_get`, admission through `webmeet_room_join_guest`, a narrowed post-join projection through `webmeet_room_guest_get`, durable guest chat through `webmeet_chat_send_guest`, and owner-bound leave, heartbeat, and avatar publication through the shared participant tools. The join result contains the admitted meeting and participant, [LiveKit](wiki.html#definition-livekit) join material, `participantIdentity`, and Meeting Notes settings; it does not contain a generic capabilities object. Post-join guest reads and chat require that returned `participantIdentity`, verify it against the router-issued guest-session owner binding, and never accept caller-supplied chat author fields. The post-join roster must omit each authenticated participant's durable `userId` and the `webmeetUserId`, `userId`, `workspaceUserId`, and `ploinkyUserId` attribute aliases. Guest chat must verify that the room remains active and guest-enabled and that the participant membership and owner binding remain valid inside the same serialized room mutation that appends the message. `webmeet_room_get`, `webmeet_chat_list`, `webmeet_chat_send`, room resources, room management, and room-agent controls remain outside the guest [MCP](wiki.html#definition-mcp) contract.

After join, [WebMeet](wiki.html#definition-webmeetagent) keeps two participant views:

- Durable [WebMeet](wiki.html#definition-webmeetagent) membership in the encrypted meeting payload, updated by join, explicit leave, [LiveKit](wiki.html#definition-livekit) reconciliation, and stale cleanup. Browser room UI must not drive the connected participant list through presence timers; the connected roster is [LiveKit](wiki.html#definition-livekit) state.
- Live room presence in [LiveKit](wiki.html#definition-livekit), surfaced through participant, publication, subscription, mute, active-speaker, data-channel, participant-attribute, and disconnect events.

A participant that completed the [WebMeet](wiki.html#definition-webmeetagent) join step but has not appeared in [LiveKit](wiki.html#definition-livekit) yet must remain in durable membership until [LiveKit](wiki.html#definition-livekit) exposes that identity or normal presence TTL cleanup removes it. A room-detail reconciliation must not drop a pending member only because another viewer refreshes before the media-plane connection finishes.

When a local participant connects to [LiveKit](wiki.html#definition-livekit), [WebMeet](wiki.html#definition-webmeetagent) must not publish a provisional room avatar and then a second canonical avatar for the same join. Initial join uses the already resolved effective avatar ([WebMeet](wiki.html#definition-webmeetagent) override first, then saved profile avatar, then fallback) and skips the generic reconnect republish path once, so participant cards render only the final resolved avatar unless the user explicitly changes avatar settings or quick actions.

Redis must never be treated as the [WebMeet](wiki.html#definition-webmeetagent) room directory. Redis may contain [LiveKit](wiki.html#definition-livekit) node, room, participant, and routing state, but [WebMeet](wiki.html#definition-webmeetagent) room lists, chat history, resources, and room metadata are owned by the [WebMeet](wiki.html#definition-webmeetagent) store.

### Decisions & Questions

### Question #1: Why store a WebMeet meeting separately from a LiveKit room?

Response: [LiveKit](wiki.html#definition-livekit) rooms are live media sessions. They are not a durable application database and do not carry WebMeet-specific authorization, encrypted chat, resources, or room lists. The [WebMeet](wiki.html#definition-webmeetagent) room record preserves those product contracts independently of media-session lifetime.

### Question #2: Why does guest access require router guest scope?

Response: The roomId is the public link secret. Router guest scope proves that [Ploinky](wiki.html#definition-ploinky) accepted that link for this unauthenticated visitor and constrained the session to exactly `webmeet:room:<roomId>`. [WebMeet](wiki.html#definition-webmeetagent) [MCP](wiki.html#definition-mcp) still verifies the room exists, is `roomType: "guest"`, is not archived, and that the invocation scope matches the requested room.

### Question #3: Why is `PLOINKY_WEBMEET_MASTER_KEY` generated by Ploinky?

Response: `PLOINKY_WEBMEET_MASTER_KEY` protects encrypted meeting payloads and therefore must be stable for the workspace. [WebMeet](wiki.html#definition-webmeetagent) declares it with `generatedSecret: true` so [Ploinky](wiki.html#definition-ploinky) derives the value deterministically from the agent identity instead of relying on a manually configured or randomly persisted key.

### Question #4: Why use a lock file rather than a lock directory with an owner file?

Response: A single atomically created lock file stores ownership at acquisition time, so another process cannot observe a fresh ownerless lock and remove it as stale. Stale cleanup waits for file age to exceed the TTL and refuses to clean up a same-host owner process that is still alive.

### Question #5: Why close LiveKit before moving the durable record?

Response: The room lock prevents a concurrent room mutation or join from crossing the deletion boundary. Closing [LiveKit](wiki.html#definition-livekit) first invalidates active media state while the durable record still exists for authorization and rollback. [WebMeet](wiki.html#definition-webmeetagent) moves persistent artifacts only after that strict control-plane operation succeeds, so an unavailable or misrouted [LiveKit](wiki.html#definition-livekit) control path cannot silently delete the application record and leave an active room behind.

### Current directory visibility

Signed room scopes restrict non-guest administrators before the archived-room allowance is considered. An administrator scoped to A cannot list or read archived B through the shared room guard. Both `webmeet:room:<id>` and `public:webmeet:room:<id>` retain their existing meaning; known-room access remains separate from directory entitlement.

The room list and authenticated workspace feed use the same current-record directory predicate. The feed captures its event slice, then reads current room records once per request. Historical creation snapshots never authorize disclosure after archive or deletion. Visible room events preserve their stored bytes, including creation names and IDs. Every present top-level or nested room identity must agree with the visible record. Excluded or ambiguous room events become response-only `workspace.rooms.invalidated` events containing exactly `id`, `createdAt`, and `workspaceId`; persistent history is unchanged. Profile avatar notifications expose only those envelope fields and `userId`. Invalid encodings, event types, or workspace envelopes reject the response.

This is a fresh read, not a multi-room transaction. An archive committed before the record read hides that room's history; a concurrent archive committed afterward is reconciled on a later feed update. Missing records are hidden. Event append remains best-effort after mutation, and opaque activity IDs and timing remain observable.

[WebMeet](wiki.html#definition-webmeetagent) room state remains coherent while [`webmeetAgent`](wiki.html#definition-webmeetagent) owns durable meeting records, encrypts payload data, validates team and guest access through the correct route shape, and treats [LiveKit](wiki.html#definition-livekit) and Redis as media/runtime services rather than application storage.
