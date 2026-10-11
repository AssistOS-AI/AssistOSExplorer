---
title: DS003-main-behavior
summary: Defines transcript admission, cumulative note reconciliation, and recoverable secretary lifecycle.
---

# DS003 Main Behavior

## Introduction

The Meeting Secretary lets a WebMeet room turn final browser transcript segments into a cumulative, editable SCRIPTA meeting note.

## Core Content

### Main Behavior Components

| Name | Explanation |
| --- | --- |
| Admitted transcript processing | The worker accepts only final text from participants confirmed by WebMeet room state. |
| Cumulative note reconciliation | The worker combines the current document and bounded meeting context into validated Markdown revisions. |
| Recoverable secretary lifecycle | The worker exposes real activity phases and recovers or resets pending work without stale mutations. |

### Admitted transcript processing

The affected actor is a WebMeet participant whose final browser transcript is routed to the secretary. The worker validates the directed packet and the sender's admitted LiveKit identity before adding it to the pending transcript. The observable result is that accepted text can enter the next analysis checkpoint, while unauthorised or malformed text is rejected without document mutation.

### Cumulative note reconciliation

The affected actor is the meeting room using Meeting Notes. At the configured 45-second or 300-word checkpoint, the worker captures an immutable transcript boundary and requests one analysis using the current document, cumulative memory, uncompacted transcript, and editable chapter structure. The observable result is a bounded Markdown revision that preserves the configured meeting-note structure and is applied through the collaboration layer after validation. The worker does not perform lexical topic matching or submit an isolated time window.

### Recoverable secretary lifecycle

The affected actor is the room control plane managing a running secretary. The worker reports listening, queued, analyzing, updating, and retrying phases, persists an encrypted recovery journal, retries transient failures with bounded backoff, and serializes durable apply before later analysis. Reset cancels obsolete retries, removes the journal, and disconnects the worker. The governing boundary is that the worker has no authority to replace a document directly outside the collaboration contract.

Meeting Notes succeeds when admitted transcript text produces cumulative, validated, recoverable notes while room ownership and collaboration authorization remain authoritative.
