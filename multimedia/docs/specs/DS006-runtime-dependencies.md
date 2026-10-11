---
title: DS006-runtime-dependencies
summary: Defines runtime startup, Git and FFmpeg availability checks, and host sandbox dependency boundaries.
---

# DS006-runtime-dependencies

## Introduction

This specification defines multimedia startup requirements and the Git and FFmpeg dependency checks for containers and host sandboxes.

## Core Content



### Role of This Document

This document defines runtime requirements for starting the `multimedia` agent and its minimum dependency guarantees.

### Runtime Contract

The agent uses this manifest:

```json
{
  "lite-sandbox": true,
  "container": "docker.io/assistos/ploinky-node@sha256:accd925fcbf460c1f4c7a5cd9e2d46539c615bbfad2e896cabb7556d8050a669",
  "profiles": {
    "default": {
      "install": "/code/scripts/install.sh"
    }
  }
}
```

### Startup Install Requirements

Requirement R1: the install script must run at startup to prepare the multimedia runtime.

Requirement R2: in container mode, the shared [Ploinky](wiki.html#definition-ploinky) Node image must provide `git` and `ffmpeg`, and the script must validate their presence before the agent becomes available. It may fall back to package installation only when a non-standard image is used.

Requirement R3: in host sandbox mode (`bwrap` on Linux, `seatbelt` on macOS), the script must validate that `git` and `ffmpeg` are present on the host.

Requirement R4: missing `git` in host sandbox mode is a blocking error; missing `ffmpeg` is an explicit warning.

### Constraints

Constraint C1: FFmpeg-dependent video processing features are not guaranteed when `ffmpeg` is missing from the runtime.

Constraint C2: in host sandbox mode, OS package installation is not managed by the agent; responsibility remains on the host.

### Invariants

Invariant I1: agent startup always includes a dependency install/check step.

Invariant I2: [FFmpeg](wiki.html#definition-ffmpeg) is a core operational dependency for advanced media workflows.

multimedia must preserve the responsibilities, boundaries, and observable results stated in this specification.
