# Soul Gateway

Soul Gateway gives Ploinky agents and authenticated users one policy-controlled interface for language-model requests. It accepts OpenAI Chat Completions, Anthropic Messages, OpenAI Responses, and OpenAI-compatible embeddings requests, resolves a configured direct or cascade model, applies gateway and provider policy, and returns the response in the caller's protocol.

The service runs as a Ploinky-managed agent behind the Ploinky Router. Public inference routes require Ploinky signed-subject API keys. The management dashboard and management API require a verified Ploinky administrator identity. Runtime configuration, provider accounts, model definitions, middleware bindings, cooldowns, sessions, and audit data are stored in embedded SQLite.

## Prerequisites

- A Ploinky workspace that can enable the `proxies/soul-gateway` agent.
- The Ploinky Node 24 agent image declared by `manifest.json`.
- Ploinky-injected signed-subject authentication values: `PLOINKY_AGENT_API_PUBLIC_KEY`, `PLOINKY_ROUTER_URL`, `PLOINKY_AGENT_ID`, and `PLOINKY_AGENT_SECRET`.
- Runtime dependencies supplied through the Ploinky agent dependency cache, including `achillesAgentLib`; Node supplies the built-in `node:sqlite` API used by `src/db/sqlite-db.mjs`.

`ALLOW_UNAUTHENTICATED=true` bypasses signed-subject authentication only for local development. The gateway logs a warning when this mode is active, and this setting must not be used in production.

## Installation and startup

Enable and start the agent from a Ploinky workspace:

```bash
ploinky enable agent proxies/soul-gateway as soul-gateway
ploinky start soul-gateway
```

The manifest runs `bash /code/install.sh` during installation and `bash /code/startup.sh` as the agent process. The default listener is `0.0.0.0:7000` inside the agent container, and persistent state is mounted at `/data` with SQLite at `/data/soul-gateway.sqlite3`.

For a local development process with all runtime dependencies available, set the required Ploinky authentication variables and run:

```bash
npm start
```

Use `npm run dev` to restart the Node process when source files change.

## Configuration

The common runtime settings are:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `7000` in the agent manifest | Internal HTTP port. |
| `HOST` | `0.0.0.0` in `startup.sh` | Internal bind address. |
| `SQLITE_PATH` | `/data/soul-gateway.sqlite3` in the agent manifest | Persistent embedded database. |
| `DATA_DIR` | `/data` in `startup.sh` | Persistent files, including the generated encryption key. |
| `CREDENTIALS_DIR` | `/data/credentials` in `startup.sh` | Encrypted provider OAuth credential files. |
| `LLM_DEFAULT_AGENT` | `default-local-llm` in the manifest | Discovered Ploinky agent used to seed standard tiers. |
| `LLM_DEFAULT_TIERS` | `fast,plan,deep` | Comma-separated compatibility tier aliases. |
| `ALLOW_UNAUTHENTICATED` | `false` | Development-only public API authentication bypass. |

`src/config/env.mjs` defines the complete environment contract for timeouts, retries, budgets, rate limits, retention, catalog refresh, loop detection, exports, and shutdown. [Deployment and Operations](docs/operations.html) explains the operational settings and lifecycle.

## Basic usage

Through the Ploinky Router, list the models available to an authenticated caller:

```bash
curl -s \
  -H "Authorization: Bearer $PLOINKY_AGENT_API_KEY" \
  http://localhost:8080/base-agent-additional-server/soul-gateway/7000/v1/models
```

Send an OpenAI-compatible chat request:

```bash
curl -s \
  -H "Authorization: Bearer $PLOINKY_AGENT_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"fast","messages":[{"role":"user","content":"Hello"}],"stream":false}' \
  http://localhost:8080/base-agent-additional-server/soul-gateway/7000/v1/chat/completions
```

The service also accepts `POST /v1/messages`, `POST /v1/responses`, and `POST /v1/embeddings`. User keys use the encoded `sk-soul-...` form issued through Ploinky; agent keys retain the signed `agent:<repo>/<agent>|<signature>` form.

Open the protected management dashboard at:

```text
/base-agent-additional-server/soul-gateway/7000/management/
```

The agent CLI provides `status`, `health`, `keys`, `models`, and `logs [n]` commands. Management commands require `PLOINKY_AUTH_COOKIE`.

## Tests

Run the complete test suite or only unit tests from this directory:

```bash
npm test
npm run test:unit
```

The suite uses Node's test runner with module mocks. Integration tests cover the HTTP and SQLite boundaries; unit tests cover route composition, authentication, routing, providers, policy, management, observability, discovery, and shutdown-related services.

## Documentation

Start with the [technical documentation](docs/index.html), use the [wiki](docs/wiki.html) for canonical terminology, and open the [design specification matrix](docs/specsLoader.html?spec=matrix.md) for normative contracts. `docs/specs/DS001-coding-style.md` is the source of truth for coding style, source layout, file-size guidance, and test organization.
