/**
 * A first start whose catalog discovery answers but whose public pricing
 * directory stalls still finishes within the pricing timeout, and the synced
 * free catalog is admitted by the free-only rules: guard and safety models
 * are never stored, and models measured as unfit are stored but join no
 * cascade. `node:https` is replaced by a double; the pricing directory is a
 * local server, so no network is used.
 *
 * Requires `--experimental-test-module-mocks` (set by `npm test`).
 */

import { after, before, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { makeSignedSubjectKey } from '../fixtures/signed-subject-key.mjs';
import {
    applyProcessEnv,
    createHttpsDouble,
    freshGatewayEnv,
} from '../fixtures/fresh-gateway-boot.mjs';
import { FREE_BASELINE_MODELS } from '../../bootstrap/free-model-catalog.mjs';

const PRICING_TIMEOUT_MS = 1_500;
const EXTRA_IDS = [
    'nvidia/nemotron-3.5-lightning:free',
    'nvidia/nemotron-3.5-content-safety:free',
    'openrouter/free',
];

function catalogEntry(id) {
    return {
        id,
        name: id,
        context_length: 131072,
        pricing: { prompt: '0', completion: '0', request: '0', image: '0' },
        architecture: { input_modalities: ['text'], output_modalities: ['text'] },
        supported_parameters: ['tools', 'tool_choice'],
    };
}

const https = createHttpsDouble((options) => {
    if (options.hostname !== 'openrouter.ai') return { status: 404, body: {} };
    const ids = [...FREE_BASELINE_MODELS.map((m) => m.providerModelId), ...EXTRA_IDS];
    return { status: 200, body: { data: ids.map(catalogEntry) } };
});
mock.module('node:https', {
    namedExports: { request: https.request, get: https.request },
    defaultExport: { request: https.request, get: https.request },
});

let pricingServer;
let gateway;
let bootMs;
let dataDir;
let restoreEnv;

before(async () => {
    pricingServer = createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('{"data":[');
    });
    await new Promise((resolve) => pricingServer.listen(0, '127.0.0.1', resolve));
    dataDir = await mkdtemp(join(tmpdir(), 'soul-pricing-stall-boot-'));
    restoreEnv = applyProcessEnv(
        freshGatewayEnv({
            dataDir,
            signed: makeSignedSubjectKey('agent:verification/pricing-stall'),
            pricingDirectoryUrl: `http://127.0.0.1:${pricingServer.address().port}/models`,
            extra: { PRICING_DIRECTORY_TIMEOUT_MS: String(PRICING_TIMEOUT_MS) },
        }),
        ['FREE_MODELS_ENABLED', 'LLM_DEFAULT_TIERS', 'OPENROUTER_API_KEY']
    );
    const { bootstrap } = await import('../../bootstrap.mjs');
    const started = Date.now();
    gateway = await bootstrap();
    bootMs = Date.now() - started;
    await new Promise((resolve) => gateway.server.listen(0, '127.0.0.1', resolve));
});

after(async () => {
    const { shutdown } = await import('../../shutdown.mjs');
    await shutdown(gateway.appCtx, gateway.server, 'test');
    restoreEnv();
    pricingServer.closeAllConnections();
    await new Promise((resolve) => pricingServer.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
});

async function freeRows() {
    const { rows } = await gateway.appCtx.pool.query(
        `SELECT m.id, m.provider_model_id, m.enabled, m.metadata
           FROM models m JOIN providers p ON p.id = m.provider_id
          WHERE p.provider_key = 'openrouter-free'`
    );
    return new Map(rows.map((row) => [row.provider_model_id, row]));
}

describe('first start with a stalled pricing directory', () => {
    it('finishes bootstrap within the pricing timeout plus a margin', () => {
        assert.ok(bootMs <= PRICING_TIMEOUT_MS + 5_000, `bootstrap took ${bootMs}ms`);
    });

    it('never stores a content-safety model from the free catalog', async () => {
        const rows = await freeRows();
        assert.equal(rows.has('nvidia/nemotron-3.5-content-safety:free'), false);
        for (const model of FREE_BASELINE_MODELS) {
            assert.equal(rows.get(model.providerModelId)?.enabled, true, model.providerModelId);
        }
    });

    it('stores unfit models enabled but as children of no cascade', async () => {
        const rows = await freeRows();
        for (const id of ['nvidia/nemotron-3.5-lightning:free', 'openrouter/free']) {
            const row = rows.get(id);
            assert.ok(row, `${id} missing`);
            assert.equal(row.enabled, true);
            assert.equal(row.metadata.excludeFromTagTiers, true);
            const { rows: parents } = await gateway.appCtx.pool.query(
                'SELECT parent_model_id FROM model_children WHERE child_model_id = $1',
                [row.id]
            );
            assert.deepEqual(parents, [], `${id} is a cascade child`);
        }
    });

    it('lets every other synced free model join its auto tag tiers', async () => {
        const rows = await freeRows();
        const { rows: children } = await gateway.appCtx.pool.query(
            `SELECT DISTINCT mc.child_model_id FROM model_children mc
               JOIN models t ON t.id = mc.parent_model_id
              WHERE json_extract(t.metadata, '$.autoTagTier') = 1`
        );
        const joined = new Set(children.map((row) => row.child_model_id));
        for (const model of FREE_BASELINE_MODELS) {
            assert.ok(joined.has(rows.get(model.providerModelId).id), model.providerModelId);
        }
    });

    it('bounds a synced non-baseline row with the free-model execution policy', () => {
        const snapshot = gateway.appCtx.services.snapshot;
        const lightning = snapshot.models.get('openrouter-free/nvidia/nemotron-3.5-lightning:free');
        assert.equal(lightning.retryPolicy.maxAttempts, 1);
        assert.equal(lightning.retryPolicy.firstEventTimeoutMs, 30_000);
        assert.equal(lightning.retryPolicy.firstContentTimeoutMs, 120_000);
        assert.equal(lightning.retryPolicy.cooldownMs, 60_000);
    });
});
