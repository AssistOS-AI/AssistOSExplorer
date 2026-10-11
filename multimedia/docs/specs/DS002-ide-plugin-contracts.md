---
title: DS002-ide-plugin-contracts
summary: Defines the multimedia contract covered by DS002-ide-plugin-contracts.
---

# DS002-ide-plugin-contracts

## Introduction

This specification defines the active contract for multimedia.

## Core Content

### DS02 - IDE Plugin Contracts

### Role of This Document

This document defines integration contracts for IDE plugins published by the `multimedia` agent.

### Requirements

Requirement U1: every published plugin must include a valid `config.json` with `pluginCategory`, `component`, `presenter`, `type`, and appropriate icon/tooltips.

Requirement U2: plugins must work in document/chapter/paragraph context using host-provided context (`data-context`).

Requirement U3: attachment-mutating actions must persist data through `document` module APIs and/or `commandsEditor`.

Requirement U3.1: generic paragraph files must be stored in paragraph attachment metadata; the SOP command string is reserved for executable and media commands and must not be replaced with an object-shaped file collection.

Requirement U4: media uploads must enforce size limits and metadata extraction (duration, dimensions), with visible user interface (UI) feedback. Attachment insert and delete controls must remain visibly busy and prevent duplicate activation until persistence and dependent invalidation finish.

Requirement U5: preview plugins must support sequential scene playback with audio/video/image/silence combinations.

### Constraints

Constraint Q1: plugins must not assume private host dependencies; integration must use the stable Explorer surface.

Constraint Q2: host-side visual changes must not impact attachment persistence behavior.

Constraint Q3: upload/metadata errors must be handled explicitly and surfaced with useful messages.

### Invariants

Invariant I1: the attachment data model remains serializable in `commands` / `mediaAttachments`.

Invariant I2: the upload flow is `validate -> metadata -> upload -> persist -> invalidate UI`.

Invariant I3: media plugins remain the primary value channel of the agent.

multimedia must preserve the responsibilities, boundaries, and observable results stated in this specification.
