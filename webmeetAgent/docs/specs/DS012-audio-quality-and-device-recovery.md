---
title: DS012-audio-quality-and-device-recovery
summary: Defines WebMeet's browser-side microphone capture profiles, single-stage voice processing, capture-session lifecycle, audio publish defaults, applied-settings verification, and read-only transport diagnostics.
---

# DS012-audio-quality-and-device-recovery

### DS012 - Audio Quality and Device Recovery

## Introduction

This specification defines how WebMeet captures, processes, and publishes participant audio without echoing, abrupt gain changes, or silent microphone failures. The contract keeps LiveKit and the browser WebRTC stack as the media transport and audio pipeline authority, and it does not introduce a WebMeet-owned jitter buffer, decoder, or additional neural denoiser.

The audio path is split into a capture profile, a single-stage processing chain, a capture-session lifecycle owner, publish defaults, and diagnostic observation. Each stage has one responsibility, and analysis never gates or rewrites the published signal.

## Core Content

### Capture profiles and constraints

Microphone constraints have one source of truth in `services/audio-processing/capture-constraints.js`. The builder resolves a profile from the voice-processing mode:

- `standard` covers the manual and browser-cleanup modes;
- `advanced` covers the automatic and enhanced modes.

Echo cancellation stays requested for conversation profiles. The advanced profile requests browser noise suppression as `false` because RNNoise owns noise reduction; the standard profile follows the browser noise-suppression preference. Browser automatic gain control is requested for the advanced profile and follows the explicit setting for the standard profile. `voiceIsolation` is requested only when the setting enables it, so two independent voice-isolation stages are never combined. The selected device is pinned with an exact identifier, and mono 48 kHz is requested as a preference rather than as a hard requirement.

After capture, the applied settings are read with `getSettings()` and compared with the requested settings. Applied echo cancellation, noise suppression, automatic gain control, and voice isolation are reported as unavailable when the browser or operating system declines them.

### Single-stage voice processing

The default path does not stack independent processors. WebMeet does not request browser noise suppression and a second noise reduction stage at the same time, and it does not run a WebMeet automatic gain stage against the browser automatic gain stage. The adaptive noise gate, the fixed compressor, and the automatic hum notch are removed from the default path. A high-pass filter and a manual 50/60 Hz notch remain available, and a manual gain stage remains available when the participant requests one.

The advanced profile runs the pinned `@jitsi/rnnoise-wasm` build inside an `AudioWorklet`. The worklet uses preallocated input and output ring buffers, processes fixed 480-sample frames at 48 kHz, and fills underrun output with silence instead of alternating between raw and processed audio. The processor is initialized before the processed track is published. Initialization failure, `processorerror`, or context closure marks the processor unavailable and falls back to the standard profile without leaving an apparently active but silent track.

### Capture-session lifecycle

A single capture session owns the original stream, the processed track, the audio context and nodes, the worklet processor, the analysis monitor, and the publish and stop operations. State moves through `stopped`, `starting`, `captured`, `published`, and `error`. Operations are serialized, and a start that completes after a stop is superseded: it releases its resources and cannot publish a track. Leaving the room or stopping the capture releases the microphone and all derived resources. The interface state distinguishes capture from transmission.

### Audio publish defaults

Published microphone audio uses explicit LiveKit publish defaults: a voice-oriented Opus bitrate, DTX, RED, mono output, and `stopMicTrackOnMute`. WebMeet does not reimplement Opus encoding or network jitter compensation; the browser WebRTC stack provides those.

### Analysis and diagnostics

Audio analysis observes the capture and playback paths without gating them. Real-time level, peak, clipping, noise-floor, and speaking calculations run in an `AudioWorklet` processor over preallocated state and post aggregated metrics to the interface several times per second. When worklet analysis is unavailable, WebMeet falls back to the existing analyser-based monitor. Voice detection controls only the speaking indicator and never truncates the beginning of a word or a weak voice. Microphone indication, speaking detection, and signal processing remain separate concerns.

Diagnostics report the requested and effective profile, the requested and applied capture settings, audio level before and after processing where the path exposes it, and the available WebRTC statistics: packet loss, jitter, round-trip time, and concealed samples. Cumulative counters are reported as interval differences. Diagnostics never export tokens, cleartext device identifiers, or automatic audio recordings, and they reuse the existing redaction rules.

Transport diagnostics are read-only. They classify the selected ICE candidate pair as direct or relay, report the ICE and DTLS state, and distinguish signaling failures from media-transport failures. Enabling or configuring TURN remains governed by DS005 and is not part of this contract.

### Output playback recovery

Remote audio playback is attempted when a track is attached. When the browser blocks playback under its autoplay policy, WebMeet exposes an explicit "Enable sound" action and marks the blocked state. A user gesture on the dashboard, or a return of document visibility or window focus, re-attempts playback, re-applies the selected output device to all audio elements, and resumes the shared analysis context. This keeps sound recovery reachable after sleep, tab switches, or a blocked autoplay without requiring a page reload.

### Room session resume across reload

WebMeet records a per-tab resume record in `sessionStorage` when the dashboard opens, when a room is joined, and when microphone or camera state changes. The record stores whether the panel is open, the active room identifier, and the microphone and camera state. The browser room URL continues to carry the active room identifier for direct room entry.

After a browser refresh, the WebMeet panel reopens when the record says it was open, and the active room is rejoined with a fresh participant token. Microphone and camera state are restored when they were on. Screen sharing is not restored automatically because display capture requires a fresh user gesture. Leaving a room clears the room identifier from the record while keeping the panel open, so a refresh does not rejoin a room that was left. Closing the panel clears the record so a refresh does not reopen it.

### Device identification and recovery

Virtual and aggregate devices remain selectable and are flagged instead of being hidden by name heuristics. A selected virtual microphone or speaker raises an explicit warning. Device-change handling refreshes the device list and surfaces a warning when the selected input or output is no longer available. When the selected microphone is gone, the participant is told to select another input rather than being left on a stale device.

## Decisions & Questions

### Question #1: Why keep the browser WebRTC stack instead of a WebMeet jitter buffer?

Response: The browser WebRTC stack already provides Opus, jitter buffering, packet-loss concealment, and network adaptation with permissive licensing. Owning a parallel stack would increase memory and CPU cost, duplicate behavior, and complicate recovery without a demonstrated quality benefit.

### Question #2: Why is analysis read-only?

Response: A gate or automatic gain stage that reacts to short analysis windows can truncate quiet speech and pump background noise. Keeping analysis read-only preserves intelligibility while still supplying level, health, and speaking state.

### Question #3: Why is `voiceIsolation` opt-in?

Response: Platform voice isolation and a WebMeet noise-reduction stage are two independent reduction mechanisms. Requesting both can degrade speech, so `voiceIsolation` is requested only when a single reduction stage is intended.

## Conclusion

WebMeet captures and publishes audio through one constraint builder, one processing stage per concern, and one capture-session owner, with verified applied settings and read-only diagnostics. This yields a stable and clear voice path on the supported browsers while leaving transport credential boundaries to DS005.
