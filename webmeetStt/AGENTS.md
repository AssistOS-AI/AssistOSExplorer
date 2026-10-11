# webmeetStt Agent Guide

## Scope

`webmeetStt` owns the optional self-hosted Faster-Whisper speech-to-text service. It is disabled by default and can be enabled by an administrator through Explorer Marketplace. The text-only Meeting Secretary uses browser SpeechRecognition without an STT fallback and does not depend on this service. It is a Ploinky-managed internal service and must not expose public HTTP routes.

## Mandatory Reading Order

Read the parent `../AGENTS.md`, then `docs/index.html`, `docs/wiki.html`, and `docs/specs/matrix.md`. Read `docs/specs/DS001-coding-style.md` and the relevant contract before changing code or tests.

## Rules

- Keep specifications aligned with the parent documentation rules: exactly `title` and `summary` frontmatter, contiguous numbering, `DS003-main-behavior.md`, and only `Introduction` and `Core Content` as top-level content sections.

- Keep the service internal to the `webmeet` network.
- Store model cache and runtime data under `.data/webmeetStt`.
- Do not log raw audio, transcript text, tokens, or request payloads.
- `AGENTS.md` is this agent's single instruction file for every coding agent; do not add a `CLAUDE.md`.
