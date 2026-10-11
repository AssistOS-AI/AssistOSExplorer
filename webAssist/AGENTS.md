# webAssist Agent Guide

## Scope

webAssist is the website-visitor assistant agent: it runs chat turns per site and session, stores site and session knowledge under `$WEBASSIST_DATA_ROOT/sites/<siteId>/.aku/`, and ships the embedded `web-assist-chat` IDE plugin.

## Mandatory Reading Order

1. Read the parent `../AGENTS.md` for workspace-wide rules.
2. Read `docs/index.html` for the local documentation entry point.
3. Read `docs/specs/matrix.md` and the relevant local DS files before changing behavior.
4. Read `docs/specs/DS015-ploinky-runtime-invariants.md` before touching auth, routing, guest access, MCP, HTTP services, files, logs, or runtime configuration.
5. Read `docs/specs/DS011-testing.md` before changing tests or fixtures.

## Repository Rules

- Specifications use only `title` and `summary` frontmatter, with `title` equal to the filename stem. Keep DS numbering contiguous, reserve `DS003-main-behavior.md` for the principal product behaviors, and use `Introduction` and `Core Content` without a `Conclusion` section. Keep paragraphs unwrapped and update `docs/specs/matrix.md` with the specification set.

- The DS specifications are the source of truth for local contracts and invariants.
- When source code changes behavior, interfaces, architecture, workflows, security boundaries, or runtime configuration, update both the HTML documentation and the DS specifications.
- Keep DS numbering gap-free within each specification set. Preserve existing local numbering conventions unless a migration updates all links in the same change.
- All documentation, specifications, and code comments must be written in English.
- Keep Ploinky runtime invariants in local context: router-mediated entry, router-minted request JWTs, manifest-declared guest routes, and redacted logs (the session secret must never reach logs, debug files, storage, or model input).
- Never add AI/coding-agent attribution to commits, release notes, changelogs, generated metadata, comments, or documentation.
- `AGENTS.md` is this agent's single instruction file for every coding agent; do not add a `CLAUDE.md`.

## Runtime Defaults

Uses `docker.io/assistos/ploinky-node@sha256:accd925fcbf460c1f4c7a5cd9e2d46539c615bbfad2e896cabb7556d8050a669`, `lite-sandbox: true`, and `guest: true` with the guest HTTP route `/IDE-plugins/web-assist-chat/*`. The manifest `cli` is `node /code/src/index.mjs`; it declares no `agent` or `start` command. Persistent storage `webAssist` is mounted at `/workspace/webassist-data` and exposed as `WEBASSIST_DATA_ROOT={{STORAGE_CONTAINER_PATH}}/data`. Debug logs mount from `.data/webAssist/debuglogs` to `/code/debuglogs`.

## Key Paths

- `manifest.json`
- `mcp-config.json`
- `docs/specs/DS015-ploinky-runtime-invariants.md`
- `docs/specs/DS011-testing.md`
- `src/` (`index.mjs`, `WebAssistAgent.mjs`, `mcp/`, `prompts/`, `runtime/`)
- `skills/` (`webassist-lead`, `webassist-session`, `webassist-site-context`)
- `IDE-plugins/web-assist-chat/`
- `tests/` and `evalsSuite/`

## Validation

There is no `package.json`; DS011 names this runner. Run the narrowest relevant check after edits, then broaden when touching shared behavior:

- `node tests/runAll.mjs`
- `node --test tests/<name>.test.mjs` for a single file
- Some tests need the sibling `ploinky` checkout and the `achillesAgentLib` package to resolve.
