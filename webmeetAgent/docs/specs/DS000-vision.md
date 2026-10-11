---
title: DS000-vision
summary: Defines webmeetAgent as the WebMeet application control plane and keeps media, Ploinky room-agent, STT, and infrastructure responsibilities separate.
---

# DS000-vision

### DS000 - WebMeet Agent Vision

## Introduction

[`webmeetAgent`](wiki.html#definition-webmeetagent) is the [Ploinky](wiki.html#definition-ploinky) application agent for [WebMeet](wiki.html#definition-webmeetagent) rooms inside AssistOSExplorer. It owns the application control plane: room records, room-scoped public link access, [LiveKit](wiki.html#definition-livekit) participant token issuance, meeting chat, room resources, blackboard state, [Ploinky](wiki.html#definition-ploinky) room-agent metadata, and the Explorer [WebMeet](wiki.html#definition-webmeetagent) plugin.

Live audio, video, screen share, Redis coordination, Egress, and external relay service are adjacent [WebMeet](wiki.html#definition-webmeetagent) runtime components. They are not owned by the [`webmeetAgent`](wiki.html#definition-webmeetagent) process. [Ploinky](wiki.html#definition-ploinky) core owns Router transport, box topology, and short-lived external TURN credential brokerage.

## Core Content

[WebMeet](wiki.html#definition-webmeetagent) is split into explicit responsibility planes:

| Area | Owner | Contract |
| --- | --- | --- |
| [WebMeet](wiki.html#definition-webmeetagent) control plane | [`webmeetAgent`](wiki.html#definition-webmeetagent) | Durable rooms, members, roomId scopes, chat, resources, blackboard state, [Ploinky](wiki.html#definition-ploinky) room-agent metadata, and [LiveKit](wiki.html#definition-livekit) participant JWTs. |
| Browser meeting UI | `webmeetAgent/IDE-plugins/webmeet-tool-button` | Explorer dashboard and direct room entry UI, [LiveKit](wiki.html#definition-livekit) browser connection, media controls, chat composer, participant rendering, and browser-scoped media/avatar preferences. |
| Live media plane | `AchillesIDE/liveKitServerAgent` | Loopback [LiveKit](wiki.html#definition-livekit) signaling/API, the exact box UDP `7882` mux, RTP/RTCP forwarding, data channels, Redis, Egress template `7980`, and semantic health `7981`; no local TURN or public TLS listener. |
| Edge and relay control | [Ploinky](wiki.html#definition-ploinky) core plus explicitly configured external TURN | Router-mediated public signaling/private Twirp, immutable topology, and current-generation short-lived TURN credentials. |
| [RoboTeam](wiki.html#definition-roboteam) room agent | [`webmeetAgent`](wiki.html#definition-webmeetagent) | Ploinky-managed virtual room agent that appears in [WebMeet](wiki.html#definition-webmeetagent) roster and can update the blackboard through [WebMeet](wiki.html#definition-webmeetagent) tools. |

The central invariant is that [WebMeet](wiki.html#definition-webmeetagent) rooms are discovered, authorized, and persisted by [`webmeetAgent`](wiki.html#definition-webmeetagent). [LiveKit](wiki.html#definition-livekit) rooms carry the live media session. Redis is infrastructure runtime state for [LiveKit](wiki.html#definition-livekit); it is not the [WebMeet](wiki.html#definition-webmeetagent) application database.

The primary implementation map is:

| Concern | Files |
| --- | --- |
| Manifest, data volumes, [LiveKit](wiki.html#definition-livekit) env, dependencies | `manifest.json` |
| [WebMeet](wiki.html#definition-webmeetagent) process startup | `scripts/startAgent.sh` |
| [MCP](wiki.html#definition-mcp) tool surface | `tools/webmeet_tool.mjs`, `mcp-config.json` |
| Store facade and MCP-facing room API | `lib/webmeetStore.mjs` |
| Room participants/presence/avatar projection | `lib/services/roomParticipants.mjs` |
| Room chat | `lib/services/roomMessages.mjs` |
| Room archive | `lib/services/roomArchive.mjs` |
| [LiveKit](wiki.html#definition-livekit) runtime adapter | `lib/runtime/livekitRuntime.mjs` |
| Avatar policy | `lib/policies/avatarPolicy.mjs` |
| Workspace/data paths | `lib/workspacePaths.mjs` |
| Payload encryption | `lib/webmeetCrypto.mjs` |
| Event append files | `lib/webmeetQueue.mjs` |
| [WebMeet](wiki.html#definition-webmeetagent) plugin API client | `IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/services/webmeet-api-client.js` |
| Browser [LiveKit](wiki.html#definition-livekit) connection | `IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/services/room/webmeet-room-livekit.js` |
| Room orchestration and lifecycle | `IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/services/room/webmeet-room.js` |
| Room event normalization and typed UI events | `IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/services/room/webmeet-room-events.js` |
| Serializable room state model | `IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/services/room/webmeet-room-state.js` |
| Room session and [LiveKit](wiki.html#definition-livekit) event handling | `IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/controllers/room-session-methods.js` |
| Browser media controls | `IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/controllers/webmeet-media-controller.js` |
| Chat UI behavior | `IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/service-components/chat-component.js` |
| Guest room entry behavior | `IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/controllers/dashboard-session-methods.js` |

The active Explorer [WebMeet](wiki.html#definition-webmeetagent) UI path is the IDE plugin under `IDE-plugins/webmeet-tool-button`. Any older router-level `/webmeet` surface must not be treated as the current product entry point unless a future specification reintroduces it.

[`webmeetAgent`](wiki.html#definition-webmeetagent) must keep its persistent store under required `WEBMEET_DATA_DIR`, normally the `/data` container mount backed by `.data/webmeetAgent/data`. Runtime resolution must fail closed when the variable is absent and must not derive a workspace fallback.

[`webmeetAgent`](wiki.html#definition-webmeetagent) must not own infrastructure supervision. Its manifest enables `AchillesIDE/liveKitServerAgent` with `no-wait`, leaving its lifecycle to [Ploinky](wiki.html#definition-ploinky). `webmeetScribeAgent` and `webmeetStt` are optional and disabled by default; an administrator can enable them independently from Explorer Marketplace. Ordinary meetings do not require either agent, and the text-only Meeting Secretary uses browser SpeechRecognition without the STT service. `scripts/startAgent.sh` must only start the [WebMeet](wiki.html#definition-webmeetagent) [MCP](wiki.html#definition-mcp) AgentServer. It must not directly launch sibling processes, start a [WebMeet](wiki.html#definition-webmeetagent) HTTP API/proxy, import `@livekit/agents`, start Redis, or start [LiveKit](wiki.html#definition-livekit) Server.

### Decisions & Questions

### Question #1: Why split WebMeet into a control plane and a media plane?

Response: The [WebMeet](wiki.html#definition-webmeetagent) application needs durable authorization, room discovery, encrypted meeting records, room-scoped public link authorization, resources, and audit-friendly event files. [LiveKit](wiki.html#definition-livekit) is optimized for low-latency media routing and transient room state. Keeping those responsibilities separate prevents media runtime state from becoming the product database and prevents application control-plane latency from sitting on the live audio/video path.

### Question #2: Why does this agent depend on `liveKitServerAgent` instead of owning multiple infra agents?

Response: The `AchillesIDE/liveKitServerAgent` contract delivers one pinned [Ploinky](wiki.html#definition-ploinky) agent, `liveKitServerAgent`, that supervises Redis, [LiveKit](wiki.html#definition-livekit) Server, Egress, and supervisor health. It contains no Coturn, nginx, certbot, local relay range, TCP ICE listener, or public `7880`. External TURN and Router are separate box and external boundaries rather than sibling infrastructure agents.

### Question #3: Why keep the repository-level WebMeet architecture content inside the DS set?

Response: DS files are the source of truth for future agent work. The root architecture document is useful narrative context, but durable requirements such as storage ownership, guest-route validation, [LiveKit](wiki.html#definition-livekit) URL topology, event encoding, and Redis limits must live in the agent-local DS files where future changes are likely to begin.

[`webmeetAgent`](wiki.html#definition-webmeetagent) remains correct while it stays the [WebMeet](wiki.html#definition-webmeetagent) application control plane, delegates live media infrastructure to `AchillesIDE/liveKitServerAgent`, models [RoboTeam](wiki.html#definition-roboteam) as Ploinky-managed room state rather than a [LiveKit](wiki.html#definition-livekit) worker, and preserves the documented storage, routing, and authorization boundaries.
