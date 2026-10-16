# Default Tiers as Cascade Models Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the local `fast`, `plan`, and `deep` defaults appear on the Soul Gateway Tiers page by storing them as editable cascade models instead of hidden model aliases, and delete legacy alias rows during promotion.

**Architecture:** `seedDefaultTiers` should continue to run after Ploinky agent discovery, but it should create `models(strategy_kind='cascade')` rows and a single `model_children` binding to the discovered default local model. If a legacy `model_aliases` row exists for a configured default tier and no cascade model exists, promote that alias to a cascade tier that points at the alias target, then delete the alias. If a cascade model already exists, delete any same-name alias so exact model lookup remains the only source of truth.

**Tech Stack:** Node.js ES modules, `node:test`, embedded SQLite-compatible DAO layer, Soul Gateway management runtime snapshot.

---

## Execution Preconditions

- Work from an isolated worktree/branch at implementation time. Do not implement directly on `main` unless the user explicitly asks.
- Read `/Users/danielsava/work/file-parser/CLAUDE.md`, `/Users/danielsava/work/file-parser/proxies/CLAUDE.md`, and `/Users/danielsava/work/file-parser/proxies/soul-gateway/CLAUDE.md` before editing.
- Use `superpowers:test-driven-development` before production-code edits.
- Keep scope inside `/Users/danielsava/work/file-parser/proxies/soul-gateway` unless verification proves another repo is required.
- Do not change the Ploinky router or the public API wire format for this task.

## Current Root Cause

The live local database currently has:

```json
{
  "directModels": 18,
  "cascadeModels": 0,
  "aliases": [
    { "alias": "deep", "model_key": "proxies/default-local-llm" },
    { "alias": "fast", "model_key": "proxies/default-local-llm" },
    { "alias": "plan", "model_key": "proxies/default-local-llm" }
  ]
}
```

`seedDefaultTiers` writes `fast`, `plan`, and `deep` into `model_aliases`. The Tiers page calls `/management/tiers`, whose handler lists only rows where `models.strategy_kind === 'cascade'`. Therefore runtime requests resolve through aliases, but the Tiers dashboard correctly shows "No tiers configured".

## File Structure

| File | Change |
| --- | --- |
| `src/db/dao/models-dao.mjs` | Add a focused `createCascade` helper for cascade model rows. |
| `src/db/dao/model-aliases-dao.mjs` | Add `deleteByAlias` so seeding can remove promoted legacy aliases. |
| `src/test/unit/dao-queries.test.mjs` | Pin the new DAO exports. |
| `src/bootstrap/seed-default-tiers.mjs` | Change default tier seeding from alias creation to cascade model creation and legacy alias promotion/deletion. |
| `src/test/unit/seed-default-tiers.test.mjs` | Replace alias-seeding expectations with cascade-tier creation, promotion, deletion, skip, and no-op tests. |
| `docs/specs/DS016-ploinky-agent-mode.md` | Update the local hub contract: default tiers are cascade models, not aliases. |
| `docs/specs/DS013-configuration-deployment.md` | Update deployment wording to match the cascade-tier behavior. |

---

## Task 1: Add DAO helpers for cascade creation and alias deletion

**Files:**
- Modify: `src/test/unit/dao-queries.test.mjs`
- Modify: `src/db/dao/models-dao.mjs`
- Modify: `src/db/dao/model-aliases-dao.mjs`

- [ ] **Step 1: Write failing DAO export tests**

In `src/test/unit/dao-queries.test.mjs`, update the expected exports.

For the `models-dao` test, add `createCascade` to the `expected` array:

```js
const expected = [
    'create',
    'createCascade',
    'findById',
    'findByKey',
    'list',
    'update',
    'del',
    'delByProvider',
    'enable',
    'disable',
    'listByProvider',
];
```

For the `model-aliases-dao` test, add `deleteByAlias`:

```js
const expected = [
    'create',
    'findByAlias',
    'updateModel',
    'listByModel',
    'deleteByModel',
    'deleteByAlias',
];
```

- [ ] **Step 2: Run the DAO tests to verify RED**

Run:

```bash
cd /Users/danielsava/work/file-parser/proxies/soul-gateway
node --test src/test/unit/dao-queries.test.mjs
```

Expected: FAIL with missing exports for `createCascade` and `deleteByAlias`.

- [ ] **Step 3: Implement `modelsDao.createCascade`**

In `src/db/dao/models-dao.mjs`, add this function after `create(...)` and before `findById(...)`:

```js
export async function createCascade(
    pool,
    {
        modelKey,
        displayName,
        enabled = true,
        maxAttempts = 5,
        discoverySource = 'manual',
        metadata = {},
    }
) {
    const id = randomUUID();
    const { rows } = await pool.query(
        `INSERT INTO ${TABLE}
       (model_key, display_name, enabled, strategy_kind, max_attempts,
        discovery_source, metadata, id)
     VALUES ($1, $2, $3, 'cascade', $4, $5, $6, $7)
     RETURNING *`,
        [
            modelKey,
            displayName,
            enabled,
            maxAttempts,
            discoverySource,
            JSON.stringify(metadata),
            id,
        ]
    );
    return rows[0];
}
```

This intentionally leaves `provider_id`, `provider_model_id`, and `execution_kind` null so it satisfies the schema check for cascade models.

- [ ] **Step 4: Implement `modelAliasesDao.deleteByAlias`**

In `src/db/dao/model-aliases-dao.mjs`, add this function after `deleteByModel(...)`:

```js
export async function deleteByAlias(pool, alias) {
    const { rowCount } = await pool.query(
        `DELETE FROM ${TABLE} WHERE alias = $1`,
        [alias]
    );
    return rowCount > 0;
}
```

- [ ] **Step 5: Run the DAO tests to verify GREEN**

Run:

```bash
cd /Users/danielsava/work/file-parser/proxies/soul-gateway
node --test src/test/unit/dao-queries.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit Task 1**

```bash
git add src/test/unit/dao-queries.test.mjs src/db/dao/models-dao.mjs src/db/dao/model-aliases-dao.mjs
git commit -m "Add cascade tier DAO helpers"
```

---

## Task 2: Rewrite default-tier tests for cascade seeding and alias deletion

**Files:**
- Modify: `src/test/unit/seed-default-tiers.test.mjs`

- [ ] **Step 1: Replace the test helpers**

In `src/test/unit/seed-default-tiers.test.mjs`, replace the helper section from `const DISCOVERED_MODEL = ...` through `function makeAppCtx(...)` with this code:

```js
const SILENT_LOG = { debug() {}, info() {}, warn() {}, error() {} };

const DISCOVERED_MODEL = {
    id: 'model-uuid-1',
    model_key: 'proxies/default-local-llm',
    enabled: true,
    metadata: {
        discoverySource: 'ploinky-agent-discovery',
        agent: 'default-local-llm',
    },
};

const OTHER_DISCOVERED_MODEL = {
    id: 'model-uuid-2',
    model_key: 'proxies/other-local-llm',
    enabled: true,
    metadata: {
        discoverySource: 'ploinky-agent-discovery',
        agent: 'other-local',
    },
};

const LEGACY_ALIAS_TARGET = {
    id: 'legacy-target-model',
    model_key: 'custom/provider-model',
    enabled: true,
    metadata: {
        discoverySource: 'manual',
        agent: 'custom',
    },
};

function makeModelsDao(seed = [DISCOVERED_MODEL], existingModels = []) {
    const existingByKey = new Map(
        existingModels.map((model) => [model.model_key, { ...model }])
    );
    const createdCascade = [];

    return {
        existingByKey,
        createdCascade,
        async list(_pool, options) {
            if (options?.limit === 500 && options?.offset > 0) return [];
            return seed;
        },
        async findByKey(_pool, modelKey) {
            return existingByKey.get(modelKey) || null;
        },
        async createCascade(_pool, fields) {
            const row = {
                id: `tier-${fields.modelKey}`,
                model_key: fields.modelKey,
                display_name: fields.displayName,
                enabled: fields.enabled ?? true,
                strategy_kind: 'cascade',
                max_attempts: fields.maxAttempts ?? 5,
                metadata: fields.metadata ?? {},
            };
            createdCascade.push({ ...fields, row });
            existingByKey.set(fields.modelKey, row);
            return row;
        },
    };
}

function makeAliasesDao(existing = []) {
    const rows = existing.map((row) => ({ ...row }));
    const deletedAliases = [];

    return {
        rows,
        deletedAliases,
        async findByAlias(_pool, alias) {
            return rows.find((row) => row.alias === alias) || null;
        },
        async create() {
            throw new Error('seedDefaultTiers must not create model aliases');
        },
        async deleteByAlias(_pool, alias) {
            const index = rows.findIndex((row) => row.alias === alias);
            if (index === -1) return false;
            rows.splice(index, 1);
            deletedAliases.push(alias);
            return true;
        },
    };
}

function makeModelChildrenDao() {
    const replacements = [];
    return {
        replacements,
        async replaceChildren(_pool, parentModelId, children) {
            replacements.push({
                parentModelId,
                children: children.map((child) => ({ ...child })),
            });
        },
    };
}

function makeDaos({
    seed = [DISCOVERED_MODEL],
    existingModels = [],
    existingAliases = [],
} = {}) {
    const modelsDao = makeModelsDao(seed, existingModels);
    const aliasesDao = makeAliasesDao(existingAliases);
    const modelChildrenDao = makeModelChildrenDao();
    return { modelsDao, aliasesDao, modelChildrenDao };
}

function spyRefresh() {
    const calls = [];
    const fn = async (_ctx, opts) => {
        calls.push(opts);
        return {};
    };
    fn.calls = calls;
    return fn;
}

function spyLog() {
    const calls = [];
    return {
        calls,
        debug() {},
        info(msg, data) {
            calls.push({ level: 'info', msg, data });
        },
        warn(msg, data) {
            calls.push({ level: 'warn', msg, data });
        },
        error() {},
    };
}

function makeAppCtx(env = {}, log = SILENT_LOG) {
    return { pool: {}, log, config: { env } };
}
```

- [ ] **Step 2: Replace the test cases**

Still in `src/test/unit/seed-default-tiers.test.mjs`, replace the full `describe('seedDefaultTiers', ...)` block with this block:

```js
describe('seedDefaultTiers', () => {
    it('creates each default tier as a cascade model with the discovered default model as child', async () => {
        const daos = makeDaos();
        const refresh = spyRefresh();
        const log = spyLog();

        const summary = await seedDefaultTiers({
            appCtx: makeAppCtx({
                LLM_DEFAULT_AGENT: 'default-local-llm',
                LLM_DEFAULT_TIERS: 'fast,plan,deep',
            }, log),
            daos,
            refresh,
        });

        assert.deepEqual(summary, {
            seeded: 3,
            promoted: 0,
            skipped: 0,
            aliasesDeleted: 0,
            refreshed: true,
        });
        assert.deepEqual(
            daos.modelsDao.createdCascade.map((entry) => entry.modelKey),
            ['fast', 'plan', 'deep']
        );
        assert.deepEqual(
            daos.modelChildrenDao.replacements.map((entry) => entry.children),
            [
                [{ childModelId: 'model-uuid-1', priority: 1, enabled: true }],
                [{ childModelId: 'model-uuid-1', priority: 1, enabled: true }],
                [{ childModelId: 'model-uuid-1', priority: 1, enabled: true }],
            ]
        );
        assert.equal(daos.aliasesDao.rows.length, 0);
        assert.equal(refresh.calls.length, 1);
        assert.deepEqual(refresh.calls[0], {
            snapshot: true,
            reason: 'seed-default-tiers',
        });
        assert.deepEqual(
            log.calls.map((entry) => entry.msg),
            [
                'seed-default-tiers: created cascade tier',
                'seed-default-tiers: created cascade tier',
                'seed-default-tiers: created cascade tier',
            ]
        );
    });

    it('promotes a legacy alias to a cascade tier and deletes the alias', async () => {
        const daos = makeDaos({
            seed: [DISCOVERED_MODEL, LEGACY_ALIAS_TARGET],
            existingAliases: [{
                alias: 'fast',
                model_id: LEGACY_ALIAS_TARGET.id,
                model_key: LEGACY_ALIAS_TARGET.model_key,
            }],
        });
        const refresh = spyRefresh();

        const summary = await seedDefaultTiers({
            appCtx: makeAppCtx({
                LLM_DEFAULT_AGENT: 'default-local-llm',
                LLM_DEFAULT_TIERS: 'fast',
            }),
            daos,
            refresh,
        });

        assert.deepEqual(summary, {
            seeded: 0,
            promoted: 1,
            skipped: 0,
            aliasesDeleted: 1,
            refreshed: true,
        });
        assert.equal(daos.modelsDao.createdCascade[0].modelKey, 'fast');
        assert.deepEqual(daos.modelChildrenDao.replacements, [{
            parentModelId: 'tier-fast',
            children: [{
                childModelId: LEGACY_ALIAS_TARGET.id,
                priority: 1,
                enabled: true,
            }],
        }]);
        assert.deepEqual(daos.aliasesDao.deletedAliases, ['fast']);
        assert.equal(daos.aliasesDao.rows.length, 0);
        assert.equal(refresh.calls.length, 1);
    });

    it('keeps an existing cascade tier and deletes a same-name legacy alias', async () => {
        const existingCascade = {
            id: 'existing-tier-fast',
            model_key: 'fast',
            display_name: 'fast',
            enabled: true,
            strategy_kind: 'cascade',
        };
        const daos = makeDaos({
            existingModels: [existingCascade],
            existingAliases: [{
                alias: 'fast',
                model_id: DISCOVERED_MODEL.id,
                model_key: DISCOVERED_MODEL.model_key,
            }],
        });
        const refresh = spyRefresh();

        const summary = await seedDefaultTiers({
            appCtx: makeAppCtx({
                LLM_DEFAULT_AGENT: 'default-local-llm',
                LLM_DEFAULT_TIERS: 'fast',
            }),
            daos,
            refresh,
        });

        assert.deepEqual(summary, {
            seeded: 0,
            promoted: 0,
            skipped: 1,
            aliasesDeleted: 1,
            refreshed: true,
        });
        assert.deepEqual(daos.modelsDao.createdCascade, []);
        assert.deepEqual(daos.modelChildrenDao.replacements, []);
        assert.deepEqual(daos.aliasesDao.deletedAliases, ['fast']);
        assert.equal(daos.aliasesDao.rows.length, 0);
        assert.equal(refresh.calls.length, 1);
    });

    it('skips a default tier when a non-cascade model already owns the key', async () => {
        const directFast = {
            id: 'direct-fast',
            model_key: 'fast',
            display_name: 'fast',
            enabled: true,
            strategy_kind: 'direct',
        };
        const daos = makeDaos({
            existingModels: [directFast],
            existingAliases: [{
                alias: 'fast',
                model_id: DISCOVERED_MODEL.id,
                model_key: DISCOVERED_MODEL.model_key,
            }],
        });
        const refresh = spyRefresh();
        const log = spyLog();

        const summary = await seedDefaultTiers({
            appCtx: makeAppCtx({
                LLM_DEFAULT_AGENT: 'default-local-llm',
                LLM_DEFAULT_TIERS: 'fast',
            }, log),
            daos,
            refresh,
        });

        assert.deepEqual(summary, {
            seeded: 0,
            promoted: 0,
            skipped: 1,
            aliasesDeleted: 0,
            refreshed: false,
        });
        assert.deepEqual(daos.modelsDao.createdCascade, []);
        assert.equal(daos.aliasesDao.rows.length, 1);
        assert.equal(refresh.calls.length, 0);
        assert.deepEqual(log.calls, [{
            level: 'warn',
            msg: 'seed-default-tiers: model key already exists and is not a cascade tier',
            data: { alias: 'fast', strategyKind: 'direct' },
        }]);
    });

    it('trims tier names and drops blank tier entries', async () => {
        const daos = makeDaos();
        const refresh = spyRefresh();

        const summary = await seedDefaultTiers({
            appCtx: makeAppCtx({
                LLM_DEFAULT_AGENT: 'default-local-llm',
                LLM_DEFAULT_TIERS: ' fast, ,plan,, deep ',
            }),
            daos,
            refresh,
        });

        assert.equal(summary.seeded, 3);
        assert.deepEqual(
            daos.modelsDao.createdCascade.map((entry) => entry.modelKey),
            ['fast', 'plan', 'deep']
        );
        assert.equal(refresh.calls.length, 1);
    });

    it('ignores disabled models, wrong discovery markers, and wrong agents', async () => {
        const disabledDefault = {
            ...DISCOVERED_MODEL,
            id: 'disabled-default',
            enabled: false,
        };
        const wrongMarker = {
            ...DISCOVERED_MODEL,
            id: 'wrong-marker',
            metadata: { discoverySource: 'manual', agent: 'default-local-llm' },
        };
        const daos = makeDaos({
            seed: [
                disabledDefault,
                wrongMarker,
                OTHER_DISCOVERED_MODEL,
                DISCOVERED_MODEL,
            ],
        });
        const refresh = spyRefresh();

        const summary = await seedDefaultTiers({
            appCtx: makeAppCtx({
                LLM_DEFAULT_AGENT: 'default-local-llm',
                LLM_DEFAULT_TIERS: 'fast',
            }),
            daos,
            refresh,
        });

        assert.equal(summary.seeded, 1);
        assert.deepEqual(daos.modelChildrenDao.replacements[0].children, [{
            childModelId: DISCOVERED_MODEL.id,
            priority: 1,
            enabled: true,
        }]);
    });

    it('scans beyond the first enabled model page for the default agent', async () => {
        const daos = makeDaos();
        const calls = [];
        const nonmatchingModels = Array.from({ length: 500 }, (_value, index) => ({
            id: `nonmatching-${index}`,
            model_key: `ploinky/nonmatching-${index}`,
            enabled: true,
            metadata: {
                discoverySource: 'ploinky-agent-discovery',
                agent: `nonmatching-${index}`,
            },
        }));
        daos.modelsDao.list = async (_pool, options) => {
            calls.push(options);
            if (options.limit === 500 && options.offset === 0) {
                return nonmatchingModels;
            }
            if (options.limit === 500 && options.offset === 500) {
                return [DISCOVERED_MODEL];
            }
            return [];
        };
        const refresh = spyRefresh();

        const summary = await seedDefaultTiers({
            appCtx: makeAppCtx({
                LLM_DEFAULT_AGENT: 'default-local-llm',
                LLM_DEFAULT_TIERS: 'fast',
            }),
            daos,
            refresh,
        });

        assert.equal(summary.seeded, 1);
        assert.deepEqual(
            calls.map((options) => options.offset),
            [0, 500]
        );
    });

    it('no-ops when the default agent is not discovered', async () => {
        const daos = makeDaos({ seed: [] });
        const refresh = spyRefresh();
        const log = spyLog();

        const summary = await seedDefaultTiers({
            appCtx: makeAppCtx({
                LLM_DEFAULT_AGENT: 'default-local-llm',
                LLM_DEFAULT_TIERS: 'fast,plan,deep',
            }, log),
            daos,
            refresh,
        });

        assert.deepEqual(summary, {
            seeded: 0,
            promoted: 0,
            skipped: 0,
            aliasesDeleted: 0,
            refreshed: false,
        });
        assert.deepEqual(daos.modelsDao.createdCascade, []);
        assert.equal(refresh.calls.length, 0);
        assert.deepEqual(log.calls, [{
            level: 'info',
            msg: 'seed-default-tiers: default agent not discovered yet',
            data: { agent: 'default-local-llm' },
        }]);
    });

    it('no-ops when LLM_DEFAULT_AGENT is unset or LLM_DEFAULT_TIERS is blank', async () => {
        for (const env of [
            { LLM_DEFAULT_TIERS: 'fast,plan,deep' },
            { LLM_DEFAULT_AGENT: 'default-local-llm', LLM_DEFAULT_TIERS: '' },
            { LLM_DEFAULT_AGENT: 'default-local-llm', LLM_DEFAULT_TIERS: ' , ,' },
        ]) {
            const daos = makeDaos();
            const refresh = spyRefresh();

            const summary = await seedDefaultTiers({
                appCtx: makeAppCtx(env),
                daos,
                refresh,
            });

            assert.deepEqual(summary, {
                seeded: 0,
                promoted: 0,
                skipped: 0,
                aliasesDeleted: 0,
                refreshed: false,
            });
            assert.deepEqual(daos.modelsDao.createdCascade, []);
            assert.equal(refresh.calls.length, 0);
        }
    });
});
```

- [ ] **Step 3: Run the default-tier tests to verify RED**

Run:

```bash
cd /Users/danielsava/work/file-parser/proxies/soul-gateway
node --test src/test/unit/seed-default-tiers.test.mjs
```

Expected: FAIL because current `seedDefaultTiers` calls `aliasesDao.create(...)` and never calls `modelsDao.createCascade(...)`, `modelChildrenDao.replaceChildren(...)`, or `aliasesDao.deleteByAlias(...)`.

- [ ] **Step 4: Commit the failing tests**

```bash
git add src/test/unit/seed-default-tiers.test.mjs
git commit -m "test: expect default tiers to seed cascade models"
```

---

## Task 3: Implement cascade seeding and legacy alias promotion

**Files:**
- Modify: `src/bootstrap/seed-default-tiers.mjs`

- [ ] **Step 1: Update imports and defaults**

In `src/bootstrap/seed-default-tiers.mjs`, replace the DAO imports and constants at the top with:

```js
import * as modelsDao from '../db/dao/models-dao.mjs';
import * as aliasesDao from '../db/dao/model-aliases-dao.mjs';
import * as modelChildrenDao from '../db/dao/model-children-dao.mjs';
import { performRuntimeRefresh } from '../runtime/registry/runtime-refresh.mjs';

const DISCOVERY_MARKER = 'ploinky-agent-discovery';
const REFRESH_REASON = 'seed-default-tiers';
const MODEL_PAGE_SIZE = 500;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_DAOS = Object.freeze({
    modelsDao,
    aliasesDao,
    modelChildrenDao,
});
```

- [ ] **Step 2: Add helper functions**

After `findDefaultAgentModel(...)`, add:

```js
function modelKeyOf(row) {
    return row?.model_key || row?.modelKey || null;
}

function makeAliasTargetModel(aliasRow) {
    if (!aliasRow) return null;
    return {
        id: aliasRow.model_id,
        model_key: aliasRow.model_key,
    };
}

function makeTierMetadata({ alias, defaultAgent, childModel }) {
    return {
        seededBy: REFRESH_REASON,
        defaultAgent,
        childModelKey: modelKeyOf(childModel),
        tierKey: alias,
    };
}

async function deleteAliasIfPresent(pool, aliasesDaoImpl, aliasRow, summary) {
    if (!aliasRow) return;
    const deleted = await aliasesDaoImpl.deleteByAlias(pool, aliasRow.alias);
    if (deleted) summary.aliasesDeleted += 1;
}

async function createCascadeTier({
    pool,
    daos,
    alias,
    defaultAgent,
    childModel,
}) {
    const tier = await daos.modelsDao.createCascade(pool, {
        modelKey: alias,
        displayName: alias,
        enabled: true,
        maxAttempts: DEFAULT_MAX_ATTEMPTS,
        discoverySource: 'manual',
        metadata: makeTierMetadata({ alias, defaultAgent, childModel }),
    });

    await daos.modelChildrenDao.replaceChildren(pool, tier.id, [{
        childModelId: childModel.id,
        priority: 1,
        enabled: true,
    }]);

    return tier;
}
```

- [ ] **Step 3: Replace `seedDefaultTiers`**

Replace the full `seedDefaultTiers(...)` function with:

```js
export async function seedDefaultTiers({
    appCtx,
    daos = DEFAULT_DAOS,
    refresh = performRuntimeRefresh,
}) {
    const summary = {
        seeded: 0,
        promoted: 0,
        skipped: 0,
        aliasesDeleted: 0,
        refreshed: false,
    };
    const pool = appCtx?.pool;
    if (!pool) return summary;

    const env = appCtx?.config?.env || {};
    const defaultAgent = String(env.LLM_DEFAULT_AGENT || '').trim();
    if (!defaultAgent) return summary;

    const tiers = parseTiers(env.LLM_DEFAULT_TIERS);
    if (tiers.length === 0) return summary;

    const defaultModel = await findDefaultAgentModel(
        pool,
        daos.modelsDao,
        defaultAgent
    );
    if (!defaultModel) {
        appCtx.log?.info?.('seed-default-tiers: default agent not discovered yet', {
            agent: defaultAgent,
        });
        return summary;
    }

    for (const alias of tiers) {
        const existingTier = await daos.modelsDao.findByKey(pool, alias);
        const existingAlias = await daos.aliasesDao.findByAlias(pool, alias);

        if (existingTier) {
            summary.skipped += 1;

            if (existingTier.strategy_kind === 'cascade') {
                await deleteAliasIfPresent(
                    pool,
                    daos.aliasesDao,
                    existingAlias,
                    summary
                );
                continue;
            }

            appCtx.log?.warn?.(
                'seed-default-tiers: model key already exists and is not a cascade tier',
                { alias, strategyKind: existingTier.strategy_kind || 'direct' }
            );
            continue;
        }

        const aliasTarget = makeAliasTargetModel(existingAlias);
        const childModel = aliasTarget || defaultModel;

        await createCascadeTier({
            pool,
            daos,
            alias,
            defaultAgent,
            childModel,
        });

        if (existingAlias) {
            await deleteAliasIfPresent(
                pool,
                daos.aliasesDao,
                existingAlias,
                summary
            );
            summary.promoted += 1;
            appCtx.log?.info?.('seed-default-tiers: promoted alias to cascade tier', {
                alias,
                model: modelKeyOf(childModel),
            });
        } else {
            summary.seeded += 1;
            appCtx.log?.info?.('seed-default-tiers: created cascade tier', {
                alias,
                model: modelKeyOf(childModel),
            });
        }
    }

    if (
        summary.seeded > 0 ||
        summary.promoted > 0 ||
        summary.aliasesDeleted > 0
    ) {
        await refresh(appCtx, { snapshot: true, reason: REFRESH_REASON });
        summary.refreshed = true;
    }

    return summary;
}
```

- [ ] **Step 4: Run the default-tier tests to verify GREEN**

Run:

```bash
cd /Users/danielsava/work/file-parser/proxies/soul-gateway
node --test src/test/unit/seed-default-tiers.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Run nearby regression tests**

Run:

```bash
cd /Users/danielsava/work/file-parser/proxies/soul-gateway
node --test \
  src/test/unit/seed-default-tiers.test.mjs \
  src/test/unit/dao-queries.test.mjs \
  src/test/unit/management.test.mjs \
  src/test/unit/snapshot.test.mjs \
  src/test/unit/model-name-normalizer.test.mjs
```

Expected: PASS. This checks seeding, DAO exports, `/management/tiers`, snapshot loading, and exact model lookup precedence.

- [ ] **Step 6: Commit Task 3**

```bash
git add src/bootstrap/seed-default-tiers.mjs src/test/unit/seed-default-tiers.test.mjs
git commit -m "Seed default tiers as cascade models"
```

---

## Task 4: Update Soul Gateway specs

**Files:**
- Modify: `docs/specs/DS016-ploinky-agent-mode.md`
- Modify: `docs/specs/DS013-configuration-deployment.md`

- [ ] **Step 1: Update DS016 local hub wording**

In `docs/specs/DS016-ploinky-agent-mode.md`, replace the two bullets under "Local LLM Hub And Tier Seeding" with:

```markdown
- Local models are discovered from enabled Ploinky agents
  (`runPloinkyReconcileOnce`), keyed `ploinky/<repo>/<agent-model>`.
- `seedDefaultTiers` creates the tier models named in `LLM_DEFAULT_TIERS`
  (default `fast,plan,deep`) as cascade models, each initially pointing at
  the model discovered for `LLM_DEFAULT_AGENT` (default
  `default-local-llm`). Legacy same-name alias rows are promoted to cascade
  tiers and then deleted, leaving the cascade model as the single source of
  truth for the dashboard and runtime exact lookup.
```

- [ ] **Step 2: Update DS013 local hub wording**

In `docs/specs/DS013-configuration-deployment.md`, replace this paragraph:

```markdown
Explorer production uses the generated-key path for local calls. The local
gateway is the LLM hub and the reference policy, logging, budget, and settings
surface, with local `fast/plan/deep` tiers owned locally; it does not delegate
to a remote gateway.
```

with:

```markdown
Explorer production uses the generated-key path for local calls. The local
gateway is the LLM hub and the reference policy, logging, budget, and settings
surface. Local `fast/plan/deep` defaults are owned locally as cascade tier
models seeded from `LLM_DEFAULT_TIERS`; the gateway does not delegate those
defaults to a remote gateway.
```

- [ ] **Step 3: Run spec/documentation grep check**

Run:

```bash
cd /Users/danielsava/work/file-parser/proxies/soul-gateway
rg -n "tier aliases|aliases named in LLM_DEFAULT_TIERS|seedDefaultTiers.*alias" docs/specs src/bootstrap src/test/unit
```

Expected: no stale contract language that says default tiers are stored as aliases. It is okay for tests and runtime code to mention legacy alias promotion or `model_aliases` generally.

- [ ] **Step 4: Commit Task 4**

```bash
git add docs/specs/DS016-ploinky-agent-mode.md docs/specs/DS013-configuration-deployment.md
git commit -m "docs: clarify default tier cascade seeding"
```

---

## Task 5: Full verification and live dashboard proof

**Files:**
- No production edits expected.

- [ ] **Step 1: Run targeted unit tests**

Run:

```bash
cd /Users/danielsava/work/file-parser/proxies/soul-gateway
node --test \
  src/test/unit/seed-default-tiers.test.mjs \
  src/test/unit/dao-queries.test.mjs \
  src/test/unit/management.test.mjs \
  src/test/unit/snapshot.test.mjs \
  src/test/unit/model-name-normalizer.test.mjs
```

Expected: PASS.

- [ ] **Step 2: Run the full Soul Gateway unit suite**

Run:

```bash
cd /Users/danielsava/work/file-parser/proxies/soul-gateway
npm run test:unit
```

Expected: PASS.

- [ ] **Step 3: Restart the local Soul Gateway agent**

Restart the local `proxies/soul-gateway` agent in the active Ploinky workspace so the updated seeder runs at startup or on the next discovery pass. Use the workspace's normal restart command. One acceptable path from `/Users/danielsava/work/testExplorerFresh` is:

```bash
cd /Users/danielsava/work/testExplorerFresh
ploinky restart soul-gateway
```

If that command is not available in the shell, use the local Ploinky CLI path that started this workspace and restart only the Soul Gateway agent. Do not restart unrelated agents unless required by the local CLI.

- [ ] **Step 4: Verify database promotion**

Run:

```bash
CONTAINER=$(podman ps --format '{{.Names}}' | grep 'ploinky_proxies_soul-gateway_' | head -n 1)
podman exec "$CONTAINER" node --input-type=module -e "
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('/data/soul-gateway.sqlite3', { readOnly: true });
const summary = {
  cascadeTiers: db.prepare(\"select model_key from models where strategy_kind='cascade' and model_key in ('fast','plan','deep') order by model_key\").all().map((r) => r.model_key),
  aliases: db.prepare(\"select alias from model_aliases where alias in ('fast','plan','deep') order by alias\").all().map((r) => r.alias),
  children: db.prepare(\"select parent.model_key as tier, child.model_key as child from model_children mc join models parent on parent.id = mc.parent_model_id join models child on child.id = mc.child_model_id where parent.model_key in ('fast','plan','deep') order by parent.model_key, mc.priority\").all()
};
console.log(JSON.stringify(summary, null, 2));
"
```

Expected:

```json
{
  "cascadeTiers": ["deep", "fast", "plan"],
  "aliases": [],
  "children": [
    { "tier": "deep", "child": "proxies/default-local-llm" },
    { "tier": "fast", "child": "proxies/default-local-llm" },
    { "tier": "plan", "child": "proxies/default-local-llm" }
  ]
}
```

If a legacy alias pointed at a custom model, that tier's `child` should be the legacy alias target instead of `proxies/default-local-llm`; the important invariant is that `aliases` is empty and every default tier is a cascade row with one child.

- [ ] **Step 5: Verify the browser dashboard**

Open or reload:

```text
http://localhost:8080/services/soul-gateway/management/#tiers
```

Expected: the Tiers page shows rows for `deep`, `fast`, and `plan` instead of "No tiers configured". Each row has one child model in its Models column.

- [ ] **Step 6: Verify runtime model resolution still works**

Run a request through the local router:

```bash
CONTAINER=$(podman ps --format '{{.Names}}' | grep 'ploinky_proxies_soul-gateway_' | head -n 1)
KEY=$(podman exec "$CONTAINER" printenv PLOINKY_AGENT_API_KEY)
curl -sS --max-time 45 \
  -X POST http://127.0.0.1:8080/services/soul-gateway/v1/chat/completions \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"fast","messages":[{"role":"user","content":"reply with pong"}],"max_tokens":16}'
```

Expected: HTTP 200 with a normal chat completion. In audit logs, `requested_model` remains `fast`; resolved execution should still reach the local default model.

- [ ] **Step 7: Commit or merge completion**

If all verification passes and the branch is ready, use the repo's finishing workflow. If the user asked to commit directly to `main`, fast-forward/merge intentionally and push. Otherwise open a PR or report the branch and verification status.

---

## Self-Review

- **Spec coverage:** The plan covers the approved behavior: create cascade tiers, promote legacy aliases, delete aliases, preserve existing cascade tiers, skip non-cascade key conflicts, update docs, and verify the Tiers page.
- **Placeholder scan:** There are no `TBD`, `TODO`, or "add tests" placeholders. Code-changing steps include concrete snippets.
- **Type consistency:** The plan consistently uses existing database field names (`model_key`, `strategy_kind`, `model_id`) and existing dashboard/API behavior (`/management/tiers` reads cascade models from `models` plus `model_children`).
- **Residual risk:** Existing manual aliases unrelated to `LLM_DEFAULT_TIERS` remain supported. Only aliases with names configured in `LLM_DEFAULT_TIERS` are deleted during promotion.
