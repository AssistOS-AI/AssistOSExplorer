---
title: DS002-room-state-and-access
summary: Defines WebMeet room records, team and guest room behavior, durable storage, encryption, and roomId-scoped access checks.
---

# DS002-room-state-and-access

### DS002 - Room State And Access

## Introduction

The WebMeet UI says "room". The backend stores a durable room record and derives a LiveKit room name from that record. This specification defines the application data model and the access contract for authenticated team rooms and public guest rooms.

## Core Content

A WebMeet room is two related objects:

| Concept | Meaning | Stored where |
| --- | --- | --- |
| WebMeet room record | Durable application object with a `room_<uuid>` id, title, `roomType`, derived `roomName`, status, expiration, wrapped data-encryption key, and encrypted payload. | `/data/rooms/*.json`, backed by `.data/webmeetAgent/data/rooms/*.json`. |
| LiveKit room | Media room name derived from the WebMeet `roomId`, sanitized and capped for LiveKit. | LiveKit runtime state, coordinated through Redis while active. |

The encrypted WebMeet payload contains members, chat messages, resources, Ploinky room-agent metadata, Blackboard state, and collaboration state. Durable room and workspace events are stored separately as encoded `.event` files. Blackboard state is authoritative and contains widgets, properties, geometry, groups, connections, revision ordering, shared interaction context, and bounded undo/redo history. Runtime-only browser fields such as DOM nodes, widget ordinals, command status, viewport, zoom, scroll, and drag previews are not persisted. Room payloads use AES-256-GCM with per-room data keys wrapped by `PLOINKY_WEBMEET_MASTER_KEY`. That key is an agent-scoped generated secret declared with `generatedSecret: true`. The store does not support automatic legacy key fallback.

WebMeet store operations are asynchronous. Meeting records, workspace records, and event logs are read and written through promise-based filesystem APIs. Record writes keep the temp-file plus rename pattern for atomic replacement. Meeting payload writes, meeting deletion, expired-meeting purge, and LiveKit participant reconciliation are serialized in two layers: an in-process per-meeting promise queue prevents interleaving within one Node process, and a cross-process filesystem lock (`<meetingLocksDir>/<meetingId>.lock`) prevents interleaving across concurrent MCP tool subprocesses. The lock is acquired by atomically creating the lock file with `open(..., "wx")`, writing pid, hostname, timestamp, meeting id, and a random token into the file, retrying with jittered backoff, and cleaning up stale locks only after the lock file itself is older than the configured stale TTL (`WEBMEET_LOCK_TIMEOUT_MS`, `WEBMEET_LOCK_STALE_TTL_MS`) and the recorded same-host owner process is not alive. Release verifies token ownership before removing the lock file. Event-log reads are incremental: a poll with an `afterId` cursor locates the cursor from the sorted file names and reads only the event files after it (see DS004).

`webmeetAgent` supports two room types:

| `roomType` | UI meaning | Access model |
| --- | --- | --- |
| `team` | Normal room. | Authenticated Explorer users enter through protected MCP paths. |
| `guest` | Public link-enabled room. | An admin-created invite URL carries only `/<webmeetAgent>/roomLoader.html?roomId=<roomId>`. The router creates a guest session scoped to `webmeet:room:<roomId>` for unauthenticated visitors. |

Admin users create, rename, archive, permanently delete, expose room links, configure RoboTeam, attach or detach the persisted Ploinky room agent, and view administrative room data. Normal authenticated users can see and join active rooms allowed by policy, including public link rooms reached directly by URL. A room-scoped guest invocation can join the linked guest room, leave, heartbeat, and publish the joined participant's avatar through operations that explicitly carry the verified guest-owner binding.

Archive and permanent deletion are distinct contracts. Archive marks the room as `archived`, removes durable members, hides the room from non-admin callers, and retains its encrypted payload and history. The dashboard treats archived rooms as read-only; the store does not implement one global archived-state mutation guard, so individual mutation services remain responsible for rejecting unsupported archived-room changes. Permanent deletion requires a router-authenticated administrator, an exact `room_<uuid>` identifier, and `confirmed: true`. Under the cross-process room lock, WebMeet first asks LiveKit to delete the derived media room through the private generation-bound route. A structured LiveKit `not_found` response means the runtime state is already invalidated; a generic HTTP 404, route error, identity error, or other control-plane failure aborts deletion and leaves the durable room intact.

After media invalidation succeeds, WebMeet stages same-filesystem moves for the room record, its room event directory, its WebMeet-local resource directory, and every workspace event whose decoded `meetingId` or `roomId` exactly matches the room. It separately stages the stored canonical `/WebMeet/<room>-<room-id-prefix>` directory on the workspace filesystem and removes that directory shell only when it is an ordinary empty directory whose room-id suffix matches the deleting record. A mismatched path, symlink, non-directory, or non-empty directory aborts deletion and preserves Explorer-owned content. A staging failure restores both the workspace directory and durable moves before returning an error; a successful stage is purged before success is returned. Removing the encrypted record removes durable participant membership, chat, Ploinky room-agent metadata, Blackboard history, and SCRIPTA attachment metadata together. Explorer-owned SCRIPTA documents and Explorer media are not recursively deleted through direct filesystem access because Explorer remains their authoritative storage owner.

Guest room creation does not store a separate invite token. The public URL has the form `/<webmeetAgent>/roomLoader.html?roomId=<roomId>`. Possession of the roomId link is necessary but not sufficient: unauthenticated requests must have a router-created guest session scoped exactly to `webmeet:room:<roomId>`, and WebMeet MCP validates that invocation scope before issuing a LiveKit participant JWT.

Guest MCP access is intentionally room-scoped. The public MCP surface exposes minimal active-room metadata through `webmeet_room_public_get`, admission through `webmeet_room_join_guest`, a narrowed post-join projection through `webmeet_room_guest_get`, durable guest chat through `webmeet_chat_send_guest`, and owner-bound leave, heartbeat, and avatar publication through the shared participant tools. The join result contains the admitted meeting and participant, LiveKit join material, `participantIdentity`, and Meeting Notes settings; it does not contain a generic capabilities object. Post-join guest reads and chat require that returned `participantIdentity`, verify it against the router-issued guest-session owner binding, and never accept caller-supplied chat author fields. The post-join roster must omit each authenticated participant's durable `userId` and the `webmeetUserId`, `userId`, `workspaceUserId`, and `ploinkyUserId` attribute aliases. Guest chat must verify that the room remains active and guest-enabled and that the participant membership and owner binding remain valid inside the same serialized room mutation that appends the message. `webmeet_room_get`, `webmeet_chat_list`, `webmeet_chat_send`, room resources, room management, and room-agent controls remain outside the guest MCP contract.

After join, WebMeet keeps two participant views:

- Durable WebMeet membership in the encrypted meeting payload, updated by join, explicit leave, LiveKit reconciliation, and stale cleanup. Browser room UI must not drive the connected participant list through presence timers; the connected roster is LiveKit state.
- Live room presence in LiveKit, surfaced through participant, publication, subscription, mute, active-speaker, data-channel, participant-attribute, and disconnect events.

A participant that completed the WebMeet join step but has not appeared in LiveKit yet must remain in durable membership until LiveKit exposes that identity or normal presence TTL cleanup removes it. A room-detail reconciliation must not drop a pending member only because another viewer refreshes before the media-plane connection finishes.

When a local participant connects to LiveKit, WebMeet must not publish a provisional room avatar and then a second canonical avatar for the same join. Initial join uses the already resolved effective avatar (WebMeet override first, then saved profile avatar, then fallback) and skips the generic reconnect republish path once, so participant cards render only the final resolved avatar unless the user explicitly changes avatar settings or quick actions.

Redis must never be treated as the WebMeet room directory. Redis may contain LiveKit node, room, participant, and routing state, but WebMeet room lists, chat history, resources, and room metadata are owned by the WebMeet store.

### Decisions & Questions

### Question #1: Why store a WebMeet meeting separately from a LiveKit room?

Response: LiveKit rooms are live media sessions. They are not a durable application database and do not carry WebMeet-specific authorization, encrypted chat, resources, or room lists. The WebMeet room record preserves those product contracts independently of media-session lifetime.

### Question #2: Why does guest access require router guest scope?

Response: The roomId is the public link secret. Router guest scope proves that Ploinky accepted that link for this unauthenticated visitor and constrained the session to exactly `webmeet:room:<roomId>`. WebMeet MCP still verifies the room exists, is `roomType: "guest"`, is not archived, and that the invocation scope matches the requested room.

### Question #3: Why is `PLOINKY_WEBMEET_MASTER_KEY` generated by Ploinky?

Response: `PLOINKY_WEBMEET_MASTER_KEY` protects encrypted meeting payloads and therefore must be stable for the workspace. WebMeet declares it with `generatedSecret: true` so Ploinky derives the value deterministically from the agent identity instead of relying on a manually configured or randomly persisted key.

### Question #4: Why use a lock file rather than a lock directory with an owner file?

Response: A single atomically created lock file stores ownership at acquisition time, so another process cannot observe a fresh ownerless lock and remove it as stale. Stale cleanup waits for file age to exceed the TTL and refuses to clean up a same-host owner process that is still alive.

### Question #5: Why close LiveKit before moving the durable record?

Response: The room lock prevents a concurrent room mutation or join from crossing the deletion boundary. Closing LiveKit first invalidates active media state while the durable record still exists for authorization and rollback. WebMeet moves persistent artifacts only after that strict control-plane operation succeeds, so an unavailable or misrouted LiveKit control path cannot silently delete the application record and leave an active room behind.

## Conclusion

WebMeet room state remains coherent while `webmeetAgent` owns durable meeting records, encrypts payload data, validates team and guest access through the correct route shape, and treats LiveKit and Redis as media/runtime services rather than application storage.
