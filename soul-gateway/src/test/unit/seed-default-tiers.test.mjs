import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { seedDefaultTiers } from '../../bootstrap/seed-default-tiers.mjs';

const SILENT_LOG = { debug() {}, info() {}, warn() {}, error() {} };

const DISCOVERED_MODEL = {
    id: 'model-uuid-1',
    model_key: 'ploinky/llm-runtime/base-local',
    enabled: true,
    metadata: { discoverySource: 'ploinky-agent-discovery', agent: 'base-local' },
};

const OTHER_DISCOVERED_MODEL = {
    id: 'model-uuid-2',
    model_key: 'ploinky/llm-runtime/other-local',
    enabled: true,
    metadata: { discoverySource: 'ploinky-agent-discovery', agent: 'other-local' },
};

function makeModelsDao(seed = [DISCOVERED_MODEL]) {
    return { async list() { return seed; } };
}

function makeAliasesDao(existing = []) {
    const rows = existing.map((r) => ({ ...r }));
    return {
        rows,
        async findByAlias(_pool, alias) {
            return rows.find((r) => r.alias === alias) || null;
        },
        async create(_pool, { alias, modelId }) {
            const row = { alias, model_id: modelId };
            rows.push(row);
            return row;
        },
    };
}

function spyRefresh() {
    const calls = [];
    const fn = async (_ctx, opts) => { calls.push(opts); return {}; };
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
        warn() {},
        error() {},
    };
}

function makeAppCtx(env = {}, log = SILENT_LOG) {
    return { pool: {}, log, config: { env } };
}

describe('seedDefaultTiers', () => {
    it('seeds each tier to the discovered default-agent model', async () => {
        const aliasesDao = makeAliasesDao();
        const refresh = spyRefresh();
        const log = spyLog();
        const summary = await seedDefaultTiers({
            appCtx: makeAppCtx({ LLM_DEFAULT_AGENT: 'base-local', LLM_DEFAULT_TIERS: 'fast,plan,deep' }, log),
            daos: { modelsDao: makeModelsDao(), aliasesDao },
            refresh,
        });
        assert.equal(summary.seeded, 3);
        assert.equal(summary.refreshed, true);
        assert.equal(aliasesDao.rows.length, 3);
        assert.deepEqual(
            aliasesDao.rows.map((r) => r.alias).sort(),
            ['deep', 'fast', 'plan']
        );
        assert.ok(aliasesDao.rows.every((r) => r.model_id === 'model-uuid-1'));
        assert.equal(refresh.calls.length, 1);
        assert.deepEqual(refresh.calls[0], {
            snapshot: true,
            reason: 'seed-default-tiers',
        });
        assert.deepEqual(
            log.calls.map((entry) => entry.msg),
            [
                'seed-default-tiers: seeded tier',
                'seed-default-tiers: seeded tier',
                'seed-default-tiers: seeded tier',
            ]
        );
    });

    it('never overwrites an alias that already exists (seed-once)', async () => {
        const aliasesDao = makeAliasesDao([{ alias: 'plan', model_id: 'admin-model' }]);
        const refresh = spyRefresh();
        const summary = await seedDefaultTiers({
            appCtx: makeAppCtx({ LLM_DEFAULT_AGENT: 'base-local', LLM_DEFAULT_TIERS: 'fast,plan,deep' }),
            daos: { modelsDao: makeModelsDao(), aliasesDao },
            refresh,
        });
        assert.equal(summary.seeded, 2);
        assert.equal(summary.skipped, 1);
        const plan = aliasesDao.rows.find((r) => r.alias === 'plan');
        assert.equal(plan.model_id, 'admin-model');
    });

    it('no-ops when appCtx.pool is absent', async () => {
        const aliasesDao = makeAliasesDao();
        const refresh = spyRefresh();
        const summary = await seedDefaultTiers({
            appCtx: { log: SILENT_LOG, config: { env: { LLM_DEFAULT_AGENT: 'base-local', LLM_DEFAULT_TIERS: 'fast,plan,deep' } } },
            daos: { modelsDao: makeModelsDao(), aliasesDao },
            refresh,
        });
        assert.deepEqual(summary, {
            seeded: 0,
            skipped: 0,
            refreshed: false,
        });
        assert.equal(aliasesDao.rows.length, 0);
        assert.equal(refresh.calls.length, 0);
    });

    it('no-ops when LLM_DEFAULT_TIERS is empty or blank', async () => {
        for (const tiers of ['', '   ', ',, ,']) {
            const aliasesDao = makeAliasesDao();
            const refresh = spyRefresh();
            const summary = await seedDefaultTiers({
                appCtx: makeAppCtx({ LLM_DEFAULT_AGENT: 'base-local', LLM_DEFAULT_TIERS: tiers }),
                daos: { modelsDao: makeModelsDao(), aliasesDao },
                refresh,
            });
            assert.deepEqual(summary, {
                seeded: 0,
                skipped: 0,
                refreshed: false,
            });
            assert.equal(aliasesDao.rows.length, 0);
            assert.equal(refresh.calls.length, 0);
        }
    });

    it('trims tier names and drops blank tier entries', async () => {
        const aliasesDao = makeAliasesDao();
        const refresh = spyRefresh();
        const summary = await seedDefaultTiers({
            appCtx: makeAppCtx({ LLM_DEFAULT_AGENT: 'base-local', LLM_DEFAULT_TIERS: ' fast, ,plan,, deep ' }),
            daos: { modelsDao: makeModelsDao(), aliasesDao },
            refresh,
        });
        assert.deepEqual(summary, {
            seeded: 3,
            skipped: 0,
            refreshed: true,
        });
        assert.deepEqual(
            aliasesDao.rows.map((r) => r.alias),
            ['fast', 'plan', 'deep']
        );
        assert.equal(refresh.calls.length, 1);
    });

    it('ignores disabled models, wrong discovery markers, and wrong agents', async () => {
        const aliasesDao = makeAliasesDao();
        const refresh = spyRefresh();
        const disabledDefault = {
            ...DISCOVERED_MODEL,
            id: 'disabled-default',
            enabled: false,
        };
        const wrongMarker = {
            ...DISCOVERED_MODEL,
            id: 'wrong-marker',
            metadata: { discoverySource: 'manual', agent: 'base-local' },
        };
        const summary = await seedDefaultTiers({
            appCtx: makeAppCtx({ LLM_DEFAULT_AGENT: 'base-local', LLM_DEFAULT_TIERS: 'fast' }),
            daos: {
                modelsDao: makeModelsDao([
                    disabledDefault,
                    wrongMarker,
                    OTHER_DISCOVERED_MODEL,
                    DISCOVERED_MODEL,
                ]),
                aliasesDao,
            },
            refresh,
        });
        assert.deepEqual(summary, {
            seeded: 1,
            skipped: 0,
            refreshed: true,
        });
        assert.deepEqual(aliasesDao.rows, [{
            alias: 'fast',
            model_id: 'model-uuid-1',
        }]);
    });

    it('treats null metadata as empty while scanning for the default model', async () => {
        const aliasesDao = makeAliasesDao();
        const refresh = spyRefresh();
        const summary = await seedDefaultTiers({
            appCtx: makeAppCtx({ LLM_DEFAULT_AGENT: 'base-local', LLM_DEFAULT_TIERS: 'fast' }),
            daos: {
                modelsDao: makeModelsDao([
                    {
                        id: 'null-metadata',
                        model_key: 'ploinky/llm-runtime/null-metadata',
                        enabled: true,
                        metadata: 'null',
                    },
                    DISCOVERED_MODEL,
                ]),
                aliasesDao,
            },
            refresh,
        });
        assert.deepEqual(summary, {
            seeded: 1,
            skipped: 0,
            refreshed: true,
        });
        assert.deepEqual(aliasesDao.rows, [{
            alias: 'fast',
            model_id: 'model-uuid-1',
        }]);
    });

    it('does not require log.info when the default agent is not discovered', async () => {
        const aliasesDao = makeAliasesDao();
        const refresh = spyRefresh();
        const summary = await seedDefaultTiers({
            appCtx: makeAppCtx({ LLM_DEFAULT_AGENT: 'base-local', LLM_DEFAULT_TIERS: 'fast' }, {}),
            daos: { modelsDao: makeModelsDao([]), aliasesDao },
            refresh,
        });
        assert.deepEqual(summary, {
            seeded: 0,
            skipped: 0,
            refreshed: false,
        });
        assert.equal(aliasesDao.rows.length, 0);
        assert.equal(refresh.calls.length, 0);
    });

    it('does not require log.info when seeding succeeds', async () => {
        const aliasesDao = makeAliasesDao();
        const refresh = spyRefresh();
        const summary = await seedDefaultTiers({
            appCtx: makeAppCtx({ LLM_DEFAULT_AGENT: 'base-local', LLM_DEFAULT_TIERS: 'fast' }, {}),
            daos: { modelsDao: makeModelsDao(), aliasesDao },
            refresh,
        });
        assert.deepEqual(summary, {
            seeded: 1,
            skipped: 0,
            refreshed: true,
        });
        assert.deepEqual(aliasesDao.rows, [{
            alias: 'fast',
            model_id: 'model-uuid-1',
        }]);
    });

    it('scans beyond the first enabled model page for the default agent', async () => {
        const aliasesDao = makeAliasesDao();
        const refresh = spyRefresh();
        const calls = [];
        const nonmatchingModels = Array.from({ length: 500 }, (_value, index) => ({
            id: `nonmatching-${index}`,
            model_key: `ploinky/llm-runtime/nonmatching-${index}`,
            enabled: true,
            metadata: {
                discoverySource: 'ploinky-agent-discovery',
                agent: `nonmatching-${index}`,
            },
        }));
        const modelsDao = {
            async list(_pool, options) {
                calls.push(options);
                if (options.limit === 500 && options.offset === 0) {
                    return nonmatchingModels;
                }
                if (options.limit === 500 && options.offset === 500) {
                    return [DISCOVERED_MODEL];
                }
                return [];
            },
        };
        const summary = await seedDefaultTiers({
            appCtx: makeAppCtx({ LLM_DEFAULT_AGENT: 'base-local', LLM_DEFAULT_TIERS: 'fast' }),
            daos: { modelsDao, aliasesDao },
            refresh,
        });
        assert.equal(summary.seeded, 1);
        assert.deepEqual(aliasesDao.rows, [{
            alias: 'fast',
            model_id: 'model-uuid-1',
        }]);
        assert.deepEqual(
            calls.map((options) => options.offset),
            [0, 500]
        );
    });

    it('no-ops when the default agent is not discovered', async () => {
        const aliasesDao = makeAliasesDao();
        const refresh = spyRefresh();
        const log = spyLog();
        const summary = await seedDefaultTiers({
            appCtx: makeAppCtx({ LLM_DEFAULT_AGENT: 'base-local', LLM_DEFAULT_TIERS: 'fast,plan,deep' }, log),
            daos: { modelsDao: makeModelsDao([]), aliasesDao },
            refresh,
        });
        assert.equal(summary.seeded, 0);
        assert.equal(aliasesDao.rows.length, 0);
        assert.equal(refresh.calls.length, 0);
        assert.deepEqual(log.calls, [{
            level: 'info',
            msg: 'seed-default-tiers: default agent not discovered yet',
            data: { agent: 'base-local' },
        }]);
    });

    it('no-ops when LLM_DEFAULT_AGENT is unset', async () => {
        const aliasesDao = makeAliasesDao();
        const summary = await seedDefaultTiers({
            appCtx: makeAppCtx({ LLM_DEFAULT_TIERS: 'fast,plan,deep' }),
            daos: { modelsDao: makeModelsDao(), aliasesDao },
            refresh: spyRefresh(),
        });
        assert.equal(summary.seeded, 0);
        assert.equal(aliasesDao.rows.length, 0);
    });
});
