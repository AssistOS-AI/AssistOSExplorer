---
title: DS006-ploinky-room-agents
summary: Defines RoboTeam as a Ploinky-managed WebMeet room agent, not a LiveKit agent worker.
---

# DS006-ploinky-room-agents

### DS006 - Ploinky Room Agents and RoboTeam

## Introduction

[WebMeet](wiki.html#definition-webmeetagent) room agents are Ploinky-managed entities stored in the encrypted [WebMeet](wiki.html#definition-webmeetagent) room payload. They are not external worker processes and are not dispatched through [LiveKit](wiki.html#definition-livekit).

## Core Content

[RoboTeam](wiki.html#definition-roboteam) is the default room agent. New and legacy rooms normalize to active [RoboTeam](wiki.html#definition-roboteam) settings unless an admin explicitly disables it. The default settings are:

- assistant name: `Robo Team`
- assistant mode: `meeting-assistant`
- blackboard enabled
- blackboard visibility: `all-participants`
- auto-update from conversation enabled
- participant requests enabled

[RoboTeam](wiki.html#definition-roboteam) appears as a virtual room participant with `agentType: "robo_team"`, `mode: "blackboard_demo"`, `runtime: "ploinky"`, and participant identity `agent_robo_team`. It does not need a [LiveKit](wiki.html#definition-livekit) participant, media track, or worker dispatch to appear in the [WebMeet](wiki.html#definition-webmeetagent) roster.

Admins can read and update full [RoboTeam](wiki.html#definition-roboteam) settings through [WebMeet](wiki.html#definition-webmeetagent) tools. Normal participants can see the agent participant card and shared blackboard behavior, but cannot read or mutate the full settings object.

Clicking the [RoboTeam](wiki.html#definition-roboteam) participant card toggles the room [Blackboard](wiki.html#definition-blackboard) only in the current participant's browser. Opening or closing this surface is local layout state: it is not published to peers and does not start, stop, or modify [LiveKit](wiki.html#definition-livekit) screen-share tracks. Shared [Blackboard](wiki.html#definition-blackboard) content continues to synchronize through persisted mutations and `blackboard.updated` invalidations whether another participant currently has the surface open or closed.

[RoboTeam](wiki.html#definition-roboteam) modifies the blackboard only through [WebMeet](wiki.html#definition-webmeetagent) blackboard tools. [Blackboard](wiki.html#definition-blackboard) collaboration remains final-state only: local drag and typing previews are not broadcast; accepted final widget or blackboard states are persisted and announced through `blackboard.updated`.

### Decisions

[LiveKit](wiki.html#definition-livekit) remains the media and room-event transport for [WebMeet](wiki.html#definition-webmeetagent), but not the runtime for AI agents. Agent state, settings, demo widgets, and blackboard mutations are owned by [`webmeetAgent`](wiki.html#definition-webmeetagent) and [Ploinky](wiki.html#definition-ploinky) tool execution.

[WebMeet](wiki.html#definition-webmeetagent) agents are durable [Ploinky](wiki.html#definition-ploinky) room entities. [RoboTeam](wiki.html#definition-roboteam) is always available by default, can present and update the blackboard, and does not depend on a separate AI worker process.
