---
title: DS007-onlyoffice
summary: Defines the Explorer and onlyOffice boundary for Office document sessions and protected callbacks.
---

# DS007 OnlyOffice

## Introduction

Explorer presents compatible Office documents while the onlyOffice agent owns the editor-session and callback lifecycle.

## Core Content

When enabling OnlyOffice in Marketplace, the administrator must select `global` runtime mode so the editor can access workspace files.

The `onlyOffice` agent must be disabled by default. An administrator may enable it from Marketplace, and Explorer retains its built-in Office preview integration. When runtime status verifies that the agent is disabled, Explorer must explain that Office editing requires Marketplace enablement instead of waiting for startup or repeatedly requesting an editor session. The loader must provide Retry so the user can resume opening the document after an administrator enables the agent.

Explorer must request an OnlyOffice session only for supported Office document types and must invalidate a cached session when the selected file changes. Explorer must not construct DocumentServer credentials, impersonate a callback, or treat a stale editor URL as reusable. Only a mounted active editor may retain its configuration; matching file metadata and an unexpired token do not authorize remounting a closed document key. Native disconnection, backup-copy, and session-expiry warnings retire the current editor generation, preserve caller warning handlers, and cannot invalidate a newer render. Reopening must request a fresh authenticated session and support further durable edits.

The onlyOffice agent must own session construction, signed editor transport, callback validation, and its persisted session metadata. Explorer must preserve the DPU authorization boundary before requesting a session for a DPU-backed document.

Secrets and other non-file DPU resources must remain outside the OnlyOffice flow.

The editor transport admits only dictionary `.dic` and `.aff` files beneath validated language directories, in addition to its existing asset allowlist. Signed editor configuration disables third-party plugins, and the managed DocumentServer process disables its background plugin updater; the Office integration has no external AI-plugin feature. Explorer loads the native editor's immutable versioned status-icon asset while its route is active so the disconnect dialog remains complete during a targeted restart. Each mount snapshots its configuration before script loading can yield, keeping document identity, transport URL, and event handlers consistent when presenter state changes. Concurrent renders await the same preload; failed or superseded preloads cannot mark an editor ready or damage a newer session.

## Conclusion

OnlyOffice integration provides Office editing without moving session security or protected storage behavior into Explorer.
