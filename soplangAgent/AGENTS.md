# soplangAgent Agent Guide

## Scope

soplangAgent mediates Explorer and UI requests to SOPLang build, execution, plugin, and skill workflows.

## Mandatory Reading Order

1. Read the nearest parent `AGENTS.md` for workspace-wide rules.
2. Read `docs/index.html` for the local documentation entry point.
3. Read `docs/specs/matrix.md` and the relevant local DS files before changing behavior.
4. Read `docs/specs/DS006-runtime-invariants.md` before touching auth, routing, guest access, MCP, HTTP services, files, logs, or runtime configuration.
5. Read `../AGENTS.md` for coding style, module structure, and test-organization rules when that file exists; otherwise inherit the parent repository coding-style authority.

## Current Skill Catalog

- No local skill catalog is declared for this agent.

## Repository Rules

- Specifications use only `title` and `summary` frontmatter, with `title` equal to the filename stem. Keep DS numbering contiguous, reserve `DS003-main-behavior.md` for the principal product behaviors, and use `Introduction` and `Core Content` without a `Conclusion` section. Keep paragraphs unwrapped and update `docs/specs/matrix.md` with the specification set.

- The DS specifications are the source of truth for local contracts and invariants.
- When source code changes behavior, interfaces, architecture, workflows, security boundaries, or runtime configuration, update both the HTML documentation and the DS specifications.
- Keep DS numbering gap-free within each specification set. Preserve existing local numbering conventions unless a migration updates all links in the same change.
- All documentation, specifications, and code comments must be written in English.
- Do not add imported-skill DS files or skill pages to a downstream host project's docs tree.
- Keep Ploinky runtime invariants in local context: router-mediated entry, secure-wire invocation JWTs, scoped guest mode, manifest-declared HTTP services, workspace-confined paths, and redacted logs.
- Never add AI/coding-agent attribution to commits, release notes, changelogs, generated metadata, comments, or documentation.
- `AGENTS.md` is this agent's single instruction file for every coding agent; do not add a `CLAUDE.md`.

## Runtime Defaults

Uses `docker.io/assistos/ploinky-node@sha256:accd925fcbf460c1f4c7a5cd9e2d46539c615bbfad2e896cabb7556d8050a669`, `lite-sandbox: true`, and Achilles/SOPLang runtime helpers.

## Key Paths

- `manifest.json`
- `docs/specs/DS006-runtime-invariants.md`
- `plugins/`
- `web/`
- `tests/`

## Validation

Run the narrowest relevant check after edits, then broaden when touching shared behavior:

- `npm test`
