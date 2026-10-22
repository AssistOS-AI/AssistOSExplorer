---
title: DS011-scripta-core
summary: Defines Explorer-owned SCRIPTA identity, Markdown metadata, Automerge state, variants, voting, ownership, undo, public collaboration, security, and lifecycle.
---

# DS011 SCRIPTA Core

## Introduction

SCRIPTA is [Explorer](wiki.html#definition-explorer)'s structured collaboration model for Markdown documents. [Explorer](wiki.html#definition-explorer) is the sole document authority. During editing, the canonical [Automerge](wiki.html#definition-automerge) document is the working state and Markdown is its durable, portable materialization. WebMeet, Advanced Editor, and other consumers use [Explorer](wiki.html#definition-explorer)'s semantic or collaboration APIs; they do not parse, overwrite, or independently reconcile SCRIPTA Markdown.

This specification defines the Explorer-owned core. WebMeet board placement, room attachment, guest interaction, RoboTeam event mapping, Meeting Notes, and realtime presentation are integration concerns defined by WebMeet DS009 in the `webmeet` repository.

## Core Content

### Identity And Storage

Each document, chapter, paragraph, variant, and variant image has a stable identifier. The document id comes from AssistOS Markdown metadata and remains the identity after rename or move; a filesystem path is only the current location. When a Markdown document has no document id, [Explorer](wiki.html#definition-explorer) generates one and persists it in Markdown during the same first initialization before returning a usable editor or SCRIPTA projection.

[Explorer](wiki.html#definition-explorer) stores canonical binary state at `.data/explorer/automerge/documents/<document-id>.automerge`. SCRIPTA's path-free, sanitized browser replica is stored separately at `.data/explorer/automerge/scripta-collaboration/<document-id>.automerge`. No `.automerge` sidecar is created beside the Markdown file. The canonical state contains the complete private model; the collaboration replica contains only the fields admitted by the public collaboration contract.

### Canonical Markdown Format

Markdown remains readable without SCRIPTA. The active variant is the visible paragraph text. Stable identity and plugin state are JSON values in the existing `achilles-ide-document`, `achilles-ide-chapter`, and `achilles-ide-paragraph` HTML comments. SCRIPTA does not use a separate YAML `<!-- scripta: ... -->` block.

A normative excerpt has this shape; generated ids and timestamps are illustrative:

```markdown
<!-- {"achilles-ide-document":{"id":"document-1","title":"Project Plan"}} -->
<!-- {"achilles-ide-chapter":{"id":"chapter-1","title":"Scope","anchorId":"chapter-chapter-1"}} -->
<a id="chapter-chapter-1"></a>
## Scope

<!-- {"achilles-ide-paragraph":{"id":"paragraph-1","pluginState":{"scripta":{"activeVariantId":"variant-2","variants":[{"id":"variant-1","text":"First formulation.","images":[],"createdBy":"owner-hash-1","createdAt":"2026-08-27T09:00:00.000Z","updatedAt":"2026-08-27T09:00:00.000Z"},{"id":"variant-2","text":"The selected formulation is visible as ordinary Markdown.","images":[],"createdBy":"owner-hash-2","createdAt":"2026-08-27T09:01:00.000Z","updatedAt":"2026-08-27T09:01:00.000Z"}],"reactionsByVariant":{"variant-2":{"participant-hash":{"type":"like","userHash":"participant-hash","userLabel":"Participant","reactedAt":"2026-08-27T09:02:00.000Z"}}}}}}} -->

The selected formulation is visible as ordinary Markdown.
```

The canonical state is `achilles-ide-paragraph.pluginState.scripta`, represented in the parsed model as both `paragraph.pluginState.scripta` and `paragraph.metadata.pluginState.scripta`. It contains `activeVariantId`, ordered `variants`, and `reactionsByVariant`. Each variant contains its stable id, clean text, ordered images, owner hash, and creation/update timestamps. The serializer writes the winning variant, including its image Markdown, into the visible paragraph and retains inactive variants, reactions, ownership, and stable ids in the metadata comment. User text is stored as text, never pre-escaped HTML; browser rendering must assign it as text or pass it through the approved sanitizer and must never interpret metadata as executable markup.

### Variants, Ownership, And Voting

Every SCRIPTA paragraph has at least one variant. The participant who creates a variant owns it and is the only participant allowed to edit or delete its text and images. The final remaining variant cannot be deleted. Owner hashes are private authorization data and are never accepted from a browser as proof of identity.

An admitted participant has at most one reaction across all variants of one paragraph. Applying the same reaction to the same variant toggles it off. Applying a reaction to another variant first removes the participant's previous reaction. Supported reactions are `like` and `dislike`.

The active variant is selected deterministically by these rules, in order:

1. Higher score, where `score = likes - dislikes`.
2. More likes.
3. Fewer dislikes.
4. Earlier `createdAt`.
5. Earlier position in the ordered variant list.

After every variant or reaction mutation, [Explorer](wiki.html#definition-explorer) recomputes `activeVariantId` and materializes the winning variant as the paragraph's visible Markdown text.

### Mutations And Collaboration

Canonical semantic mutations are variant add/edit/delete, vote/vote-withdraw, variant image insert/replace/delete/layout, chapter add/delete/rename/move, paragraph add/delete/move, and undo. AI reformulation is not a persistence mutation: an integration may generate proposed text, but it persists the result through variant add. Focus, selection, edit-start, edit-cancel, and transient draft presentation do not modify the document model.

The public browser replica accepts incremental text changes only for the selected variant edit. [Explorer](wiki.html#definition-explorer) validates that the submitted [Automerge](wiki.html#definition-automerge) changes alter no other public field before merging them into canonical state. Structural operations, voting, ownership-sensitive changes, and media changes always use semantic mutations. Pull is based on `knownHeads`; apply includes the `baseHeads` from which the browser changes were created. If the requested heads are unavailable, [Explorer](wiki.html#definition-explorer) returns `resetRequired` with a replacement state. One request accepts at most 128 changes and 2 MiB of encoded change data.

Markdown proposals based on a collaboration snapshot use a fresh [Automerge](wiki.html#definition-automerge) actor for each writable fork. A document-wide actor must not be reused on historical snapshots: different proposals and delayed retries can otherwise create different changes with the same actor sequence. [Explorer](wiki.html#definition-explorer) validates the snapshot's document identity and heads before accepting a proposal, then merges it with the current public state under the document lock so concurrent edits survive.

For proposals with an explicit base snapshot, [Explorer](wiki.html#definition-explorer) computes a retry identifier from the document identity, sorted base heads, trimmed Markdown, and authenticated participant identity. Accepted identifiers are stored in the private canonical `scriptaMarkdownProposals` map in the same transaction as the model, Markdown, and public replica. They are not browser-supplied receipts, public replica fields, Markdown metadata, or undo snapshots. A failed commit rolls back its receipt; a successful retry returns the current state without another revision or undo entry, including after restart, later edits, or undo. Submitting the same text from new base heads is a new proposal. Receipts remain for the lifetime of the canonical document, matching the retained collaboration history; existing documents without receipts remain readable. The committed public replica reflects the saved canonical model before the response is returned.

Receipt storage and its compaction copy cost grow with the number of accepted snapshot proposals: each adds one 64-character SHA256 key and a Boolean value. Receipts must not be capped while their historical base heads remain admissible. Physical document deletion removes them with canonical state; any future earlier retirement must atomically retire the corresponding public history and reject its old snapshots. Public change actors or messages alone cannot prove acceptance because browser replicas can supply those values. Snapshots accepted before receipt tracking was introduced have no retrospective retry guarantee; integrations must refresh their base after upgrading before resubmitting such proposals.

### Undo

Undo history is private, document-scoped, and bounded to the five most recent accepted SCRIPTA model changes. Every accepted semantic mutation and accepted collaboration edit or Markdown collaboration merge that changes the model pushes the complete pre-change model and the digest of the resulting model. Presentation-only operations do not enter history.

Undo applies only to the newest history entry. [Explorer](wiki.html#definition-explorer) compares the current model digest with that entry's recorded post-change digest, computed from the materialized model including its rebuilt structural blocks. If they differ because another change was accepted after the target operation, undo fails with `scripta_undo_conflict`; it never overwrites the newer state. A successful undo removes that history entry, commits the restored canonical model, rematerializes Markdown, updates the safe projection, and causes browser replicas to pull the new heads or reset when their heads are no longer available. Undo does not erase accepted proposal receipts, so a delayed retry cannot reapply an undone proposal.

### Public Projection And Security

The canonical Markdown and canonical [Automerge](wiki.html#definition-automerge) state contain ownership and reaction records. They are private workspace data, not encrypted fields inside the Markdown file. The sanitized collaboration replica removes `variant.createdBy` and `reactionsByVariant`. Viewer projections may expose only derived values such as counts, the current viewer's reaction, `canEdit`, and `canDelete`.

[Explorer](wiki.html#definition-explorer) validates workspace paths, stable document identity, operation schemas, participant identity supplied by the authenticated caller, ownership, and resource lifecycle. Guest-facing integrations receive path-free resource identifiers and projections. SCRIPTA text and metadata are data: HTML, event attributes, URLs, and scripts embedded in titles, paragraphs, variants, labels, or metadata must not execute in preview, Blackboard, or editor surfaces.

### Lifecycle And External Changes

Create and first open initialize canonical [Automerge](wiki.html#definition-automerge) state and materialize stable metadata atomically. Rename and move preserve the document id and therefore reuse the same canonical state. Save serializes the current canonical state to Markdown. A changed workspace Markdown file is reparsed and imported through [Explorer](wiki.html#definition-explorer) synchronization; direct file content never becomes a competing authority while a canonical state exists.

Physical deletion is transactional across Markdown, canonical [Automerge](wiki.html#definition-automerge) state, and the sanitized collaboration replica. Prepare stages every owned artifact, commit removes the stage after the attaching integration has persisted its detach, and rollback restores it. [Explorer](wiki.html#definition-explorer) serializes lifecycle operations with a document lock and recovers expired pending deletions conservatively.

Deletion stages live only under `.data/explorer/automerge/documents/pending-deletions/<transaction-id>`. Every phase, including recovery after an earlier successful initialization, revalidates the private directory chain, transaction metadata, staged files, and related private artifacts before accessing them. Symbolic links are rejected with `PLOINKY_AGENT_DATA_POLICY_VIOLATION`. Preparation preflights all artifact paths before moving originals; rollback preflights staged files and destinations before restoring anything. If preparation fails and restoration cannot complete safely, the remaining staged originals are retained rather than deleted.

SCRIPTA remains portable because the visible winner and complete structured metadata are materialized in Markdown, while safe concurrent editing is governed by one Explorer-owned [Automerge](wiki.html#definition-automerge) authority and one explicit semantic contract.

Advanced Editor variant images use the existing authenticated workspace Markdown upload flow: PNG, JPEG, WebP or GIF up to 20 MB is stored in the document’s sibling `<stem>.assets/` directory. The owner-only adapter persists image identity, text position and layout through the document presenter’s CRDT paragraph update. The shared normalizer accepts these safe workspace asset paths as well as validated WebMeet assets and rejects traversal, private folders and remote URLs. WebMeet retains its server-side room asset validation. Image controls must have working insert, replace, delete and layout handlers, preserve drafts when file selection is cancelled, and block duplicate mutations until completion.
