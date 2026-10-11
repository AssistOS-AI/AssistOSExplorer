---
title: DS006-document-workflows
summary: Defines Markdown source editing, explicit SOPLang editing, CRDT collaboration, and safe media insertion workflows.
---

# DS006 Document Workflows

## Introduction

[Explorer](wiki.html#definition-explorer) supports ordinary Markdown work and structured document work without forcing every Markdown file into the same user interface.

## Core Content

The default Edit action for a workspace Markdown file must open the [TinyMDE](wiki.html#definition-tinymde)-backed Markdown source editor. On first open, [Explorer](wiki.html#definition-explorer) initializes the document's [Automerge](wiki.html#definition-automerge) state and persists the generated document identity in Markdown before returning the editor payload. Each incremental source edit is anchored to the [Automerge](wiki.html#definition-automerge) heads for the text visible to that editor; [Explorer](wiki.html#definition-explorer) applies the edit on a fork of that historical view and merges the fork into the current state. Save materializes the converged state back to Markdown. Confidential [DPU](wiki.html#definition-dpu) virtual paths continue to use their owning [DPU](wiki.html#definition-dpu) read/write contract instead of workspace [CRDT](wiki.html#definition-crdt) storage. The Advanced edit action may enter the SOPLang-aware workflow when a user needs structured nodes, commands, variables, or references.

Structured document operations must preserve their Markdown persistence contract. Collaborative SCRIPTA operations use the Explorer-owned [Automerge](wiki.html#definition-automerge) [CRDT](wiki.html#definition-crdt) state under the private [Explorer](wiki.html#definition-explorer) workspace data root. The [CRDT](wiki.html#definition-crdt) mutation path covers open, pull, mutate, merge, save, synchronization, and delete behavior; mutations are serialized per document and the resulting state is materialized back to Markdown. A caller must not bypass that path by writing structured document content directly. Stable SCRIPTA identity, metadata, variants, voting, ownership, undo, public collaboration, security, and lifecycle are defined by [DS011 SCRIPTA Core](specsLoader.html?spec=DS011-scripta-core.md).

The Markdown [CRDT](wiki.html#definition-crdt) is the collaboration mechanism for workspace Markdown source editing and structured SCRIPTA operations. Its private state is stored under `.data/explorer/automerge/documents/<document-id>.automerge`; the Markdown path is not the document identity. Office co-editing uses OnlyOffice's separate collaboration transport and signed callback persistence. Public SCRIPTA replicas must expose only the sanitized collaboration model and must not leak author-only or reaction-private metadata.

Media attached through workspace workflows must preserve the validation and storage rules of the owning media service. Document insertion must reference an approved stored media item through the established server-side document mutation path.

[Explorer](wiki.html#definition-explorer) provides simple Markdown editing by default and explicit structured collaboration when the document requires it.
