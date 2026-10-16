/**
 * Administrator choices and uninformative catalogs, through the real
 * bootstrap, catalog sync, and management handlers on one SQLite file:
 *
 *   - an empty catalog (key replacement, manual sync) never disables the free
 *     baseline; a discovery 404 on the free-only provider fails the sync
 *     instead of emptying it; a catalog of only paid models disables rows;
 *   - a synced model an administrator deleted is not recreated by a later
 *     sync or a restart, and a manual create brings it back;
 *   - a disabled model, a deleted tier, and reordered priorities survive.
 *
 * `node:https` is replaced by a double; the pricing directory is unreachable
 * locally; no network is used.
 *
 * Requires `--experimental-test-module-mocks` (set by `npm test`).
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
    freeModelKey,
} from '../../bootstrap/free-model-catalog.mjs';

const DELETED = 'liquid/lfm-2.5-2.6b:free';
const DISABLED = 'google/gemma-4-26b-a4b-it:free';
const BASELINE_IDS = FREE_BASELINE_MODELS.map((m) => m.providerModelId);

let catalogMode = 'catalog';

function entry(id, price = '0') {
    return {
        id,
        name: id,
        context_length: 65536,
        pricing: { prompt: price, completion: price },
        architecture: { input_modalities: ['text'], output_modalities: ['text'] },
    };
}

const https = createHttpsDouble((options) => {
    if (options.hostname !== 'openrouter.ai') return { status: 404, body: {} };
    switch (catalogMode) {
        case 'empty':
            return { status: 200, body: { data: [] } };
        case 'not-found':
            return { status: 404, body: { error: { message: 'Not Found' } } };
        case 'paid':
            return { status: 200, body: { data: [entry('openai/gpt-5', '0.00001')] } };
        default:
            return { status: 200, body: { data: BASELINE_IDS.map((id) => entry(id)) } };
    }
});
mock.module('node:https', {
    namedExports: { request: https.request, get: https.request },
    defaultExport: { request: https.request, get: https.request },
});

let dataDir;
let restoreEnv;
let gateway;

async function boot() {
    const { bootstrap } = await import('../../bootstrap.mjs');
    gateway = await bootstrap();
}

async function stop() {
    const { shutdown } = await import('../../shutdown.mjs');
    await shutdown(gateway.appCtx, gateway.server, 'test');
}

function pool() {
    return gateway.appCtx.pool;
}

async function freeProvider() {
    const { rows } = await pool().query('SELECT * FROM providers WHERE provider_key = $1', [FREE_PROVIDER_KEY]);
    return rows[0];
}

async function freeRows() {
    const { rows } = await pool().query(
        `SELECT m.* FROM models m JOIN providers p ON p.id = m.provider_id
          WHERE p.provider_key = $1`,
        [FREE_PROVIDER_KEY]
    );
    return new Map(rows.map((row) => [row.provider_model_id, row]));
}

async function enabledCount() {
    return [...(await freeRows()).values()].filter((row) => row.enabled).length;
}

async function keyReplacementSync() {
    const { autoProvisionModels } = await import('../../runtime/providers/auto-provisioner.mjs');
    return autoProvisionModels(gateway.appCtx, await freeProvider(), null, {
        strict: true,
        disableMissing: true,
        refreshReason: 'provider.update',
    });
}

async function periodicRefresh() {
    const { refreshProviderModelCatalog } = await import('../../runtime/providers/provider-catalog-refresh.mjs');
    return refreshProviderModelCatalog(gateway.appCtx, { phase: 'test' });
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

async function tombstoneCount() {
    const { rows } = await pool().query('SELECT COUNT(*) AS n FROM model_tombstones');
    return Number(rows[0].n);
}

async function parentKeysOf(modelKey) {
    const { rows } = await pool().query(
        `SELECT t.model_key FROM model_children mc
           JOIN models c ON c.id = mc.child_model_id
           JOIN models t ON t.id = mc.parent_model_id
          WHERE c.model_key = $1`,
        [modelKey]
    );
    return rows.map((row) => row.model_key);
}

before(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'soul-free-ownership-'));
    restoreEnv = applyProcessEnv(
        freshGatewayEnv({
            dataDir,
            signed: makeSignedSubjectKey('agent:verification/ownership'),
            pricingDirectoryUrl: 'http://127.0.0.1:9/none',
        }),
        ['FREE_MODELS_ENABLED', 'LLM_DEFAULT_TIERS', 'OPENROUTER_API_KEY']
    );
    await boot();
});

after(async () => {
    await stop();
    restoreEnv();
    await rm(dataDir, { recursive: true, force: true });
});

describe('an uninformative catalog keeps the free baseline', () => {
    it('starts with every baseline model enabled', async () => {
        assert.equal(await enabledCount(), BASELINE_IDS.length);
    });

    it('an empty catalog through the key-replacement sync disables nothing', async () => {
        catalogMode = 'empty';
        const result = await keyReplacementSync();
        assert.equal(result.disabled, 0);
        assert.equal(result.emptySkipped, true);
        assert.equal(await enabledCount(), BASELINE_IDS.length);
    });

    it('an empty catalog through the periodic refresh is counted as skipped', async () => {
        catalogMode = 'empty';
        const summary = await periodicRefresh();
        assert.equal(summary.emptySkipped, 1);
        assert.equal(summary.disabled, 0);
        assert.equal(await enabledCount(), BASELINE_IDS.length);
    });

    it('a discovery 404 on the free-only provider fails the sync and preserves rows', async () => {
        catalogMode = 'not-found';
        await assert.rejects(keyReplacementSync(), /HTTP 404/);
        assert.equal(await enabledCount(), BASELINE_IDS.length);
    });

    it('a catalog of only paid models disables the synced rows, and a healthy one restores them', async () => {
        catalogMode = 'paid';
        const result = await keyReplacementSync();
        assert.equal(result.disabled, BASELINE_IDS.length);
        assert.equal(await enabledCount(), 0);

        catalogMode = 'catalog';
        await keyReplacementSync();
        assert.equal(await enabledCount(), BASELINE_IDS.length);
    });
});

describe('administrator ownership across syncs and restarts', () => {
    let deletedParentsBefore;
    let codeOrderBefore;

    it('records a tombstone when a synced model is deleted through management', async () => {
        const { handleDeleteModel, handleDisableModel } = await import('../../management/models-route.mjs');
        const rows = await freeRows();
        deletedParentsBefore = await parentKeysOf(freeModelKey(DELETED));
        assert.ok(deletedParentsBefore.length > 0, 'baseline model starts as a tier child');

        const res = mockRes();
        await handleDeleteModel({ res, params: { modelId: rows.get(DELETED).id }, appCtx: gateway.appCtx });
        assert.equal(res.statusCode, 200, res.body);
        assert.equal(await tombstoneCount(), 1);

        const disableRes = mockRes();
        await handleDisableModel({ res: disableRes, params: { modelId: rows.get(DISABLED).id }, appCtx: gateway.appCtx });
        assert.equal(disableRes.statusCode, 200, disableRes.body);

        const ultra = (await pool().query("SELECT id FROM models WHERE model_key = 'ultra'")).rows[0];
        const tierRes = mockRes();
        await handleDeleteModel({ res: tierRes, params: { modelId: ultra.id }, appCtx: gateway.appCtx });
        assert.equal(tierRes.statusCode, 200);
        assert.equal(await tombstoneCount(), 1, 'deleting a tier records no tombstone');

        const code = (await pool().query("SELECT id FROM models WHERE model_key = 'code'")).rows[0];
        const childrenDao = await import('../../db/dao/model-children-dao.mjs');
        const children = await childrenDao.listForParent(pool(), code.id);
        const reversed = [...children].reverse().map((child, index) => ({
            childModelId: child.child_model_id,
            priority: 96 + index,
            settings: child.settings,
        }));
        await childrenDao.replaceChildren(pool(), code.id, reversed);
        codeOrderBefore = reversed.map((child) => child.childModelId);
    });

    it('a sync whose catalog lists the deleted model does not recreate it', async () => {
        catalogMode = 'catalog';
        const summary = await periodicRefresh();
        assert.equal(summary.failed, 0);
        assert.equal(summary.refreshed, 1);
        const rows = await freeRows();
        assert.equal(rows.has(DELETED), false);
        assert.equal(rows.get(DISABLED).enabled, false);
    });

    it('a restart on the same database keeps every administrator choice', async () => {
        await stop();
        await boot();
        const rows = await freeRows();
        assert.equal(rows.has(DELETED), false, 'deleted model recreated');
        assert.deepEqual(await parentKeysOf(freeModelKey(DELETED)), []);
        assert.equal(rows.get(DISABLED).enabled, false);
        const ultra = await pool().query("SELECT id FROM models WHERE model_key = 'ultra'");
        assert.equal(ultra.rows.length, 0, 'deleted tier recreated');
        const code = (await pool().query("SELECT id FROM models WHERE model_key = 'code'")).rows[0];
        const childrenDao = await import('../../db/dao/model-children-dao.mjs');
        const order = (await childrenDao.listForParent(pool(), code.id)).map((child) => child.child_model_id);
        assert.deepEqual(order, codeOrderBefore);
        const snapshot = gateway.appCtx.services.snapshot;
        assert.equal(snapshot.models.has(freeModelKey(DELETED)), false);
    });

    it('a manual create brings the model back and clears its tombstone', async () => {
        const { handleCreateModel } = await import('../../management/models-route.mjs');
        const provider = await freeProvider();
        const res = mockRes();
        await handleCreateModel({
            req: mockReq({
                modelKey: freeModelKey(DELETED),
                displayName: 'Liquid (manual)',
                providerId: provider.id,
                providerModelId: DELETED,
                pricingMode: 'free',
            }),
            res,
            appCtx: gateway.appCtx,
        });
        assert.equal(res.statusCode, 201, res.body);
        assert.equal(await tombstoneCount(), 0);
        await periodicRefresh();
        const row = (await freeRows()).get(DELETED);
        assert.equal(row.discovery_source, 'manual');
    });

    it('deleting a provider removes its tombstones', async () => {
        const providersDao = await import('../../db/dao/providers-dao.mjs');
        const modelsDao = await import('../../db/dao/models-dao.mjs');
        const tombstonesDao = await import('../../db/dao/model-tombstones-dao.mjs');
        const provider = await providersDao.create(pool(), {
            providerKey: 'short-lived',
            displayName: 'short-lived',
            kind: 'external_api',
            adapterKey: 'openai-api',
            authStrategy: 'api_key',
            baseUrl: 'http://127.0.0.1:9/v1',
        });
        const model = await modelsDao.create(pool(), {
            modelKey: 'short-lived/m',
            displayName: 'm',
            providerId: provider.id,
            providerModelId: 'm',
            discoverySource: 'synced',
        });
        const result = await tombstonesDao.deleteModelRecordingTombstone(pool(), model.id);
        assert.deepEqual(result, { deleted: true, tombstoned: true });
        assert.equal(await tombstoneCount(), 1);
        await providersDao.del(pool(), provider.id);
        assert.equal(await tombstoneCount(), 0);
    });
});
