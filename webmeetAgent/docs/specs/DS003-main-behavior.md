---
title: DS003-main-behavior
summary: Defines WebMeet room access, durable collaboration, and explicit media and room-agent participation as the product's principal behaviors.
---

# DS003-main-behavior

## Introduction

[WebMeet](wiki.html#definition-webmeetagent) gives authenticated workspace users and room-scoped guests a sovereign collaboration room whose access, durable state, live media, shared resources, and explicitly enabled room agents remain under clear ownership boundaries.

## Core Content

### Main Behavior Components

| Name | Explanation |
| --- | --- |
| Room lifecycle and scoped participation | Administrators create and manage rooms, while authenticated users and verified room-scoped guests join only through the access path authorized for that room. |
| Durable room collaboration | Joined participants exchange persisted chat, [Blackboard](wiki.html#definition-blackboard) changes, [SCRIPTA](wiki.html#definition-scripta) documents, attachments, and room events through [WebMeet](wiki.html#definition-webmeetagent)'s authoritative room state. |
| Live media and explicit room agents | Participants connect to the selected [LiveKit](wiki.html#definition-livekit) generation, and administrators explicitly attach or detach Ploinky-managed room agents without representing them as ordinary browser participants. |

### Room Lifecycle and Scoped Participation

An administrator creates a team or guest room through the [WebMeet](wiki.html#definition-webmeetagent) tool interface, and [WebMeet](wiki.html#definition-webmeetagent) returns the durable room identity used by the dashboard and room loader. Authenticated users join through protected [Ploinky](wiki.html#definition-ploinky) [Model Context Protocol](wiki.html#definition-mcp) ([MCP](wiki.html#definition-mcp)) calls. An unauthenticated visitor can enter a guest room only after the router creates a guest session scoped to the exact `webmeet:room:<roomId>` value declared by the public `roomLoader.html` route.

[WebMeet](wiki.html#definition-webmeetagent) binds each participant identity to its verified caller, mints the participant token needed for [LiveKit](wiki.html#definition-livekit), and keeps room management separate from the explicitly owner-bound guest operations. Archive preserves the encrypted room record, removes its durable members, and hides it from non-admin callers; the dashboard presents the retained room as read-only. Confirmed permanent deletion is administrator-only and fails closed when [LiveKit](wiki.html#definition-livekit) invalidation or safe persistent-data staging cannot be completed. The detailed room, encryption, guest, archive, and deletion contracts are defined in [DS002-room-state-and-access](specsLoader.html?spec=DS002-room-state-and-access.md).

### Durable Room Collaboration

A joined participant sends chat, [Blackboard](wiki.html#definition-blackboard) commands, [SCRIPTA](wiki.html#definition-scripta) updates, and attachments through [WebMeet](wiki.html#definition-webmeetagent)'s authorized room interfaces. [WebMeet](wiki.html#definition-webmeetagent) serializes room mutations, saves the encrypted payload before appending related durable events, and returns the updated room projection. Connected browsers may receive best-effort realtime notifications, but those notifications do not replace the authoritative stored state.

The Explorer-hosted dashboard and guest room shell reuse the same selected-room orchestration while selecting authenticated or guest [MCP](wiki.html#definition-mcp) adapters from the session type. The guest adapter is limited to the operations explicitly wired through the public room scope; it does not receive a server-provided generic capabilities object. Explorer remains the storage authority for workspace documents and staged blobs; [WebMeet](wiki.html#definition-webmeetagent) stores room metadata, chat, [Blackboard](wiki.html#definition-blackboard) state, resource references, and event history. The application and event contracts are defined in [DS004-application-runtime-and-events](specsLoader.html?spec=DS004-application-runtime-and-events.md), with specialized [SCRIPTA](wiki.html#definition-scripta) and [Blackboard](wiki.html#definition-blackboard) rules in [DS009-scripta-robo-collaboration](specsLoader.html?spec=DS009-scripta-robo-collaboration.md) and [DS010-blackboard-agentic-diagrams](specsLoader.html?spec=DS010-blackboard-agentic-diagrams.md).

### Live Media and Explicit Room Agents

After [WebMeet](wiki.html#definition-webmeetagent) authorizes a join, the browser connects to the [LiveKit](wiki.html#definition-livekit) generation selected by the private topology contract and observes participant, publication, subscription, mute, speaker, attribute, data-channel, and disconnect events. [LiveKit](wiki.html#definition-livekit) owns active media and presence; [WebMeet](wiki.html#definition-webmeetagent) owns durable room records and must not use Redis or [LiveKit](wiki.html#definition-livekit) as the room directory.

An administrator explicitly attaches, lists, or detaches a Ploinky-managed room agent. Its metadata is stored in the encrypted room payload, and activation waits for the room conditions required by that agent rather than fabricating a normal participant. [LiveKit](wiki.html#definition-livekit) routing and fail-closed reachability are defined in [DS005-livekit-media-runtime](specsLoader.html?spec=DS005-livekit-media-runtime.md); room-agent ownership is defined in [DS006-ploinky-room-agents](specsLoader.html?spec=DS006-ploinky-room-agents.md), and Meeting Secretary behavior is defined in [DS011-meeting-secretary](specsLoader.html?spec=DS011-meeting-secretary.md).

[WebMeet](wiki.html#definition-webmeetagent) fulfills its purpose when every participant enters through a verified room scope, durable collaboration commits through the [WebMeet](wiki.html#definition-webmeetagent) control plane, live media remains owned by [LiveKit](wiki.html#definition-livekit), and room agents participate only through explicit administration and their documented lifecycle.
