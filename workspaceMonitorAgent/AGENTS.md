# workspaceMonitorAgent Agent Guide

## Scope

workspaceMonitorAgent is the administrator-only Workspace Monitor: it collects Ploinky workspace and runtime resource metrics, keeps bounded history in SQLite, manages Ploinky logs, and exposes them through MCP tools and an Explorer plugin.

## Mandatory Reading Order

1. Read the parent `../AGENTS.md` for workspace-wide rules, coding style, module structure, and test-organization rules.
2. Read `docs/index.html` for the local documentation entry point.
3. Read `docs/specs/matrix.md` and the relevant local DS files before changing behavior.
4. Read `docs/specs/DS001-coding-style.md` before changing code or tests.
5. Read `docs/specs/DS002-runtime-and-storage.md` before touching the manifest, supervisor, collector, current snapshot, SQLite store, or retention.
6. Read `docs/specs/DS005-admin-and-log-access.md` before touching authorization, settings validation, or Ploinky log operations.

## Repository Rules

- Specifications use only `title` and `summary` frontmatter, with `title` equal to the filename stem. Keep DS numbering contiguous, reserve `DS003-main-behavior.md` for the principal product behaviors, and use `Introduction` and `Core Content` without a `Conclusion` section. Keep paragraphs unwrapped and update `docs/specs/matrix.md` with the specification set.

- The DS specifications in `docs/specs/` are the source of truth for local contracts and invariants.
- When source code changes behavior, interfaces, architecture, workflows, security boundaries, or runtime configuration, update both the HTML documentation in `docs/` and the DS specifications.
- Preserve the existing DS numbering (`DS000` to `DS005`) and keep `docs/specs/matrix.md` in sync with the DS files.
- All documentation, specifications, and code comments must be written in English.
- Apply administrator authorization before dispatching any tool; never expose secrets or private Router assertion values in logs or errors.
- Do not create local copies of Ploinky-owned logs; persistent state belongs under `WORKSPACE_MONITOR_DATA_ROOT`.
- The Explorer plugin must not read agent storage directly.
- Do not add LLM interaction without an explicit contract (DS001).
- Never add AI/coding-agent attribution to commits, release notes, changelogs, generated metadata, comments, or documentation.
- `AGENTS.md` is this agent's single instruction file for every coding agent; do not add a `CLAUDE.md`.

## Runtime Defaults

`manifest.json` uses `docker.io/assistos/ploinky-node@sha256:accd925fcbf460c1f4c7a5cd9e2d46539c615bbfad2e896cabb7556d8050a669` and starts `node /code/server/supervisor.mjs`. It declares `routerAccess.workspaceLogs`, persistent storage key `workspace-monitor` mounted at `/data`, and `WORKSPACE_MONITOR_DATA_ROOT` set from that mount. `mcp-config.json` declares the `workspace_monitor_*` tools, run through `tools/workspace_monitor_tool.sh`.

## Key Paths

- `manifest.json`, `mcp-config.json`
- `server/` (supervisor, collector, log maintenance)
- `lib/` (collector, current snapshot, SQLite store, settings, admin, Ploinky logs)
- `tools/`
- `IDE-plugins/workspace-monitor/`
- `docs/specs/`
- `tests/`

## Validation

Run the narrowest relevant check after edits, then broaden when touching shared behavior:

- `npm test` (runs `node --test tests/*.test.mjs`)
