---
title: DS002-runtime-and-network
summary: Defines the WebMeet bridge, readiness, storage, and transcription configuration boundary.
---

# DS002 Runtime And Network

## Introduction

WebMeet STT runs as a Python service with a manifest-defined bridge attachment and persistent data volume.

## Core Content

`webmeetStt` must be disabled by default and excluded from the default Explorer dependency graph. An administrator can enable the service independently through Marketplace. The text-only Meeting Secretary uses browser SpeechRecognition without an STT fallback and must not require this service.

The manifest must use the webmeet bridge as the primary network attachment, mount `.data/webmeetStt` at `/data`, and start the `scripts/startAgent.sh` entrypoint. The service must not publish a physical host port or declare a Router browser route. Readiness must use the loopback healthcheck endpoint.

WEBMEET_STT_PORT defaults to 9000. WHISPER_MODEL defaults to base, WHISPER_LANGUAGE to auto, WHISPER_DEVICE to cpu, WHISPER_COMPUTE_TYPE to int8, and WEBMEET_STT_DENOISE to dtln. The service must preserve these defaults unless an active Ploinky profile overrides them.

## Conclusion

The bridge and loopback readiness rules keep transcription private to the WebMeet runtime.
