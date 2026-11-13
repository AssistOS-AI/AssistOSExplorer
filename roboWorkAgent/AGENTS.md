# RoboWork

## Scope

RoboWork owns robot homes and resident execution. RoboTeam owns user interfaces, registry metadata, conversations, workflows and scheduling. Read the repository root `AGENTS.md` first.

## Mandatory Reading Order

Read `docs/index.html`, `docs/wiki.html`, `docs/specs/matrix.md`, and `docs/specs/DS001-coding-style.md` before editing. Specifications are the source of truth. Read the root runtime and security specifications before changing a mount, network, caller, callback or resource-ownership boundary.

## Current Skill Catalog

RoboWork exposes no product skill catalog. RoboTeam selects skills and supplies bounded read-only folder grants. Imported authoring skills keep their documentation inside their own folders, outside this agent's documentation.

## Repository Rules

Keep documentation, specifications and comments in English. Update HTML documentation and specifications together when behavior changes. Keep DS numbering gap-free, with exactly `title` and `summary` frontmatter fields. Put rationale, limitations and boundaries in declarative prose under Core Content. Analyze defining product behaviors before changing DS003. Preserve the exact RoboTeam caller check on every internal tool. Never introduce a generic file or execution tool, forward credentials to a robot, or grant another robot's home. The single exception to forwarding credentials is the git credential mechanism of DS002: a robot's stored GitHub token is served on demand over that robot's own credential socket to the credential helper in its home, and is never written to the home, a robot environment variable or a log.

## Runtime Defaults

Use Node.js ES modules in `.mjs` files, built-ins and async/await. Follow the root coding and dependency rules. RoboWork uses the runtime-provided AgentLib and linked ALA. Its private data bind is `.data/.private/roboWorkAgent` at `/data`; visible homes are `/home/<id>`. Run only focused provider-free tests locally. Live acceptance runs on the explicitly selected apparatus deployment and requires exact revision and resource identity evidence. `tests/e2e` probes must fail on a missing prerequisite or a detected hole; a model refusal is never command evidence.

## Key Paths

`server/main.mjs` wires the resident service. `tools/robowork.mjs` verifies internal invocations. `server/run-manager.mjs` owns runs and logs. `server/launch.mjs` narrows ALA's host view and creates private networks. `server/workspace-view.mjs` computes the read-only workspace view, its masks and the ALA and Podman arguments every execution path adds. `server/git-credentials.mjs` stores encrypted robot git credentials and the Ploinky mirror; `server/git-credential-socket.mjs` serves them over per-robot sockets; `server/git-home-config.mjs` and `server/git-credential-helper.mjs` are the home configuration and helper the confined home helper installs. `server/gui-manager.mjs` owns GUI containers. `server/environment.mjs` starts fresh containers from selected images. `scripts/robot-shell.mjs` launches profile terminals. `tests/` holds focused checks; `tests/e2e/` holds explicit live acceptance probes.
