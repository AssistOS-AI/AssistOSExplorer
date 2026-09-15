---
title: DS008-meeting-chat-routing
summary: Defines WebMeet chat persistence, verified authorship, file-reference autocomplete, and the boundary between room messages and explicit agent workflows.
---

# DS008-meeting-chat-routing

## Introduction

WebMeet chat is a room conversation surface. It persists participant messages and may deliver realtime notifications, but it does not infer provider routing from text that resembles an agent tag.

## Core Content

`webmeet_chat_send` must persist the user's message before a connected browser publishes the corresponding reliable LiveKit data-channel notification. LiveKit provides prompt delivery to connected participants but does not store WebMeet chat history.

Authenticated chat submissions derive authorship from verified invocation identity. The registered `webmeet_chat_send` schema and browser caller do not send `authorId` or `authorName`, and ordinary callers cannot claim a reserved room-agent identity. Guest chat uses the separate `webmeet_chat_send_guest` contract, which requires the joined participant identity and verifies the exact router-issued room scope, active room state, current participant membership, and stored guest-session owner inside the serialized append mutation before deriving authorship from the participant record. The browser cannot select a guest author by supplying author fields, and a participant removed before the append mutation cannot persist another message.

Text such as `@open-interpreter list primes` is persisted as ordinary meeting text. WebMeet does not parse arbitrary `@word` tokens into provider calls, research jobs, tasks, or room-agent commands. Agent participation uses the explicit Ploinky room-agent lifecycle and `webmeet_event_command`, with their own authorization, visible state, and administration.

The WebMeet composer may offer file and folder references from Explorer through the host's `search_files` tool. This autocomplete contains workspace references only; it does not present an Agents group or provider suggestions. Known `@file:` references may receive distinct presentation after the message is stored, while other tag-like text remains unchanged.

Autocomplete requests `includeKind: true` and reads each result's path and file/folder kind from that single search response. It must not issue a separate metadata request for every suggestion: that burst can queue the browser mutation proof needed to send an ordinary message. Untyped or malformed entries are omitted without additional network calls.

Ploinky-managed room agents may read authorized room context and call WebMeet tools through their documented lifecycle. Their participation does not change the routing meaning of ordinary participant chat.

## Conclusion

WebMeet chat remains predictable when every message has verified authorship, durable persistence precedes realtime delivery, workspace references stay presentation-only, and agent execution requires an explicit workflow rather than tag inference.
