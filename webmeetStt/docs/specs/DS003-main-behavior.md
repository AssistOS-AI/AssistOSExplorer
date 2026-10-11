---
title: DS003-main-behavior
summary: Defines private transcription for WebMeet audio workers.
---

# DS003 Main Behavior

## Introduction

[WebMeet STT](wiki.html#definition-webmeetstt) converts audio uploaded by an internal caller into transcript text through an optional private Faster-Whisper service.

## Core Content

### Private transcription service

The affected actor is an internal service caller. It uploads an audio file to `POST /v1/audio/transcriptions` through the private webmeet bridge, where Faster-Whisper applies the configured model, language, device, compute type, and optional DTLN denoise settings. The observable result is JSON containing transcript text, language, and duration, or plain text when `response_format=text`. Temporary audio is deleted after processing. The governing boundary is that the service has no public browser route, physical-host publication, or direct user-facing tool contract.

The [STT](wiki.html#definition-stt) behavior is complete when internal WebMeet consumers can obtain transcript text while the network and storage boundary remains private.
