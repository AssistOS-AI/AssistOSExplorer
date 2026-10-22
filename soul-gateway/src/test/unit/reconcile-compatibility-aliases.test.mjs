import assert from 'node:assert/strict';
import test from 'node:test';

import {
    reconcileCompatibilityAliases,
} from '../../bootstrap/reconcile-compatibility-aliases.mjs';

function harness({ models = {}, existingAlias = null } = {}) {
    const calls = { create: [], update: [] };
    const appCtx = {
        pool: {},
        log: { info() {}, warn() {} },
    };
    const daos = {
        modelsDao: {
            async findByKey(_pool, key) {
                return models[key] || null;
            },
        },
        modelAliasesDao: {
            async findByAlias() {
                return existingAlias;
            },
            async create(_pool, value) {
                calls.create.push(value);
            },
            async updateModel(_pool, value) {
                calls.update.push(value);
            },
        },
    };
    return { appCtx, daos, calls };
}

test('creates the concrete Codex compatibility alias when fast exists', async () => {
    const state = harness({ models: { fast: { id: 'fast-id' } } });
    const summary = await reconcileCompatibilityAliases({
        appCtx: state.appCtx,
        daos: state.daos,
    });

    assert.deepEqual(summary, {
        created: 1,
        updated: 0,
        unchanged: 0,
        skipped: 0,
    });
    assert.deepEqual(state.calls.create, [{
        alias: 'gpt-5.6-sol',
        modelId: 'fast-id',
    }]);
});

test('repairs a stale alias and leaves a correct alias unchanged', async () => {
    const stale = harness({
        models: { fast: { id: 'fast-id' } },
        existingAlias: { model_id: 'old-id' },
    });
    assert.equal((await reconcileCompatibilityAliases({
        appCtx: stale.appCtx,
        daos: stale.daos,
    })).updated, 1);
    assert.deepEqual(stale.calls.update, [{
        alias: 'gpt-5.6-sol',
        modelId: 'fast-id',
    }]);

    const correct = harness({
        models: { fast: { id: 'fast-id' } },
        existingAlias: { model_id: 'fast-id' },
    });
    assert.equal((await reconcileCompatibilityAliases({
        appCtx: correct.appCtx,
        daos: correct.daos,
    })).unchanged, 1);
    assert.deepEqual(correct.calls.update, []);
});

test('does not shadow a concrete model or point at a missing target', async () => {
    const collision = harness({
        models: {
            'gpt-5.6-sol': { id: 'concrete-id' },
            fast: { id: 'fast-id' },
        },
    });
    assert.equal((await reconcileCompatibilityAliases({
        appCtx: collision.appCtx,
        daos: collision.daos,
    })).skipped, 1);
    assert.deepEqual(collision.calls.create, []);

    const missing = harness();
    assert.equal((await reconcileCompatibilityAliases({
        appCtx: missing.appCtx,
        daos: missing.daos,
    })).skipped, 1);
    assert.deepEqual(missing.calls.create, []);
});
