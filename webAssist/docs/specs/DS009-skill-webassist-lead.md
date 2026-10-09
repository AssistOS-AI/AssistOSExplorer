---
title: DS009-skill-webassist-lead
summary: Defines the DS009-skill-webassist-lead contract for WebAssist.
---

# DS009-skill-webassist-lead

## Introduction

This specification defines the active DS009-skill-webassist-lead contract for WebAssist.

## Core Content

### DS006 - Skill: webassist-lead

`webassist-lead` creates or updates `leads/<sessionId>-lead.md` inside the active site.

### Trusted Context
- `context.siteDataDir`, `context.siteId` and `context.sessionId` are supplied by the runtime for the effective session. The skill writes only `ku_lead_<context.sessionId>` and ignores any `siteId` or `sessionId` the model writes into the payload; it fails when the context values are missing.

### Required Input
- `profile`
- `mandatoryConditionsSatisfied: true`
- `matchExplanation`
- `contactInfo`
- `summary`

### Guarantees
- Rejects missing contact information.
- Preserves `Created At` on update and refreshes `Updated At`.
- Stores match explanation, contact route, and summary in Markdown sections.

## Conclusion

WebAssist must preserve the responsibilities and boundaries stated by this specification.
