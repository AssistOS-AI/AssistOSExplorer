# AXL Proxy Delegating Mirror — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When an upstream **AXL Proxy** (remote soul-gateway) API key is present, the local soul-gateway auto-registers a single delegating `openai-api` provider that mirrors the upstream `/v1/models` catalog — and the workspace's stale design specs are reconciled to describe this (replacing the deleted `SOUL_GATEWAY_PROVIDER_*` / `LOCAL_LLM_*` bootstraps).

**Architecture:** Ploinky already injects manifest-declared env vars into agent containers by resolving `.secrets` → `process.env` → nearest-ancestor `.env` (`resolveManifestEnv` → `loadEnvFile`'s upward walk). So the local soul-gateway gets `AXL_PROXY_API_KEY`/`AXL_PROXY_BASE_URL` purely by **declaring them in its own manifest** — no ploinky framework code, no hardcoded agent id. Inside the gateway, a new startup bootstrap (`axl-proxy-bootstrap.mjs`, modeled on the deleted `soul-gateway-provider-bootstrap.mjs` minus alias creation) upserts an `axl-proxy` provider, stores the key, and calls the existing `autoProvisionModels` to mirror the upstream `GET /v1/models`. The bootstrap creates **no** tier aliases: `seed-default-tiers` keeps `fast/plan/deep` on the local `default-local-llm`.

**Tech Stack:** Node.js ESM, `node:test`, embedded SQLite, existing soul-gateway runtime primitives (`autoProvisionModels`, `upsertProviderApiKeyAccount`, `providers-dao`), Ploinky manifest env resolution.

## Global Constraints

- **ES modules** (`import`/`export`); **4-space** JS indent; **2-space** JSON indent.
- **Request-time LLM inference must route through `achillesAgentLib`.** The mirror only uses the `openai-api` backend's `discoverModels` (direct `GET {base}/models`) — explicitly allowed for *discovery* by soul-gateway `CLAUDE.md`. Do not add request-time `fetch`/`http` inference.
- **Routing is unchanged.** Goal B (move to top-level `/soul-gateway/...`) is **DROPPED** (see Decisions). Keep `/services/soul-gateway/...`. Do **not** touch the manifest `httpServices`, the router, `achillesAgentLib`'s URL resolver, the dashboard marker, or the routing tests.
- **Env var names: `AXL_PROXY_*` only.** Do not reintroduce `SOUL_GATEWAY_PROVIDER_*`.
- **Spec-driven:** update affected DS specs in the same change. HTML docs under `docs/specs/` are a dynamic viewer (`specs-viewer.html` fetches the `.md`), so editing Markdown updates the rendered docs — no per-section HTML edits.
- **Commits:** present-tense imperative; **NO** `Co-Authored-By` / "Generated with" / any AI-agent attribution anywhere (commit messages, docs, code comments). **Do not commit or push without explicit user confirmation.** Keep edits scoped per subrepo; the `proxies` and `AssistOSExplorer` changes are separate commits.
- **Tier precedence:** local wins. The bootstrap must never create or reassign the bare `fast`/`plan`/`deep` aliases.

---

## Decisions (resolved during brainstorming)

| # | Decision | Consequence |
|---|---|---|
| Goal B routing | **Dropped** — keep `/services/soul-gateway/`. A top-level `/soul-gateway/` prefix collides with the agent's own route key (`extractAgentName` in `RoutingServer.js:150`), so it would route as agent-passthrough and bypass per-service access tiers + signed management authInfo. | No router/manifest-route/achillesAgentLib/dashboard/test churn. |
| `.env` discovery | Ploinky injects via existing manifest-env resolution + ancestor-`.env` walk. | **Zero ploinky framework code.** Declare vars in the soul-gateway manifest only. |
| Mirror scope | One delegating `openai-api` provider mirroring all of `/v1/models`. | Upstream tier entries (`fast`/`plan`/`deep`) arrive as reachable `axl-proxy/fast` etc. models. |
| Tier precedence | Local wins; AXL adds models only. | Bootstrap creates **no** bare tier aliases. |
| Env names | `AXL_PROXY_*` only. | `SOUL_GATEWAY_PROVIDER_*` stays deleted. |

## Grounding references (verified)

| Fact | Location |
|---|---|
| Mechanism deleted 2026-06-17 | commit `c9ed615` (`proxies` repo) |
| Recoverable template | `git -C proxies show c9ed615^:soul-gateway/src/bootstrap/soul-gateway-provider-bootstrap.mjs` |
| Env reader (insert point: after `SOUL_GATEWAY_API_KEY`) | `src/config/env.mjs:140` |
| Boot hook (after `reconcileProvidersOnStartup`, before `installSnapshotServices`) | `src/bootstrap.mjs:75-76` |
| Reusable primitives | `src/runtime/providers/auto-provisioner.mjs` (`autoProvisionModels`), `src/runtime/providers/api-key-account.mjs` (`upsertProviderApiKeyAccount`), `src/db/dao/providers-dao.mjs` (`create`/`findByKey`/`update`) |
| Tier seeding (local) — skips existing aliases | `src/bootstrap/seed-default-tiers.mjs`, called from `src/ploinky/discovery-scheduler.mjs:56` |
| Ploinky resolves manifest env from ancestor `.env` | `ploinky/cli/services/secretVars.js:540-577` → `masterKey.js:51-69` (`loadEnvFile` upward walk) |
| Manifest env precedent | `manifest.json` `AXIOLOGIC_PROXY_API_KEY` entry (`:88`) |
| Stale specs | DS016 `:52-71` (two sections), DS013 `:102,191-194`, `CLAUDE.md:20`, Explorer `explorer/CLAUDE.md:34` + `docs/specs/DS06-ploinky-runtime-invariants.md:27` |

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `proxies/soul-gateway/manifest.json` | Declare `AXL_PROXY_*` env so Ploinky injects them | Modify (`profiles.default.env`) |
| `proxies/soul-gateway/src/config/env.mjs` | Surface `AXL_PROXY_*` from `process.env` | Modify (`:140`) |
| `proxies/soul-gateway/src/bootstrap/axl-proxy-bootstrap.mjs` | Register delegating provider + mirror `/v1/models` | **Create** |
| `proxies/soul-gateway/src/bootstrap.mjs` | Call the bootstrap at startup | Modify (`:75-76`) |
| `proxies/soul-gateway/src/test/unit/manifest-axl-proxy-env.test.mjs` | Assert manifest declares the vars | **Create** |
| `proxies/soul-gateway/src/test/unit/env-axl-proxy.test.mjs` | Assert `readEnv` surfaces the vars | **Create** |
| `proxies/soul-gateway/src/test/unit/axl-proxy-bootstrap.test.mjs` | Unit-test the bootstrap (DI style) | **Create** |
| `proxies/soul-gateway/docs/specs/DS016-ploinky-agent-mode.md` | Reconcile two stale bootstrap sections | Modify (`:52-71`, Migration Notes) |
| `proxies/soul-gateway/docs/specs/DS013-configuration-deployment.md` | Reconcile env-var docs | Modify (`:102,191-194`) |
| `proxies/soul-gateway/CLAUDE.md` | Reconcile stale line | Modify (`:20`) |
| `AssistOSExplorer/docs/specs/DS06-ploinky-runtime-invariants.md` | Reconcile stale provider-bootstrap prose | Modify (`:27`) |
| `AssistOSExplorer/explorer/CLAUDE.md` | Reconcile stale provider-bootstrap prose | Modify (`:34`) |

---

## Task 1: Declare `AXL_PROXY_*` in the soul-gateway manifest

**Files:**
- Modify: `proxies/soul-gateway/manifest.json` (`profiles.default.env`)
- Test: `proxies/soul-gateway/src/test/unit/manifest-axl-proxy-env.test.mjs` (create)

**Interfaces:**
- Produces: three manifest env entries (`AXL_PROXY_API_KEY`, `AXL_PROXY_BASE_URL`, `AXL_PROXY_DISCOVERY_MODE`) that Ploinky resolves from `.secrets`/`process.env`/ancestor-`.env` and injects into the container. Task 2 reads these names from `process.env`.

- [ ] **Step 1: Write the failing test**

Create `proxies/soul-gateway/src/test/unit/manifest-axl-proxy-env.test.mjs`:

```js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const manifestPath = join(here, '../../../manifest.json');

describe('soul-gateway manifest AXL_PROXY_* env', () => {
    it('declares the three AXL_PROXY_* env entries', () => {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
        const env = manifest.profiles.default.env;
        assert.ok(env.AXL_PROXY_API_KEY, 'AXL_PROXY_API_KEY declared');
        assert.equal(env.AXL_PROXY_API_KEY.required, false);
        assert.ok('default' in env.AXL_PROXY_API_KEY);
        assert.ok(env.AXL_PROXY_BASE_URL, 'AXL_PROXY_BASE_URL declared');
        assert.equal(env.AXL_PROXY_BASE_URL.required, false);
        assert.equal(env.AXL_PROXY_DISCOVERY_MODE.default, 'auto');
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/danielsava/work/file-parser/proxies/soul-gateway && node --test src/test/unit/manifest-axl-proxy-env.test.mjs`
Expected: FAIL — `AXL_PROXY_API_KEY declared` assertion throws (entries not present yet).

- [ ] **Step 3: Add the manifest entries**

In `proxies/soul-gateway/manifest.json`, inside `profiles.default.env`, add (after the `LLM_DEFAULT_TIERS` entry, before `AXIOLOGIC_PROXY_API_KEY`):

```json
                "AXL_PROXY_API_KEY": {
                    "required": false,
                    "default": "",
                    "description": "API key for an upstream AXL Proxy (remote soul-gateway). When set, the local gateway mirrors the upstream /v1/models catalog as a delegating 'axl-proxy' provider. Resolved from .secrets, process.env, or the nearest ancestor .env."
                },
                "AXL_PROXY_BASE_URL": {
                    "required": false,
                    "default": "",
                    "description": "Base URL of the upstream AXL Proxy OpenAI-compatible API (e.g. https://soul.axiologic.dev/v1). Required for the mirror to activate."
                },
                "AXL_PROXY_DISCOVERY_MODE": {
                    "required": false,
                    "default": "auto",
                    "description": "auto = sync the upstream /v1/models at startup; off = register the provider/account only."
                },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/danielsava/work/file-parser/proxies/soul-gateway && node --test src/test/unit/manifest-axl-proxy-env.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit** (only after user confirmation)

```bash
cd /Users/danielsava/work/file-parser/proxies
git add soul-gateway/manifest.json soul-gateway/src/test/unit/manifest-axl-proxy-env.test.mjs
git commit -m "Declare AXL_PROXY_* env in soul-gateway manifest"
```

---

## Task 2: Read `AXL_PROXY_*` in the env reader

**Files:**
- Modify: `proxies/soul-gateway/src/config/env.mjs:140`
- Test: `proxies/soul-gateway/src/test/unit/env-axl-proxy.test.mjs` (create)

**Interfaces:**
- Consumes: env names from Task 1.
- Produces: `config.env.AXL_PROXY_API_KEY` (string|null), `config.env.AXL_PROXY_BASE_URL` (string|null), `config.env.AXL_PROXY_DISCOVERY_MODE` (string, default `'auto'`). Task 3 reads these.

- [ ] **Step 1: Write the failing test**

Create `proxies/soul-gateway/src/test/unit/env-axl-proxy.test.mjs`:

```js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { readEnv } from '../../config/env.mjs';

describe('readEnv AXL_PROXY_*', () => {
    it('defaults key/base-url to null and discovery-mode to auto', () => {
        const env = readEnv({});
        assert.equal(env.AXL_PROXY_API_KEY, null);
        assert.equal(env.AXL_PROXY_BASE_URL, null);
        assert.equal(env.AXL_PROXY_DISCOVERY_MODE, 'auto');
    });

    it('reads provided values', () => {
        const env = readEnv({
            AXL_PROXY_API_KEY: 'k',
            AXL_PROXY_BASE_URL: 'https://soul.axiologic.dev/v1',
            AXL_PROXY_DISCOVERY_MODE: 'off',
        });
        assert.equal(env.AXL_PROXY_API_KEY, 'k');
        assert.equal(env.AXL_PROXY_BASE_URL, 'https://soul.axiologic.dev/v1');
        assert.equal(env.AXL_PROXY_DISCOVERY_MODE, 'off');
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/danielsava/work/file-parser/proxies/soul-gateway && node --test src/test/unit/env-axl-proxy.test.mjs`
Expected: FAIL — `env.AXL_PROXY_DISCOVERY_MODE` is `undefined`, not `'auto'`.

- [ ] **Step 3: Add the env reads**

In `proxies/soul-gateway/src/config/env.mjs`, immediately after the `SOUL_GATEWAY_API_KEY` line (`:140`), add:

```js
        SOUL_GATEWAY_API_KEY: str(processEnv.SOUL_GATEWAY_API_KEY, null),
        // AXL Proxy delegating mirror. When AXL_PROXY_API_KEY is set, the
        // local gateway mirrors the upstream AXL Proxy /v1/models catalog as a
        // single delegating 'axl-proxy' provider. Request-time inference still
        // flows through achillesAgentLib; this only mirrors the catalog.
        AXL_PROXY_API_KEY: str(processEnv.AXL_PROXY_API_KEY, null),
        AXL_PROXY_BASE_URL: str(processEnv.AXL_PROXY_BASE_URL, null),
        AXL_PROXY_DISCOVERY_MODE: str(
            processEnv.AXL_PROXY_DISCOVERY_MODE,
            'auto'
        ),
```

(The existing `SOUL_GATEWAY_API_KEY` line stays; only the AXL lines are new.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/danielsava/work/file-parser/proxies/soul-gateway && node --test src/test/unit/env-axl-proxy.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit** (only after user confirmation)

```bash
cd /Users/danielsava/work/file-parser/proxies
git add soul-gateway/src/config/env.mjs soul-gateway/src/test/unit/env-axl-proxy.test.mjs
git commit -m "Read AXL_PROXY_* env in soul-gateway env reader"
```

---

## Task 3: Create the `axl-proxy-bootstrap` module (core)

**Files:**
- Create: `proxies/soul-gateway/src/bootstrap/axl-proxy-bootstrap.mjs`
- Test: `proxies/soul-gateway/src/test/unit/axl-proxy-bootstrap.test.mjs` (create)

**Interfaces:**
- Consumes: `appCtx` (`{ pool, log, config: { env } }`) with `config.env.AXL_PROXY_*` from Task 2; `appCtx.services.encryptionKey` (installed by `installProviderAuthServices`, used by `upsertProviderApiKeyAccount`); primitives `providersDao.{findByKey,create,update}`, `upsertProviderApiKeyAccount({appCtx,providerId,providerDisplayName,apiKey})`, `autoProvisionModels(appCtx, provider, oauthAdapterKey, opts)`.
- Produces: `export async function bootstrapAxlProxyProvider({ appCtx, deps })` returning `{ configured: boolean, discovered?: number, provider?: object }`. Task 4 calls `bootstrapAxlProxyProvider({ appCtx })`.

- [ ] **Step 1: Write the failing test**

Create `proxies/soul-gateway/src/test/unit/axl-proxy-bootstrap.test.mjs`:

```js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { bootstrapAxlProxyProvider } from '../../bootstrap/axl-proxy-bootstrap.mjs';

const SILENT_LOG = { debug() {}, info() {}, warn() {}, error() {} };

function makeAppCtx(env = {}) {
    return { pool: {}, log: SILENT_LOG, config: { env } };
}

function makeDeps({ existingProvider = null } = {}) {
    const calls = { create: [], update: [], upsert: [], autoProvision: [] };
    const providersDao = {
        async findByKey() {
            return existingProvider;
        },
        async create(_pool, spec) {
            calls.create.push(spec);
            return { id: 'prov-1', ...spec };
        },
        async update(_pool, id, fields) {
            calls.update.push({ id, fields });
            return { id, ...fields };
        },
    };
    const upsertProviderApiKeyAccount = async (args) => {
        calls.upsert.push(args);
        return { id: 'acct-1' };
    };
    const autoProvisionModels = async (_ctx, provider, _oauth, opts) => {
        calls.autoProvision.push({ provider, opts });
        return { discovered: 3, created: 3, updated: 0, disabled: 0, models: [] };
    };
    return {
        deps: { providersDao, upsertProviderApiKeyAccount, autoProvisionModels },
        calls,
    };
}

describe('bootstrapAxlProxyProvider', () => {
    it('skips when AXL_PROXY_API_KEY is unset', async () => {
        const { deps, calls } = makeDeps();
        const result = await bootstrapAxlProxyProvider({
            appCtx: makeAppCtx({}),
            deps,
        });
        assert.equal(result.configured, false);
        assert.equal(calls.create.length, 0);
        assert.equal(calls.autoProvision.length, 0);
    });

    it('skips when base URL is missing', async () => {
        const { deps, calls } = makeDeps();
        const result = await bootstrapAxlProxyProvider({
            appCtx: makeAppCtx({ AXL_PROXY_API_KEY: 'k' }),
            deps,
        });
        assert.equal(result.configured, false);
        assert.equal(calls.create.length, 0);
    });

    it('creates the delegating provider, stores the key, and mirrors models', async () => {
        const { deps, calls } = makeDeps();
        const result = await bootstrapAxlProxyProvider({
            appCtx: makeAppCtx({
                AXL_PROXY_API_KEY: 'k',
                AXL_PROXY_BASE_URL: 'https://soul.axiologic.dev/v1/',
            }),
            deps,
        });
        assert.equal(result.configured, true);
        assert.equal(calls.create.length, 1);
        assert.equal(calls.create[0].providerKey, 'axl-proxy');
        assert.equal(calls.create[0].adapterKey, 'openai-api');
        assert.equal(calls.create[0].kind, 'external_api');
        // trailing slash stripped
        assert.equal(calls.create[0].baseUrl, 'https://soul.axiologic.dev/v1');
        assert.equal(calls.upsert.length, 1);
        assert.equal(calls.upsert[0].apiKey, 'k');
        assert.equal(calls.autoProvision.length, 1);
        assert.equal(
            calls.autoProvision[0].opts.refreshReason,
            'axl-proxy-bootstrap'
        );
        assert.equal(result.discovered, 3);
    });

    it('reconciles an existing provider instead of creating one', async () => {
        const existingProvider = {
            id: 'prov-1',
            provider_key: 'axl-proxy',
            display_name: 'Old Name',
            kind: 'external_api',
            adapter_key: 'openai-api',
            auth_strategy: 'api_key',
            base_url: 'https://old.example/v1',
            enabled: true,
        };
        const { deps, calls } = makeDeps({ existingProvider });
        const result = await bootstrapAxlProxyProvider({
            appCtx: makeAppCtx({
                AXL_PROXY_API_KEY: 'k',
                AXL_PROXY_BASE_URL: 'https://soul.axiologic.dev/v1',
            }),
            deps,
        });
        assert.equal(calls.create.length, 0);
        assert.equal(calls.update.length, 1);
        assert.equal(
            calls.update[0].fields.baseUrl,
            'https://soul.axiologic.dev/v1'
        );
        assert.equal(result.discovered, 3);
    });

    it('registers the provider but skips discovery when DISCOVERY_MODE=off', async () => {
        const { deps, calls } = makeDeps();
        const result = await bootstrapAxlProxyProvider({
            appCtx: makeAppCtx({
                AXL_PROXY_API_KEY: 'k',
                AXL_PROXY_BASE_URL: 'https://x/v1',
                AXL_PROXY_DISCOVERY_MODE: 'off',
            }),
            deps,
        });
        assert.equal(result.configured, true);
        assert.equal(calls.create.length, 1);
        assert.equal(calls.autoProvision.length, 0);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/danielsava/work/file-parser/proxies/soul-gateway && node --test src/test/unit/axl-proxy-bootstrap.test.mjs`
Expected: FAIL — module `../../bootstrap/axl-proxy-bootstrap.mjs` does not exist (import error).

- [ ] **Step 3: Write the module**

Create `proxies/soul-gateway/src/bootstrap/axl-proxy-bootstrap.mjs`:

```js
/**
 * axl-proxy-bootstrap.mjs — register an upstream AXL Proxy (remote
 * soul-gateway) as a single delegating provider and mirror its /v1/models
 * catalog at startup.
 *
 * Activated only when AXL_PROXY_API_KEY (and AXL_PROXY_BASE_URL) are present
 * (injected by Ploinky from the nearest ancestor .env via the soul-gateway
 * manifest). No-ops cleanly otherwise.
 *
 * Tier precedence: this bootstrap NEVER creates or reassigns the bare
 * fast/plan/deep aliases. seed-default-tiers keeps those on the local
 * default-local-llm; the upstream's own tier entries are mirrored as
 * reachable `axl-proxy/<id>` models via /v1/models, not as local aliases.
 *
 * Provider boundary: discovery uses the openai-api backend's direct
 * GET {base}/models (allowed for discovery). Request-time inference still
 * flows through achillesAgentLib.
 */
import * as providersDaoModule from '../db/dao/providers-dao.mjs';
import { upsertProviderApiKeyAccount } from '../runtime/providers/api-key-account.mjs';
import { autoProvisionModels } from '../runtime/providers/auto-provisioner.mjs';

const PROVIDER_KEY = 'axl-proxy';
const DISPLAY_NAME = 'AXL Proxy';
const ADAPTER_KEY = 'openai-api';
const PROVIDER_KIND = 'external_api';
const AUTH_STRATEGY = 'api_key';
const DISCOVERY_MODE_OFF = 'off';
const REFRESH_REASON = 'axl-proxy-bootstrap';

const DEFAULT_DEPS = Object.freeze({
    providersDao: providersDaoModule,
    upsertProviderApiKeyAccount,
    autoProvisionModels,
});

function normalizeBaseUrl(value) {
    const baseUrl = String(value || '').trim();
    if (!baseUrl) return '';
    return baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
}

function normalizeDiscoveryMode(value) {
    const mode = String(value || 'auto').trim().toLowerCase();
    return mode === DISCOVERY_MODE_OFF ? DISCOVERY_MODE_OFF : 'auto';
}

async function ensureProvider({ appCtx, deps, baseUrl }) {
    const { pool, log } = appCtx;
    const existing = await deps.providersDao.findByKey(pool, PROVIDER_KEY);
    if (!existing) {
        const created = await deps.providersDao.create(pool, {
            providerKey: PROVIDER_KEY,
            displayName: DISPLAY_NAME,
            kind: PROVIDER_KIND,
            adapterKey: ADAPTER_KEY,
            authStrategy: AUTH_STRATEGY,
            baseUrl,
            enabled: true,
            supportsStreaming: true,
            supportsTools: true,
            metadata: { remoteGateway: true, bootstrap: PROVIDER_KEY },
        });
        log?.info?.('AXL Proxy provider created', { id: created.id, baseUrl });
        return created;
    }

    const fields = {};
    if (existing.display_name !== DISPLAY_NAME) fields.displayName = DISPLAY_NAME;
    if (existing.kind !== PROVIDER_KIND) fields.kind = PROVIDER_KIND;
    if (existing.adapter_key !== ADAPTER_KEY) fields.adapterKey = ADAPTER_KEY;
    if (existing.auth_strategy !== AUTH_STRATEGY) fields.authStrategy = AUTH_STRATEGY;
    if (existing.base_url !== baseUrl) fields.baseUrl = baseUrl;
    if (existing.enabled !== true) fields.enabled = true;
    if (Object.keys(fields).length === 0) return existing;

    const updated = await deps.providersDao.update(pool, existing.id, fields);
    log?.info?.('AXL Proxy provider reconciled', { id: existing.id, baseUrl });
    return updated || { ...existing, ...fields };
}

/**
 * @param {object} args
 * @param {object} args.appCtx
 * @param {object} [args.deps] injectable { providersDao, upsertProviderApiKeyAccount, autoProvisionModels }
 * @returns {Promise<{ configured: boolean, discovered?: number, provider?: object }>}
 */
export async function bootstrapAxlProxyProvider({ appCtx, deps = DEFAULT_DEPS }) {
    const { config, pool, log } = appCtx;
    const env = config?.env || {};

    if (!pool) return { configured: false };
    if (!env.AXL_PROXY_API_KEY) {
        log?.info?.('AXL_PROXY_API_KEY not set, skipping AXL Proxy bootstrap');
        return { configured: false };
    }

    const baseUrl = normalizeBaseUrl(env.AXL_PROXY_BASE_URL);
    if (!baseUrl) {
        log?.warn?.(
            'AXL_PROXY_API_KEY set but AXL_PROXY_BASE_URL missing; ' +
                'skipping AXL Proxy bootstrap'
        );
        return { configured: false };
    }

    const provider = await ensureProvider({ appCtx, deps, baseUrl });
    await deps.upsertProviderApiKeyAccount({
        appCtx,
        providerId: provider.id,
        providerDisplayName: DISPLAY_NAME,
        apiKey: env.AXL_PROXY_API_KEY,
    });

    if (normalizeDiscoveryMode(env.AXL_PROXY_DISCOVERY_MODE) === DISCOVERY_MODE_OFF) {
        log?.info?.('AXL Proxy model discovery disabled (DISCOVERY_MODE=off)');
        return { configured: true, discovered: 0, provider };
    }

    const result = await deps.autoProvisionModels(appCtx, provider, null, {
        strict: false,
        discoverySource: 'auto_provisioned',
        refreshReason: REFRESH_REASON,
    });
    log?.info?.('AXL Proxy catalog mirrored', {
        provider: PROVIDER_KEY,
        baseUrl,
        discovered: result.discovered,
    });
    return { configured: true, discovered: result.discovered, provider };
}

export default { bootstrapAxlProxyProvider };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/danielsava/work/file-parser/proxies/soul-gateway && node --test src/test/unit/axl-proxy-bootstrap.test.mjs`
Expected: PASS (5 tests). Note: the module imports no aliases DAO and has no alias logic, structurally guaranteeing "no bare tier aliases created" (Q3).

- [ ] **Step 5: Commit** (only after user confirmation)

```bash
cd /Users/danielsava/work/file-parser/proxies
git add soul-gateway/src/bootstrap/axl-proxy-bootstrap.mjs soul-gateway/src/test/unit/axl-proxy-bootstrap.test.mjs
git commit -m "Add AXL Proxy delegating-provider bootstrap"
```

---

## Task 4: Wire the bootstrap into startup

**Files:**
- Modify: `proxies/soul-gateway/src/bootstrap.mjs` (import + call between `:75` and `:76`)

**Interfaces:**
- Consumes: `bootstrapAxlProxyProvider({ appCtx })` from Task 3.

- [ ] **Step 1: Add the import**

In `proxies/soul-gateway/src/bootstrap.mjs`, after the `discovery-scheduler` import block (around `:27`), add:

```js
import {
    runInitialPloinkyReconcile,
    startPloinkyDiscoveryTimer,
} from './ploinky/discovery-scheduler.mjs';
import { bootstrapAxlProxyProvider } from './bootstrap/axl-proxy-bootstrap.mjs';
```

- [ ] **Step 2: Add the call before the snapshot is built**

In `bootstrap()`, between `reconcileProvidersOnStartup(appCtx)` (`:75`) and `installSnapshotServices(appCtx)` (`:76`):

```js
    await runInitialPloinkyReconcile(appCtx);
    await reconcileProvidersOnStartup(appCtx);
    // Mirror an upstream AXL Proxy catalog when AXL_PROXY_API_KEY is set.
    // No-op when unset. Runs before installSnapshotServices so the initial
    // snapshot includes the mirrored provider/models. Never throws on a
    // failed upstream (autoProvisionModels is strict:false).
    await bootstrapAxlProxyProvider({ appCtx });
    await installSnapshotServices(appCtx);
```

- [ ] **Step 3: Verify the full unit suite still passes**

Run: `cd /Users/danielsava/work/file-parser/proxies/soul-gateway && npm run test:unit`
Expected: PASS, including the three new test files. No previously-passing test regresses.

- [ ] **Step 4: Verify the call placement**

Run: `cd /Users/danielsava/work/file-parser/proxies/soul-gateway && grep -n "bootstrapAxlProxyProvider" src/bootstrap.mjs`
Expected: two lines — the import and the call between `reconcileProvidersOnStartup` and `installSnapshotServices`.

- [ ] **Step 5: Commit** (only after user confirmation)

```bash
cd /Users/danielsava/work/file-parser/proxies
git add soul-gateway/src/bootstrap.mjs
git commit -m "Run AXL Proxy bootstrap during startup before snapshot load"
```

---

## Task 5: Reconcile soul-gateway specs + CLAUDE.md

The deleted commit `c9ed615` removed **both** `bootstrapLocalLlmProvider` (`LOCAL_LLM_*`) and `bootstrapSoulGatewayProvider` (`SOUL_GATEWAY_PROVIDER_*`). DS016 still documents both as live (`:52-71`). Replace them with the current reality + the new AXL Proxy mirror.

**Files:**
- Modify: `proxies/soul-gateway/docs/specs/DS016-ploinky-agent-mode.md` (`:52-71`, Migration Notes `:151`)
- Modify: `proxies/soul-gateway/docs/specs/DS013-configuration-deployment.md` (`:102`, `:191-194`)
- Modify: `proxies/soul-gateway/CLAUDE.md` (`:20`)

- [ ] **Step 1: DS016 — replace the two stale bootstrap sections**

Replace the `## Local LLM Bootstrap` and `## Soul Gateway Provider Bootstrap` sections (lines 52–71) with a single section that describes the current local-hub model and the AXL Proxy mirror:

```markdown
## Local LLM Hub And Tier Seeding

The local gateway is the LLM hub. There is no `LOCAL_LLM_*` provider
bootstrap and no `SOUL_GATEWAY_PROVIDER_*` bootstrap; both were removed
(commit `c9ed615`, 2026-06-17).

- Local models are discovered from enabled Ploinky agents
  (`runPloinkyReconcileOnce`), keyed `ploinky/<repo>/<agent-model>`.
- `seedDefaultTiers` seeds the tier aliases named in `LLM_DEFAULT_TIERS`
  (default `fast,plan,deep`) onto the model discovered for `LLM_DEFAULT_AGENT`
  (default `default-local-llm`). It **skips** any alias that already exists, so
  the local tiers are stable and owned locally.

## AXL Proxy Delegating Mirror

When `AXL_PROXY_API_KEY` (and `AXL_PROXY_BASE_URL`) are present,
`bootstrapAxlProxyProvider` runs at startup, before `installSnapshotServices`:

- It creates or reconciles provider key `axl-proxy` (display name `AXL Proxy`,
  backend `openai-api`, kind `external_api`, auth strategy `api_key`, base URL
  `AXL_PROXY_BASE_URL`).
- It stores `AXL_PROXY_API_KEY` as an encrypted provider API-key account.
- `AXL_PROXY_DISCOVERY_MODE=auto` (default) syncs the upstream `/v1/models`
  catalog via the openai-api backend's discovery; `off` registers only the
  provider/account. The upstream's own tier entries (`fast`/`plan`/`deep`)
  arrive as reachable `axl-proxy/<id>` models.
- It does **not** create or reassign the bare `fast`/`plan`/`deep` aliases —
  those stay locally owned by `seedDefaultTiers` (local tiers win).
- `AXL_PROXY_API_KEY`/`AXL_PROXY_BASE_URL` are declared in the soul-gateway
  manifest and injected by Ploinky from `.secrets`, `process.env`, or the
  nearest ancestor `.env` (no agent-specific framework code).
```

- [ ] **Step 2: DS016 — add a Migration Notes entry**

Under `## Migration Notes`, append:

```markdown
- 2026-06-17 (`c9ed615`): removed `LOCAL_LLM_*` and `SOUL_GATEWAY_PROVIDER_*`
  bootstraps in favor of the local-hub + `seedDefaultTiers` model. The
  delegate-to-a-remote-gateway capability is reintroduced under `AXL_PROXY_*`
  as the AXL Proxy delegating mirror (models-only; local tiers retained).
```

- [ ] **Step 3: DS013 — replace the stale prose at `:102`**

Replace the sentence(s) referencing `SOUL_GATEWAY_PROVIDER_API_KEY`/`_BASE_URL` with:

```markdown
Explorer production uses the generated-key path for local calls. To delegate to
an upstream AXL Proxy (e.g. `soul.axiologic.dev`), set `AXL_PROXY_API_KEY` and
`AXL_PROXY_BASE_URL`; the local gateway then registers a delegating `axl-proxy`
provider and mirrors the upstream `/v1/models`. This keeps the Explorer-local
gateway as the reference policy, logging, budget, and settings surface, with
local `fast/plan/deep` tiers retained.
```

- [ ] **Step 4: DS013 — replace the env-var list at `:191-194`**

```markdown
- `AXL_PROXY_API_KEY` activates the AXL Proxy delegating mirror (register the
  `axl-proxy` provider + mirror its catalog). Resolved by Ploinky from
  `.secrets`, `process.env`, or the nearest ancestor `.env`.
- `AXL_PROXY_BASE_URL` is the upstream OpenAI-compatible base URL
  (e.g. `https://soul.axiologic.dev/v1`); required for the mirror to activate.
- `AXL_PROXY_DISCOVERY_MODE` controls model discovery (`auto` or `off`).
```

- [ ] **Step 5: CLAUDE.md — replace line 20**

```markdown
In Explorer deployments, the local Ploinky-managed Soul Gateway is the reference gateway. To delegate to an upstream AXL Proxy (remote soul-gateway), set `AXL_PROXY_API_KEY` (and `AXL_PROXY_BASE_URL`); the local gateway registers a delegating `axl-proxy` provider and mirrors the upstream `/v1/models`, while the generated local `SOUL_GATEWAY_API_KEY` and locally-owned `fast/plan/deep` tiers are retained.
```

- [ ] **Step 6: Verify no stale references remain and the viewer renders**

Run: `cd /Users/danielsava/work/file-parser/proxies && grep -rniE "SOUL_GATEWAY_PROVIDER|LOCAL_LLM_(BASE_URL|MODEL|API_KEY|DISCOVERY|ALIASES)|bootstrapSoulGatewayProvider|bootstrapLocalLlmProvider" soul-gateway/docs soul-gateway/CLAUDE.md`
Expected: no matches (a Migration Notes mention of the removed names as history is acceptable; if present, confirm it is only the dated history line).

- [ ] **Step 7: Commit** (only after user confirmation)

```bash
cd /Users/danielsava/work/file-parser/proxies
git add soul-gateway/docs/specs/DS016-ploinky-agent-mode.md soul-gateway/docs/specs/DS013-configuration-deployment.md soul-gateway/CLAUDE.md
git commit -m "Reconcile soul-gateway specs with AXL Proxy mirror and local-hub model"
```

---

## Task 6: Reconcile AssistOSExplorer docs

**Files:**
- Modify: `AssistOSExplorer/docs/specs/DS06-ploinky-runtime-invariants.md` (`:27`)
- Modify: `AssistOSExplorer/explorer/CLAUDE.md` (`:34`)

> Keep these in a **separate commit** from the `proxies` changes (different subrepo). The `/services/soul-gateway/management/` references in these files are **unchanged** (Goal B dropped) — only the provider-bootstrap prose changes.

- [ ] **Step 1: DS06 — replace the `SOUL_GATEWAY_PROVIDER_*` clause at `:27`**

Replace the clause beginning "`soul.axiologic.dev` is configured only as a normal `soul-gateway` provider … using `SOUL_GATEWAY_PROVIDER_API_KEY`…" with:

```markdown
Explorer deployments must treat that local Soul Gateway as the reference gateway. To delegate to an upstream AXL Proxy (e.g. `soul.axiologic.dev`), set `AXL_PROXY_API_KEY` (and `AXL_PROXY_BASE_URL`) so the local gateway registers a delegating `axl-proxy` provider and mirrors the upstream catalog. Explorer-started generated gateway credentials must not use `explicitOverride`, because a stale or explicit `SOUL_GATEWAY_API_KEY` would bypass the local gateway.
```

(Leave the trailing sentence about the Settings button / `/services/soul-gateway/management/` as-is.)

- [ ] **Step 2: explorer/CLAUDE.md — replace the `SOUL_GATEWAY_PROVIDER_*` clause at `:34`**

Replace "When production should delegate to `soul.axiologic.dev`, the remote gateway is configured as the normal `soul-gateway` provider … by setting `SOUL_GATEWAY_PROVIDER_API_KEY`, or by setting an operator `SOUL_GATEWAY_API_KEY` … and optionally `SOUL_GATEWAY_PROVIDER_BASE_URL`." with:

```markdown
When production should delegate to an upstream AXL Proxy (`soul.axiologic.dev`), set `AXL_PROXY_API_KEY` and `AXL_PROXY_BASE_URL`; the local gateway registers a delegating `axl-proxy` provider and mirrors the upstream `/v1/models`. Do not use explicit `SOUL_GATEWAY_API_KEY` deployment secrets to bypass the local gateway.
```

(Leave the `soul-gateway-settings` / `/services/soul-gateway/management/` sentence as-is.)

- [ ] **Step 3: Check the Explorer HTML doc**

Run: `cd /Users/danielsava/work/file-parser/AssistOSExplorer && grep -rniE "SOUL_GATEWAY_PROVIDER" docs/`
Expected: no matches. If a match appears (e.g. embedded text in `docs/index.html`), apply the same replacement there; otherwise no HTML edit is needed.

- [ ] **Step 4: Verify no stale references remain**

Run: `cd /Users/danielsava/work/file-parser/AssistOSExplorer && grep -rniE "SOUL_GATEWAY_PROVIDER" docs/specs explorer/CLAUDE.md`
Expected: no matches.

- [ ] **Step 5: Commit** (only after user confirmation)

```bash
cd /Users/danielsava/work/file-parser/AssistOSExplorer
git add docs/specs/DS06-ploinky-runtime-invariants.md explorer/CLAUDE.md
git commit -m "Reconcile Explorer docs with AXL Proxy delegating mirror"
```

---

## Final Verification

- [ ] **Full unit suite (soul-gateway)**

Run: `cd /Users/danielsava/work/file-parser/proxies/soul-gateway && npm run test:unit`
Expected: PASS, including `manifest-axl-proxy-env`, `env-axl-proxy`, `axl-proxy-bootstrap`.

- [ ] **No stale references anywhere**

Run: `cd /Users/danielsava/work/file-parser && grep -rniE "SOUL_GATEWAY_PROVIDER" proxies/soul-gateway/src`
Expected: no matches (src never reintroduced the old names).

- [ ] **Routing untouched (Goal B dropped)**

Run: `cd /Users/danielsava/work/file-parser && git -C proxies diff --name-only; git -C ploinky status --porcelain`
Expected: no changes to `manifest.json` `httpServices`, `RoutingServer.js`, `httpServiceRoutes.js`, `achillesAgentLib`, or routing tests.

- [ ] **Manual end-to-end (documented recipe, run by operator)**

1. Put `AXL_PROXY_API_KEY=<key>` and `AXL_PROXY_BASE_URL=https://soul.axiologic.dev/v1` in an **ancestor** `.env` (e.g. `~/work/.env`) above the deployment dir.
2. Fresh redeploy per the project recipe: `ploinky destroy` + `rm -rf .ploinky` + `ploinky start explorer 8080 --branch=<branch>` at `~/work/testExplorerFresh`.
3. `curl -s http://localhost:8080/services/soul-gateway/v1/models -H "Authorization: Bearer $SOUL_GATEWAY_API_KEY" | jq '.data[].id'`
   Expected: `axl-proxy/*` model ids appear (including `axl-proxy/fast` etc.).
4. Confirm bare `fast`/`plan`/`deep` still resolve to the local `default-local-llm` (the `_alias` entries' `root` points at a `ploinky/...` model, not `axl-proxy/...`).
5. Confirm management still loads at `/services/soul-gateway/management/` (routing unchanged).

---

## Self-Review

**Spec coverage:** Goal A — manifest declaration (Task 1), env reads (Task 2), bootstrap module (Task 3), startup wiring (Task 4). `.env` injection — Task 1 (relies on existing ploinky machinery; verified). Mirror scope + tier precedence — Task 3 (no aliases). Spec reconciliation — Tasks 5–6 (DS016 ×2 sections, DS013, CLAUDE.md, DS06, explorer/CLAUDE.md). Goal B drop — Decisions + Final Verification guard. HTML docs — viewer renders Markdown (no edit), with an explicit Explorer-HTML check (Task 6 Step 3). All covered.

**Placeholder scan:** none — every code/step shows full content and a runnable command.

**Type consistency:** `bootstrapAxlProxyProvider({ appCtx, deps })` signature, `{ configured, discovered, provider }` return, and the `providersDao.{findByKey,create,update}` / `upsertProviderApiKeyAccount` / `autoProvisionModels` signatures are identical across Task 3's module, its test, and Task 4's call site. `refreshReason: 'axl-proxy-bootstrap'` matches between module and test.

**Open follow-ups (non-blocking):** the startup-only mirror is not added to the 60s discovery timer (matches the original deleted behavior; periodic upstream refresh would be a future enhancement). DS016 may benefit from an index-card on the landing page, but that is cosmetic.
