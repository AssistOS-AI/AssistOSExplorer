---
title: DS004-editor-and-callback-contract
summary: Defines JWT, forwarding, callback, download, and session recovery constraints for OnlyOffice.
---

# DS004 Editor And Callback Contract

## Introduction

The editor and callback routes carry short-lived, session-bound data between [DocumentServer](wiki.html#definition-documentserver) and the OnlyOffice agent.

## Core Content

Configuration [JSON Web Tokens](wiki.html#definition-jwt) must have a positive integer lifetime no greater than 300 seconds and must enter DocumentServer as the single signed top-level body token with boolean in-body validation enabled. Callback delivery must authenticate its own string token first and may use only verified claims; unsigned duplicates must match verified non-temporal claims recursively and exactly.

Session state must not contain delegation bearers. After recreation, a fresh authenticated Confidential control request may reauthorize only an unexpired session that DocumentServer previously loaded and that exactly matches the non-empty authenticated user identity, canonical browser authority, stable storage path and object identity, file type, and permissions. Issued but unused configurations and every identity, authority, storage, or permission mismatch must remain inactive. Reauthorization keeps the fresh delegation in memory only and must not extend the session's existing absolute expiry. Missing or duplicate per-session document keys, invalid topology, invalid signing, invalid forwarding metadata, callback body overflow, storage failure, and listener ownership drift must fail closed. A token from another session must not authorize an opaque callback URL for the same document.

Authenticated status 4 callbacks durably record closure without document changes. Status 1 starts a new editing cycle and clears prior closure and drain receipts. These transitions require the same signed body, exact per-session document key, and live session validation as save callbacks; unsigned, mismatched, or expired events cannot alter drain decisions. Native drain receipts remain separate from callback acknowledgements and contain no delegation bearer.

Confidential paths must use the Router-minted [dpuConfidential delegation](wiki.html#definition-confidential-delegation) with the declared DPU tools and scopes. Workspace paths must use the configured workspace storage policy. [DocumentServer auto-assembly](wiki.html#definition-auto-assembly) remains controlled by the manifest environment variables and does not bypass session or storage validation.

Public editor assets include only validated `/dictionaries/<language>/<name>.dic` and `.aff` requests for spellcheck; mutation methods, directory listings, other extensions, and traversal remain denied. Signed `editorConfig.customization.plugins` is false because this integration does not provide third-party editor plugins or their independent inference providers.

## Conclusion

Short-lived body-bound JWTs, exact forwarding validation, and delegated storage keep the editor transport from becoming a general credential or filesystem proxy.
