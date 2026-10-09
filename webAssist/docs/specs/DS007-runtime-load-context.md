---
title: DS007-runtime-load-context
summary: Defines the DS007-runtime-load-context contract for WebAssist.
---

# DS007-runtime-load-context

## Introduction

This specification defines the active DS007-runtime-load-context contract for WebAssist.

## Core Content

### DS004 - Runtime Module: load-aku-context

`loadAkuContext({ siteId, sessionId, message })` loads AKU-backed runtime context.

### Inputs
- `siteId` (required)
- `sessionId` (required)
- `message` (used by AKU search input)

### Reads
- `$WEBASSIST_DATA_ROOT/sites/<siteId>/.aku/` runtime context, including:
  - site KU and available profile documents,
  - session KU state metadata,
  - session turn history events,
  - lead KU state.

### Output
Returns:
- `sessionProfile` (contact data and profile details),
- `sessionProfileText`,
- `conversationHistoryText`,
- `currentLead`,
- `akuContextText`.

If AKU is missing, returns a valid “new session” scaffold and no-site-context payload.

### Visitor isolation
Site-wide search results are filtered before any KU state is loaded, before the prompt context is built, and before the `aku-search` debug capture. Every result whose `ku_id` starts with `ku_sess_` or `ku_lead_`, or whose `ku_type` is `session-profile` or `lead`, is dropped unless its `ku_id` is the caller's own `ku_sess_<sessionId>` or `ku_lead_<sessionId>`. Other KU types are unchanged.

## Conclusion

WebAssist must preserve the responsibilities and boundaries stated by this specification.
