# Specification Matrix

| Name | Description |
| --- | --- |
| [DS000-vision](specsLoader.html?spec=DS000-vision.md) | Defines webmeetAgent as the WebMeet application control plane and keeps media, Ploinky room-agent, STT, and infrastructure responsibilities separate. |
| [DS001-coding-style](specsLoader.html?spec=DS001-coding-style.md) | Defines local source layout, documentation, test, validation, and runtime style for webmeetAgent. |
| [DS002-room-state-and-access](specsLoader.html?spec=DS002-room-state-and-access.md) | Defines WebMeet room records, team and guest room behavior, durable storage, encryption, and roomId-scoped access checks. |
| [DS003-main-behavior](specsLoader.html?spec=DS003-main-behavior.md) | Defines WebMeet room access, durable collaboration, and explicit media and room-agent participation as the product's principal behaviors. |
| [DS004-application-runtime-and-events](specsLoader.html?spec=DS004-application-runtime-and-events.md) | Defines the WebMeet MCP tools, browser shells, event encoding, chat persistence, resources, Ploinky room-agent metadata, and avatar rendering boundaries. |
| [DS005-livekit-media-runtime](specsLoader.html?spec=DS005-livekit-media-runtime.md) | Defines topology-resolved signaling, private Twirp assertions, external relay credentials, reconnect, local voice-responsive avatars, release gates, and the current fail-closed reachability boundary. |
| [DS006-ploinky-room-agents](specsLoader.html?spec=DS006-ploinky-room-agents.md) | Defines RoboTeam as a Ploinky-managed WebMeet room agent, not a LiveKit agent worker. |
| [DS007-ploinky-runtime-invariants](specsLoader.html?spec=DS007-ploinky-runtime-invariants.md) | Captures WebMeet's runtime-v5 routing, private-service, security, and fail-closed rootless reachability invariants. |
| [DS008-meeting-chat-routing](specsLoader.html?spec=DS008-meeting-chat-routing.md) | Defines WebMeet chat persistence, verified authorship, file-reference autocomplete, and the boundary between room messages and explicit agent workflows. |
| [DS009-scripta-robo-collaboration](specsLoader.html?spec=DS009-scripta-robo-collaboration.md) | Defines WebMeet board integration, room attachment, RoboTeam event mapping, guest access, Meeting Notes, and realtime behavior for Explorer-owned SCRIPTA documents. |
| [DS010-blackboard-agentic-diagrams](specsLoader.html?spec=DS010-blackboard-agentic-diagrams.md) | Defines the shared multi-zone Blackboard workspace, global atomic history, canonical commands, semantic focus, cross-zone transfers, and agentic diagrams. |
| [DS011-meeting-secretary](specsLoader.html?spec=DS011-meeting-secretary.md) | Defines browser transcription, directed LiveKit text transport, holistic note reconciliation, encrypted recovery journals, and the permanent Meeting Notes Blackboard workspace. |
| [DS012-audio-quality-and-device-recovery](specsLoader.html?spec=DS012-audio-quality-and-device-recovery.md) | Defines microphone capture profiles, single-stage voice processing, capture-session lifecycle, audio publish defaults, applied-settings verification, and read-only transport diagnostics. |
