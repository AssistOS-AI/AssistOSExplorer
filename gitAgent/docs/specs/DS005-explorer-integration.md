---
title: DS005-explorer-integration
summary: Defines the gitAgent contract covered by DS005-explorer-integration.
---

# DS005-explorer-integration

## Introduction

This specification defines the active contract for gitAgent.

## Core Content

### DS04 - Explorer Integration and IDE Plugin Channel

### Role of This Document

This document defines integration rules for Explorer-facing usage of `gitAgent` and IDE plugin behavior.

### Integration Position

Explorer is the user interface (UI) host. `gitAgent` is the backend Git intermediary. IDE plugin artifacts in `gitAgent/IDE-plugins/` are the UI extension channel that connects Explorer interactions to Model Context Protocol (MCP) tool calls.

### Integration Requirements

Requirement U1: Explorer-facing UI components shall call `gitAgent` through MCP application programming interfaces (APIs).

Requirement U2: Git operation decisions and execution shall remain in the agent backend, not in UI presenters.

Requirement U3: toolbar plugin integration in slot `file-exp:toolbar` shall remain documented and operational.

Requirement U4: plugin dependency components shall remain declarative through plugin configuration.

Requirement U5: asynchronous operation outcomes shall remain representable in UI state through MCP success and failure payloads.

Requirement U6: Explorer selection shall be the source of truth for Git action targeting. Selecting any file or folder inside a repository shall also select that repository for repository-level actions.

Requirement U7: repository-level pull actions may execute for a selected repository, but commit and push actions shall remain restricted to the selected files within each selected repository.

Requirement U8: autosync/autocommit scheduling shall target only repositories explicitly chosen in autosync settings and shall not infer targets from transient tree selection.

Requirement U9: when an autosync push is explicitly rejected as non-fast-forward, the plugin shall synchronize the selected repository and retry the push at most once. It shall never force-push and shall stop when synchronization conflicts or the bounded retry fails.

Requirement U10: repository status shall distinguish an active merge from unresolved conflict entries and expose Git's prepared merge message. Once all merge conflicts are resolved and staged, the Git panel shall pre-fill that message for an editable manual Commit or Commit & Push; Sync and AutoSync shall complete the merge with the prepared message before attempting another pull or push.

Requirement U11: the Git toolbar shall open `git-panel` as a reactive component in Explorer's shared expanded modal, initially fullscreen. The shell exclusively owns resizing, fullscreen, Escape and close controls. The panel receives typed repository and conflict-selection properties, releases listeners and polling on removal, and notifies toolbar state refresh. Branch, stash and credential dialogs remain secondary interactions above the panel. No standalone Git window component or compatibility alias is provided.

### Constraints

Constraint Q1: UI components are not allowed to bypass agent contracts and execute shell Git directly.

Constraint Q2: host UI refactors are not allowed to alter backend contract semantics.

Constraint Q3: plugin metadata changes are not allowed to break the declared integration slot without coordinated contract updates.

Constraint Q4: UI flows for identity, credentials, and pending Git retries are not allowed to infer a repository by taking the first discovered repository from overview data when no explicit selection exists.

### Invariants

Invariant I1: communication between Explorer and Git backend remains MCP-based.

Invariant I2: IDE plugin channel remains an integration surface, while tool contracts remain the operational source of truth.

Invariant I3: the intermediary role of `gitAgent` between Explorer intent and Git runtime remains unchanged.

Invariant I4: manual selection state and autosync repository configuration remain separate sources of truth; one cannot silently substitute for the other.

Invariant I5: autosync preserves remote history by integrating a concurrent remote update before its single push retry.

Invariant I6: clearing the conflicted-file list does not by itself mark a merge as complete; completion requires the merge commit that removes Git's active merge state.

### Validation Criteria

Validation is satisfied when Explorer-triggered plugin actions call `gitAgent` tools successfully, tool outcomes map to UI state transitions, repository targeting follows explicit selection rules, autosync runs only for explicitly configured repositories, non-fast-forward recovery remains bounded to one synchronize-and-push retry without force, and Git execution behavior remains isolated from frontend internals.

Shared expanded panels serialize ownership across pending and visible launches. Reopening the same target retains its close promise and forwards updated properties; Git applies these through `updateModalProps` without recreating its panel or clearing drafts. Superseded launches are cancelled before display. Fullscreen restore preserves the previous dimensions within the viewport. Help delegates all window controls to the shared shell.

Closing an expanded panel aborts its owned startup requests, polling and waits, removes iframe content, and prevents delayed registration from mounting content. Shared module imports and server operations already accepted are not rolled back; their late results must not continue the closed panel initialization.

The modal owns cleanup directly: closing marks it closed, aborts HTTP probes, clears its retry and readiness timers, and removes hosted content. Component loading uses normal awaits followed by closed checks. Each presenter releases its own resources in `afterUnload`; no generic promise cancellation wrapper is used.

## Conclusion

gitAgent must preserve the responsibilities, boundaries, and observable results stated in this specification.
