---
title: DS000-vision
summary: Defines the multimedia contract covered by DS000-vision.
---

# DS000-vision

## Introduction

This specification defines the active contract for multimedia.

## Core Content

### DS01 - Agent Overview

### Summary

`multimedia` is an IDE-extension-focused agent for working with document media attachments: audio, video, image, and auxiliary files.

### Background / Problem Statement

The editor needs dedicated plugins for upload, metadata editing, preview, and video compilation without pushing media-specific logic into the generic Explorer host.

### Goals

1. Provide a coherent set of IDE plugins for media attachments.
2. Enable fast preview at paragraph and document levels.
3. Include a reusable [FFmpeg](wiki.html#definition-ffmpeg) skill for image-to-video transformations.

### Non-Goals

1. It is not a general-purpose LLM orchestration agent.
2. It does not define a large [Model Context Protocol](wiki.html#definition-mcp) ([MCP](wiki.html#definition-mcp)) tool catalog like builder/runtime-oriented agents.

### Core Surfaces

- `IDE-plugins/audio-plugin`
- `IDE-plugins/image-plugin`
- `IDE-plugins/video-plugin`
- `IDE-plugins/document-video-preview`
- `skills/ffmpegImageToVideo`

### Operational Note

At agent startup, `scripts/install.sh` is executed, where `ffmpeg` is installed (or validated in bwrap mode) to support audio/video/image processing flows.

multimedia must preserve the responsibilities, boundaries, and observable results stated in this specification.
