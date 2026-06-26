import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { seedDefaultTiers } from '../../bootstrap/seed-default-tiers.mjs';

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
        seed.map((model) => [model.model_key, { ...model }])
    );
    for (const model of existingModels) {
        existingByKey.set(model.model_key, { ...model });
    }
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
            if (
                typeof fields?.modelKey !== 'string' ||
                fields.modelKey.trim() === ''
            ) {
                throw new Error('modelsDao.createCascade requires modelKey');
            }
            if (
                typeof fields.displayName !== 'string' ||
                fields.displayName.trim() === ''
            ) {
                throw new Error('modelsDao.createCascade requires displayName');
            }
            if (existingByKey.has(fields.modelKey)) {
                throw new Error(`duplicate modelKey: ${fields.modelKey}`);
            }
            const created = {
                modelKey: fields.modelKey,
                displayName: fields.displayName,
                enabled: fields.enabled ?? true,
                maxAttempts: fields.maxAttempts ?? 5,
                discoverySource: fields.discoverySource ?? 'manual',
                metadata: fields.metadata ?? {},
            };
            const row = {
                id: `tier-${created.modelKey}`,
                model_key: created.modelKey,
                display_name: created.displayName,
                enabled: created.enabled,
                strategy_kind: 'cascade',
                max_attempts: created.maxAttempts,
                discovery_source: created.discoverySource,
                metadata: created.metadata,
            };
            createdCascade.push({ ...created, row });
            existingByKey.set(created.modelKey, row);
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

function compactSql(sql) {
    return String(sql).replace(/\s+/g, ' ').trim();
}

function parseJsonParam(value) {
    return typeof value === 'string' ? JSON.parse(value) : value;
}

function makeDefaultDaoSmokePool() {
    const createdCascade = [];
    const childDeletes = [];
    const childInserts = [];
    const existingCascadeByKey = new Map();

    return {
        createdCascade,
        childDeletes,
        childInserts,
        async query(sql, params = []) {
            const normalized = compactSql(sql);

            if (
                normalized.startsWith('SELECT m.*,') &&
                normalized.includes('FROM models m') &&
                normalized.includes('LIMIT $2 OFFSET $3')
            ) {
                const offset = params[2] ?? 0;
                return { rows: offset === 0 ? [DISCOVERED_MODEL] : [] };
            }

            if (normalized === 'SELECT * FROM models WHERE model_key = $1') {
                const row = existingCascadeByKey.get(params[0]);
                return { rows: row ? [row] : [] };
            }

            if (
                normalized ===
                'SELECT ma.*, m.model_key FROM model_aliases ma JOIN models m ON m.id = ma.model_id WHERE ma.alias = $1'
            ) {
                return { rows: [] };
            }

            if (normalized.startsWith('INSERT INTO models')) {
                const row = {
                    id: `tier-${params[0]}`,
                    model_key: params[0],
                    display_name: params[1],
                    enabled: params[2],
                    strategy_kind: 'cascade',
                    max_attempts: params[3],
                    discovery_source: params[4],
                    metadata: parseJsonParam(params[5]),
                };
                createdCascade.push(row);
                existingCascadeByKey.set(row.model_key, row);
                return { rows: [row] };
            }

            if (normalized === 'BEGIN' || normalized === 'COMMIT') {
                return { rows: [] };
            }

            if (
                normalized ===
                'DELETE FROM model_children WHERE parent_model_id = $1'
            ) {
                childDeletes.push(params[0]);
                return { rows: [], rowCount: 1 };
            }

            if (normalized.startsWith('INSERT INTO model_children')) {
                childInserts.push({
                    parentModelId: params[0],
                    childModelId: params[1],
                    priority: params[2],
                    enabled: params[3],
                    settings: parseJsonParam(params[4]),
                });
                return { rows: [] };
            }

            if (normalized === 'ROLLBACK') {
                return { rows: [] };
            }

            throw new Error(`Unexpected SQL in default DAO smoke fake: ${normalized}`);
        },
    };
}

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
            daos.modelsDao.createdCascade.map((entry) => ({
                modelKey: entry.modelKey,
                displayName: entry.displayName,
                enabled: entry.enabled,
                maxAttempts: entry.maxAttempts,
                discoverySource: entry.discoverySource,
            })),
            [
                {
                    modelKey: 'fast',
                    displayName: 'fast',
                    enabled: true,
                    maxAttempts: 5,
                    discoverySource: 'manual',
                },
                {
                    modelKey: 'plan',
                    displayName: 'plan',
                    enabled: true,
                    maxAttempts: 5,
                    discoverySource: 'manual',
                },
                {
                    modelKey: 'deep',
                    displayName: 'deep',
                    enabled: true,
                    maxAttempts: 5,
                    discoverySource: 'manual',
                },
            ]
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

    it('wires default DAOs to create cascade model children without module mocks', async () => {
        const pool = makeDefaultDaoSmokePool();
        const appCtx = makeAppCtx({
            LLM_DEFAULT_AGENT: 'default-local-llm',
            LLM_DEFAULT_TIERS: 'fast',
        });
        appCtx.pool = pool;
        const refresh = spyRefresh();

        const summary = await seedDefaultTiers({
            appCtx,
            refresh,
        });

        assert.deepEqual(summary, {
            seeded: 1,
            promoted: 0,
            skipped: 0,
            aliasesDeleted: 0,
            refreshed: true,
        });
        assert.deepEqual(pool.createdCascade.map((row) => ({
            modelKey: row.model_key,
            displayName: row.display_name,
            enabled: row.enabled,
            maxAttempts: row.max_attempts,
            discoverySource: row.discovery_source,
        })), [{
            modelKey: 'fast',
            displayName: 'fast',
            enabled: true,
            maxAttempts: 5,
            discoverySource: 'manual',
        }]);
        assert.deepEqual(pool.childDeletes, ['tier-fast']);
        assert.deepEqual(pool.childInserts, [{
            parentModelId: 'tier-fast',
            childModelId: DISCOVERED_MODEL.id,
            priority: 1,
            enabled: true,
            settings: {},
        }]);
        assert.equal(refresh.calls.length, 1);
    });

    it('no-ops when appCtx.pool is absent', async () => {
        const daos = makeDaos({
            existingAliases: [{
                alias: 'fast',
                model_id: LEGACY_ALIAS_TARGET.id,
                model_key: LEGACY_ALIAS_TARGET.model_key,
            }],
        });
        const refresh = spyRefresh();

        const summary = await seedDefaultTiers({
            appCtx: {
                log: SILENT_LOG,
                config: {
                    env: {
                        LLM_DEFAULT_AGENT: 'default-local-llm',
                        LLM_DEFAULT_TIERS: 'fast,plan,deep',
                    },
                },
            },
            daos,
            refresh,
        });

        assert.deepEqual(daos.modelsDao.createdCascade, []);
        assert.deepEqual(daos.modelChildrenDao.replacements, []);
        assert.deepEqual(daos.aliasesDao.deletedAliases, []);
        assert.deepEqual(daos.aliasesDao.rows, [{
            alias: 'fast',
            model_id: LEGACY_ALIAS_TARGET.id,
            model_key: LEGACY_ALIAS_TARGET.model_key,
        }]);
        assert.equal(refresh.calls.length, 0);
        assert.deepEqual(summary, {
            seeded: 0,
            promoted: 0,
            skipped: 0,
            aliasesDeleted: 0,
            refreshed: false,
        });
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

    it('ignores disabled models, malformed metadata, wrong discovery markers, and wrong agents', async () => {
        const disabledDefault = {
            ...DISCOVERED_MODEL,
            id: 'disabled-default',
            enabled: false,
        };
        const nonObjectMetadata = {
            ...DISCOVERED_MODEL,
            id: 'null-metadata',
            model_key: 'proxies/null-metadata',
            metadata: 'null',
        };
        const invalidJsonMetadata = {
            ...DISCOVERED_MODEL,
            id: 'invalid-json-metadata',
            model_key: 'proxies/invalid-json-metadata',
            metadata: '{not-json',
        };
        const wrongMarker = {
            ...DISCOVERED_MODEL,
            id: 'wrong-marker',
            metadata: { discoverySource: 'manual', agent: 'default-local-llm' },
        };
        const daos = makeDaos({
            seed: [
                disabledDefault,
                nonObjectMetadata,
                invalidJsonMetadata,
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
