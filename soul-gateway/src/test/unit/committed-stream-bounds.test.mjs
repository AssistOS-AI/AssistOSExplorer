/**
 * A committed stream is bounded even while the upstream keeps reasoning.
 * Liveness restarts the idle deadline, so a model that resumes its answer is
 * still served, but it never restarts the content-gap deadline
 * (`max(streamIdleTimeoutMs, firstContentTimeoutMs)`), so endless reasoning
 * after commit ends with `provider_timeout` and the upstream socket closed.
 * A model without a first-content cap keeps the older bound: one idle
 * deadline after its last content event. Buffered attempts hold no lease and
 * stay bounded by the whole-attempt deadline. Real gateway, cascade, retry,
 * timeout, AchillesAgentLib transport and a local stub upstream with scaled
 * deadlines; no network.
 */

import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { makeSignedSubjectKey } from '../fixtures/signed-subject-key.mjs';
import { applyProcessEnv, freshGatewayEnv } from '../fixtures/fresh-gateway-boot.mjs';

const SILENCE_MS = 400;
const IDLE_MS = 400;
const CONTENT_CAP_MS = 1_200;
const TICK_MS = 100;
const RESUME_REASONING_MS = 800;
const STREAM_REQUEST_TIMEOUT_MS = 10_000;
const BUFFERED_REQUEST_TIMEOUT_MS = 1_500;

const calls = [];
const openUpstream = new Set();
const unhandled = [];
let upstream;
let gateway;
let base;
let signed;
let dataDir;
let restoreEnv;

function frame(delta, finish = null) {
    return `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
}

function every(res, ms, write, { forMs = Infinity, then } = {}) {
    const started = Date.now();
    const timer = setInterval(() => {
        if (Date.now() - started >= forMs) {
            clearInterval(timer);
            then?.();
            return;
        }
        write();
    }, ms);
    res.on('close', () => clearInterval(timer));
}

function finish(res, text) {
    res.write(frame({ content: text }));
    res.write(frame({}, 'stop'));
    res.end('data: [DONE]\n\n');
}

function reply(res, model) {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.flushHeaders();
    switch (model) {
        case 'commit-reason-forever':
            res.write(frame({ content: 'partial ' }));
            return every(res, TICK_MS, () => res.write(frame({ reasoning: 'thinking ' })));
        case 'commit-reason-resume':
            res.write(frame({ content: 'Hello' }));
            return every(res, TICK_MS, () => res.write(frame({ reasoning: 'hmm ' })), {
                forMs: RESUME_REASONING_MS,
                then: () => finish(res, ' world'),
            });
        default:
            return finish(res, 'answer from fallback');
    }
}

const SCENARIOS = ['commit-reason-forever', 'commit-reason-resume', 'ok'];

// Child settings win over the model row and over the free-only execution
// defaults, exactly as the installed tiers do.
function capped(requestTimeoutMs) {
    return {
        requestTimeoutMs,
        retryPolicy: {
            firstEventTimeoutMs: SILENCE_MS,
            firstContentTimeoutMs: CONTENT_CAP_MS,
            streamIdleTimeoutMs: IDLE_MS,
        },
    };
}

// No first-content cap: the content-gap deadline collapses onto the idle
// deadline, which is how every model behaved before liveness existed.
function uncapped(requestTimeoutMs) {
    return {
        requestTimeoutMs,
        retryPolicy: {
            firstEventTimeoutMs: SILENCE_MS,
            streamIdleTimeoutMs: IDLE_MS,
        },
    };
}

async function seedProvider({ providerKey, settings }) {
    const { pool } = gateway.appCtx;
    const providersDao = await import('../../db/dao/providers-dao.mjs');
    const modelsDao = await import('../../db/dao/models-dao.mjs');
    const { upsertProviderApiKeyAccount } = await import('../../runtime/providers/api-key-account.mjs');
    const provider = await providersDao.create(pool, {
        providerKey,
        displayName: providerKey,
        kind: 'external_api',
        adapterKey: 'openai-api',
        authStrategy: 'api_key',
        baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`,
        settings,
    });
    await upsertProviderApiKeyAccount({
        appCtx: gateway.appCtx,
        providerId: provider.id,
        providerDisplayName: providerKey,
        apiKey: `${providerKey}-secret-0123456789`,
    });
    const ids = {};
    for (const name of SCENARIOS) {
        const id = `vendor/${name}:free`;
        const row = await modelsDao.create(pool, {
            modelKey: `${providerKey}/${id}`,
            displayName: `${providerKey} ${name}`,
            providerId: provider.id,
            providerModelId: id,
            pricingMode: 'free',
            isFree: true,
            discoverySource: 'synced',
        });
        ids[name] = row.id;
    }
    return ids;
}

async function seedTier(modelKey, children) {
    const { pool } = gateway.appCtx;
    const modelsDao = await import('../../db/dao/models-dao.mjs');
    const childrenDao = await import('../../db/dao/model-children-dao.mjs');
    const tier = await modelsDao.createCascade(pool, {
        modelKey,
        displayName: modelKey,
        maxAttempts: 3,
    });
    await childrenDao.replaceChildren(
        pool,
        tier.id,
        children.map(({ childModelId, settings }, index) => ({
            childModelId,
            priority: index + 1,
            settings,
        }))
    );
}

async function seed() {
    const free = await seedProvider({
        providerKey: 'freeonly',
        settings: { free_only: true },
    });
    const ordinary = await seedProvider({ providerKey: 'ordinary', settings: {} });

    await seedTier('t-capped', [
        {
            childModelId: free['commit-reason-forever'],
            settings: capped(STREAM_REQUEST_TIMEOUT_MS),
        },
    ]);
    await seedTier('t-uncapped', [
        {
            childModelId: ordinary['commit-reason-forever'],
            settings: uncapped(STREAM_REQUEST_TIMEOUT_MS),
        },
    ]);
    await seedTier('t-resume', [
        {
            childModelId: free['commit-reason-resume'],
            settings: capped(STREAM_REQUEST_TIMEOUT_MS),
        },
    ]);
    await seedTier('t-buffered', [
        {
            childModelId: free['commit-reason-forever'],
            settings: capped(BUFFERED_REQUEST_TIMEOUT_MS),
        },
        { childModelId: free.ok, settings: capped(BUFFERED_REQUEST_TIMEOUT_MS) },
    ]);

    const { performRuntimeRefresh } = await import('../../runtime/registry/runtime-refresh.mjs');
    await performRuntimeRefresh(gateway.appCtx, { snapshot: true, reason: 'bounds-test' });
}

async function chat(model, stream) {
    const started = Date.now();
    const res = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${signed.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model, stream, messages: [{ role: 'user', content: 'hi' }] }),
    });
    const text = await res.text();
    return { status: res.status, text, ms: Date.now() - started };
}

async function openUpstreamAfterSettle() {
    const until = Date.now() + 2_000;
    while (openUpstream.size > 0 && Date.now() < until) {
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return openUpstream.size;
}

function collectUnhandled(reason) {
    unhandled.push(reason);
}

before(async () => {
    process.on('unhandledRejection', collectUnhandled);
    upstream = createServer((req, res) => {
        openUpstream.add(res);
        res.on('close', () => openUpstream.delete(res));
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
            const model = JSON.parse(body || '{}').model || '';
            const name = model.replace(/^vendor\//, '').replace(/:free$/, '');
            calls.push(name);
            reply(res, name);
        });
    });
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    dataDir = await mkdtemp(join(tmpdir(), 'soul-bounds-'));
    signed = makeSignedSubjectKey('agent:verification/bounds');
    restoreEnv = applyProcessEnv(
        freshGatewayEnv({
            dataDir,
            signed,
            pricingDirectoryUrl: 'http://127.0.0.1:9/none',
            extra: { FREE_MODELS_ENABLED: 'false' },
        })
    );
    const { bootstrap } = await import('../../bootstrap.mjs');
    gateway = await bootstrap();
    await new Promise((resolve) => gateway.server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${gateway.server.address().port}`;
    await seed();
});

beforeEach(async () => {
    calls.length = 0;
    await gateway.appCtx.pool.query('DELETE FROM model_cooldowns');
    const { performRuntimeRefresh } = await import('../../runtime/registry/runtime-refresh.mjs');
    await performRuntimeRefresh(gateway.appCtx, { snapshot: true, reason: 'bounds-reset' });
});

after(async () => {
    const { shutdown } = await import('../../shutdown.mjs');
    await shutdown(gateway.appCtx, gateway.server, 'test');
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
    restoreEnv();
    await rm(dataDir, { recursive: true, force: true });
    process.off('unhandledRejection', collectUnhandled);
    assert.deepEqual(unhandled, []);
});

describe('post-commit bounds of a reasoning stream', () => {
    it('streamed: endless reasoning after commit ends at the content-gap deadline', async () => {
        const result = await chat('t-capped', true);
        assert.equal(result.status, 200, result.text);
        assert.match(result.text, /partial /);
        assert.match(result.text, /provider_timeout/);
        // A committed stream that fails is never completed with [DONE].
        assert.doesNotMatch(result.text, /data: \[DONE\]/);
        assert.doesNotMatch(result.text, /thinking|activity/i);
        assert.deepEqual(calls, ['commit-reason-forever']);
        assert.ok(
            result.ms >= CONTENT_CAP_MS - 150 && result.ms < CONTENT_CAP_MS + 800,
            `took ${result.ms}ms`
        );
        assert.equal(await openUpstreamAfterSettle(), 0);
    });

    it('streamed: without a first-content cap the bound is one idle deadline after the last content event', async () => {
        const result = await chat('t-uncapped', true);
        assert.equal(result.status, 200, result.text);
        assert.match(result.text, /partial /);
        assert.match(result.text, /provider_timeout/);
        assert.doesNotMatch(result.text, /data: \[DONE\]/);
        assert.deepEqual(calls, ['commit-reason-forever']);
        assert.ok(
            result.ms >= IDLE_MS - 150 && result.ms < CONTENT_CAP_MS,
            `took ${result.ms}ms`
        );
        assert.equal(await openUpstreamAfterSettle(), 0);
    });

    it('streamed: reasoning longer than the idle deadline between content events still serves', async () => {
        const result = await chat('t-resume', true);
        assert.equal(result.status, 200, result.text);
        const text = result.text
            .split('\n')
            .filter((line) => line.startsWith('data: {'))
            .map((line) => JSON.parse(line.slice(6)).choices?.[0]?.delta?.content || '')
            .join('');
        assert.equal(text, 'Hello world');
        assert.match(result.text, /data: \[DONE\]/);
        assert.doesNotMatch(result.text, /hmm|activity/i);
        assert.deepEqual(calls, ['commit-reason-resume']);
        assert.ok(
            result.ms >= RESUME_REASONING_MS - 150 && result.ms < CONTENT_CAP_MS + 800,
            `took ${result.ms}ms`
        );
    });

    it('buffered: endless reasoning after commit is bounded by the attempt deadline', async () => {
        const result = await chat('t-buffered', false);
        assert.equal(result.status, 200, result.text);
        assert.match(result.text, /answer from fallback/);
        assert.deepEqual(calls, ['commit-reason-forever', 'ok']);
        assert.ok(
            result.ms >= BUFFERED_REQUEST_TIMEOUT_MS - 150 &&
                result.ms < BUFFERED_REQUEST_TIMEOUT_MS + 900,
            `took ${result.ms}ms`
        );
        assert.equal(await openUpstreamAfterSettle(), 0);
    });
});
