# WebMeet Agent

`webmeetAgent` is the AchillesIDE agent for WebMeet rooms, roomId link routing, LiveKit token issuance, chat, room resources, Blackboard state, and Ploinky-managed room-agent metadata.

## Components

- `webmeetAgent`
  - owns the WebMeet MCP surface and room store
  - does not serve a WebMeet-specific HTTP API or public proxy
  - stores persistent room data under `.data/webmeetAgent/data`, mounted at required `WEBMEET_DATA_DIR=/data`
  - stores and projects the Ploinky-managed RoboTeam room agent
- `AchillesIDE/liveKitServerAgent`
  - single Ploinky agent that supervises the WebMeet media runtime
  - includes LiveKit Server, Redis, Egress, and semantic supervisor health inside one pinned container
  - binds signaling/API only to box loopback `127.0.0.1:7880`, owns the one box UDP mux on `7882`, and contains no local TURN, public TLS proxy, or certificate manager
- `webmeetScribeAgent`
  - separate text-only Meeting Secretary agent enabled with `no-wait`
  - reconciles cumulative meeting notes through delegated WebMeet tools
  - does not act as a LiveKit audio or video participant

## Running

The agent is started through Ploinky, not directly with Docker Compose.

The WebMeet manifest:

- enables `AchillesIDE/liveKitServerAgent`
- enables `webmeetScribeAgent`
- starts the MCP `AgentServer`
- does not start Redis, LiveKit Server, Egress, or an external AI worker process

Explorer only needs to enable `webmeetAgent` and the `webmeet` plugin for normal rooms, chat, camera, and screen sharing flows.

Each join resolves the current box-owned topology generation. Public signaling
uses Router `8080`; server-side LiveKit Twirp uses private Router `8081` with an
exact current-generation assertion. External TURN supplies UDP and TLS relay,
and Ploinky core brokers short-lived relay credentials only to allowed current-
generation consumers. WebMeet keeps no static relay URL or credential fallback.

WebMeet browser settings are user-scoped preferences stored in the browser, not per-room state. Device selection, audio processing, camera quality, screen share quality, and background privacy effects are opened from the dashboard header and apply across every room that the same Explorer user joins from that browser profile.

The main WebMeet application is the page component `webmeet-dashboard`, not a modal. WebMeet settings open in the dedicated WebSkel `webmeet-settings-modal`, which supports edge/corner resizing and a fullscreen toggle.

Microphone voice processing is local to the browser before the track is published to LiveKit. New users default to `auto`, which prefers the locally bundled Apache-2.0 RNNoise pipeline, detects sustained 50/60 Hz hum, applies conservative adaptive gain before final peak compression, and falls back to standard browser processing when needed. `custom`, `enhanced`, `standard`, and `off` remain explicit manual modes; editing gain, hum filtering, echo cancellation, noise suppression, or AGC while in `auto` switches the draft to `custom` instead of blocking the control. Saved settings are not overwritten. Remote participant volume normalization is also browser-local, default-enabled, and disabled per participant by an explicit manual volume override. LiveKit remains the self-hosted SFU and no paid/cloud denoise service or per-minute processing is used. Vendor provenance is documented in `IDE-plugins/webmeet-tool-button/vendor/rnnoise/THIRD_PARTY_NOTICES.md`.

Background privacy uses a locally bundled LiveKit processor pipeline plus bundled MediaPipe assets. Blur and virtual-background images therefore stay inside the routed WebMeet frontend instead of depending on third-party CDN fetches at runtime.

## Ploinky Room Agent

RoboTeam is the current WebMeet room agent. It is a Ploinky-managed logical participant stored in the encrypted room payload with participant identity `agent_robo_team`, agent type `robo_team`, mode `blackboard_demo`, and runtime `ploinky`.

The `webmeet_agent_attach`, `webmeet_agent_list`, and `webmeet_agent_detach` tools manage this persisted room-agent state. They do not create a LiveKit `AGENT` participant, invoke `CreateDispatch`, or require a separate LiveKit Agents worker. RoboTeam appears in the WebMeet roster without a microphone, camera, media track, or independent LiveKit session.

New rooms normalize RoboTeam state in the encrypted room payload. Administrators can configure it, and admitted participants can invoke the supported Blackboard workflow through `webmeet_event_command`.

## Room Links

Guest-capable rooms use the same entrypoint as authenticated direct links:

```text
/<webmeetAgent>/roomLoader.html?roomId=room_<uuid>
```

Unauthenticated visitors receive a Ploinky guest session scoped to `webmeet:room:<roomId>` from the router. Authenticated users keep their normal Ploinky identity and can still see the dashboard and other allowed rooms.

After admission, guest room refresh and chat use dedicated owner-bound MCP tools. Both require the joined `participantIdentity`; WebMeet verifies that identity against the router-issued guest session before returning the guest-safe room projection or deriving the persisted chat author. The guest roster omits durable account identifiers, and guest chat revalidates the active room, membership, and owner binding inside the same serialized mutation that persists the message.

Room avatar projection is LiveKit-only rendering state, not durable room state. Joins do not persist avatar projections into the room record; after the participant connects, WebMeet publishes the effective avatar through LiveKit participant attributes and the reliable data channel. Authenticated users and guests publish through the room-scoped MCP tool path. Avatar publish failures must not block joining a room.

## Runtime Validation

WebMeet no longer ships a dedicated HTTP server or server-side runtime validation script. Runtime checks should use the Ploinky agent lifecycle and the MCP room tools: verify `ploinky status`, container status, `webmeet_room_list`, and a room join response with a non-empty LiveKit participant token.
