---
title: DS000-vision
summary: Defines webmeetAgent as the WebMeet application control plane and keeps media, Ploinky room-agent, STT, and infrastructure responsibilities separate.
---

# DS000-vision

### DS000 - WebMeet Agent Vision

## Introduction

`webmeetAgent` is the Ploinky application agent for WebMeet rooms inside AssistOSExplorer. It owns the application control plane: room records, room-scoped public link access, LiveKit participant token issuance, meeting chat, room resources, blackboard state, Ploinky room-agent metadata, and the Explorer WebMeet plugin.

Live audio, video, screen share, Redis coordination, Egress, and external relay service are adjacent WebMeet runtime components. They are not owned by the `webmeetAgent` process. Ploinky core owns Router transport, box topology, and short-lived external TURN credential brokerage.

## Core Content

WebMeet is split into explicit responsibility planes:

| Area | Owner | Contract |
| --- | --- | --- |
| WebMeet control plane | `webmeetAgent` | Durable rooms, members, roomId scopes, chat, resources, blackboard state, Ploinky room-agent metadata, and LiveKit participant JWTs. |
| Browser meeting UI | `webmeetAgent/IDE-plugins/webmeet-tool-button` | Explorer dashboard and direct room entry UI, LiveKit browser connection, media controls, chat composer, participant rendering, and browser-scoped media/avatar preferences. |
| Live media plane | `webmeetInfra/liveKitServerAgent` | Loopback LiveKit signaling/API, the exact box UDP `7882` mux, RTP/RTCP forwarding, data channels, Redis, Egress template `7980`, and semantic health `7981`; no local TURN or public TLS listener. |
| Edge and relay control | Ploinky core plus explicitly configured external TURN | Router-mediated public signaling/private Twirp, immutable topology, and current-generation short-lived TURN credentials. |
| RoboTeam room agent | `webmeetAgent` | Ploinky-managed virtual room agent that appears in WebMeet roster and can update the blackboard through WebMeet tools. |

The central invariant is that WebMeet rooms are discovered, authorized, and persisted by `webmeetAgent`. LiveKit rooms carry the live media session. Redis is infrastructure runtime state for LiveKit; it is not the WebMeet application database.

The primary implementation map is:

| Concern | Files |
| --- | --- |
| Manifest, data volumes, LiveKit env, dependencies | `manifest.json` |
| WebMeet process startup | `scripts/startAgent.sh` |
| MCP tool surface | `tools/webmeet_tool.mjs`, `mcp-config.json` |
| Store facade and MCP-facing room API | `lib/webmeetStore.mjs` |
| Room participants/presence/avatar projection | `lib/services/roomParticipants.mjs` |
| Room chat | `lib/services/roomMessages.mjs` |
| Room archive | `lib/services/roomArchive.mjs` |
| LiveKit runtime adapter | `lib/runtime/livekitRuntime.mjs` |
| Avatar policy | `lib/policies/avatarPolicy.mjs` |
| Workspace/data paths | `lib/workspacePaths.mjs` |
| Payload encryption | `lib/webmeetCrypto.mjs` |
| Event append files | `lib/webmeetQueue.mjs` |
| WebMeet plugin API client | `IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/services/webmeet-api-client.js` |
| Browser LiveKit connection | `IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/services/room/webmeet-room-livekit.js` |
| Room orchestration and lifecycle | `IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/services/room/webmeet-room.js` |
| Room event normalization and typed UI events | `IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/services/room/webmeet-room-events.js` |
| Serializable room state model | `IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/services/room/webmeet-room-state.js` |
| Room session and LiveKit event handling | `IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/controllers/room-session-methods.js` |
| Browser media controls | `IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/controllers/webmeet-media-controller.js` |
| Chat UI behavior | `IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/service-components/chat-component.js` |
| Guest room entry behavior | `IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/controllers/dashboard-session-methods.js` |

The active Explorer WebMeet UI path is the IDE plugin under `IDE-plugins/webmeet-tool-button`. Any older router-level `/webmeet` surface must not be treated as the current product entry point unless a future specification reintroduces it.

`webmeetAgent` must keep its persistent store under required `WEBMEET_DATA_DIR`, normally the `/data` container mount backed by `.data/webmeetAgent/data`. Runtime resolution must fail closed when the variable is absent and must not derive a workspace fallback.

`webmeetAgent` must not own infrastructure supervision. Its manifest enables `webmeetInfra/liveKitServerAgent` with `no-wait`, leaving its lifecycle to Ploinky. `webmeetScribeAgent` and `webmeetStt` are optional and disabled by default; an administrator can enable them independently from Explorer Marketplace. Ordinary meetings do not require either agent, and the text-only Meeting Secretary uses browser SpeechRecognition without the STT service. `scripts/startAgent.sh` must only start the WebMeet MCP AgentServer. It must not directly launch sibling processes, start a WebMeet HTTP API/proxy, import `@livekit/agents`, start Redis, or start LiveKit Server.

### Decisions & Questions

### Question #1: Why split WebMeet into a control plane and a media plane?

Response: The WebMeet application needs durable authorization, room discovery, encrypted meeting records, room-scoped public link authorization, resources, and audit-friendly event files. LiveKit is optimized for low-latency media routing and transient room state. Keeping those responsibilities separate prevents media runtime state from becoming the product database and prevents application control-plane latency from sitting on the live audio/video path.

### Question #2: Why does this agent depend on `liveKitServerAgent` instead of owning multiple infra agents?

Response: The `webmeetInfra` contract delivers one pinned Ploinky agent, `liveKitServerAgent`, that supervises Redis, LiveKit Server, Egress, and supervisor health. It contains no Coturn, nginx, certbot, local relay range, TCP ICE listener, or public `7880`. External TURN and Router are separate box and external boundaries rather than sibling infrastructure agents.

### Question #3: Why keep the repository-level WebMeet architecture content inside the DS set?

Response: DS files are the source of truth for future agent work. The root architecture document is useful narrative context, but durable requirements such as storage ownership, guest-route validation, LiveKit URL topology, event encoding, and Redis limits must live in the agent-local DS files where future changes are likely to begin.

## Conclusion

`webmeetAgent` remains correct while it stays the WebMeet application control plane, delegates live media infrastructure to `webmeetInfra/liveKitServerAgent`, models RoboTeam as Ploinky-managed room state rather than a LiveKit worker, and preserves the documented storage, routing, and authorization boundaries.
