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

For a local development process with all runtime dependencies available, set the required Ploinky authentication variables and explicitly place all private persistence beneath the workspace `.data/soul-gateway` directory before running:

```bash
DATA_DIR=/absolute/workspace/.data/soul-gateway \
CREDENTIALS_DIR=/absolute/workspace/.data/soul-gateway/credentials \
SQLITE_PATH=/absolute/workspace/.data/soul-gateway/soul-gateway.sqlite3 \
  npm start
```

Use the same explicit persistence variables with `npm run dev` to restart the Node process when source files change. Direct starts fail closed when any of the three variables is absent; they do not select a relative data directory.

## Configuration

The common runtime settings are:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `7000` in the agent manifest | Internal HTTP port. |
| `HOST` | `0.0.0.0` in `startup.sh` | Internal bind address. |
| `SQLITE_PATH` | `/data/soul-gateway.sqlite3` in the agent manifest; required explicitly for direct starts | Persistent embedded database. |
| `DATA_DIR` | `/data` in the agent manifest; required explicitly for direct starts | Persistent files, including the generated encryption key. |
| `CREDENTIALS_DIR` | `/data/credentials` in the agent manifest; required explicitly for direct starts | Encrypted provider OAuth credential files. |
| `FREE_MODELS_ENABLED` | `true` | Installs the free OpenRouter provider and baseline free models once, on the first start, and creates each compatibility tier named in `LLM_DEFAULT_TIERS` once. `false` skips the install; setting it back to `true` later installs the defaults on the next start. The install runs on any database without its marker, so set `false` before upgrading an existing gateway that should not receive the free defaults. |
| `OPENROUTER_API_KEY` | empty | When set at the time of the one-time install, this OpenRouter key is stored instead of the bundled free-tier key. It has no effect after the install; replace the key from the management dashboard instead. |
| `LLM_DEFAULT_TIERS` | `fast,code,plan,write,deep,ultra,web-assist` | Comma-separated compatibility tier names the free defaults create. A name added later is created on the next start. A tier that was created or kept once is never created again, and a tier with no enabled free model among its children waits until one is enabled instead of being created empty. |
| `PRICING_DIRECTORY_TIMEOUT_MS` | `5000` | Upper bound for one load of the external pricing directory, headers and body together, clamped to at most `2147483647` (the largest delay a timer accepts). Catalog syncs, including the startup sync, wait for that load; a timeout is logged and the sync continues without directory metadata. A failed load is then remembered for the refresh interval, at most a minute, so a stalled directory costs one timeout per backoff window instead of one per caller. |
| `STREAM_IDLE_TIMEOUT_MS` | `300000` | Longest silence allowed between events of a committed response stream when the model or tier child sets no `streamIdleTimeoutMs`. Model reasoning counts as an event, so a committed stream is bounded a second time by `max(streamIdleTimeoutMs, firstContentTimeoutMs)` measured from its last content event, which reasoning does not extend. The seeded free models set their own idle limits (8 seconds for `fast` children, 60 seconds otherwise), so this fallback does not apply to them. |
| `ALLOW_UNAUTHENTICATED` | `false` | Development-only public API authentication bypass. |

`src/config/env.mjs` defines the complete environment contract for timeouts, retries, budgets, rate limits, retention, catalog refresh, loop detection, exports, and shutdown. [Deployment and Operations](docs/operations.html) explains the operational settings and lifecycle.

## Default models on first start

A new Soul Gateway can answer requests without any provider setup when it can reach OpenRouter. On its first start it installs, once and in one database transaction, a free-only OpenRouter provider named `openrouter-free`, an encrypted provider account holding a bundled restricted OpenRouter key, nine baseline free models, and the compatibility tiers `fast`, `code`, `plan`, `write`, `deep`, `ultra`, and `web-assist` as cascades of free models. A marker row in the database records the install and every tier it has created or kept, so the provider is installed once and no tier is created twice, and a deleted synced model leaves a tombstone that later catalog refreshes honour, so tiers, models, or keys that an administrator changes, disables, or deletes are never recreated. The one limit is a model created again by hand: that model is manual and leaves no tombstone, so deleting it a second time lets the next refresh add it back as a synced model (see `docs/operations.html`). The later catalog refresh adds the rest of OpenRouter's free general chat models; models with any non-zero price, and classifiers, rerankers or embedding models, are never stored on this provider, and requests through it cannot select a paid model. Every model on the provider runs with one attempt and bounded first-output deadlines; models measured as unfit stay callable directly but join no tier.

The gateway starts, reports healthy, and lists its tiers without internet access. Answering a request requires outbound HTTPS access to `openrouter.ai`, because the free models run at OpenRouter; Soul Gateway performs no local inference by default.

The bundled key has a zero credit limit and an OpenRouter guardrail that allows only free models. Its daily free-model allowance (currently 50 requests per day on OpenRouter's free tier) is shared by every installation that uses the bundled key, and the key expires on 2027-03-20. The free defaults are a working first start, not unlimited or guaranteed capacity. When the shared allowance is spent, tier requests return HTTP 429 with error type `provider_quota_exhausted` or `provider_accounts_exhausted` until the reset time OpenRouter reports (at most 26 hours); when OpenRouter reports no reset time, the account is tried again after at most 15 minutes. Per-minute rate limits only pause the affected model briefly.

To use your own OpenRouter key, set `OPENROUTER_API_KEY` before the first start, or later edit the `openrouter-free` provider in the management dashboard and enter a new API key. The key is stored encrypted and is never returned by the dashboard or any API. The provider stays free-only; add a separate provider for paid models. [Deployment and Operations](docs/operations.html) describes quota exhaustion, key replacement, offline starts, and restart behavior in detail.

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
