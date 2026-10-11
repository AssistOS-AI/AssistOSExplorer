---
title: DS009-scripta-robo-collaboration
summary: Defines WebMeet board integration, room attachment, RoboTeam event mapping, guest access, Meeting Notes, and realtime behavior for Explorer-owned SCRIPTA documents.
---

# DS009 SCRIPTA Robo Collaboration

## Introduction

[WebMeet](wiki.html#definition-webmeetagent) integrates Explorer-owned [SCRIPTA](wiki.html#definition-scripta) documents into the [Blackboard](wiki.html#definition-blackboard) and [RoboTeam](wiki.html#definition-roboteam) experience. The canonical [Automerge](wiki.html#definition-automerge) document is the working authority and Markdown is its durable portable materialization, as defined by Explorer DS011 [SCRIPTA](wiki.html#definition-scripta) Core. [WebMeet](wiki.html#definition-webmeetagent) stores only room attachment metadata, the active resource id for each board, document-scoped presentation focus, audit data, and safe widget projections. It never parses, serializes, or overwrites [SCRIPTA](wiki.html#definition-scripta) Markdown.

This specification owns board placement, room attachment, event mapping, guest behavior, Meeting Notes integration, and realtime presentation. Stable identity, Markdown metadata, variants, voting, ownership, mutations, undo, collaboration replicas, security, and document lifecycle are normative in Explorer DS011 and are not redefined here.

## Core Content

### Blackboard Integration

Each [Blackboard](wiki.html#definition-blackboard) board may contain at most one native `scripta-document` widget with the stable widget id `robo_scripta_document`. A room may retain multiple attached [SCRIPTA](wiki.html#definition-scripta) documents when they belong to different boards. `activeResourceIdsByBoard` is the only persistent active-resource mapping, and each attached document owns its own `view`. There is no room-global active document, room-global view, singleton-mode flag, or compatibility projection.

The widget is mounted on its explicitly selected board and may be transferred atomically to another board without changing the Explorer resource. Every read and mutation carries or resolves the relevant `boardId`. Collaboration open, pull, apply, focus, and mutation resolve the resource against the active resource of that resource's board, so a Meeting Notes document on its dedicated board cannot deactivate a document on another board.

The [SCRIPTA](wiki.html#definition-scripta) widget has a 600 by 400 pixel minimum footprint and persists user resize geometry. Its body is the internal document scroll container while the outer widget keeps contextual controls reachable. Document mode renders the document title, every chapter, and only the active variant text and active-variant images for each paragraph. It does not render the complete variant list. Paragraph mode renders the selected paragraph and its complete variant list through Explorer's shared `scripta-variants-view` component, including voting, alternative creation, owner-authorized editing and deletion, and AI reformulation. This paragraph mode is [WebMeet](wiki.html#definition-webmeetagent)'s Multi-Version Paragraph Widget experience; it is a mode of the single native `scripta-document` widget, not a second independently persisted [Blackboard](wiki.html#definition-blackboard) widget. Repeated markup is cloned from inert templates, and all document-owned strings are assigned as text or passed through the approved sanitizer; metadata and participant content are never executable markup.

The document header exposes chapter creation, and contextual chapter actions add a paragraph, move one position, rename inline with explicit Save/Cancel, or delete. Paragraph actions move one position or delete. Paragraph selection opens variant mode; Previous and Next cross chapter boundaries without wrapping. Creation updates persistent focus to the generated stable id so each browser can focus the new element once for that revision.

### Room Documents And Attachments

Creating a room idempotently creates `/WebMeet/<room-slug>-<short-room-id>/`. [SCRIPTA](wiki.html#definition-scripta) Markdown documents are direct children and chat, [Blackboard](wiki.html#definition-blackboard), and [SCRIPTA](wiki.html#definition-scripta) assets use its `assets/` child. Renaming the room does not move this folder, and room creation does not create an implicit document. A participant may create a room document; an authenticated workspace user may additionally open a workspace Markdown path. One canonical path may be attached to only one room at a time.

Vision, Plan, and General are creation templates, not document roles. Vision creates one chapter with at least three aspect paragraphs. Plan creates the requested chapter structure with at least one paragraph per chapter. General creates one chapter with one empty paragraph and does not invoke AI. Every result uses the same Explorer [SCRIPTA](wiki.html#definition-scripta) format.

Explorer create/open returns the canonical resource, projection, and stable document id. [WebMeet](wiki.html#definition-webmeetagent) attaches that result without reopening it. If Explorer creation succeeds but the room save fails, [WebMeet](wiki.html#definition-webmeetagent) preserves the valid document and returns `scripta_attachment_failed` with `documentCreated: true` and `attached: false`, allowing the user to open the existing document instead of duplicating it.

The generic Delete action in the [Blackboard](wiki.html#definition-blackboard) widget context menu removes only the `scripta-document` widget from that board and clears the board's active-resource mapping. It preserves the room's document reference, the Markdown file, and both Explorer [Automerge](wiki.html#definition-automerge) replicas, so the same document can be opened or projected again later. This widget-only action is not a request for physical document deletion.

Physical deletion is a separate `scripta-document-delete` event. It requires explicit confirmation and uses Explorer's prepare/commit/rollback transaction. [WebMeet](wiki.html#definition-webmeetagent) removes the attachment and widget only after prepare succeeds, commits after the room payload is saved, and restores both room projection and Explorer artifacts on failure. [WebMeet](wiki.html#definition-webmeetagent) never deletes Explorer-owned documents or assets with direct filesystem access.

### Event And Mutation Mapping

`webmeet_blackboard_get` is the projection read path and `webmeet_event_command` is the sole [WebMeet](wiki.html#definition-webmeetagent) mutation path. Direct controls, deterministic `/event` JSON, and multilingual `/robo` instructions all produce the same validated event contract. AI interpretation occurs outside the room lock; the event executor authorizes, serializes, persists, audits, and publishes the accepted mutation.

[WebMeet](wiki.html#definition-webmeetagent) events and Explorer mutations are distinct contracts:

- `scripta-p-variant-reformulate` is a [WebMeet](wiki.html#definition-webmeetagent) intent. AI generates proposed text and [WebMeet](wiki.html#definition-webmeetagent) persists it through Explorer's canonical `p-variant-add` mutation.
- Variant add/edit/delete, vote/vote-withdraw, image insert/replace/delete/layout, chapter add/delete/rename/move, paragraph add/delete/move, and undo map directly to the corresponding Explorer semantic mutation.
- Focus, variant selection, edit start/cancel, and transient draft presentation are room presentation events and do not create Explorer document mutations.

Canonical events omit transport ids, participant ids, revision preconditions, provenance, filesystem paths, and server-generated ids. Upload-backed image insert or replace requires an Explorer-validated asset. The interpreter cannot invent asset ids, workspace URLs, or paths. Every successful or failed mutation updates one event entry visible in Full chat mode.

### Realtime Collaboration

Selecting a variant is shared room presentation state. Starting and cancelling an owner-authorized edit are canonical presentation events. While the owner types, a debounced transient [Blackboard](wiki.html#definition-blackboard) presentation distributes the draft; peers render it read-only. Save sends incremental [Automerge](wiki.html#definition-automerge) changes to Explorer and clears the transient draft.

Document updates are invalidation signals, not serialized viewer projections. Each receiver reloads the authoritative board using its own identity before rendering viewer reactions or owner-only controls. Inline edit queues are keyed by resource, wait for pending pulls, use the heads corresponding to the visible draft, and advance their next heads only after acknowledgement. If Explorer returns `resetRequired`, the client replaces its local public replica before accepting further edits.

The authoritative widget projection is rendered before cached browser replicas synchronize. A successful event applies the returned [Blackboard](wiki.html#definition-blackboard) directly without a redundant read. Normal chat hides event traffic; Full chat interleaves safe semantic commands and participant discussion in timestamp order.

### Guests And Authorization

`webmeet_scripta_workspace_list` is authenticated-only and excludes runtime/dependency trees such as `.data`, `.git`, `.ploinky`, and `node_modules`. Its folder and document limits are independent. The Other picker permits only `.md` paths returned by that tool.

Guests operate only on room-visible resource ids and titles. They may create in the room folder, ask [RoboTeam](wiki.html#definition-roboteam) to open a direct room-folder document by title, and operate on attached documents. They never receive the workspace tree, canonical path, Explorer document id, owner hash, or editor URL. Server-side title resolution is limited to direct Markdown children of the room folder.

Every action binds the supplied [LiveKit](wiki.html#definition-livekit) participant to the admitted room member derived from authenticated room state before projection, ownership checks, or voting. Public projections expose viewer-relative capabilities and the viewer's own reaction, while private ownership and reaction records remain within Explorer's canonical contract.

### Meeting Notes

Meeting Notes uses its own persistent board and Explorer [SCRIPTA](wiki.html#definition-scripta) resource. Background note generation cannot change the visible board's active document. Each revision starts from an Explorer collaboration snapshot, reconciles generated content, and merges the result through Explorer rather than overwriting Markdown. Explorer preserves stable ids, ownership, reactions, images, and concurrent participant changes and returns the new canonical projection.

### Decisions

### Why are Vision and Plan templates instead of document types?

They differ only in generated initial structure. One document format prevents editing, voting, navigation, serialization, and authorization rules from branching by creation history.

### Why do direct controls use the RoboTeam event path?

One event path gives direct controls, deterministic commands, and natural-language requests identical authorization, serialization, audit, and realtime behavior while Explorer remains the sole document mutation authority.

[WebMeet](wiki.html#definition-webmeetagent) provides the board, room, command, guest, and realtime integration around [SCRIPTA](wiki.html#definition-scripta). Explorer's canonical [Automerge](wiki.html#definition-automerge) state governs the document, Markdown remains its portable materialization, and no [WebMeet](wiki.html#definition-webmeetagent) compatibility projection or direct filesystem path competes with that authority.
