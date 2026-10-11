# webmeetScribeAgent Agent Guide

## Scope

`webmeetScribeAgent` owns the text-only LiveKit Meeting Secretary worker, encrypted temporary transcript journals, cumulative meeting-note analysis, and internal calls to `webmeetAgent`.

## Mandatory Reading Order

Read the parent `../AGENTS.md`, then `docs/index.html`, `docs/wiki.html`, and `docs/specs/matrix.md`. Read `docs/specs/DS001-coding-style.md` and the relevant contract before changing code or tests.

## Rules

- Keep specifications aligned with the parent documentation rules: exactly `title` and `summary` frontmatter, contiguous numbering, `DS003-main-behavior.md`, and only `Introduction` and `Core Content` as top-level content sections.

- Never subscribe to, persist, or log LiveKit audio.
- Accept only final, participant-addressed transcript packets from admitted LiveKit participants.
- Keep journals encrypted under `/data/sessions`; purge them after the documented recovery window.
- Notes analysis is holistic: the complete cumulative journal and current document are inputs to every revision.
- `webmeetAgent` remains authoritative for rooms, participants, Blackboard, and SCRIPTA persistence.
- `AGENTS.md` is this agent's single instruction file for every coding agent; do not add a `CLAUDE.md`.
