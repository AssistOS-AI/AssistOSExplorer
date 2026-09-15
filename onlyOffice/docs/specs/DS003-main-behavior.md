---
title: DS003-main-behavior
summary: Defines the essential OnlyOffice session, editor transport, and persistence behavior.
---

# DS003 Main Behavior

## Introduction

[OnlyOffice](wiki.html#definition-onlyoffice) lets an authenticated Explorer user open, edit, and save an Office document through a generation-bound editor session.

## Core Content

### Main Behavior Components

| Name | Explanation |
| --- | --- |
| Authenticated document sessions | Control requests create a per-session document key and short-lived tokenized editor configuration. |
| Validated editor transport | The public editor route accepts only the Router-installed forwarding tuple and sanitized session traffic. |
| Storage and callback persistence | Callbacks persist to workspace or delegated Confidential storage; loaded Confidential sessions can recover through fresh authenticated control after a controlled restart. |

### Authenticated document sessions

The affected actor is an authenticated Explorer user opening an Office document. The control route resolves the document path, creates per-session state, selects workspace or [DPU](wiki.html#definition-dpu) Confidential storage, and returns a short-lived [JWT](wiki.html#definition-jwt)-protected editor configuration. Session state records when DocumentServer first requests the source document so controlled drain can distinguish a loaded editor from an issued but unused configuration. After recreation, fresh authenticated control may restore the in-memory delegation only for an unexpired loaded session bound to the same user, browser authority, document identity, and permissions. The observable result is an editor session whose opaque callback URL and document key cannot be reused from another session.

### Validated editor transport

The affected actor is the browser-hosted [DocumentServer](wiki.html#definition-documentserver) editor. The public proxy validates the exact [Router forwarding tuple](wiki.html#definition-forwarding-tuple) before proxying. It strips browser Authorization, cookies, and unrelated credentials and fails closed on malformed, duplicated, missing, unexpected, or caller-supplied forwarding fields.

### Storage and callback persistence

The affected actor is DocumentServer returning a callback or download request. The agent authenticates the session's own token, validates signed claims and body size, and persists through workspace storage or an expiring [Confidential persistence delegation](wiki.html#definition-confidential-delegation). Agent-owned DocumentServer logs, data, and library state are mounted from `.data/onlyOffice/log`, `.data/onlyOffice/data`, and `.data/onlyOffice/lib`; session metadata is stored at `/root/state/onlyoffice-sessions-v5.json` inside the persistent agent workdir. Runtime v5 does not read, migrate, or delete retired OnlyOffice data under `.ploinky`. During a controlled restart it drains and persists active sessions, then lets DocumentServer send its terminal shutdown notification and close editor sockets before process teardown. This prevents the old editor transport from reconnecting into a retired generation. Failure to deliver the graceful disconnect within its bounded drain budget leaves callback storage and DocumentServer alive. The editor reopens only after a new [topology generation](wiki.html#definition-topology-generation) is ready. Persisted state contains no delegation bearer, and unused or identity-mismatched sessions remain inactive after recreation. The governing boundary is that Explorer-owned files and DPU Confidential objects are never replaced by direct recursive host access.

## Conclusion

OnlyOffice succeeds when users receive a valid editor session, the public transport remains narrowly trusted, and document changes reach the correct storage owner.
