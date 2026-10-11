# webmeetAgent Agent Guide

## Scope

webmeetAgent owns WebMeet rooms, LiveKit token issuance, AI dispatch metadata, room resources, the WebMeet IDE plugin, and room-scoped public link authorization.

## Mandatory Reading Order

1. Read the nearest parent `AGENTS.md` for workspace-wide rules.
2. Read `docs/index.html` for the local documentation entry point.
3. Read `docs/specs/DS000-vision.md` for the local WebMeet ownership model.
4. Read `docs/specs/matrix.md` and the relevant local DS files before changing behavior.
5. Read `docs/specs/DS007-ploinky-runtime-invariants.md` before touching auth, routing, guest access, MCP, Router HTTP paths, files, logs, or runtime configuration.
6. Read `docs/specs/DS001-coding-style.md` for coding style, module structure, and test-organization rules when that file exists; otherwise inherit the parent repository coding-style authority.

## Current Skill Catalog

- skills/blackboard-event
- skills/scripta-content

## Repository Rules

- Specifications use only `title` and `summary` frontmatter, with `title` equal to the filename stem. Keep DS numbering contiguous, reserve `DS003-main-behavior.md` for the principal product behaviors, and use `Introduction` and `Core Content` without a `Conclusion` section. Keep paragraphs unwrapped and update `docs/specs/matrix.md` with the specification set.

- The DS specifications are the source of truth for local contracts and invariants.
- When source code changes behavior, interfaces, architecture, workflows, security boundaries, or runtime configuration, update both the HTML documentation and the DS specifications.
- Keep DS numbering gap-free within each specification set. Preserve existing local numbering conventions unless a migration updates all links in the same change.
- All documentation, specifications, and code comments must be written in English.
- Do not add imported-skill DS files or skill pages to a downstream host project's docs tree.
- Keep Ploinky runtime invariants in local context: router-mediated entry, secure-wire invocation JWTs, scoped public room mode, generic MCP calls, workspace-confined paths, and redacted logs.
- Never add AI/coding-agent attribution to commits, release notes, changelogs, generated metadata, comments, or documentation.
- `AGENTS.md` is this agent's single instruction file for every coding agent; do not add a `CLAUDE.md`.

## Runtime Defaults

Runs `scripts/startAgent.sh` and the WebMeet MCP AgentServer in `docker.io/assistos/ploinky-node@sha256:accd925fcbf460c1f4c7a5cd9e2d46539c615bbfad2e896cabb7556d8050a669`. Its manifest declares no network of its own; it enables `AchillesIDE/liveKitServerAgent`, which uses host networking, and only `webmeetStt` attaches to the `webmeet` network. No self-hosted LiveKit AI worker agent exists in the repository any more (the former `webmeetLivekitAiAgent` survives only as a `.gitignore` entry), and none is part of the default Explorer dependency graph.

## Key Paths

- `manifest.json`
- `docs/specs/DS007-ploinky-runtime-invariants.md`
- `lib/`
- `IDE-plugins/`
- `tools/`

## Validation

Run the narrowest relevant check after edits, then broaden when touching shared behavior:

- `node --check IDE-plugins/webmeet-tool-button/webmeet-tool-button.js`
