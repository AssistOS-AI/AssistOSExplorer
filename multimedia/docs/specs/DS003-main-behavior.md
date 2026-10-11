---
title: DS003-main-behavior
summary: Defines document media workflows and the dependency boundary for FFmpeg processing.
---

# DS003-main-behavior

## Introduction

Multimedia supplies Explorer document controls for audio, video, images, and file attachments, together with media-processing helpers.

## Core Content

### Main Behavior Components

| Name | Explanation |
| --- | --- |
| Document media workflows | Document users add and inspect media in the document, chapter, or paragraph context supplied by Explorer. |
| Media runtime prerequisites | Operators receive dependency checks before using FFmpeg-dependent media processing. |

### Document media workflows

Opening a multimedia [IDE plugin](wiki.html#definition-ide-plugin) selects the relevant document context and presents upload, preview, metadata, or generated-output controls. Explorer owns the host shell; the multimedia components own the media-specific workflow and must preserve the owning document and file access rules. [DS002-ide-plugin-contracts](specsLoader.html?spec=DS002-ide-plugin-contracts.md) and [DS004-ffmpeg-media-processing](specsLoader.html?spec=DS004-ffmpeg-media-processing.md) define the supported interfaces.

### Media runtime prerequisites

[Ploinky](wiki.html#definition-ploinky) invokes `scripts/install.sh` for the selected runtime. Containers require `git` and `ffmpeg`; host sandbox startup fails when `git` is absent and warns when `ffmpeg` is absent. FFmpeg-dependent processing requires the executable even when other plugin workflows remain available. [DS006-runtime-dependencies](specsLoader.html?spec=DS006-runtime-dependencies.md) preserves the startup contract. The `ffmpegImageToVideo` descriptor entrypoint imports `ffmpegImageToVideo.js`, while the implementation is named `ffmpegImageToVideo.mjs`; that entrypoint cannot load until its import matches the implementation.
