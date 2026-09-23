---
title: DS005-livekit-media-runtime
summary: Defines topology-resolved signaling, private Twirp assertions, external relay credentials, reconnect, local voice-responsive avatars, release gates, and the current fail-closed reachability boundary.
---

# DS005-livekit-media-runtime

### DS005 - LiveKit Media Runtime

## Introduction

This specification defines the active LiveKit media runtime contract for WebMeet.

## Core Content

### Boundary

`webmeetAgent` owns rooms, membership, participant JWTs, chat, resources, Meeting Secretary dispatch coordination, and controlled rejoin. `liveKitServerAgent` owns Redis, LiveKit Server, Egress, and supervisor health. Ploinky Router owns browser signaling and private administrative transport.

For every join, WebMeet reads the current unversioned media topology and uses the same-origin `/base-agent-additional-server/liveKitServerAgent/7880/` signaling path. It obtains short-lived external relay credentials from the private broker using an exact current-generation assertion. The material must include valid expiry and matching topology and publication generations. There is no static ICE or URL fallback.

Server-side RoomService calls use `/base-agent-additional-server/liveKitServerAgent/7880/twirp/livekit.RoomService/` on private Router `8081`. The request assertion binds the audience, caller generation, method, exact Twirp path, body digest, expiry, and nonce. Router consumes the assertion and preserves the LiveKit API JWT.

The verified rootless Podman transport cannot activate the private broker or private RoomService convention route for a default managed-bridge WebMeet runtime. Its `host.containers.internal:host-gateway` mapping terminates on the box outer-facing interface rather than loopback or an address assigned to the managed bridge. Binding private Router `8081` there would violate the approved interface boundary. Ploinky therefore leaves the affected selectors inactive and fails closed. WebMeet does not use public Router, a direct LiveKit target, a widened bind, host mode, or a forwarding sidecar as a fallback.

### Media and credential lifecycle

The SFU advertises one direct candidate at the configured public IPv4 and UDP `7882`. External TURN provides UDP and TLS/TCP relay. The long-term relay secret is absent from WebMeet environment and topology; only allowed current-generation consumers can mint short-lived material.

Before credential expiry and after browser network transitions, the room UI performs a controlled disconnect, resolves fresh join material, recreates the LiveKit connection, rejoins, and restores microphone/camera state. An active screen share is stopped and the user is told to press the real Share screen button again because display capture cannot be reacquired without a fresh browser user activation. Failure is visible and closed; stale material is not retried as a fallback. Refresh timers and network listeners are removed when the dashboard unloads.

Microphone capture profiles, single-stage voice processing, capture-session lifecycle, applied-settings verification, and read-only ICE transport diagnostics are defined by DS012. Published microphone audio uses explicit voice-oriented LiveKit publish defaults covering Opus bitrate, DTX, RED, mono output, and stop-microphone-on-mute. That contract does not change the transport credential brokerage or the fail-closed reachability boundary described here.

### Voice-responsive AxiFace state

When the participant's avatar `expressionMode` is `audio`, LiveKit is the only authority for microphone availability and speaking activity. Track publish, unpublish, mute, unmute, connection, and active-speaker events update one browser-side avatar controller. The controller alone reconciles those facts into the effective state; participant-card media state and received avatar projections do not feed back into that decision. A mute or unpublish event immediately makes the microphone unavailable, and a delayed active-speaker event can update activity but cannot keep or restore `speaking` until LiveKit explicitly publishes or unmutes the microphone again.

LiveKit is authoritative for microphone publication, Mute and track availability. While that microphone track is available, the browser creates a separate analysis graph over the same media track and samples locally vendored Meyda 5.6.3 features every 100 ms. A conservative RMS gate with start/release hysteresis maintains local voice continuity when LiveKit's active-speaker ranking briefly drops the participant; it cannot override a muted, unpublished or ended LiveKit track. The remaining features calibrate against the participant's recent voice and supply a stable expression candidate to the controller. The controller uses `speaking` as the fallback during calibration or weak evidence and can refine active speech to `happy`, `confused`, or `alert`. It never derives the resting `sleepy` state from active speech. Muting or losing the microphone returns immediately to `neutral`; sustained local and remote inactivity returns to `neutral` after the release interval. Eligible remote speech selects `listening`. Three consecutive candidate windows and a minimum one-second state interval prevent rapid oscillation.

The analyser neither replaces nor reconnects the published LiveKit track. It never analyzes screen-share audio, never sends raw samples or extracted features to LiveKit, WebMeet tools, or a server agent, and discards its sample buffers when the microphone disappears, the room disconnects, the mode becomes manual, or the dashboard unloads. Disconnect cleanup cancels its browser timers with their required browser-global receiver and must not interrupt the LiveKit reconnect lifecycle. Failure to load or run Meyda leaves LiveKit-derived speaking/listening/neutral behavior available. The vendored bundle and license are pinned beneath the WebMeet plugin's `vendor/meyda` directory; meeting execution does not load Meyda from a CDN or package registry.

The controller publishes only its effective output as a transient overlay on the existing reliable `participant.avatar.projected` LiveKit data-channel event. The channel distributes the decision to other clients; it is not a competing authority for the sender's local controller, and received local projections are not reconciled back into media activity. Only `emotion`, bounded `intensity`, and `speaking` are shared. Calibration values, confidence, acoustic features, and raw media never enter the event. Manual mode clears the transient overlay and continues to use the existing full avatar projection behavior.

### Screen-share release gate

With `SMOKE_WEBMEET_SCREEN=1`, the existing two-account smoke test requires two distinct authenticated identities in isolated browser contexts. It exercises the real screen-share button in both directions. For each direction it proves:

- local LiveKit ScreenShare publication and active UI state;
- a visible attached remote ScreenShare video with current media data;
- increasing screen-source outbound and inbound RTP packet/frame counters;
- selected ICE candidate-pair evidence proving both browsers use an active
non-relay UDP pair on the fixed `7882` mux; and
- local unpublication plus remote track removal before reversing direction.

The test retains chat and room cleanup and writes redacted trace, video, screenshots, publication identity, candidate-pair, and RTC diagnostics on failure. Screen mode never skips for environment or account absence.

The local screen lane deliberately does not claim that the selected address is the configured public IPv4. Separate native Linux x64 and arm64 lanes use two remote browsers on verified distinct external networks. There, direct UDP must select the configured public IPv4 and `7882` rather than `7881` or a private/discovered alternative; relay lanes must select external TURN/UDP and TURN/TLS respectively.

### Security

Participant JWTs remain room-scoped and temporal. Private assertions are not user/admin credentials. Unknown topology, inactive signaling, stale caller generation, replay, wrong path/body, invalid relay response, or expired join material fails before an upstream connection is created.

### Decisions & Questions

### Question #1: Why does the private media control path fail closed?

Response: The release contract requires a managed-bridge WebMeet process to reach private Router `8081` without making that listener outer-facing. The verified rootless `host-gateway` topology cannot provide that transport while preserving the approved bind boundary. Private Twirp, TURN brokerage, and the fresh-stack screen-share gate therefore remain inactive and fail closed.

## Conclusion

WebMeet's media contract is implemented only through the point that preserves the private-listener boundary. The blocked managed-bridge transport is never replaced by a compatibility path or counted as a passed end-to-end gate.
