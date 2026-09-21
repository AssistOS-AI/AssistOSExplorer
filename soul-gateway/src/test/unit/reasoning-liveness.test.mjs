/**
 * Upstream reasoning proves liveness: before the first answer token the
 * first-event deadline is a silence window that reasoning restarts, and a
 * separate first-content cap bounds the whole wait. SSE keepalive comments
 * are not liveness. Liveness never reaches the client, buffered or streamed.
 * Real gateway, cascade, retry, timeout, AchillesAgentLib transport, and a
 * local stub upstream with scaled deadlines; no network.
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
const CONTENT_CAP_MS = 2_000;
const IDLE_MS = 400;
const REASONING_MS = 1_200;
const TICK_MS = 100;

const calls = [];
const openUpstream = new Set();
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
        case 'reason-then-answer':
            return every(res, TICK_MS, () => res.write(frame({ reasoning: 'thinking ' })), {
                forMs: REASONING_MS,
                then: () => finish(res, 'answer from reasoner'),
            });
        case 'reason-forever':
            return every(res, TICK_MS, () => res.write(frame({ reasoning_content: 'still thinking ' })));
        case 'keepalive-only':
            return every(res, TICK_MS, () => res.write(': keepalive\n\n'));
        case 'stall':
            return undefined;
        case 'reason-mid-stream':
            res.write(frame({ content: 'Hello' }));
            return every(res, TICK_MS, () => res.write(frame({ reasoning: 'hmm ' })), {
                forMs: IDLE_MS * 3,
                then: () => finish(res, ' world'),
            });
        default:
            return finish(res, 'answer from fallback');
    }
}

async function seed() {
    const { pool } = gateway.appCtx;
    const providersDao = await import('../../db/dao/providers-dao.mjs');
    const modelsDao = await import('../../db/dao/models-dao.mjs');
    const childrenDao = await import('../../db/dao/model-children-dao.mjs');
    const { upsertProviderApiKeyAccount } = await import('../../runtime/providers/api-key-account.mjs');
    const { performRuntimeRefresh } = await import('../../runtime/registry/runtime-refresh.mjs');
    const provider = await providersDao.create(pool, {
        providerKey: 'freeonly',
        displayName: 'freeonly',
        kind: 'external_api',
        adapterKey: 'openai-api',
        authStrategy: 'api_key',
        baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`,
        settings: { free_only: true },
    });
    await upsertProviderApiKeyAccount({
        appCtx: gateway.appCtx,
        providerId: provider.id,
        providerDisplayName: 'freeonly',
        apiKey: 'freeonly-secret-0123456789',
    });
    const ids = {};
    for (const name of ['reason-then-answer', 'reason-forever', 'keepalive-only', 'stall', 'reason-mid-stream', 'ok']) {
        const id = `vendor/${name}:free`;
        const row = await modelsDao.create(pool, {
            modelKey: `freeonly/${id}`,
            displayName: name,
            providerId: provider.id,
            providerModelId: id,
            pricingMode: 'free',
            isFree: true,
            discoverySource: 'synced',
        });
        ids[name] = row.id;
    }
    // Tier child settings carry scaled deadlines and win over the free-model
    // execution defaults, exactly as the installed tiers do.
    const settings = {
        requestTimeoutMs: 10_000,
        retryPolicy: {
            firstEventTimeoutMs: SILENCE_MS,
            firstContentTimeoutMs: CONTENT_CAP_MS,
            streamIdleTimeoutMs: IDLE_MS,
        },
    };
    const tiers = {
        't-reason': ['reason-then-answer', 'ok'],
        't-forever': ['reason-forever', 'ok'],
        't-keepalive': ['keepalive-only', 'ok'],
        't-stall': ['stall', 'ok'],
        't-mid': ['reason-mid-stream'],
    };
    for (const [key, children] of Object.entries(tiers)) {
        const tier = await modelsDao.createCascade(pool, { modelKey: key, displayName: key, maxAttempts: 3 });
        await childrenDao.replaceChildren(pool, tier.id, children.map((name, index) => ({
            childModelId: ids[name],
            priority: index + 1,
            settings,
        })));
    }
    await performRuntimeRefresh(gateway.appCtx, { snapshot: true, reason: 'liveness-test' });
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

function assertNoLiveness(text) {
    assert.doesNotMatch(text, /activity|reasoning|thinking|still thinking|hmm/i, text);
}

before(async () => {
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
    dataDir = await mkdtemp(join(tmpdir(), 'soul-liveness-'));
    signed = makeSignedSubjectKey('agent:verification/liveness');
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
    await performRuntimeRefresh(gateway.appCtx, { snapshot: true, reason: 'liveness-reset' });
});

after(async () => {
    const { shutdown } = await import('../../shutdown.mjs');
    await shutdown(gateway.appCtx, gateway.server, 'test');
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
    restoreEnv();
    await rm(dataDir, { recursive: true, force: true });
});

describe('pre-commit deadlines with upstream liveness', () => {
    for (const stream of [false, true]) {
        const mode = stream ? 'streamed' : 'buffered';

        it(`${mode}: a child that reasons longer than the silence window still serves`, async () => {
            const result = await chat('t-reason', stream);
            assert.equal(result.status, 200, result.text);
            assert.match(result.text, /answer from reasoner/);
            assert.deepEqual(calls, ['reason-then-answer']);
            assert.ok(result.ms >= REASONING_MS - 100 && result.ms < CONTENT_CAP_MS, `took ${result.ms}ms`);
            assertNoLiveness(result.text);
            if (stream) assert.match(result.text, /data: \[DONE\]/);
        });

        it(`${mode}: keepalive comments are not liveness`, async () => {
            const result = await chat('t-keepalive', stream);
            assert.equal(result.status, 200, result.text);
            assert.match(result.text, /answer from fallback/);
            assert.deepEqual(calls, ['keepalive-only', 'ok']);
            assert.ok(result.ms >= SILENCE_MS - 50 && result.ms < SILENCE_MS + 600, `took ${result.ms}ms`);
            assert.equal(await openUpstreamAfterSettle(), 0);
        });

        it(`${mode}: HTTP 200 and then nothing is abandoned at the silence window`, async () => {
            const result = await chat('t-stall', stream);
            assert.equal(result.status, 200, result.text);
            assert.deepEqual(calls, ['stall', 'ok']);
            assert.ok(result.ms >= SILENCE_MS - 50 && result.ms < SILENCE_MS + 600, `took ${result.ms}ms`);
            assert.equal(await openUpstreamAfterSettle(), 0);
        });

        it(`${mode}: endless reasoning is abandoned at the first-content cap`, async () => {
            const result = await chat('t-forever', stream);
            assert.equal(result.status, 200, result.text);
            assert.match(result.text, /answer from fallback/);
            assert.deepEqual(calls, ['reason-forever', 'ok']);
            assert.ok(
                result.ms >= CONTENT_CAP_MS - 50 && result.ms < CONTENT_CAP_MS + 800,
                `took ${result.ms}ms`
            );
            assertNoLiveness(result.text);
            assert.equal(await openUpstreamAfterSettle(), 0);
        });

        it(`${mode}: reasoning after the answer started keeps the stream alive and stays hidden`, async () => {
            const result = await chat('t-mid', stream);
            assert.equal(result.status, 200, result.text);
            assertNoLiveness(result.text);
            if (stream) {
                const text = result.text
                    .split('\n')
                    .filter((line) => line.startsWith('data: {'))
                    .map((line) => JSON.parse(line.slice(6)).choices?.[0]?.delta?.content || '')
                    .join('');
                assert.equal(text, 'Hello world');
                assert.match(result.text, /data: \[DONE\]/);
            } else {
                const body = JSON.parse(result.text);
                assert.equal(body.choices[0].message.content, 'Hello world');
                assert.deepEqual(Object.keys(body.choices[0].message).sort(), ['content', 'role']);
            }
            assert.deepEqual(calls, ['reason-mid-stream']);
        });
    }
});
