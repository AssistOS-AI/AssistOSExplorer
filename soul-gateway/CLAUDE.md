# Soul Gateway Instructions

## Scope

These instructions apply to the `soul-gateway/` project. Soul Gateway is a Ploinky-managed provider-routing and policy gateway under `src/`. Design specifications under `docs/specs/` are the source of truth for documented behavior and structure.

## Mandatory Reading Order

1. Read [README.md](README.md) for setup, configuration, startup, and basic usage.
2. Read [docs/index.html](docs/index.html), then the technical page relevant to the change.
3. Read [docs/wiki.html](docs/wiki.html) for canonical project terminology.
4. Read [docs/specs/DS000-vision.md](docs/specs/DS000-vision.md), [docs/specs/DS001-coding-style.md](docs/specs/DS001-coding-style.md), [docs/specs/DS002-model-strategy.md](docs/specs/DS002-model-strategy.md), and [docs/specs/DS003-main-behavior.md](docs/specs/DS003-main-behavior.md).
5. Read every specialized DS file affected by the change through [docs/specs/matrix.md](docs/specs/matrix.md).

Run the repository's `detect-main-behaviors` analysis before creating or revising `DS003-main-behavior.md`, and whenever code or product changes may alter Soul Gateway's purpose, user outcomes, essential paths, public interfaces, broad subsystems, major hidden consequences, project-special behavior, architectural skeleton, or active direction.

## Current Skill Catalog

Soul Gateway does not implement or distribute agent skills as product artifacts. Workspace-provided skills are development tooling and are not part of the gateway's public runtime or documentation surface. If a downstream project imports skills, keep their specifications and pages inside those skill folders rather than adding skill-focused files to the host project's `docs/` tree.

## Repository Rules

- Write source comments, documentation, and specifications in English.
- Use ES modules with `import` and `export`.
- Use four-space indentation for JavaScript and two-space indentation for JSON and YAML.
- Keep request-time vendor LLM inference in `achillesAgentLib`. Gateway backends may select providers, lease credentials, pass provider settings, and normalize canonical streams. Direct vendor HTTP is limited to provider lifecycle checks and model discovery; search backends may own provider-specific search transport behind the standard model interface. The Ploinky-agent backend may own exact-byte serialization, signed request hashing, and Router transport for its authenticated agent capability call.
- Keep gateway modules focused on request normalization, routing, policy, credentials, streaming normalization, persistence, observability, and management.
- Update both HTML documentation and affected DS specifications whenever source changes alter behavior, interfaces, architecture, workflows, or constraints.
- Keep DS numbering contiguous. Every DS file has only `title` and `summary` frontmatter and only `Introduction` and `Core Content` as top-level content sections.
- Write rationale, limitations, assumptions, alternatives, and contract boundaries as declarative statements inside the affected DS `Core Content`; do not create a separate decision log.
- Follow [documentation-writing-guidelines.md](docs/documentation-writing-guidelines.md) for future documentation changes.
- Preserve unrelated workspace changes and do not modify sibling projects or `node_modules/`.
- Do not add coding-agent attribution to commits, pull requests, release notes, comments, or metadata.

## Runtime Defaults

- Soul Gateway runs as a Ploinky-managed agent behind Router paths rooted at `/base-agent-additional-server/soul-gateway/7000/`.
- Public inference uses `/v1/*` and requires a valid Ploinky signed-subject API key unless the development-only `ALLOW_UNAUTHENTICATED=true` setting is explicit.
- Management uses `/management/*` and requires a verified Ploinky administrator identity and protected-route invocation.
- Health uses `/healthz/` and is public through the Router.
- Persistent runtime state uses embedded SQLite at `${SQLITE_PATH:-/data/soul-gateway.sqlite3}` inside the agent container.
- The standard compatibility tiers are `fast`, `plan`, and `deep`, seeded from `LLM_DEFAULT_AGENT` when the required discovered model exists.

## Key Paths

- `src/index.mjs` — process entry point and signal handling.
- `src/bootstrap.mjs` — boot sequence and core route registration.
- `src/public-api/` — public model and inference interfaces.
- `src/runtime/route/` — canonical ingress route chain.
- `src/runtime/execution/` — direct and cascade model execution.
- `src/runtime/backends/` — Achilles adapters, Ploinky agent capabilities, provider lifecycle operations, and backend catalog.
- `src/runtime/middleware/` and `src/runtime/policy/` — configurable request policy.
- `src/management/` — protected dashboard and management API.
- `src/db/` — SQLite schema and data-access modules.
- `src/test/unit/` and `src/test/integration/` — modular automated tests.
- `docs/index.html` — technical documentation entry point.
- `docs/wiki.html` — canonical terminology.
- `docs/specs/` — normative design specifications.
- `docs/specs/DS001-coding-style.md` — canonical coding and test organization rules.

## Provider Source

The canonical Achilles source for this workspace is `/Users/danielsava/work/file-parser/ploinky/node_modules/achillesAgentLib`. Add a new vendor LLM protocol family there before wiring its Soul Gateway adapter. Add a search provider as a Soul Gateway search backend behind the OpenAI-compatible model interface.

## Useful Commands

Run from `soul-gateway/`:

```bash
npm test
npm run test:unit
node --experimental-test-module-mocks --test src/test/unit/providers.test.mjs
```

For provider transport changes, also run the relevant `achillesAgentLib` tests from the Achilles checkout before wiring the gateway adapter.

## Production Operations

Production uses:

- Public URL: `https://soul.axiologic.dev`
- Health check: `https://soul.axiologic.dev/base-agent-additional-server/soul-gateway/7000/healthz/`
- Remote SSH target: `admin@45.136.70.141`
- SSH key: `~/proxies_server_private_key.pem`
- Remote workspace: `~/soulGateway`
- Remote source checkout: `~/code/proxies`
- Expected container database: `/data/soul-gateway.sqlite3`

Direct SSH is a read-only status and debugging path by default. Do not modify production state over SSH unless the user explicitly requests that operation.

Deployment and administration workflows live under `../.github/workflows/`:

- `deploy-soul-gateway.yml` (`Deploy Soul Gateway`)
- `destroy-soul-gateway.yml` (`Destroy Soul Gateway`)
- `soul-gateway-admin.yml` (`Soul Gateway Admin`)

Prefer GitHub Actions for deployment, restart, status, destroy, and administrative operations. After a deployment or restart, verify the Router health path, container status, and the SQLite file at `${SQLITE_PATH:-/data/soul-gateway.sqlite3}` inside the container.
