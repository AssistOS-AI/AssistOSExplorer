---
title: DS000-vision
summary: Defines WebMeet STT as a private self-hosted speech-to-text service.
---

# DS000 Vision

## Introduction

[WebMeet STT](wiki.html#definition-webmeetstt) must provide local speech-to-text processing for WebMeet services without exposing an internet-facing or browser-facing route.

## Core Content

The service must run on the configured WebMeet bridge, keep its readiness endpoint loopback-scoped, and return transcript results through the consuming internal service. The image and dependency installation path must remain reproducible from the manifest and startup scripts.

The service is a private transcription dependency with a narrow network and lifecycle boundary.
