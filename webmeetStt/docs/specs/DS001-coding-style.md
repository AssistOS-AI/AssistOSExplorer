---
title: DS001-coding-style
summary: Defines Python layout, dependency, secret, and test conventions for WebMeet STT.
---

# DS001 Coding Style

## Introduction

This specification defines implementation and verification rules for the Python [STT](wiki.html#definition-stt) service.

## Core Content

Python modules must remain under the service source and scripts, use explicit configuration from the manifest environment, and avoid hard-coded host paths. Dependencies must be pinned or constrained by the repository's startup installation contract and installed atomically into persistent service storage.

The service must not log raw audio, generated credentials, or private runtime descriptors. Tests must remain under webmeetStt/tests/ and must cover startup configuration and transcription boundary behavior. AchillesAgentLib is not an [STT](wiki.html#definition-stt) runtime dependency; if it is introduced for a future agent interaction, all LLM calls must use the configured LLMAgent class and manual runtime overrides.

A private, reproducible Python service and colocated tests preserve the [STT](wiki.html#definition-stt) boundary.
