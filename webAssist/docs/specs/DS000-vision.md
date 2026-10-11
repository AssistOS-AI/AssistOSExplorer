---
title: DS000-vision
summary: Defines the DS000-vision contract for WebAssist.
---

# DS000-vision

## Introduction

[WebAssist](wiki.html#definition-webassist) provides a site-scoped assistant workflow for visitors and operators.

## Core Content

### DS000 - webAssist Vision

### Objective
The **webAssist** agent is designed to act as a personal assistant available via a command-line interface. Its primary goal is to interact with visitors, understand their needs through profiling, and convert them into valuable leads for the site owner.

### Core Pillars
1. **Single Session Context**: It maintains a coherent conversation within a unique `sessionId`.
2. **Visitor Profiling**: It identifies the most relevant profile for a user based on their input.
3. **Information Gathering**: It provides information while simultaneously asking strategic questions to complete the user's profile.
4. **[Lead](wiki.html#definition-lead) Conversion**: It automatically creates leads and offers meeting scheduling once a profile threshold is met.
5. **Adaptive Orchestration**: Turn execution is delegated to Achilles `MainAgent` with a dedicated `systemPrompt` and cskills.

### User Experience
The interaction should feel professional and helpful. The agent doesn't just answer; it guides the user toward a specific outcome (e.g., booking a meeting).

[WebAssist](wiki.html#definition-webassist) must preserve the responsibilities and boundaries stated by this specification.
