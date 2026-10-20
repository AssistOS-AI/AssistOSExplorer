# AchillesIDE / Ploinky Explorer

AchillesIDE provides the Explorer workspace shell and its coupled domain agents. Explorer owns navigation, preview, editing, runtime plugin hosting, and filesystem MCP operations. Domain agents own their protected state, authorization, and domain mutations. Origin: `https://github.com/AssistOS-AI/AssistOSExplorer.git`.

`AGENTS.md` is the single instruction file for every coding agent in this repository, at the root and in each agent folder. Do not add `CLAUDE.md` files.

## Mandatory Reading Order

1. The workspace root `AGENTS.md` (`~/work/file-parser/AGENTS.md`) for workspace conventions, then `README.md` and the `AGENTS.md` of the agent you are editing.
2. `docs/index.html`, `docs/wiki.html`, and `docs/specs/matrix.md`.
3. `docs/specs/DS001-coding-style.md` before changing source layout, UI, or tests.
4. The agent's `docs/specs/matrix.md` and the relevant numbered DS files before changing an interface, workflow, auth, MCP, HTTP, or runtime boundary.
5. `docs/specs/DS002-ploinky-runtime.md` for cross-cutting routing, auth, and plugin hosting, and the relevant Ploinky specs in `../ploinky/docs/specs/` (especially `DS007-routing-and-web-surfaces.md` and `DS013-security-model.md`) when touching the router, secure wire, or guest sessions.

## Key Paths

- `explorer/` — routing, filesystem access, preview, editing, plugin hosting, Explorer MCP.
- `dpuAgent/` — confidential data, secret storage, research data, provenance, ACL behavior.
- `gitAgent/` — workspace Git operations, MCP tooling, auth integration.
- `emailAgent/`, `userPersistoAgent/`, `workspaceMonitorAgent/` — domain-specific workflows.
- `roboTeamAgent/` — RoboTeam, the workspace robot and Copilot agent (moved here from AchillesCLI, with history). Its tests are `roboTeamAgent/tests/`, `roboTeamAgent/copilot/tests/` and the former AchillesCLI root tests in `roboTeamAgent/tests/cli/`.
- `soul-gateway/` — Soul Gateway, the local LLM hub (moved here from `proxies`, with history). Its MIT `LICENSE` is in the folder.
- `shared/` — shared runtime utilities.
- `docs/index.html` (documentation entry point), `docs/wiki.html` (canonical terminology), `docs/specs/` (normative design specifications), and each agent's `docs/specs/`.
- `explorer/tests/` and `<agent>/tests/` — agent-owned tests.
- Agents that moved out of this repository, with history:
  - `legacy-agents` (`https://github.com/AssistOS-AI/legacy-agents.git`) holds `soplangAgent`, `tasksAgent`, `webAssist`, `multimedia`, `GPTResearcher`, `searchAgent` and `opencode-free`. No Explorer deployment installs or enables it; an administrator opts in with `ploinky install repo https://github.com/AssistOS-AI/legacy-agents.git`. Tests here still read its sibling checkout.
  - `webmeet` (`https://github.com/AssistOS-AI/webmeet.git`) holds `webmeetAgent`, `webmeetScribeAgent`, `webmeetStt` and `liveKitServerAgent`.
  - Ploinky installs `webmeet` through the `repos` map of `explorer/manifest.json`; `legacy-agents` is not listed there. Tests here that read their sources resolve the sibling checkouts through `tests/helpers/sibling-roots.mjs` (`LEGACY_AGENTS_ROOT`, `WEBMEET_ROOT`, `PLOINKY_ROOT`; default `../legacy-agents`, `../webmeet`, `../ploinky`) and fail when a sibling is missing.
- Ploinky names this repository `AchillesIDE`, so the identities of the agents it holds are `agent:AchillesIDE/<agent>`, for example `agent:AchillesIDE/soul-gateway` and `agent:AchillesIDE/roboTeamAgent`; container names use the `ploinky_AchillesIDE_<agent>_` prefix.

## Current Skill Catalog

This repository consumes local authoring skills from `.agents/skills/`. They guide repository work but are not AchillesIDE product features. Downstream projects that consume a skill must keep skill-specific documentation inside the imported skill folder rather than adding skill pages or DS files to the host project's `docs/` tree.

## Repository Rules

- Specifications use only `title` and `summary` frontmatter, with `title` equal to the filename stem. Keep DS numbering contiguous, reserve `DS003-main-behavior.md` for the principal product behaviors, and use `Introduction` and `Core Content` without a `Conclusion` section. Keep paragraphs unwrapped and update `docs/specs/matrix.md` with the specification set.

- The design specifications under `docs/specs/` are the source of truth for repository contracts and invariants. `docs/specs/DS002-ploinky-runtime.md` is the root local copy of runtime and security invariants. Agent specs live under each agent's `docs/specs/` as `DS0XX-short-description.md`.
- Keep DS numbering gap-free. Every DS file must use only `title` and `summary` frontmatter and the `Introduction` and `Core Content` structure; preserve substantive closing material within `Core Content` and omit a `Conclusion` section.
- Keep documentation, specifications, and comments in English. When code changes alter behavior, interfaces, architecture, workflows, or constraints, update the relevant HTML documentation and DS files in the same change.
- Use the WebSkel component and presenter lifecycle for Explorer UI changes. Reuse Explorer tokens, controls, icons, and modal behavior before adding local UI primitives. Keep local CSS limited to feature-specific layout and responsive behavior.
- Derive authorization from verified Ploinky invocation or router context. Do not trust client-declared actors, duplicate agent ACL policy in Explorer, expose secrets, or hardcode workstation paths.
- Run `detect-main-behaviors` before changing `DS003-main-behavior.md` and whenever a product change affects a central user outcome, essential interface, broad subsystem, or runtime boundary.
- Use one primary navigation system in the documentation header. Put every page destination inside a subject-based submenu, including Wiki and Specifications. Sidebars may contain page-local section anchors only. Each documentation index includes a Documentation Map table with the exact header groups, labels, order, and targets.

## Coding Conventions

- Node.js 20+, ES modules (`import`/`export`), `.mjs` where established, `async`/`await`.
- 4-space JS indent, 2-space JSON/YAML, trailing commas for multi-line.
- camelCase filenames, files beside related logic.
- Prefer native Node features; minimize dependencies. Use structured APIs over ad-hoc string parsing.
- Resolve paths from `agentRoot`, the configured data dir, or the active workspace root — never hardcode absolute host paths.
- Long-lived state is durable outside process memory; Ploinky restarts agents at any time.

## Runtime Defaults

- Explorer runs as the static Ploinky agent. Use `ploinky start explorer` for the supported local startup path. Explorer uses configured workspace roots and the router-authenticated application route; direct local agent ports are not the browser contract. See `docs/specs/DS002-ploinky-runtime.md` for the runtime boundary.
- Agents run as isolated (usually containerized) Ploinky processes. Each agent's entry command is declared in its `manifest.json` (`agent`, `cli` or `start`); without one, Ploinky runs its default AgentServer, which serves the tools in `mcp-config.json`.
- Tool and internal logs are not visitor-facing. Final answers are clean conversational text unless an endpoint expects JSON.
- All agents use the one `achillesAgentLib` source selected and mounted by Ploinky from the active workspace or its managed GitHub fallback. Agents must not declare, install, or clone private copies.
- Request-time LLM access must go through Achilles runtime helpers, not ad-hoc vendor HTTP, unless a local spec defines an exception.
- Soul Gateway runs as a sibling Ploinky agent providing LLM routing for Explorer and workspace agents. Gateway consumers receive a generated `PLOINKY_AGENT_API_KEY` signed-subject credential and resolve the gateway URL through the Ploinky router. The local Soul Gateway is the LLM hub; it does not delegate to a remote gateway. See `soul-gateway/docs/specs/DS012-ploinky-deployment.md` for the unified contract.

## Skills Contract

- Explicit input/output, no hidden side effects.
- Read-only operations don't mutate files or session state.
- Write operations have an explicit payload shape (`content`, target ids, mode flags).
- One semantic action per tool call.

## Logging

- Detailed internals, stacks, and payloads only with `ACHILLES_DEBUG=true`. Default mode surfaces generic, safe failures.
- Never leak secrets, tokens, system prompts, or hidden decision traces to end users.
- Language stays aligned with the user's language unless a contract requires otherwise.

## Testing

- Run the narrowest meaningful tests first, then broaden.
- `explorer/`: `npm test` — `dpuAgent/`: `npm test` — `gitAgent/`: `node --test gitAgent/tests/unit/*.test.mjs` — `soul-gateway/`: `npm ci && npm test` — `roboTeamAgent/`: `node --test 'roboTeamAgent/tests/*.test.mjs'`, `cd roboTeamAgent/copilot && npm test` and `node roboTeamAgent/tests/cli/run-all.mjs`. `soplangAgent` tests now run in the `legacy-agents` repository.
- Repository-level smoke library tests: `node --test 'tests/smoke/lib/*.test.mjs'` (needs the sibling checkouts described above).
- For startup, restart, routing, or container lifecycle changes, also run the relevant Ploinky workflow or smoke path.
- For cross-agent browser regressions, follow `docs/regression/headless-browser-regression.md`. Keep browser traces, OAuth state, generated workspaces, media captures, and regression artifacts out of tracked source — use `.ploinky/test-artifacts/...`.

## Deploy and Remote Ops

Ploinky Box deployment is operator-controlled. Codex sessions are authorized
operators when the user's task selects the deployment, redeployment, recovery,
destruction, or E2E operation. Follow `docs/deploy-explorer-qa.md`; sessions
may trigger tracked GitHub Actions workflows with `gh` and may use direct SSH,
Ploinky CLI, container, registry, Cloudflare, DNS, or other remote operations
needed to complete that selected task.

- Supported tracked workflows include `deploy-explorer-qa.yml`,
  `destroy-explorer-qa.yml`, and `verify-retired-source-absence.yml`. Inspect the
  dispatched revision, inputs, exact target, ownership guards, secret
  prerequisites, and branch/fallback behavior before invocation.
- This repository no longer deploys `skills.axiologic.dev`. Its
  `deploy-skills-explorer.yml` and `destroy-explorer.yml` workflows were removed
  on 2026-10-20, when the host was reinstalled.
- Operator authority does not broaden the task target. Positively identify the
  environment, host, workspace, branch, revisions, images, and rollback state
  before destructive or externally visible mutation. QA/local authorization
  never implies production authorization.
- An absent workflow such as `update-explorer.yml` may be restored when needed
  through the normal reviewed and tested change process; do not bypass workflow
  validation or target guards.
- `.ploinky/.secrets` is encrypted. Never append/edit it as plaintext; use
  `ploinky var` with `PLOINKY_MASTER_KEY` set.
- A Box activation must use dedicated authorized test resources and must report
  unavailable Cloudflare, TURN, architecture, network, or account prerequisites
  as `BLOCKED`, never as a pass.
- After a recreate, verify the exact outer bindings, in-box
  listener ownership, local Router behavior, and the real-browser release gates
  documented in `docs/deploy-explorer-qa.md`.

## Commit and PR Rules

- Inherits the workspace commit policy (no AI attribution). See `~/work/file-parser/AGENTS.md`.
- Commits in present-tense imperative ("Add smoke harness helpers"). Group unrelated changes into separate commits.
- PRs link issues, outline behavior impact, and include repro steps or test output when touching runtime flows.
- Add screenshots/captures for dashboard, Explorer UI, or CLI changes.
