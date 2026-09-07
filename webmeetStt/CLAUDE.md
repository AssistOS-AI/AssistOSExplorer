# webmeetStt Agent Guide

## Scope

`webmeetStt` owns the optional self-hosted Faster-Whisper speech-to-text service. It is disabled by default and can be enabled by an administrator through Explorer Marketplace. The text-only Meeting Secretary uses browser SpeechRecognition without an STT fallback and does not depend on this service. It is a Ploinky-managed internal service and must not expose public HTTP routes.

## Rules

- Keep the service internal to the `webmeet` network.
- Store model cache and runtime data under `.data/webmeetStt`.
- Do not log raw audio, transcript text, tokens, or request payloads.
- Update `AGENTS.md` and `CLAUDE.md` together so coding agents receive the same local context.
