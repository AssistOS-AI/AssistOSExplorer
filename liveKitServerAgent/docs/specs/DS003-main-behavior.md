---
title: DS003-main-behavior
summary: Defines attested LiveKit startup, private administration, and supervised recording for WebMeet.
---

# DS003-main-behavior

## Introduction

[LiveKit Server](wiki.html#definition-livekit) supplies the signaling, media transport, and recording runtime used by WebMeet while Ploinky owns publication and caller authorization.

## Core Content

### Main Behavior Components

| Name | Explanation |
| --- | --- |
| Attested media runtime | Operators start a supervised runtime whose advertised media address follows the attested topology. |
| Protected signaling and recording | WebMeet participants receive Router-mediated signaling, while authorized callers use private administration and recordings remain agent-owned. |

### Attested media runtime

Ploinky starts the pinned image and provides the attested topology before `scripts/generate-config.mjs` writes runtime configuration. The supervisor starts Redis, [LiveKit Server](wiki.html#definition-livekit), [Egress](wiki.html#definition-egress), and private health, and checks process and socket ownership. LiveKit owns one UDP mux on `7882`. A declared media stanza is authoritative; topology without media selects bounded local deployment and cannot satisfy cross-network release evidence. [DS002-livekit-server-agent](specsLoader.html?spec=DS002-livekit-server-agent.md) defines address and readiness requirements.

### Protected signaling and recording

Public signaling and authenticated Twirp administration use their declared Router services. Redis, [Egress](wiki.html#definition-egress), and detailed health remain private. [Egress](wiki.html#definition-egress) uses its supervised PulseAudio runtime and writes recordings under `.data/liveKitServerAgent/recordings/`. Release evidence requires a connected publisher and a completed non-empty recording, plus the documented native architecture and external network lanes; listener readiness alone cannot satisfy those gates. [DS004-ploinky-runtime-invariants](specsLoader.html?spec=DS004-ploinky-runtime-invariants.md) preserves invocation, guest, logging, and relay boundaries.
