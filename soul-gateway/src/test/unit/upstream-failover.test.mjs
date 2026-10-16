/**
 * End-to-end failover regressions through the real route chain, cascade,
 * retry, timeout, credential lease, OpenAI-compatible backend, and the shared
 * AchillesAgentLib transport, against a local fake upstream (no network).
 */

import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { makeSignedSubjectKey } from '../fixtures/signed-subject-key.mjs';

const calls = [];
const openUpstreamRequests = new Set();
let upstream;
let upstreamUrl;
let gateway;
let base;
let signed;
let envSnapshot;
let dataDir;
const modelIds = {};
let freeCatalog = [];

function reply(res, model) {
    const json = (status, body, headers = {}) => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers });
        res.end(JSON.stringify(body));
    };
    const sse = (chunks, { fail = false } = {}) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const text of chunks) {
            res.write(`data: ${JSON.stringify({ id: 'u', model, choices: [{ index: 0, delta: { content: text } }] })}\n\n`);
        }
        if (fail) {
            setTimeout(() => res.destroy(), 30);
            return;
        }
        res.write(`data: ${JSON.stringify({ id: 'u', model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } })}\n\n`);
        res.end('data: [DONE]\n\n');
    };
    switch (model) {
        case 'ok':
        case 'ok-other':
        case 'vendor/ok:free':
            return sse(['Hello', ' world']);
        case 'notfound':
            return json(404, { error: { message: 'No endpoints found for notfound.', code: 404 } });
        case 'dailylimit':
            return json(429, {
                error: {
                    message: 'Rate limit exceeded: free-models-per-day.',
                    code: 429,
                    metadata: { headers: { 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': String(Date.now() + 3 * 3600_000) } },
                },
            });
        case 'capacity':
            return json(429, { error: { message: 'Provider returned error', code: 429 } }, { 'retry-after': '7' });
        case 'unauthorized':
            return json(401, { error: { message: 'No auth credentials found', code: 401 } });
        case 'badrequest':
            return json(400, { error: { message: 'Invalid parameter: messages', code: 400 } });
        case 'empty':
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            res.end('data: [DONE]\n\n');
            return undefined;
        case 'reasoning-only':
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            res.write(`data: ${JSON.stringify({ id: 'u', model, choices: [{ index: 0, delta: { reasoning: 'thinking...' } }] })}\n\n`);
            res.write(`data: ${JSON.stringify({ id: 'u', model, choices: [{ index: 0, delta: {}, finish_reason: 'length' }] })}\n\n`);
            res.end('data: [DONE]\n\n');
            return undefined;
        case 'hang':
            return undefined;
        case 'stall':
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            res.write(': keepalive\n\n');
            return undefined;
        case 'midfail':
            return sse(['partial'], { fail: true });
        default:
            return json(400, { error: { message: `unknown fake model ${model}` } });
    }
}

async function bootGateway() {
    dataDir = await mkdtemp(join(tmpdir(), 'soul-failover-'));
    signed = makeSignedSubjectKey('agent:verification/failover');
    envSnapshot = { ...process.env };
    Object.assign(process.env, {
        PORT: '0',
        HOST: '127.0.0.1',
        DATA_DIR: dataDir,
        CREDENTIALS_DIR: join(dataDir, 'credentials'),
        SQLITE_PATH: join(dataDir, 'gateway.sqlite3'),
        ENCRYPTION_KEY: '8'.repeat(64),
        PLOINKY_AGENT_API_PUBLIC_KEY: signed.publicKeyBase64url,
        PLOINKY_ROUTER_URL: 'http://127.0.0.1:9',
        PLOINKY_AGENT_ID: 'agent:proxies/soul-gateway',
        PLOINKY_AGENT_PRINCIPAL: 'agent:proxies/soul-gateway',
        PLOINKY_AGENT_SECRET: '7'.repeat(64),
        PLOINKY_AGENT_API_KEY: signed.apiKey,
        PLOINKY_ENV_SOURCE_PLOINKY_AGENT_API_KEY: 'generated',
        PLOINKY_ENV_SOURCE_PLOINKY_AGENT_API_PUBLIC_KEY: 'generated',
        OAUTH_ADAPTERS_ENABLED: '',
        SHUTDOWN_GRACE_MS: '50',
        TOKEN_REFRESH_INTERVAL_MS: '0',
        PRICING_REFRESH_INTERVAL_MS: '0',
        PRICING_DIRECTORY_URL: 'http://127.0.0.1:9/none',
        PROVIDER_MODEL_REFRESH_INTERVAL_MS: '0',
        FREE_MODELS_ENABLED: 'false',
        HTTP_RETRY_BASE_DELAY_MS: '20',
    });
    const { bootstrap } = await import('../../bootstrap.mjs');
    const booted = await bootstrap();
    await new Promise((resolve) => booted.server.listen(0, '127.0.0.1', resolve));
    return booted;
}

async function createProvider(pool, appCtx, key) {
    const providersDao = await import('../../db/dao/providers-dao.mjs');
    const { upsertProviderApiKeyAccount } = await import('../../runtime/providers/api-key-account.mjs');
    const provider = await providersDao.create(pool, {
        providerKey: key,
        displayName: key,
        kind: 'external_api',
        adapterKey: 'openai-api',
        authStrategy: 'api_key',
        baseUrl: upstreamUrl,
    });
    await upsertProviderApiKeyAccount({ appCtx, providerId: provider.id, providerDisplayName: key, apiKey: `${key}-secret-0123456789` });
    return provider;
}

async function seed(appCtx) {
    const pool = appCtx.pool;
    const modelsDao = await import('../../db/dao/models-dao.mjs');
    const childrenDao = await import('../../db/dao/model-children-dao.mjs');
    const { performRuntimeRefresh } = await import('../../runtime/registry/runtime-refresh.mjs');
    const fake = await createProvider(pool, appCtx, 'fake');
    const other = await createProvider(pool, appCtx, 'other');
    const modelSpec = [
        ['ok', fake, {}],
        ['ok-other', other, {}],
        ['notfound', fake, {}],
        ['dailylimit', fake, {}],
        ['capacity', fake, {}],
        ['unauthorized', fake, {}],
        ['badrequest', fake, {}],
        ['hang', fake, {}],
        ['stall', fake, { firstEventTimeoutMs: 150 }],
        ['midfail', fake, {}],
        ['textonly', fake, {}],
        ['empty', fake, {}],
        // A cut-off reply fails over only under the failover policy; the
        // same upstream answer on a row without it keeps its length finish.
        ['reasoning-only', fake, { lengthWithoutContentFails: true }],
        ['reasoning-only-b', fake, { lengthWithoutContentFails: true }],
        ['length-only', fake, {}],
    ];
    const sharedUpstreamIds = { textonly: 'ok', 'length-only': 'reasoning-only', 'reasoning-only-b': 'reasoning-only' };
    for (const [name, provider, extraPolicy] of modelSpec) {
        const row = await modelsDao.create(pool, {
            modelKey: `${provider.provider_key}/${name}`,
            displayName: name,
            providerId: provider.id,
            providerModelId: sharedUpstreamIds[name] || name,
            requestTimeoutMs: 400,
            retryPolicy: { maxAttempts: 1, ...extraPolicy },
            pricingMode: 'free',
            isFree: true,
            capabilities: { supportsTools: true, supportsVision: name !== 'textonly' },
        });
        modelIds[name] = row.id;
    }
    const tiers = {
        'tier-notfound': ['notfound', 'ok'],
        'tier-dailylimit': ['dailylimit', 'ok'],
        'tier-capacity': ['capacity', 'ok'],
        'tier-unauthorized-same': ['unauthorized', 'ok'],
        'tier-unauthorized-cross': ['unauthorized', 'ok-other'],
        'tier-badrequest': ['badrequest', 'ok'],
        'tier-hang': ['hang', 'ok'],
        'tier-stall': ['stall', 'ok'],
        'tier-midfail': ['midfail', 'ok'],
        'tier-vision': ['textonly', 'ok'],
        'tier-empty': ['empty', 'reasoning-only', 'ok'],
        'tier-all-length': ['reasoning-only', 'reasoning-only-b'],
    };
    for (const [tierKey, children] of Object.entries(tiers)) {
        const tier = await modelsDao.createCascade(pool, { modelKey: tierKey, displayName: tierKey, maxAttempts: 3 });
        await childrenDao.replaceChildren(pool, tier.id, children.map((child, index) => ({ childModelId: modelIds[child], priority: index + 1 })));
    }
    const budget = await modelsDao.createCascade(pool, {
        modelKey: 'tier-budget',
        displayName: 'tier-budget',
        maxAttempts: 3,
        metadata: { cascadeBudgetMs: 250 },
    });
    const slow = await modelsDao.create(pool, {
        modelKey: 'fake/hang-slow',
        displayName: 'hang-slow',
        providerId: fake.id,
        providerModelId: 'hang',
        requestTimeoutMs: 5000,
        retryPolicy: { maxAttempts: 1 },
        pricingMode: 'free',
        isFree: true,
    });
    await childrenDao.replaceChildren(pool, budget.id, [
        { childModelId: slow.id, priority: 1 },
        { childModelId: modelIds.ok, priority: 2 },
    ]);
    // A budget larger than a timer can represent means "no tier budget in
    // practice"; it must not overflow into an immediate abort.
    const hugeBudget = await modelsDao.createCascade(pool, {
        modelKey: 'tier-budget-overflow',
        displayName: 'tier-budget-overflow',
        maxAttempts: 3,
        metadata: { cascadeBudgetMs: 2 ** 31 },
    });
    await childrenDao.replaceChildren(pool, hugeBudget.id, [
        { childModelId: modelIds.ok, priority: 1 },
    ]);
    const providersDao = await import('../../db/dao/providers-dao.mjs');
    const { upsertProviderApiKeyAccount } = await import('../../runtime/providers/api-key-account.mjs');
    const freeOnly = await providersDao.create(pool, {
        providerKey: 'freeonly',
        displayName: 'freeonly',
        kind: 'external_api',
        adapterKey: 'openai-api',
        authStrategy: 'api_key',
        baseUrl: upstreamUrl,
        settings: {
            free_only: true,
            discovery_path: '/models/user',
            extra_body: {
                model: 'openai/gpt-4o',
                models: ['openai/gpt-4o'],
                plugins: [{ id: 'web' }],
                provider: { max_price: { prompt: 10, completion: 10 } },
            },
        },
    });
    await upsertProviderApiKeyAccount({ appCtx, providerId: freeOnly.id, providerDisplayName: 'freeonly', apiKey: 'freeonly-secret-0123456789' });
    for (const id of ['vendor/ok:free', 'openai/gpt-4o']) {
        const row = await modelsDao.create(pool, {
            modelKey: `freeonly/${id}`,
            displayName: id,
            providerId: freeOnly.id,
            providerModelId: id,
            retryPolicy: { maxAttempts: 1 },
            discoverySource: 'manual',
        });
        modelIds[`freeonly:${id}`] = row.id;
    }
    modelIds.freeOnlyProvider = freeOnly.id;
    await performRuntimeRefresh(appCtx, { snapshot: true, reason: 'failover-test' });
}

async function chat(model, { stream = false, messages, signal } = {}) {
    const started = Date.now();
    const res = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${signed.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model, stream, messages: messages || [{ role: 'user', content: 'hi' }] }),
        signal,
    });
    const text = await res.text();
    return { status: res.status, text, ms: Date.now() - started, requestId: res.headers.get('x-request-id') };
}

function upstreamModels() {
    return calls.map((call) => call.model);
}

before(async () => {
    upstream = createServer((req, res) => {
        // The response closes when it is answered or its connection drops.
        openUpstreamRequests.add(res);
        res.on('close', () => openUpstreamRequests.delete(res));
        if (req.method === 'GET') {
            const payload = req.url === '/v1/models/user' ? { data: freeCatalog } : { data: [] };
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(payload));
            return;
        }
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
            const parsed = JSON.parse(body || '{}');
            calls.push({ model: parsed.model, body: parsed });
            reply(res, parsed.model);
        });
    });
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    upstreamUrl = `http://127.0.0.1:${upstream.address().port}/v1`;
    gateway = await bootGateway();
    base = `http://127.0.0.1:${gateway.server.address().port}`;
    await seed(gateway.appCtx);
});

beforeEach(async () => {
    calls.length = 0;
    const { appCtx } = gateway;
    await appCtx.pool.query("UPDATE provider_accounts SET status = 'active', quota_resets_at = NULL");
    await appCtx.pool.query('DELETE FROM model_cooldowns');
    appCtx.services.accountPool.clearExhaustions();
    const { performRuntimeRefresh } = await import('../../runtime/registry/runtime-refresh.mjs');
    await performRuntimeRefresh(appCtx, { snapshot: true, reason: 'failover-reset' });
});

after(async () => {
    const { shutdown } = await import('../../shutdown.mjs');
    await shutdown(gateway.appCtx, gateway.server, 'test');
    upstream.closeAllConnections?.();
    await new Promise((resolve) => upstream.close(resolve));
    for (const key of Object.keys(process.env)) {
        if (!(key in envSnapshot)) delete process.env[key];
    }
    Object.assign(process.env, envSnapshot);
    await rm(dataDir, { recursive: true, force: true });
});

describe('upstream failover through the real cascade', () => {
    for (const stream of [false, true]) {
        const mode = stream ? 'streamed' : 'buffered';

        it(`${mode}: an upstream 404 falls back to the next child without retrying`, async () => {
            const result = await chat('tier-notfound', { stream });
            assert.equal(result.status, 200, result.text);
            assert.match(result.text, /Hello/);
            assert.deepEqual(upstreamModels(), ['notfound', 'ok']);
        });

        it(`${mode}: an empty or reasoning-only answer falls back instead of returning nothing`, async () => {
            const result = await chat('tier-empty', { stream });
            assert.equal(result.status, 200, result.text);
            assert.match(result.text, /Hello/);
            assert.deepEqual(upstreamModels(), ['empty', 'reasoning-only', 'ok']);
        });

        it(`${mode}: a reply cut off by the token limit keeps its length finish without the failover policy`, async () => {
            const result = await chat('fake/length-only', { stream });
            assert.equal(result.status, 200, result.text);
            assert.match(result.text, /"finish_reason":"length"/);
            assert.deepEqual(upstreamModels(), ['reasoning-only']);
        });

        it(`${mode}: a direct request keeps the length finish even under the failover policy`, async () => {
            // The same row fails over inside tier-empty; requested directly,
            // no other model would be tried, so the caller gets the signal.
            const result = await chat('fake/reasoning-only', { stream });
            assert.equal(result.status, 200, result.text);
            assert.match(result.text, /"finish_reason":"length"/);
            assert.deepEqual(upstreamModels(), ['reasoning-only']);
        });

        it(`${mode}: a tier whose every child is cut off by length ends with tier_exhausted`, async () => {
            // The last child fails over too, so no length finish reaches the caller.
            const result = await chat('tier-all-length', { stream });
            assert.equal(result.status, 503, result.text);
            assert.match(result.text, /tier_exhausted/);
            assert.deepEqual(upstreamModels(), ['reasoning-only', 'reasoning-only']);
        });

        it(`${mode}: a stalled or hung child is bounded and falls back`, async () => {
            for (const tier of ['tier-hang', 'tier-stall']) {
                calls.length = 0;
                const result = await chat(tier, { stream });
                assert.equal(result.status, 200, `${tier}: ${result.text}`);
                assert.match(result.text, /Hello/);
                assert.ok(result.ms < 2000, `${tier} took ${result.ms}ms`);
                assert.deepEqual(upstreamModels().slice(-1), ['ok']);
            }
        });
    }

    it('keeps the cascade-child marker out of the wire, the reply, the audit row, and the snapshot', async () => {
        const { pool, services } = gateway.appCtx;
        for (const stream of [false, true]) {
            calls.length = 0;
            const result = await chat('tier-notfound', { stream });
            assert.equal(result.status, 200, result.text);
            assert.ok(result.requestId, 'the reply names its request');
            assert.deepEqual(upstreamModels(), ['notfound', 'ok']);
            assert.doesNotMatch(result.text, /cascadeChild/);
            for (const call of calls) assert.doesNotMatch(JSON.stringify(call.body), /cascadeChild/);
            // The audit row is written just after the reply is sent.
            let rows = [];
            for (let wait = 0; rows.length === 0 && wait < 100; wait += 1) {
                if (wait > 0) await new Promise((resolve) => setTimeout(resolve, 20));
                ({ rows } = await pool.query('SELECT * FROM audit_logs WHERE request_id = $1', [result.requestId]));
            }
            assert.equal(rows.length, 1, `audit row for ${result.requestId}`);
            assert.doesNotMatch(JSON.stringify(rows[0]), /cascadeChild/);
        }
        for (const key of ['fake/notfound', 'fake/ok']) {
            assert.equal('cascadeChild' in services.snapshot.models.get(key), false, key);
        }
    });

    it('a daily account quota marks the shared account exhausted and stops sibling calls', async () => {
        const first = await chat('tier-dailylimit');
        assert.equal(first.status, 429, first.text);
        assert.equal(JSON.parse(first.text).error.type, 'provider_quota_exhausted');
        assert.deepEqual(upstreamModels(), ['dailylimit']);
        const { rows } = await gateway.appCtx.pool.query(
            "SELECT status, quota_resets_at FROM provider_accounts pa JOIN providers p ON p.id = pa.provider_id WHERE p.provider_key = 'fake'"
        );
        assert.equal(rows[0].status, 'quota_exhausted');
        const resetIn = Date.parse(rows[0].quota_resets_at) - Date.now();
        assert.ok(resetIn > 2.5 * 3600_000 && resetIn <= 3 * 3600_000, `reset in ${resetIn}ms`);

        calls.length = 0;
        const second = await chat('tier-notfound');
        assert.equal(second.status, 429, second.text);
        assert.deepEqual(upstreamModels(), [], 'no upstream call while the account is exhausted');
    });

    it('a model capacity 429 cascades once and cools only that model briefly', async () => {
        const result = await chat('tier-capacity');
        assert.equal(result.status, 200, result.text);
        assert.deepEqual(upstreamModels(), ['capacity', 'ok']);
        await new Promise((resolve) => setTimeout(resolve, 100));
        const { rows } = await gateway.appCtx.pool.query(
            'SELECT m.model_key, cd.expires_at FROM model_cooldowns cd JOIN models m ON m.id = cd.model_id'
        );
        assert.deepEqual(rows.map((row) => row.model_key), ['fake/capacity']);
        const cooldownMs = Date.parse(rows[0].expires_at) - Date.now();
        assert.ok(cooldownMs > 5_000 && cooldownMs <= 7_000, `cooldown ${cooldownMs}ms`);
    });

    it('a rejected credential is not retried and skips children on the same account', async () => {
        const same = await chat('tier-unauthorized-same');
        assert.equal(same.status, 502, same.text);
        assert.equal(JSON.parse(same.text).error.type, 'provider_auth_error');
        assert.deepEqual(upstreamModels(), ['unauthorized']);

        calls.length = 0;
        const cross = await chat('tier-unauthorized-cross');
        assert.equal(cross.status, 200, cross.text);
        assert.deepEqual(upstreamModels(), ['unauthorized', 'ok-other']);
    });

    it('an upstream request validation failure neither retries nor cascades', async () => {
        const result = await chat('tier-badrequest');
        assert.equal(result.status, 400, result.text);
        assert.equal(JSON.parse(result.text).error.type, 'provider_bad_request');
        assert.deepEqual(upstreamModels(), ['badrequest']);
    });

    it('a failure after streamed output terminates the stream with an error event', async () => {
        const result = await chat('tier-midfail', { stream: true });
        assert.equal(result.status, 200);
        assert.match(result.text, /partial/);
        assert.match(result.text, /"error"/);
        assert.doesNotMatch(result.text, /Hello/, 'output must not be replaced mid-stream');
        assert.deepEqual(upstreamModels(), ['midfail']);
    });

    it('a buffered failure after partial output may still fall back safely', async () => {
        const result = await chat('tier-midfail');
        assert.equal(result.status, 200, result.text);
        assert.match(result.text, /Hello world/);
        assert.deepEqual(upstreamModels(), ['midfail', 'ok']);
    });

    it('a tier budget caps the whole fallback walk', async () => {
        const result = await chat('tier-budget');
        assert.equal(result.status, 504, result.text);
        assert.ok(result.ms < 1500, `budget exceeded: ${result.ms}ms`);
    });

    it('a tier budget too large for a timer does not abort the walk at once', async () => {
        const result = await chat('tier-budget-overflow');
        assert.equal(result.status, 200, result.text);
        assert.deepEqual(upstreamModels(), ['ok']);
    });

    it('image requests skip children recorded as text-only', async () => {
        const result = await chat('tier-vision', {
            messages: [{
                role: 'user',
                content: [
                    { type: 'text', text: 'describe' },
                    { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
                ],
            }],
        });
        assert.equal(result.status, 200, result.text);
        assert.equal(calls.length, 1);
        assert.equal(JSON.parse(result.text).model, 'fake/ok');
    });

    it('a client disconnect aborts the in-flight upstream request', async () => {
        const controller = new AbortController();
        const pending = chat('tier-hang', { stream: true, signal: controller.signal }).catch((err) => err);
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.equal(openUpstreamRequests.size, 1);
        controller.abort();
        await pending;
        const deadline = Date.now() + 1000;
        while (openUpstreamRequests.size > 0 && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
        assert.equal(openUpstreamRequests.size, 0, 'upstream request left open');
        await new Promise((resolve) => setTimeout(resolve, 600));
        assert.deepEqual(upstreamModels(), ['hang'], 'no fallback after the client left');
    });
});

function catalogEntry(id, pricing = { prompt: '0', completion: '0' }, architecture = { input_modalities: ['text'], output_modalities: ['text'] }) {
    return { id, name: id, pricing, architecture, context_length: 8192, supported_parameters: ['tools'] };
}

async function refreshCatalog() {
    const { refreshProviderModelCatalog } = await import('../../runtime/providers/provider-catalog-refresh.mjs');
    return refreshProviderModelCatalog(gateway.appCtx, {
        phase: 'test',
        discoverySource: 'synced',
        disableMissing: true,
    });
}

async function syncedFreeModels() {
    const { rows } = await gateway.appCtx.pool.query(
        "SELECT provider_model_id, enabled FROM models WHERE provider_id = $1 AND discovery_source = 'synced' ORDER BY provider_model_id",
        [modelIds.freeOnlyProvider]
    );
    return Object.fromEntries(rows.map((row) => [row.provider_model_id, row.enabled]));
}

describe('free-only provider policy through the real gateway', () => {
    it('forces zero price ceilings and strips paid routing on the wire', async () => {
        const res = await fetch(`${base}/v1/chat/completions`, {
            method: 'POST',
            headers: { authorization: `Bearer ${signed.apiKey}`, 'content-type': 'application/json' },
            body: JSON.stringify({
                model: 'freeonly/vendor/ok:free',
                messages: [{ role: 'user', content: 'hi' }],
                models: ['openai/gpt-4o'],
                route: 'fallback',
                plugins: [{ id: 'web' }],
                provider: { max_price: { prompt: 99 } },
            }),
        });
        assert.equal(res.status, 200, await res.clone().text());
        assert.equal(calls.length, 1);
        const sent = calls[0].body;
        assert.equal(sent.model, 'vendor/ok:free');
        assert.deepEqual(sent.provider.max_price, { prompt: 0, completion: 0, request: 0, image: 0 });
        for (const field of ['models', 'route', 'plugins']) {
            assert.equal(Object.hasOwn(sent, field), false, field);
        }
    });

    it('blocks a paid model row on the free-only provider before any upstream call', async () => {
        const result = await chat('freeonly/openai/gpt-4o');
        assert.equal(result.status, 502, result.text);
        assert.match(result.text, /free-only provider policy/);
        assert.deepEqual(upstreamModels(), []);
    });

    it('admits only strictly free chat entries, disables repriced ones, and keeps operator disables', async () => {
        freeCatalog = [
            catalogEntry('vendor/alpha:free'),
            catalogEntry('vendor/beta:free'),
            catalogEntry('openai/gpt-4o'),
            catalogEntry('vendor/sneaky:free', { prompt: '0', completion: '0', request: '0.02' }),
            catalogEntry('vendor/blank:free', { prompt: ' ', completion: '0' }),
            catalogEntry('vendor/embed:free', { prompt: '0', completion: '0' }, { input_modalities: ['text'], output_modalities: ['embeddings'] }),
            catalogEntry('openrouter/auto', { prompt: '-1', completion: '-1' }),
        ];
        await refreshCatalog();
        assert.deepEqual(await syncedFreeModels(), { 'vendor/alpha:free': true, 'vendor/beta:free': true });

        const modelsDao = await import('../../db/dao/models-dao.mjs');
        const beta = await modelsDao.findByKey(gateway.appCtx.pool, 'freeonly/vendor/beta:free');
        await modelsDao.disable(gateway.appCtx.pool, beta.id);

        freeCatalog = [
            catalogEntry('vendor/alpha:free', { prompt: '0.0000001', completion: '0' }),
            catalogEntry('vendor/beta:free'),
            catalogEntry('vendor/gamma:free'),
        ];
        await refreshCatalog();
        assert.deepEqual(await syncedFreeModels(), {
            'vendor/alpha:free': false,
            'vendor/beta:free': false,
            'vendor/gamma:free': true,
        });
    });

    it('disables every synced model when nothing is free, but keeps them on an empty upstream response', async () => {
        freeCatalog = [catalogEntry('vendor/delta:free')];
        await refreshCatalog();
        assert.equal((await syncedFreeModels())['vendor/delta:free'], true);

        freeCatalog = [];
        await refreshCatalog();
        assert.equal((await syncedFreeModels())['vendor/delta:free'], true, 'an empty upstream catalog is not evidence of repricing');

        freeCatalog = [catalogEntry('vendor/delta:free', { prompt: '0.000001', completion: '0.000002' })];
        await refreshCatalog();
        assert.equal((await syncedFreeModels())['vendor/delta:free'], false);
    });
});
