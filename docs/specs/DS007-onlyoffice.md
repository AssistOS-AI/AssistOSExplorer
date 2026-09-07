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

Explorer must request an OnlyOffice session only for supported Office document types and must invalidate a cached session when the selected file changes. Explorer must not construct DocumentServer credentials, impersonate a callback, or treat a stale editor URL as reusable.

The onlyOffice agent must own session construction, signed editor transport, callback validation, and its persisted session metadata. Explorer must preserve the DPU authorization boundary before requesting a session for a DPU-backed document.

Secrets and other non-file DPU resources must remain outside the OnlyOffice flow.

## Conclusion

OnlyOffice integration provides Office editing without moving session security or protected storage behavior into Explorer.
