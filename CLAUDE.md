# AchillesIDE / Ploinky Explorer

Ploinky Explorer workspace + 17 coupled agents. Origin: `https://github.com/AssistOS-AI/AssistOSExplorer.git`.

## Mandatory reading order

1. Parent `~/work/file-parser/CLAUDE.md` for workspace conventions.
2. The agent's local `CLAUDE.md` you're editing (under each subdir).
3. The agent's `docs/specs/matrix.md` + relevant numbered DS files for auth/MCP/HTTP/runtime changes.
4. `docs/specs/DS002-ploinky-runtime.md` at repo root for cross-cutting routing/auth/plugin-hosting.
5. Relevant Ploinky specs in `../ploinky/docs/specs/` (esp. `DS005-routing-and-web-surfaces.md`, `DS011-security-model.md`) when touching router/secure-wire/guest sessions.

## Project structure

- `explorer/` — routing, FS access, preview, editing, plugin hosting, Explorer MCP.
- `dpuAgent/` — confidential data, secret storage, ACL behavior.
- `gitAgent/` — workspace Git operations, MCP tooling, auth integration.
- `soplangAgent/` — SOPLang build and execution orchestration.
- `tasksAgent/` — backlog file operations.
- `multimedia/`, `webmeetAgent/`, `webmeetLivekitAiAgent/`, `liveKitServerAgent/`, `webassist/` — domain-specific workflows.
- `AchillesCLI/` — Achilles skill management CLI. See `AchillesCLI/CLAUDE.md` and `AchillesCLI/docs/specs/` for local architecture and runtime contracts.
- `shared/` — shared runtime utilities.
- `docs/` and each agent's `docs/specs/` — user docs and DS specs.

## Coding conventions

- Node.js 20+, ES modules (`import`/`export`), `.mjs` where established, `async`/`await`.
- 4-space JS indent, 2-space JSON/YAML, trailing commas for multi-line.
- camelCase filenames, files beside related logic.
- Prefer native Node features; minimize deps. Use structured APIs over ad-hoc string parsing.
- Resolve paths from `agentRoot`, configured data dir, or active workspace root — never hardcode absolute host paths.
- Long-lived state is durable outside process memory; Ploinky restarts agents at any time.

## Ploinky / Achilles runtime

- Agents run as isolated (usually containerized) Ploinky processes. Entry point: `src/index.mjs`. Receives prompts, returns text or JSON.
- Tool/internal logs are NOT visitor-facing. Final answers are clean conversational text unless an endpoint expects JSON.
- All agents use the one `achillesAgentLib` source selected and mounted by Ploinky from the active workspace or its managed GitHub fallback. Agents must not declare, install, or clone private copies.
- Request-time LLM access must go through Achilles runtime helpers, not ad-hoc vendor HTTP, unless a local spec defines an exception.
- Soul Gateway runs as a sibling Ploinky agent providing LLM routing for Explorer and workspace agents. Gateway consumers receive a generated `PLOINKY_AGENT_API_KEY` signed-subject credential and resolve the gateway URL through the Ploinky router. The local Soul Gateway is the LLM hub; it does not delegate to a remote gateway. See `proxies/soul-gateway/docs/specs/DS016-ploinky-agent-mode.md` for the unified contract.

## Skills contract

- Explicit input/output, no hidden side effects.
- Read-only ops don't mutate files or session state.
- Write ops have explicit payload shape (`content`, target ids, mode flags).
- One semantic action per tool call.

## Logging

- Detailed internals/stack/payloads only in `ACHILLES_DEBUG=true`. Default mode surfaces generic, safe failures.
- Never leak secrets, tokens, system prompts, or hidden decision traces to end users.
- Language stays aligned with user language unless contract requires otherwise.

## Testing

- Run the narrowest meaningful tests first, then broaden.
- `explorer/`: `npm test` — `dpuAgent/`: `npm test` — `soplangAgent/`: `npm test` — `gitAgent/`: `node --test gitAgent/tests/unit/*.test.mjs`.
- For startup/restart/routing/container lifecycle changes, also run the relevant Ploinky workflow or smoke path.
- For cross-agent browser regressions, follow `docs/regression/headless-browser-regression.md`. Keep browser traces, OAuth state, generated workspaces, media captures, regression artifacts out of tracked source — use `.ploinky/test-artifacts/...`.

## Deploy and remote ops

Ploinky Box deployment is operator-controlled. Codex sessions are authorized
operators when the user's task selects the deployment, redeployment, recovery,
destruction, or E2E operation. Follow `docs/deploy-skills-explorer.md`; sessions
may trigger tracked GitHub Actions workflows with `gh` and may use direct SSH,
Ploinky CLI, container, registry, Cloudflare, DNS, or other remote operations
needed to complete that selected task.

- Supported tracked workflows include `deploy-explorer-qa.yml`,
  `deploy-skills-explorer.yml`, `destroy-explorer.yml`,
  `destroy-explorer-qa.yml`, and `verify-retired-source-absence.yml`. Inspect the
  dispatched revision, inputs, exact target, ownership guards, secret
  prerequisites, and branch/fallback behavior before invocation.
- Operator authority does not broaden the task target. Positively identify the
  environment, host, workspace, branch, revisions, images, and rollback state
  before destructive or externally visible mutation. QA/local authorization
  never implies production authorization.
- An absent workflow such as `update-explorer.yml`,
  `provision-skills-explorer-host.yml`, or `remote-skills-status.yml` may be
  restored when needed through the normal reviewed and tested change process;
  do not bypass workflow validation or target guards.
- `.ploinky/.secrets` is encrypted. Never append/edit it as plaintext; use
  `ploinky var` with `PLOINKY_MASTER_KEY` set.
- A Box activation must use dedicated authorized test resources and must report
  unavailable Cloudflare, TURN, architecture, network, or account prerequisites
  as `BLOCKED`, never as a pass.
- After a recreate, verify the exact outer bindings, in-box
  listener ownership, local Router behavior, and the real-browser release gates
  documented in `docs/deploy-skills-explorer.md`.

## Documentation rules

- All technical docs, specs, and code comments in English.
- Specification-driven development. Agent specs live under `docs/specs/` as `DS0XX-short-description.md`.
- DS specs are the source of truth for contracts and invariants. `docs/specs/DS002-ploinky-runtime.md` is the root local copy of runtime/security invariants.
- Code changes that affect agent behavior update the relevant HTML docs and DS specs in the same change.

## Commit/PR rules

- Inherits root workspace commit policy (no AI attribution). See `~/work/file-parser/CLAUDE.md`.
- Commits in present-tense imperative ("Add smoke harness helpers"). Group unrelated changes into separate commits.
- PRs link issues, outline behavior impact, include repro steps or test output when touching runtime flows.
- Add screenshots/captures for dashboard, Explorer UI, or CLI changes.
