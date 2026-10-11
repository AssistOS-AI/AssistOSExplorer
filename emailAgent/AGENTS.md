# emailAgent Agent Guide

## Scope

emailAgent sends transactional email through Mailjet (auth codes for UserPersisto, password-reset messages, and text/template emails for other agents) and exposes an admin-only settings plugin to Explorer. It must never log raw auth codes.

## Mandatory Reading Order

1. Read `../AGENTS.md` for workspace-wide rules, coding style, module structure, and test-organization rules.
2. Read `manifest.json` and `mcp-config.json` for the runtime contract and the declared MCP tools.
3. Read the relevant `lib/`, `tools/`, and `tests/` files before changing behavior.
4. Read `tools/invocation-context.mjs` and `tests/tool-authorization.test.mjs` before touching caller authorization (admin versus agent callers).
5. Read `lib/settings.mjs` and `tests/settings.test.mjs` before touching stored Mailjet settings or secret handling.

## Current Skill Catalog

- No local skill catalog is declared for this agent.

## Repository Rules

- This agent currently has no local `docs/` tree; if you change behavior, interfaces, or runtime configuration, say so in your report and do not invent documentation paths.
- All documentation, specifications, and code comments must be written in English.
- Never log or return raw secrets or auth codes; settings are stored encrypted and returned masked.
- Never add AI/coding-agent attribution to commits, release notes, changelogs, generated metadata, comments, or documentation.
- `AGENTS.md` is this agent's single instruction file for every coding agent; do not add a `CLAUDE.md`.

## Runtime Defaults

Uses `docker.io/assistos/ploinky-node@sha256:accd925fcbf460c1f4c7a5cd9e2d46539c615bbfad2e896cabb7556d8050a669` with MCP readiness. `manifest.json` declares no `agent`, `cli`, or `start` command, so Ploinky runs its default AgentServer (`sh /Agent/server/AgentServer.sh`) serving the `mcp-config.json` tools. Tools run `sh tools/email_tool.sh` from `/code`. Persistent data is mounted from `.data/emailAgent` to `/data`. The default profile generates `EMAILAGENT_SETTINGS_KEY` and optionally reads `EMAILAGENT_SETTINGS_FILE` (default `/data/settings.enc.json`).

## Key Paths

- `manifest.json`
- `mcp-config.json`
- `tools/email_tool.mjs`
- `tools/invocation-context.mjs`
- `lib/`
- `IDE-plugins/email-agent-settings/`
- `tests/`

## Validation

Run the narrowest relevant check after edits, then broaden when touching shared behavior:

- `npm test` (runs `node --test tests/*.test.mjs`)
