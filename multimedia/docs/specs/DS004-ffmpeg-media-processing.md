---
title: DS004-ffmpeg-media-processing
summary: Defines the multimedia contract covered by DS004-ffmpeg-media-processing.
---

# DS004-ffmpeg-media-processing

## Introduction

This specification defines the active contract for multimedia.

## Core Content

### DS04 - FFmpeg Media Processing

### Role of This Document

This document describes the `ffmpegImageToVideo` skill contract and FFmpeg-based media processing rules.

### Skill Scope

`ffmpegImageToVideo` produces MP4 output from a list of images and optional audio track input. The result is uploaded to blob storage and returned with useful metadata (`id`, `downloadUrl`, `mime`, `size`).

### Input Requirements

Requirement M1: input must contain at least one image.

Requirement M2: sources may be blob IDs or HTTP(S) URLs.

Requirement M3: rendering parameters (`duration`, `fps`, `width`, `height`, `bg`) are optional, with operational defaults.

Requirement M4: SVG image inputs are explicitly rejected.

### Processing Guarantees

Guarantee G1: the skill normalizes URLs for containerized runtime (`host.docker.internal` fallback).

Guarantee G2: it runs [FFmpeg](wiki.html#definition-ffmpeg) using a `scale + pad + libx264 + yuv420p` pipeline for compatible MP4 output.

Guarantee G3: temporary files are cleaned up at the end, including error paths.

Guarantee G4: output is uploaded to blob storage before return.

### Constraints

Constraint F1: without [FFmpeg](wiki.html#definition-ffmpeg) available in runtime, the skill cannot complete.

Constraint F2: input download and output upload failures propagate to the caller as execution-level errors.

multimedia must preserve the responsibilities, boundaries, and observable results stated in this specification.

### Entrypoint boundary

The implementation is `skills/ffmpegImageToVideo/src/ffmpegImageToVideo.mjs`. The descriptor entrypoint `src/index.mjs` imports a missing `ffmpegImageToVideo.js`; loading that entrypoint fails until the import matches the implementation. The processing contract above does not establish successful execution through that entrypoint.
