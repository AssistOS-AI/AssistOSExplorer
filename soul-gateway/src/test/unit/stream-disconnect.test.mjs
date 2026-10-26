/**
 * A client that stops reading a streamed response and then disconnects
 * must never suspend the request.  Once the client's socket buffers are
 * full, every write of the respond step returns false and it waits for
 * `drain`, which a destroyed socket never emits.  The disconnect must still
 * end that wait, write the audit row as aborted, release the backend
 * generation and close the upstream request.  A client that only reads
 * slowly must still receive the whole answer, because the respond step
 * keeps waiting for `drain` while the socket is alive.
 *
 * Real gateway, cascade, retry, timeout, AchillesAgentLib transport and a
 * local stub upstream on ephemeral loopback ports; no network.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { makeSignedSubjectKey } from '../fixtures/signed-subject-key.mjs';
import { applyProcessEnv, freshGatewayEnv } from '../fixtures/fresh-gateway-boot.mjs';

const CHUNK_TEXT = 'x'.repeat(16 * 1024);
// Far more than the loopback socket buffers hold, so a client that does not
// read always backs the respond step up before the upstream runs out.
const HELD_LIMIT_BYTES = 256 * 1024 * 1024;
const FINITE_LIMIT_BYTES = 24 * 1024 * 1024;
const BACKED_UP_MS = 300;
const BACK_UP_TIMEOUT_MS = 15_000;
const SETTLE_TIMEOUT_MS = 3_000;
const CONCURRENT_CLIENTS = 8;

const upstreamStreams = new Set();
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

// Streams 16 KiB text deltas as fast as the gateway reads them, honouring
// back-pressure, up to `limitBytes`.  `finish` ends the answer there;
// otherwise the stream stays open until the gateway closes it.
async function flood(res, { limitBytes, finish }) {
    const progress = { sent: 0, backedUpSince: null, closed: false };
    upstreamStreams.add(progress);
    const closed = new AbortController();
    res.on('close', () => {
        progress.closed = true;
        closed.abort();
    });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.flushHeaders();
    while (!progress.closed && progress.sent < limitBytes) {
        progress.sent += CHUNK_TEXT.length;
        if (res.write(frame({ content: CHUNK_TEXT }))) continue;
        progress.backedUpSince = Date.now();
        try {
            await once(res, 'drain', { signal: closed.signal });
        } catch {
            return;
        }
        progress.backedUpSince = null;
    }
    if (!progress.closed && finish) {
        res.write(frame({}, 'stop'));
        res.end('data: [DONE]\n\n');
    }
}

function backedUp(progress) {
    return (
        progress.backedUpSince !== null &&
        Date.now() - progress.backedUpSince >= BACKED_UP_MS
    );
}

async function waitFor(probe, timeoutMs) {
    const until = Date.now() + timeoutMs;
    while (true) {
        const value = await probe();
        if (value || Date.now() >= until) return value;
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
}

// Opens a streamed chat completion and does not read the body.
function openStream(model) {
    return new Promise((resolve, reject) => {
        const req = request(`${base}/v1/chat/completions`, {
            method: 'POST',
            headers: {
                authorization: `Bearer ${signed.apiKey}`,
                'content-type': 'application/json',
            },
        });
        req.on('response', (res) => {
            // Destroying the request later aborts this response.
            res.on('error', () => {});
            resolve({ req, res });
        });
        req.on('error', reject);
        req.end(JSON.stringify({
            model,
            stream: true,
            messages: [{ role: 'user', content: 'hi' }],
        }));
    });
}

async function readContent(res) {
    res.setEncoding('utf8');
    let pending = '';
    let contentChars = 0;
    let done = false;
    for await (const chunk of res) {
        pending += chunk;
        const end = pending.lastIndexOf('\n\n');
        if (end === -1) continue;
        for (const line of pending.slice(0, end).split('\n')) {
            if (line === 'data: [DONE]') done = true;
            if (!line.startsWith('data: {')) continue;
            contentChars +=
                JSON.parse(line.slice(6)).choices?.[0]?.delta?.content?.length || 0;
        }
        pending = pending.slice(end + 2);
    }
    return { contentChars, done, rest: pending };
}

async function auditStatus(requestId) {
    const { rows } = await gateway.appCtx.pool.query(
        'SELECT status FROM audit_logs WHERE request_id = $1',
        [requestId]
    );
    return rows[0]?.status ?? null;
}

// Leases of the current backend generation still held by requests.
function inflightGenerationLeases() {
    return gateway.appCtx.services.backendCatalog._inflightCount;
}

async function seed() {
    const { pool } = gateway.appCtx;
    const providersDao = await import('../../db/dao/providers-dao.mjs');
    const modelsDao = await import('../../db/dao/models-dao.mjs');
    const childrenDao = await import('../../db/dao/model-children-dao.mjs');
    const { upsertProviderApiKeyAccount } = await import('../../runtime/providers/api-key-account.mjs');
    const provider = await providersDao.create(pool, {
        providerKey: 'local',
        displayName: 'local',
        kind: 'external_api',
        adapterKey: 'openai-api',
        authStrategy: 'api_key',
        baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`,
        settings: {},
    });
    await upsertProviderApiKeyAccount({
        appCtx: gateway.appCtx,
        providerId: provider.id,
        providerDisplayName: 'local',
        apiKey: 'local-secret-0123456789',
    });
    for (const name of ['held', 'finite']) {
        const model = await modelsDao.create(pool, {
            modelKey: `local/vendor/${name}`,
            displayName: `local ${name}`,
            providerId: provider.id,
            providerModelId: `vendor/${name}`,
            pricingMode: 'free',
            isFree: true,
            discoverySource: 'synced',
        });
        const tier = await modelsDao.createCascade(pool, {
            modelKey: `t-${name}`,
            displayName: `t-${name}`,
            maxAttempts: 1,
        });
        await childrenDao.replaceChildren(pool, tier.id, [
            {
                childModelId: model.id,
                priority: 1,
                settings: { requestTimeoutMs: 60_000 },
            },
        ]);
    }

    const { performRuntimeRefresh } = await import('../../runtime/registry/runtime-refresh.mjs');
    await performRuntimeRefresh(gateway.appCtx, { snapshot: true, reason: 'disconnect-test' });
}

function collectUnhandled(reason) {
    unhandled.push(reason);
}

before(async () => {
    process.on('unhandledRejection', collectUnhandled);
    upstream = createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
            const model = JSON.parse(body || '{}').model || '';
            void flood(res, model.endsWith('/finite')
                ? { limitBytes: FINITE_LIMIT_BYTES, finish: true }
                : { limitBytes: HELD_LIMIT_BYTES, finish: false });
        });
    });
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    dataDir = await mkdtemp(join(tmpdir(), 'soul-disconnect-'));
    signed = makeSignedSubjectKey('agent:verification/disconnect');
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

// Each step is guarded so a failed `before` still closes what it opened.
after(async () => {
    if (gateway) {
        const { shutdown } = await import('../../shutdown.mjs');
        await shutdown(gateway.appCtx, gateway.server, 'test');
    }
    if (upstream) {
        upstream.closeAllConnections();
        await new Promise((resolve) => upstream.close(resolve));
    }
    restoreEnv?.();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
    process.off('unhandledRejection', collectUnhandled);
    assert.deepEqual(unhandled, []);
});

describe('a streamed response whose client stops reading', () => {
    it('is delivered whole once a slow client resumes reading', async () => {
        upstreamStreams.clear();
        const client = await openStream('t-finite');
        assert.equal(client.res.statusCode, 200);

        assert.ok(
            await waitFor(() => [...upstreamStreams].some(backedUp), BACK_UP_TIMEOUT_MS),
            'the client never backed the response up'
        );
        const { contentChars, done, rest } = await readContent(client.res);

        assert.equal(contentChars, FINITE_LIMIT_BYTES);
        assert.equal(done, true);
        assert.equal(rest, '');
        const requestId = client.res.headers['x-request-id'];
        assert.equal(
            await waitFor(() => auditStatus(requestId), SETTLE_TIMEOUT_MS),
            'succeeded'
        );
        assert.equal(
            await waitFor(() => inflightGenerationLeases() === 0, SETTLE_TIMEOUT_MS),
            true
        );
    });

    it('ends, is audited as aborted and releases its leases when the client then disconnects', async () => {
        upstreamStreams.clear();
        const client = await openStream('t-held');
        assert.equal(client.res.statusCode, 200);
        const requestId = client.res.headers['x-request-id'];

        assert.ok(
            await waitFor(() => [...upstreamStreams].some(backedUp), BACK_UP_TIMEOUT_MS),
            'the client never backed the response up'
        );
        client.req.destroy();

        assert.equal(
            await waitFor(() => auditStatus(requestId), SETTLE_TIMEOUT_MS),
            'aborted'
        );
        assert.equal(
            await waitFor(() => inflightGenerationLeases() === 0, SETTLE_TIMEOUT_MS),
            true
        );
        assert.equal(
            await waitFor(
                () => [...upstreamStreams].every((progress) => progress.closed),
                SETTLE_TIMEOUT_MS
            ),
            true
        );
    });

    it(`releases every lease when ${CONCURRENT_CLIENTS} backed-up clients disconnect together`, async () => {
        upstreamStreams.clear();
        const clients = await Promise.all(
            Array.from({ length: CONCURRENT_CLIENTS }, () => openStream('t-held'))
        );

        assert.ok(
            await waitFor(
                () => upstreamStreams.size === CONCURRENT_CLIENTS &&
                    [...upstreamStreams].every(backedUp),
                BACK_UP_TIMEOUT_MS
            ),
            'not every client backed its response up'
        );
        for (const client of clients) client.req.destroy();

        for (const client of clients) {
            assert.equal(
                await waitFor(
                    () => auditStatus(client.res.headers['x-request-id']),
                    SETTLE_TIMEOUT_MS
                ),
                'aborted'
            );
        }
        assert.equal(
            await waitFor(() => inflightGenerationLeases() === 0, SETTLE_TIMEOUT_MS),
            true
        );
        assert.equal(
            await waitFor(
                () => [...upstreamStreams].every((progress) => progress.closed),
                SETTLE_TIMEOUT_MS
            ),
            true
        );
    });
});
