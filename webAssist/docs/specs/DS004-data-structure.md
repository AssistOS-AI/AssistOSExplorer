---
title: DS004-data-structure
summary: Defines the DS004-data-structure contract for WebAssist.
---

# DS004-data-structure

## Introduction

This specification defines the active DS004-data-structure contract for WebAssist.

## Core Content

### DS001 - webAssist Data Structure and Session Management

`webAssist` stores all operational data under a site-scoped data root. There is no single-site storage contract.

### Data Root
- Required root: `path.resolve(process.env.WEBASSIST_DATA_ROOT)`.
- No CLI/MCP override exists.
- The manifest declares persistent storage key `webAssist` at `/workspace/webassist-data` and injects `WEBASSIST_DATA_ROOT={{STORAGE_CONTAINER_PATH}}/data`; the host sandbox translation is `.data/webAssist/data`.
- Chat startup and standalone event/session writers require the managed persistent root to pre-exist as a non-symlink directory, create only its `data` child, and canonically revalidate the child beneath that root. They reject symlinked roots or children and do not fall back to or migrate the retired workspace-level `webassist-data` directory.
- Read-only site listing and session history return empty results when the application-owned `data` child is absent, without creating it or requiring an earlier chat call. The managed persistent parent is still required and validated; symlinks are errors rather than empty results.
- Creating the data child does not provision a site AKU. Standalone event/session writers retain the explicit uninitialized-site error until that site has been provisioned.
- Site root: `$WEBASSIST_DATA_ROOT/sites/<siteId>/`.
- `siteId` is required for every runtime, CLI, MCP, and embedded chat operation.

### Session Ownership
- Session ids match `^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`; any other caller-supplied id is rejected with the public error `Invalid sessionId.`. New ids are `session-<compact ISO timestamp>-<32 hex characters>` (16 random bytes).
- Every chat session created through MCP has an owner record at `$WEBASSIST_DATA_ROOT/sites/<siteId>/session-owners/<sessionId>.json`, written before inference with exclusive create (`wx`, first writer wins) and mode `0600`. The `session-owners` directory is created when needed and must be a non-symlink directory. Owner records are written only for a site whose AKU is initialized.
- Record content (schema 2): `{"schema":2,"kind":"guest"|"user","id":"<verified actor id>","secretHash":"<64 lowercase hex>","createdAt":"<ISO timestamp>"}`. The record is a separate file because AKU manifests do not keep nested metadata.
- `sessionSecret` is 32 random bytes encoded as base64url (43 characters). It is returned once, in the `web_cli_chat` response that creates the session, and is never stored in plaintext. `secretHash` is the lowercase hex SHA-256 of the UTF-8 bytes of the `sessionSecret` text exactly as presented (the base64url string, not the decoded bytes).
- Owner records are read without following symlinks. A missing, unreadable (`EACCES`, `ELOOP`, any read error), symlinked, malformed, or non-schema-2 record means the session has no owner; reading creates nothing.
- A session may be continued in chat, and its history read, only when the verified caller's `kind` and `id` equal the owner record's, or when the caller presents a `sessionSecret` whose SHA-256 digest equals `secretHash` (constant-time comparison of digests). A wrong, malformed, oversized, or absent secret is treated exactly like no secret. A verified admin may read any history but never continues another principal's chat session.
- Sessions without an owner record (created before ownership existed, or by the interactive CLI) fail closed: only an admin can read their history, and a chat that names one starts a new owned session. A caller-supplied id is never claimed: every chat that cannot continue the named session creates a new id, owner record and secret.

### Site Folders
- `config/owner.md`: owner contact rules and routes that may be disclosed after lead creation.
- `config/policy.md`: visitor notice, retention settings, lead statuses, and disclosure policy.
- `info/`: approved website, organization, service, project, and opportunity information.
- `profiles/`: target visitor profile files.
- `sessions/`: active visitor records, two files per session:
  - `<sessionId>-profile.md` — profile details and contact information.
  - `<sessionId>-history.md` — full user/agent conversation transcript.
- `leads/`: active lead records, one `<sessionId>-lead.md` file per qualified visitor.
- `visits/`: visit, chat, match, and lead event records used for statistics.
- `archive/sessions/` and `archive/leads/`: archived records excluding from active operations.
- `.aku/`: site-specific Agentic Knowledge Units memory.

### Session Profile File
Each session profile uses `sessions/<sessionId>-profile.md`.

Required sections:
- `Profile Details`
- `Contact Information`

This file is written by `webassist-session` skill and read by `loadContext` for session state.

### Session History File
Each session history uses `sessions/<sessionId>-history.md`.

Required sections:
- `History`

This file is appended automatically by the runtime after each visitor turn. It is not modified by `webassist-session`.

### Lead File
Each lead uses `leads/<sessionId>-lead.md`.

Required sections:
- `Lead Info`
- `Match Explanation`
- `Contact Info`
- `Summary`

Lead creation requires target profile match, mandatory conditions, and explicit contact information.

## Conclusion

WebAssist must preserve the responsibilities and boundaries stated by this specification.
