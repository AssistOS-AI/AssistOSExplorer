---
title: DS010-skill-webassist-session
summary: Defines the DS010-skill-webassist-session contract for WebAssist.
---

# DS010-skill-webassist-session

## Introduction

This specification defines the active DS010-skill-webassist-session contract for WebAssist.

## Core Content

### DS007 - Skill: webassist-session

`webassist-session` persists visitor session profile memory for the active site.

### Trusted Context
- `context.siteDataDir`, `context.siteId` and `context.sessionId` are supplied by the runtime for the effective session. The skill writes only `ku_sess_<context.sessionId>` and ignores any `siteId` or `sessionId` the model writes into the payload; it fails when the context values are missing.

### Optional Input
- `profileDetails`
- `contactInformation`

### Guarantees
- Writes only to `$WEBASSIST_DATA_ROOT/sites/<siteId>/.aku/`.
- Does not write legacy session markdown files.
- Uses the runtime `updateSessionProfile` function.
- Does not call the LLM.

## Conclusion

WebAssist must preserve the responsibilities and boundaries stated by this specification.
