/**
 * Models that a catalog sync adds to a free-only provider are admitted,
 * tiered, and bounded like the curated baseline: guard and safety models are
 * never stored, models measured as unfit join no cascade, and every synced
 * direct model runs with the free-model execution policy (one attempt, a
 * first-event deadline) even without a row policy. An ordinary provider is
 * unchanged. Real gateway, real SQLite, local stub upstream; no network.
 */

import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { makeSignedSubjectKey } from '../fixtures/signed-subject-key.mjs';
import { applyProcessEnv, freshGatewayEnv } from '../fixtures/fresh-gateway-boot.mjs';
import { FREE_BASELINE_MODELS } from '../../bootstrap/free-model-catalog.mjs';

const LIGHTNING = 'nvidia/nemotron-3.5-lightning:free';
const SAFETY = 'nvidia/nemotron-3.5-content-safety:free';
const ROUTER = 'openrouter/free';
const RECREATED = 'liquid/lfm-2.5-2.6b:free';
const CATALOG_IDS = [...FREE_BASELINE_MODELS.map((m) => m.providerModelId), LIGHTNING, SAFETY, ROUTER];
const STALLED = new Set([LIGHTNING, RECREATED]);

const calls = [];
const openUpstream = new Set();
let upstream;
let upstreamUrl;
let gateway;
let base;
let signed;
let dataDir;
let restoreEnv;
const providers = {};

function catalogEntry(id) {
    return {
        id,
        name: id,
        context_length: 65536,
        pricing: { prompt: '0', completion: '0' },
        architecture: { input_modalities: ['text'], output_modalities: ['text'] },
        supported_parameters: ['tools'],
    };
}

function reply(res, model) {
    if (STALLED.has(model)) {
        // HTTP 200 and then nothing, as measured for the Lightning model.
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.flushHeaders();
        return;
    }
    if (model === 'plain/fails') {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'upstream exploded', code: 500 } }));
        return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'Hello' } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
    res.end('data: [DONE]\n\n');
}

async function createProvider(key, settings) {
    const { pool } = gateway.appCtx;
    const providersDao = await import('../../db/dao/providers-dao.mjs');
    const { upsertProviderApiKeyAccount } = await import('../../runtime/providers/api-key-account.mjs');
    const provider = await providersDao.create(pool, {
        providerKey: key,
        displayName: key,
        kind: 'external_api',
        adapterKey: 'openai-api',
        authStrategy: 'api_key',
        baseUrl: upstreamUrl,
        settings,
    });
    await upsertProviderApiKeyAccount({
        appCtx: gateway.appCtx,
        providerId: provider.id,
        providerDisplayName: key,
        apiKey: `${key}-secret-0123456789`,
    });
    return provider;
}

async function sync(provider) {
    const { autoProvisionModels } = await import('../../runtime/providers/auto-provisioner.mjs');
    return autoProvisionModels(gateway.appCtx, provider, null, {
        strict: true,
        discoverySource: 'synced',
        refreshReason: 'test.sync',
    });
}

async function rowsOf(provider) {
    const { rows } = await gateway.appCtx.pool.query(
        'SELECT id, provider_model_id, enabled, retry_policy, metadata FROM models WHERE provider_id = $1',
        [provider.id]
    );
    return new Map(rows.map((row) => [row.provider_model_id, row]));
}

async function parentsOf(modelId) {
    const { rows } = await gateway.appCtx.pool.query(
        'SELECT parent_model_id FROM model_children WHERE child_model_id = $1',
        [modelId]
    );
    return rows;
}

async function chat(model) {
    const started = Date.now();
    const res = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${signed.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model, stream: false, messages: [{ role: 'user', content: 'hi' }] }),
    });
    const text = await res.text();
    return { status: res.status, text, ms: Date.now() - started };
}

async function waitForClosedUpstream(timeoutMs = 2_000) {
    const until = Date.now() + timeoutMs;
    while (openUpstream.size > 0 && Date.now() < until) {
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return openUpstream.size;
}

before(async () => {
    upstream = createServer((req, res) => {
        if (req.method === 'GET') {
            const data = req.url === '/v1/models/user' || req.url === '/v1/models'
                ? CATALOG_IDS.map(catalogEntry)
                : [];
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ data }));
            return;
        }
        openUpstream.add(res);
        res.on('close', () => openUpstream.delete(res));
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
            const parsed = JSON.parse(body || '{}');
            calls.push(parsed.model);
            reply(res, parsed.model);
        });
    });
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    upstreamUrl = `http://127.0.0.1:${upstream.address().port}/v1`;

    dataDir = await mkdtemp(join(tmpdir(), 'soul-free-sync-exec-'));
    signed = makeSignedSubjectKey('agent:verification/free-sync');
    restoreEnv = applyProcessEnv(
        freshGatewayEnv({
            dataDir,
            signed,
            pricingDirectoryUrl: 'http://127.0.0.1:9/none',
            extra: { FREE_MODELS_ENABLED: 'false', HTTP_RETRY_BASE_DELAY_MS: '20' },
        })
    );
    const { bootstrap } = await import('../../bootstrap.mjs');
    gateway = await bootstrap();
    await new Promise((resolve) => gateway.server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${gateway.server.address().port}`;

    providers.free = await createProvider('freeonly', { free_only: true, discovery_path: '/models/user' });
    providers.plain = await createProvider('plain', {});
});

beforeEach(() => {
    calls.length = 0;
});

after(async () => {
    const { shutdown } = await import('../../shutdown.mjs');
    await shutdown(gateway.appCtx, gateway.server, 'test');
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
    restoreEnv();
    await rm(dataDir, { recursive: true, force: true });
});

describe('catalog sync on a free-only provider', () => {
    it('stores no guard model and keeps unfit models out of every cascade', async () => {
        const result = await sync(providers.free);
        assert.equal(result.created, 11);
        const rows = await rowsOf(providers.free);
        assert.equal(rows.has(SAFETY), false);
        for (const id of [LIGHTNING, ROUTER]) {
            const row = rows.get(id);
            assert.equal(row?.enabled, true, id);
            assert.equal(row.metadata.excludeFromTagTiers, true, id);
            assert.deepEqual(await parentsOf(row.id), [], `${id} joined a cascade`);
        }
        const joined = await parentsOf(rows.get(FREE_BASELINE_MODELS[0].providerModelId).id);
        assert.ok(joined.length > 0, 'a baseline model joined its tag tiers');
    });

    it('keeps the exclusion mark on every later sync', async () => {
        await sync(providers.free);
        const rows = await rowsOf(providers.free);
        assert.equal(rows.get(LIGHTNING).metadata.excludeFromTagTiers, true);
        assert.deepEqual(await parentsOf(rows.get(LIGHTNING).id), []);
    });

    it('bounds a stalled synced row and a recreated baseline row to one attempt and the first-event deadline', async () => {
        const { pool } = gateway.appCtx;
        await pool.query('DELETE FROM models WHERE model_key = $1', [`freeonly/${RECREATED}`]);
        await sync(providers.free);
        const recreated = (await rowsOf(providers.free)).get(RECREATED);
        assert.ok(recreated, 'the deleted row is recreated by a raw-database delete');
        assert.deepEqual(recreated.retry_policy, {}, 'recreated rows carry no row policy');

        const [lightning, again] = await Promise.all([
            chat(`freeonly/${LIGHTNING}`),
            chat(`freeonly/${RECREATED}`),
        ]);
        for (const [label, result] of [['synced Lightning', lightning], ['recreated baseline', again]]) {
            assert.equal(result.status, 504, `${label}: ${result.text}`);
            assert.equal(JSON.parse(result.text).error.type, 'provider_timeout', label);
            assert.ok(result.ms <= 31_000, `${label} took ${result.ms}ms`);
            assert.ok(result.ms >= 29_000, `${label} ended early at ${result.ms}ms`);
        }
        assert.deepEqual(calls.filter((model) => model === LIGHTNING), [LIGHTNING]);
        assert.deepEqual(calls.filter((model) => model === RECREATED), [RECREATED]);
        assert.equal(await waitForClosedUpstream(), 0, 'upstream sockets left open');
    });
});

describe('catalog sync on an ordinary provider', () => {
    it('stores every listed model and applies no free-model policy', async () => {
        await sync(providers.plain);
        const rows = await rowsOf(providers.plain);
        assert.ok(rows.has(SAFETY));
        assert.equal(rows.get(LIGHTNING).metadata.excludeFromTagTiers, undefined);
        const snapshotModel = gateway.appCtx.services.snapshot.models.get(`plain/${LIGHTNING}`);
        assert.deepEqual({ ...snapshotModel.retryPolicy }, {});
    });

    it('still retries a failing model three times', async () => {
        const modelsDao = await import('../../db/dao/models-dao.mjs');
        const { performRuntimeRefresh } = await import('../../runtime/registry/runtime-refresh.mjs');
        await modelsDao.create(gateway.appCtx.pool, {
            modelKey: 'plain/plain/fails',
            displayName: 'fails',
            providerId: providers.plain.id,
            providerModelId: 'plain/fails',
        });
        await performRuntimeRefresh(gateway.appCtx, { snapshot: true, reason: 'test' });
        const result = await chat('plain/plain/fails');
        assert.equal(result.status, 502, result.text);
        assert.deepEqual(calls, ['plain/fails', 'plain/fails', 'plain/fails']);
    });
});
