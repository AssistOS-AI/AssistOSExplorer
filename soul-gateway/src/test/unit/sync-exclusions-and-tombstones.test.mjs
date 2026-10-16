/**
 * Two sync decisions that depend on rows already in the database, through the
 * real bootstrap, catalog sync and management handlers on one SQLite file:
 *
 *   - a model that gains the tag-tier exclusion flag on an existing row leaves
 *     every auto tag tier and keeps every operator cascade;
 *   - a tombstone whose key a row currently holds is only suspended: the row
 *     is updated instead of disabled, the tombstone stays recorded, and it
 *     applies again as soon as no row holds the key, so a rename cannot undo
 *     a deletion; only a manual create clears it;
 *   - a manual sync whose upstream catalog came back empty reports the skip,
 *     so all-zero counters are not read as an unchanged catalog.
 *
 * `node:https` is replaced by a double; the pricing directory is unreachable
 * locally; no network is used.
 *
 * Requires `--experimental-test-module-mocks`.
 */

import { after, before, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { makeSignedSubjectKey } from '../fixtures/signed-subject-key.mjs';
import {
    applyProcessEnv,
    createHttpsDouble,
    freshGatewayEnv,
} from '../fixtures/fresh-gateway-boot.mjs';
import {
    FREE_BASELINE_MODELS,
    FREE_PROVIDER_KEY,
    TAG_TIER_EXCLUDED_MODEL_IDS,
    freeModelKey,
} from '../../bootstrap/free-model-catalog.mjs';

const BASELINE_IDS = FREE_BASELINE_MODELS.map((model) => model.providerModelId);
// Already on the exclusion list, so a sync that meets it on an existing row
// is exactly the case where the list reached a model after its row existed.
const [EXCLUDED_ID] = TAG_TIER_EXCLUDED_MODEL_IDS;
const RENAMED_FROM = 'qwen/qwen3.8-27b:free';
const DELETED = 'liquid/lfm-2.5-2.6b:free';
const OPERATOR_TIER = 'operator-pick';
// A key the upstream catalog never lists, used to move a row off a
// tombstoned key without colliding with a synced row.
const PARKED = 'vendor/parked-row:free';

let extraCatalogIds = [];
let emptyCatalog = false;

function entry(id) {
    return {
        id,
        name: id,
        context_length: 65536,
        pricing: { prompt: '0', completion: '0' },
        architecture: { input_modalities: ['text'], output_modalities: ['text'] },
    };
}

const https = createHttpsDouble((options) => {
    if (options.hostname !== 'openrouter.ai') return { status: 404, body: {} };
    if (emptyCatalog) return { status: 200, body: { data: [] } };
    return {
        status: 200,
        body: { data: [...BASELINE_IDS, ...extraCatalogIds].map(entry) },
    };
});
mock.module('node:https', {
    namedExports: { request: https.request, get: https.request },
    defaultExport: { request: https.request, get: https.request },
});

let dataDir;
let restoreEnv;
let gateway;

function pool() {
    return gateway.appCtx.pool;
}

async function freeProvider() {
    const { rows } = await pool().query(
        'SELECT * FROM providers WHERE provider_key = $1',
        [FREE_PROVIDER_KEY]
    );
    return rows[0];
}

async function rowByKey(modelKey) {
    const { rows } = await pool().query('SELECT * FROM models WHERE model_key = $1', [
        modelKey,
    ]);
    return rows[0] || null;
}

async function rowById(id) {
    const { rows } = await pool().query('SELECT * FROM models WHERE id = $1', [id]);
    return rows[0] || null;
}

async function parentKeysOf(modelKey) {
    const { rows } = await pool().query(
        `SELECT t.model_key FROM model_children mc
           JOIN models c ON c.id = mc.child_model_id
           JOIN models t ON t.id = mc.parent_model_id
          WHERE c.model_key = $1
          ORDER BY t.model_key`,
        [modelKey]
    );
    return rows.map((row) => row.model_key);
}

async function tombstoneCount() {
    const { rows } = await pool().query('SELECT COUNT(*) AS n FROM model_tombstones');
    return Number(rows[0].n);
}

async function sync() {
    const { autoProvisionModels } = await import(
        '../../runtime/providers/auto-provisioner.mjs'
    );
    return autoProvisionModels(gateway.appCtx, await freeProvider(), null, {
        strict: true,
        discoverySource: 'synced',
        disableMissing: true,
        refreshReason: 'provider.sync-models',
    });
}

function mockRes() {
    const res = {
        statusCode: null,
        body: '',
        headersSent: false,
        writeHead(status) { res.statusCode = status; res.headersSent = true; },
        setHeader() {},
        write(chunk) { res.body += chunk; },
        end(chunk) { if (chunk) res.body += chunk; },
    };
    return res;
}

function mockReq(body) {
    const req = new EventEmitter();
    req.headers = { 'content-type': 'application/json' };
    req.method = 'POST';
    process.nextTick(() => {
        req.emit('data', Buffer.from(JSON.stringify(body)));
        req.emit('end');
    });
    return req;
}

before(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'soul-sync-exclusions-'));
    restoreEnv = applyProcessEnv(
        freshGatewayEnv({
            dataDir,
            signed: makeSignedSubjectKey('agent:verification/sync-exclusions'),
            pricingDirectoryUrl: 'http://127.0.0.1:9/none',
        }),
        ['FREE_MODELS_ENABLED', 'LLM_DEFAULT_TIERS', 'OPENROUTER_API_KEY']
    );
    const { bootstrap } = await import('../../bootstrap.mjs');
    gateway = await bootstrap();
});

after(async () => {
    const { shutdown } = await import('../../shutdown.mjs');
    await shutdown(gateway.appCtx, gateway.server, 'test');
    restoreEnv();
    await rm(dataDir, { recursive: true, force: true });
});

describe('a row that gains the tag-tier exclusion flag', () => {
    let excludedRowId;

    it('starts as a child of auto tag tiers and of an operator cascade', async () => {
        const modelsDao = await import('../../db/dao/models-dao.mjs');
        const childrenDao = await import('../../db/dao/model-children-dao.mjs');
        const provider = await freeProvider();

        // The row exists before the exclusion reaches it: no flag, ordinary
        // tags, already a tag-tier child.
        const row = await modelsDao.create(pool(), {
            modelKey: freeModelKey(EXCLUDED_ID),
            displayName: EXCLUDED_ID,
            providerId: provider.id,
            providerModelId: EXCLUDED_ID,
            enabled: true,
            pricingMode: 'free',
            isFree: true,
            discoverySource: 'synced',
            tags: ['free', 'tool-calling'],
            metadata: {},
        });
        excludedRowId = row.id;

        for (const tag of ['free', 'tool-calling']) {
            const tier = await rowByKey(tag);
            assert.ok(tier, `auto tag tier ${tag} exists`);
            assert.equal(tier.metadata.autoTagTier, true);
            await childrenDao.create(pool(), {
                parentModelId: tier.id,
                childModelId: row.id,
                priority: 99,
                enabled: true,
            });
        }

        const operatorTier = await modelsDao.createCascade(pool(), {
            modelKey: OPERATOR_TIER,
            displayName: OPERATOR_TIER,
            enabled: true,
            maxAttempts: 2,
            discoverySource: 'manual',
            metadata: { pickedBy: 'operator' },
        });
        await childrenDao.create(pool(), {
            parentModelId: operatorTier.id,
            childModelId: row.id,
            priority: 1,
            enabled: true,
        });

        assert.deepEqual(await parentKeysOf(freeModelKey(EXCLUDED_ID)), [
            'free',
            OPERATOR_TIER,
            'tool-calling',
        ]);
    });

    it('leaves every auto tag tier on the next sync and keeps the operator cascade', async () => {
        extraCatalogIds = [EXCLUDED_ID];
        const result = await sync();

        // The trigger is an update, not a creation: a sync that creates
        // nothing must still reconcile the tiers.
        assert.equal(result.created, 0);
        assert.equal(result.tagTierModelsRemoved, 2);
        assert.deepEqual(await parentKeysOf(freeModelKey(EXCLUDED_ID)), [OPERATOR_TIER]);

        const row = await rowById(excludedRowId);
        assert.equal(row.enabled, true, 'the model stays callable as a direct model');
        assert.equal(row.metadata.excludeFromTagTiers, true);
    });

    it('is idempotent on a later sync', async () => {
        const result = await sync();
        assert.equal(result.tagTierModelsRemoved, 0);
        assert.deepEqual(await parentKeysOf(freeModelKey(EXCLUDED_ID)), [OPERATOR_TIER]);
    });
});

describe('a tombstone whose key a row currently holds', () => {
    let movedRowId = null;

    it('is ignored by the sync, so the row is updated and not disabled', async () => {
        const row = await rowByKey(freeModelKey(RENAMED_FROM));
        assert.ok(row);
        await pool().query(
            'INSERT INTO model_tombstones (provider_id, model_key) VALUES ($1, $2)',
            [row.provider_id, row.model_key]
        );

        const result = await sync();
        assert.equal(result.disabled, 0);
        const after = await rowById(row.id);
        assert.equal(after.enabled, true);

        await pool().query('DELETE FROM model_tombstones WHERE model_key = $1', [
            row.model_key,
        ]);
    });

    it('is kept when an administrator renames a row onto it, while that row is updated and stays enabled', async () => {
        const { handleDeleteModel, handleUpdateModel } = await import(
            '../../management/models-route.mjs'
        );
        const deleted = await rowByKey(freeModelKey(DELETED));
        const renamed = await rowByKey(freeModelKey(RENAMED_FROM));
        assert.ok(deleted && renamed);
        movedRowId = renamed.id;

        const before = await tombstoneCount();
        const deleteRes = mockRes();
        await handleDeleteModel({
            res: deleteRes,
            params: { modelId: deleted.id },
            appCtx: gateway.appCtx,
        });
        assert.equal(deleteRes.statusCode, 200, deleteRes.body);
        assert.equal(await tombstoneCount(), before + 1);

        const patchRes = mockRes();
        await handleUpdateModel({
            req: mockReq({
                modelKey: freeModelKey(DELETED),
                providerModelId: DELETED,
            }),
            res: patchRes,
            params: { modelId: renamed.id },
            appCtx: gateway.appCtx,
        });
        assert.equal(patchRes.statusCode, 200, patchRes.body);
        // The deletion is not undone by a rename: the tombstone is only
        // suspended while a row holds its key.
        assert.equal(await tombstoneCount(), before + 1);

        const result = await sync();
        const after = await rowById(renamed.id);
        assert.equal(after.model_key, freeModelKey(DELETED));
        assert.equal(after.enabled, true, 'the renamed row is not disabled');
        assert.equal(result.disabled, 0);
        assert.equal(await tombstoneCount(), before + 1);
    });

    it('applies again once the row moves off the key, so the deleted model is not recreated', async () => {
        const { handleUpdateModel } = await import(
            '../../management/models-route.mjs'
        );
        assert.ok(movedRowId, 'the previous case moved a row onto the key');
        const before = await tombstoneCount();

        const patchRes = mockRes();
        await handleUpdateModel({
            req: mockReq({
                modelKey: freeModelKey(PARKED),
                providerModelId: PARKED,
            }),
            res: patchRes,
            params: { modelId: movedRowId },
            appCtx: gateway.appCtx,
        });
        assert.equal(patchRes.statusCode, 200, patchRes.body);

        // The catalog still lists the deleted model, and no row holds its key
        // any more, so only the tombstone keeps it away.
        const result = await sync();
        assert.equal(result.created, 0);
        assert.equal(await rowByKey(freeModelKey(DELETED)), null);
        assert.equal(await tombstoneCount(), before);
    });

    it('is cleared from the stored row when a deleted model is created manually', async () => {
        const { handleCreateModel, handleDeleteModel } = await import(
            '../../management/models-route.mjs'
        );
        const provider = await freeProvider();
        const target = await rowByKey(freeModelKey(BASELINE_IDS[0]));
        assert.ok(target);
        const before = await tombstoneCount();

        const deleteRes = mockRes();
        await handleDeleteModel({
            res: deleteRes,
            params: { modelId: target.id },
            appCtx: gateway.appCtx,
        });
        assert.equal(deleteRes.statusCode, 200, deleteRes.body);
        assert.equal(await tombstoneCount(), before + 1);

        const createRes = mockRes();
        await handleCreateModel({
            req: mockReq({
                modelKey: freeModelKey(BASELINE_IDS[0]),
                displayName: BASELINE_IDS[0],
                providerId: provider.id,
                providerModelId: BASELINE_IDS[0],
            }),
            res: createRes,
            appCtx: gateway.appCtx,
        });
        assert.equal(createRes.statusCode, 201, createRes.body);
        assert.equal(await tombstoneCount(), before, 'only its own tombstone is cleared');
    });
});

describe('a manual sync of an empty upstream catalog', () => {
    it('reports the skip through the management route and disables nothing', async () => {
        const { handleSyncModels } = await import(
            '../../management/providers-route.mjs'
        );
        const provider = await freeProvider();
        const { rows: before } = await pool().query(
            `SELECT COUNT(*) AS n FROM models
              WHERE provider_id = $1 AND enabled = 1`,
            [provider.id]
        );

        emptyCatalog = true;
        const res = mockRes();
        await handleSyncModels({
            req: mockReq({}),
            res,
            params: { providerId: provider.id },
            appCtx: gateway.appCtx,
        });
        emptyCatalog = false;

        assert.equal(res.statusCode, 200, res.body);
        const body = JSON.parse(res.body);
        assert.equal(body.emptySkipped, true);
        assert.equal(body.disabled, 0);
        assert.equal(body.created, 0);

        const { rows: after } = await pool().query(
            `SELECT COUNT(*) AS n FROM models
              WHERE provider_id = $1 AND enabled = 1`,
            [provider.id]
        );
        assert.equal(Number(after[0].n), Number(before[0].n));
    });

    it('reports no skip when the catalog answers normally', async () => {
        const { handleSyncModels } = await import(
            '../../management/providers-route.mjs'
        );
        const provider = await freeProvider();
        const res = mockRes();
        await handleSyncModels({
            req: mockReq({}),
            res,
            params: { providerId: provider.id },
            appCtx: gateway.appCtx,
        });
        assert.equal(res.statusCode, 200, res.body);
        assert.equal(JSON.parse(res.body).emptySkipped, false);
    });
});
