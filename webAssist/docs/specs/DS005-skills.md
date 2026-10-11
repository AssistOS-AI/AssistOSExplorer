---
title: DS005-skills
summary: Defines the DS005-skills contract for WebAssist.
---

# DS005-skills

## Introduction

This specification defines the active DS005-skills contract for [WebAssist](wiki.html#definition-webassist).

## Core Content

### DS002 - webAssist Skills and Behavioral Logic

`webAssist` uses only the `webassist-*` skill set. There are no legacy visitor-runtime skill names.

### Skill Catalog
- `webassist-site-context`: reads approved site info, profiles, owner rules, and policy.
- `webassist-session`: creates and updates site-scoped session records.
- `webassist-lead`: creates or updates lead records.

### Orchestration
Visitor turn orchestration is driven by the system prompt (`visitor-flow-system-prompt.mjs`) through the MainAgent instance. No separate orchestration skill is used.

### MCP Tools
- `register-events`: appends site-scoped events (visit, chat-start, message, lead-notification) to `visits/events.md`.

### Runtime Modules
- `load-aku-context` loads site-scoped AKU context before orchestration.
- `update-session` updates session profile KU state and appends session turns as events.
- `akuStore` resolves `$WEBASSIST_DATA_ROOT/sites/<siteId>/.aku`.

### Behavioral Rules
- `siteId` is mandatory and isolates all reads/writes.
- The assistant answers only from approved website information and the current visitor conversation.
- Session state is persisted through `webassist-session` before final response.
- Leads are persisted only through `webassist-lead`.

[WebAssist](wiki.html#definition-webassist) must preserve the responsibilities and boundaries stated by this specification.
