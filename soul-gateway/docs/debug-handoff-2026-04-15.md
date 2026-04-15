# Soul Gateway Debug Handoff — 2026-04-15

This document is for a fresh LLM session that needs to debug the current `soul-gateway/` state without relying on prior chat history.

It describes:

- the exact repo / branch / deploy context
- the remote machine and hosted old-version context
- the important architectural constraints already enforced in this branch
- the live debugging workflow for the local deployment in `~/work/testProxies`
- the current model-metadata enrichment work that is present locally but not yet committed
- the known limitations / likely failure points

This is a handoff / debugging note, not a source-of-truth behavior spec. The current runtime behavior is documented separately in `docs/specs/`.

## Repo state

- Repo root: `/Users/danielsava/work/file-parser/proxies`
- Soul Gateway app root: `/Users/danielsava/work/file-parser/proxies/soul-gateway`
- Current branch: `soul-gateway-v2-src`
- Last pushed commit on this branch before the current uncommitted work:
  - `a5c3fb2fd53400a799777934b9fc66b0bb20684b`
  - message: `Tighten provider composition and model seeding`

## Working tree state

The tree is intentionally dirty. A fresh session must not assume the checked-out code matches the pushed branch tip.

Current modified files under `soul-gateway/`:

- `docs/specs/DS002-provider-auth.md`
- `docs/specs/DS006-database-schema.md`
- `docs/specs/DS007-rate-limiting-budgets.md`
- `docs/specs/DS012-api-reference.md`
- `docs/specs/DS013-configuration-deployment.md`
- `src/bootstrap/service-installers.mjs`
- `src/dashboard/js/app.mjs`
- `src/db/dao/models-dao.mjs`
- `src/management/models-route.mjs`
- `src/management/providers-route.mjs`
- `src/runtime/backends/builtin/openai-api.backend.mjs`
- `src/runtime/policy/cost-calculator.mjs`
- `src/runtime/policy/pricing-directory.mjs`
- `src/runtime/providers/auto-provisioner.mjs`
- `src/test/unit/auto-provisioner.test.mjs`
- `src/test/unit/management.test.mjs`
- `src/test/unit/policy.test.mjs`
- `src/test/unit/providers.test.mjs`
- `src/test/unit/service-installers.test.mjs`
- new untracked test file: `src/test/unit/pricing-directory.test.mjs`

Also present locally and not meant to be committed:

- `soul-gateway/node_modules/`

Important: `AGENTS.md` and `CLAUDE.md` must not be committed. They caused push-protection problems earlier in this branch history.

## Repository instruction files

There are two local instruction files relevant to any fresh debugging session:

- repo `AGENTS.md`
- repo `CLAUDE.md`

`AGENTS.md` is the active repository instruction set used in this branch:

- read `docs/specs/README.md` plus the relevant `DS0xx` docs before working in `soul-gateway/`
- keep specs in sync after code changes
- middleware-first architecture is mandatory
- fail-fast / no-silent-fallbacks is mandatory
- 4-space indentation only

`CLAUDE.md` repeats the same main engineering rules and, importantly, also contains the remote-machine inventory for the hosted old version.

## Hosted old-version reference

There is an older, already-deployed Soul Gateway instance that should be treated as a visual / product-behavior reference while debugging the new branch:

- URL: `https://soul.axiologic.dev`
- repo branch behind that hosted version: the default branch of `proxies`, i.e. `origin/main`
- separately cloned reference checkout: `/Users/danielsava/work/file-parser/proxies-main-branch`
- reference checkout branch / commit:
  - branch: `main`
  - commit: `05da1f7b46e04e62acee8d16590746fb775a4f0f`
- login page: `https://soul.axiologic.dev/login`
- dashboard password from `CLAUDE.md`: `soulpass!321`

This mapping was verified locally from git:

- `git remote show origin` reports `HEAD branch: main`
- the separate checkout at `/Users/danielsava/work/file-parser/proxies-main-branch` is on `main`

Observed login behavior:

- login is a classic form POST to `/login`, not the newer JSON `POST /management/auth/login` flow used by the local src-based branch
- successful login sets a `soul_session` cookie and redirects to `/`
- the UI is an older server-rendered / Alpine-style dashboard with client-side page switching

Important implication:

- treat `soul.axiologic.dev` as the live product reference for the default branch, not as an unrelated historical fork
- use `soul.axiologic.dev` as a visual reference for expected metadata richness and UX
- do not assume its route structure or management API matches the current src-based branch
- when deciding whether an old behavior should come back, consult the migration inventory in `docs/main-branch-feature-migration-list-2026-04-15.md`

## Remote machine for the hosted old version

From `CLAUDE.md`, the hosted old Soul Gateway instance runs on:

### Machine 1: Proxies Server

- host: `45.136.70.141`
- SSH:

```bash
ssh -i ~/proxies_server_private_key.pem admin@45.136.70.141
```

Relevant services on that machine:

- Soul Gateway: `:8042` (`soul.axiologic.dev`)
- CLIProxyAPI: `:8317` (`proxy.axiologic.dev`)
- PostgreSQL: `:5432` (localhost only)
- Copilot Gateway: `:4141`
- Kiro Gateway: `:8000`

Reverse proxy / service management details:

- Cloudflared is a system service and routes `soul.axiologic.dev` / `proxy.axiologic.dev`
- Caddy is system service `cliproxy-caddy`, routing `:8318` -> `:8317`
- systemd user services include:
  - `ploinky-soul-gateway`
  - `ploinky-cliproxyapi`

Old remote Soul Gateway credentials / DB details recorded in `CLAUDE.md`:

- dashboard password: `soulpass!321`
- PostgreSQL host: `10.0.2.2`
- PostgreSQL port: `5432`
- PostgreSQL user: `postgres`
- PostgreSQL password: `postgres`
- PostgreSQL schema: `soul_gateway`

If a new session needs the remote Soul Gateway API key or any unrelated repo secrets, check `CLAUDE.md` directly rather than copying all secrets into additional documents.

## Local deployment context

The local runnable deployment used during debugging is not the repo checkout itself. It is the Ploinky workspace:

- deploy workspace: `~/work/testProxies`
- deployed source mirror: `~/work/testProxies/.ploinky/repos/proxies/soul-gateway`
- deploy command:

```bash
cd ~/work/testProxies
./deploy.sh --restart
```

What `deploy.sh` does:

- syncs source from `/Users/danielsava/work/file-parser/proxies/soul-gateway`
- restarts `postgres`
- restarts `soul-gateway`

Relevant endpoints after deploy:

- gateway: `http://localhost:8042`
- dashboard: `http://localhost:8042`
- health: `http://localhost:8042/healthz`

Dashboard password in the local deploy:

- `soulpass!321`

## Dashboard / management auth

Management endpoints require an admin session.

Quick login flow from shell:

```bash
tmpdir=$(mktemp -d)
cookie="$tmpdir/cookies.txt"
curl -sS -c "$cookie" \
  -H 'content-type: application/json' \
  -d '{"password":"soulpass!321"}' \
  http://localhost:8042/management/auth/login
```

Then reuse the cookie:

```bash
curl -sS -b "$cookie" http://localhost:8042/management/models
```

If you hit `{"error":{"message":"Admin session required"...}}`, that is expected when you forgot the login step.

## Old-version models-page baseline

The old hosted version at `soul.axiologic.dev` is the baseline for what a "rich" models page looked like before this refactor.

From the provided screenshots:

- many models had non-empty tag chips
- many models had non-empty context values (for example `200k`)
- pricing was often rendered as:
  - token pricing, e.g. `$2/8`
  - request pricing, e.g. `$0.04/req`
  - free or zeroed token pricing, e.g. `$0/$0`
- NVIDIA models in particular showed much richer metadata coverage than the current branch initially showed before the OpenRouter fallback work

Examples visible in the screenshots:

- Copilot rows carried tags such as `coding`, `reasoning`, `agentic`, `tool-calling`, and showed request pricing plus `200k` context
- Codex rows carried tags such as `coding`, `reasoning`, `agentic`
- many NVIDIA rows showed tags like `chat`, `fast`, `reasoning`, `instruction-following`, `vision`, or `coding`
- some NVIDIA rows showed non-zero token pricing while many "free" rows still showed useful tags

This matters because:

- when validating the new branch, an empty models page or a mostly-metadata-free models page is not acceptable as the end state
- the old version demonstrates that the product expectation is richer pricing/context/tag coverage, even if the new branch obtains that data through a different architecture

## High-level branch changes already in place

These are not hypothetical; they are already implemented on this branch.

### Provider composition invariant

The intended provider model is still:

- provider config / auth / account data
- one backend key
- one ordered provider middleware chain

The runtime no longer tolerates unknown provider backends or unknown provider middleware keys silently.

### Provider create / update / OAuth model seeding

When a provider gets usable credentials:

- create with `apiKey` does strict initial model sync
- OAuth completion does strict initial model sync
- `apiKey` PATCH does strict model sync
- startup reconciliation re-seeds eligible providers with zero models

If strict sync fails, the operation fails instead of pretending the provider is usable.

### Provider rollback / delete behavior

Earlier bugs fixed on this branch:

- create rollback now deletes partially inserted provider models before deleting the provider row
- provider delete auto-removes provider-seeded models
- provider delete still blocks when manual models depend on the provider

### Dashboard / tiers

The dashboard has a separate `Tiers` page again, but it is a UI / management view over cascade models, not a separate runtime abstraction.

### Alias / compatibility cleanup

This branch intentionally removed a number of compatibility surfaces. The only historical bridge that should remain is the `main`-branch import flow under `src/db/import/`.

## Current uncommitted work: model metadata enrichment

This is the most important current feature-in-progress.

### Goal

When a provider’s own `/models` response does not include enough metadata, enrich the model with pricing / context / tags from OpenRouter.

Requested behavior:

1. try the provider’s own `/models` response first
2. only fall back to OpenRouter if metadata is still missing

That precedence is implemented locally.

### Current code path

#### 1. Shared OpenRouter-backed directory

File:

- `src/runtime/policy/pricing-directory.mjs`

Purpose:

- loads OpenRouter-style `/models` data
- caches pricing plus metadata
- supports lookup by:
  - exact id
  - canonical slug
  - unique display name
  - unique leaf slug

Important details:

- default URL is `https://openrouter.ai/api/v1/models`
- configurable by `PRICING_DIRECTORY_URL`
- refresh interval configurable by `PRICING_REFRESH_INTERVAL_MS`
- used both for request-time `external_directory` cost calculation and management-side enrichment

#### 2. Boot installation

File:

- `src/bootstrap/service-installers.mjs`

`installExecutionServices()` now installs:

- `spendCache`
- `pricingDirectory`

and kicks off an initial best-effort refresh.

#### 3. OpenAI-compatible provider parsing

File:

- `src/runtime/backends/builtin/openai-api.backend.mjs`

`discoverModels()` now preserves provider-supplied fields when available:

- display name
- context window
- max output tokens
- supports tools
- supports vision
- token / request / free pricing
- basic tags derived from supported parameters / modalities

This means the provider response wins whenever it already supplies the info.

#### 4. Fallback overlay

File:

- `src/runtime/providers/auto-provisioner.mjs`

Key functions:

- `enrichDiscoveryDescriptors()`
- `enrichStoredModelRows()`

Fallback is only used when data is still missing:

- no real pricing
- no context window
- empty tags

It does not blindly overwrite provider-supplied metadata.

#### 5. Management reads

File:

- `src/management/models-route.mjs`

Behavior:

- `GET /management/models` now overlays missing metadata onto DB rows before returning them
- `GET /management/models/providers/:key/models` does live discovery, then applies the same enrichment before returning Add Model choices

#### 6. Dashboard Add Model persistence

File:

- `src/dashboard/js/app.mjs`

The Add Model flow now persists:

- pricing
- capabilities
- tags
- metadata

instead of dropping everything except a few pricing fields.

#### 7. Cost calculator

File:

- `src/runtime/policy/cost-calculator.mjs`

`external_directory` lookups now support:

- token pricing
- request pricing
- free entries

instead of assuming token pricing only.

## What was verified locally

All of the following were run successfully against the local code in the main repo checkout:

```bash
cd soul-gateway && node --experimental-test-module-mocks --test \
  src/test/unit/auto-provisioner.test.mjs \
  src/test/unit/management.test.mjs \
  src/test/unit/policy.test.mjs \
  src/test/unit/pricing-directory.test.mjs \
  src/test/unit/providers.test.mjs \
  src/test/unit/service-installers.test.mjs

git diff --check
```

Also ran `node --check` on the modified JS files during the implementation.

## Live behavior after redeploy

After redeploying `~/work/testProxies`, the new enrichment code is present in the deployed mirror:

- deployed `models-route.mjs` contains `enrichStoredModelRows()` usage
- deployed `auto-provisioner.mjs` contains `enrichDiscoveryDescriptors()` / `enrichStoredModelRows()`

Health check after redeploy:

```http
GET /healthz -> 200
{"ok":true,"db":true,"snapshotGeneration":1,...}
```

## Current observed limitation

The enrichment is working, but only for models that can be matched in OpenRouter.

Verified live examples from `GET /management/models` after redeploy:

Rows that now enrich correctly:

- `codex-api/gpt-5.4-mini`
- `nvidia/deepseek-ai/deepseek-v3.1-terminus`
- `nvidia/deepseek-ai/deepseek-v3.2`
- `nvidia/google/gemma-3-12b-it`

Rows that still remain blank:

- `nvidia/01-ai/yi-large`
- `nvidia/abacusai/dracarys-llama-3.1-70b-instruct`
- `nvidia/google/gemma-2b`
- many other NVIDIA catalog entries

Why:

- provider discovery for these rows is still thin
- OpenRouter lookup is intentionally conservative
- if there is no exact id / canonical slug / unique leaf-slug match, the row stays `external_directory` with null prices/context

This is not a dashboard rendering failure. It is a lookup coverage limitation.

When comparing against the old hosted version, remember:

- the old version had broader metadata coverage for many NVIDIA rows
- the current branch has only partially recovered that behavior via exact / canonical / leaf-slug OpenRouter matching
- the remaining gap is likely an alias / mapping problem rather than a rendering problem

## Most likely next debugging target

If the goal is to enrich more NVIDIA rows, the next likely change is:

- add a curated alias map between provider model ids and OpenRouter ids

Examples of why exact / leaf matching is insufficient:

- provider namespace differs (`nvidia/meta/...` vs `meta-llama/...`)
- vendor prefixes differ (`deepseek-ai` vs `deepseek`)
- some provider ids simply do not exist in OpenRouter’s public catalog

Do not weaken matching into arbitrary fuzzy search without explicit product approval. The current code intentionally avoids guessing.

## Debugging commands worth reusing

### Deploy and verify

```bash
cd ~/work/testProxies
./deploy.sh --restart
curl -sS -i http://localhost:8042/healthz
```

### Authenticated model dump

```bash
tmpdir=$(mktemp -d)
cookie="$tmpdir/cookies.txt"
curl -sS -c "$cookie" \
  -H 'content-type: application/json' \
  -d '{"password":"soulpass!321"}' \
  http://localhost:8042/management/auth/login >/dev/null

curl -sS -b "$cookie" http://localhost:8042/management/models
```

### Check deployed source instead of assuming

```bash
sed -n '1,220p' \
  ~/work/testProxies/.ploinky/repos/proxies/soul-gateway/src/management/models-route.mjs

sed -n '1,320p' \
  ~/work/testProxies/.ploinky/repos/proxies/soul-gateway/src/runtime/providers/auto-provisioner.mjs
```

### Old hosted version quick checks

Visual reference:

```text
https://soul.axiologic.dev
```

Login from shell:

```bash
tmpdir=$(mktemp -d)
cookie="$tmpdir/cookies.txt"
curl -sS -c "$cookie" \
  -d 'password=soulpass!321' \
  https://soul.axiologic.dev/login
```

Notes:

- this sets a `soul_session` cookie
- the hosted old version does not appear to expose the same `/management/auth/login` JSON flow as the local src-based branch
- use it mainly for UI / behavior comparison unless you verify a specific remote endpoint first

### Compare local repo vs deployed mirror

```bash
diff -u \
  /Users/danielsava/work/file-parser/proxies/soul-gateway/src/management/models-route.mjs \
  ~/work/testProxies/.ploinky/repos/proxies/soul-gateway/src/management/models-route.mjs
```

### Inspect OpenRouter catalog shape quickly

```bash
python3 - <<'PY'
import json, urllib.request
data = json.loads(urllib.request.urlopen('https://openrouter.ai/api/v1/models').read())
print(data['data'][0].keys())
PY
```

## Browser cache gotcha

Earlier in this branch, there was a dashboard asset cache-skew issue:

- browser loaded new `index.html`
- browser kept old cached `js/app.mjs`
- Alpine errors appeared (`tiers is not defined`, etc.)

That turned out to be a stale asset cache issue, not a source bug. A hard refresh fixed it.

If the dashboard looks impossible relative to deployed source, hard-refresh before changing code.

## Current `/healthz` behavior

`/healthz` is the canonical health endpoint.

Current implementation:

- unauthenticated
- returns JSON with `ok`, `db`, `snapshotGeneration`, `uptimeSeconds`
- still returns HTTP 200 even if the DB probe fails and only `db: false` changes

This is a known spec-vs-code nuance that already came up earlier.

## Important docs to read first in a fresh session

For actual current behavior:

- `docs/specs/README.md`
- `docs/specs/DS002-provider-auth.md`
- `docs/specs/DS003-middleware-framework.md`
- `docs/specs/DS004-model-routing.md`
- `docs/specs/DS006-database-schema.md`
- `docs/specs/DS007-rate-limiting-budgets.md`
- `docs/specs/DS012-api-reference.md`
- `docs/specs/DS013-configuration-deployment.md`

For this specific debugging thread:

- this file

## Safe assumptions for a new LLM session

- The local repo is ahead of the last pushed commit.
- The deploy target used during manual testing is `~/work/testProxies`.
- Management endpoints require admin auth.
- If dashboard data does not match expectations, inspect the JSON API before touching the UI.
- If deployed behavior does not match local source, compare against the Ploinky mirror before changing code.
- Missing pricing/context for some NVIDIA models is currently expected when no provider metadata exists and OpenRouter has no safe match.

## Source used for the OpenRouter response shape

- Official docs: `https://openrouter.ai/docs/api-reference/models/get-models`
