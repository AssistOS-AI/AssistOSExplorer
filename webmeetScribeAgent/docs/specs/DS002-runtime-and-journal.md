---
title: DS002-runtime-and-journal
summary: Defines LiveKit dispatch, cumulative analysis checkpoints, encrypted recovery, and note application.
---

# DS002 Runtime And Journal

## Introduction

The Meeting Secretary worker receives text-only dispatches and maintains recoverable cumulative analysis state.

## Core Content

`webmeetScribeAgent` must be disabled by default and must not be automatically enabled by WebMeet. An administrator may enable the worker through Explorer Marketplace before automatic Meeting Notes are used. Ordinary meetings remain available without the worker. Transcript capture uses browser SpeechRecognition, with no dependency on `webmeetStt`.

The worker must require a meeting identifier, connect without an audio pipeline, and advertise the meeting-secretary participant attributes. A transcript segment is admissible only when its LiveKit identity has been confirmed by the authoritative WebMeet room state.

Analysis must use the configured time and word checkpoints and must capture an immutable transcript checkpoint before invoking the meeting-notes skill. The input must include the active document, cumulative semantic memory, uncompacted chronological transcript, and editable title-and-chapter structure. Text that arrives during analysis remains pending for the next sequential revision.

The worker must persist temporary encrypted recovery state under the `/data` runtime mount backed by `.data/webmeetScribeAgent`, remove compacted transcript prefixes only after validated publication, divide oversized pending backlogs into bounded checkpoints, and delete the journal after successful finalization or after the configured recovery expiry. A generated document must be validated as bounded Markdown with one leading H1, the configured chapter order, and no SCRIPTA metadata before persistence.

## Conclusion

The runtime contract preserves cumulative context, sequential document application, and recovery after worker or provider interruption.
