import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { createCoordinatorHttpHandler } from '../server/providerHttp.mjs';

// The NDJSON event subscription of the HTTP layer over a stub adapter: keep-alive lines, the byte cap below the Router's 64 MiB
// response cap, a retention gap, a mid-stream error, the lifetime end and the stream limit.

const REF = 'A'.repeat(22);
const row = (sequence, text = '') => ({ sequence, at: '2026-10-30T00:00:00.000Z', type: 'ala', data: { record: { text } } });

async function run(t, adapterEvents, streaming, count = 1) {
    const handler = createCoordinatorHttpHandler({ adapter: { referenceEvents: adapterEvents }, limits: { requestBytes: 1024 }, streaming });
    const server = http.createServer(handler);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
    const once = () => new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: server.address().port, path: `/v1/coordinator/references/${REF}/events`, method: 'POST' }, (res) => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => { text += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], lines: text.split('\n').filter(Boolean).map((line) => JSON.parse(line)) }));
            res.on('error', reject);
        });
        req.on('error', reject);
        req.end('{}');
    });
    return count === 1 ? once() : Promise.all(Array.from({ length: count }, once));
}

const follow = (pages, finished = () => null) => {
    let index = 0;
    return { follow: { first: pages[0], page: () => pages[Math.min(++index, pages.length - 1)], finished } };
};
const quick = { pollMs: 5, keepAliveMs: 10 };

test('rows, keep-alive, and a closing line when the reference is terminal', async (t) => {
    const empty = { events: [], nextAfter: 2 };
    let calls = 0;
    const result = await run(t, () => follow([{ events: [row(1), row(2)], nextAfter: 2 }, empty, empty, empty], () => (++calls > 3 ? 2 : null)), quick);
    assert.equal(result.status, 200);
    assert.equal(result.type, 'application/x-ndjson');
    assert.deepEqual(result.lines[0], { keepalive: true });
    assert.deepEqual(result.lines.filter((line) => line.sequence).map((line) => line.sequence), [1, 2]);
    assert.ok(result.lines.filter((line) => line.keepalive).length >= 2, 'idle keep-alive lines');
    assert.deepEqual(result.lines.at(-1), { end: true, nextAfter: 2 });
});

test('the stream ends below the byte cap with reason bytes and the cursor, never in the middle of a line', async (t) => {
    const big = Array.from({ length: 6 }, (_, i) => row(i + 1, 'x'.repeat(1000)));
    const result = await run(t, () => follow([{ events: big, nextAfter: 6 }]), { ...quick, maxBytes: 3500 });
    const rows = result.lines.filter((line) => line.sequence);
    assert.equal(rows.length, 3);
    assert.deepEqual(result.lines.at(-1), { end: false, nextAfter: 3, reason: 'bytes' });
});

test('lifetime end, gap, error and the open-stream limit', async (t) => {
    const empty = { events: [], nextAfter: 0 };
    const lifetime = await run(t, () => follow([empty]), { ...quick, maxLifetimeMs: 30 });
    assert.deepEqual(lifetime.lines.at(-1), { end: false, nextAfter: 0, reason: 'lifetime' });
    const gap = await run(t, () => follow([{ gap: true, snapshotSequence: 9 }]), quick);
    assert.deepEqual(gap.lines, [{ keepalive: true }, { gap: true, snapshotSequence: 9 }]);
    let polled = 0;
    const failing = await run(t, () => ({ follow: { first: empty, page: () => { polled += 1; throw Object.assign(new Error('x'), { name: 'WorkerStateError', code: 'stale_generation' }); }, finished: () => null } }), quick);
    assert.ok(polled >= 1);
    assert.deepEqual(failing.lines.at(-1), { error: 'internal_error' }, 'an unexpected error is reported without detail');
    const results = await run(t, () => follow([empty]), { ...quick, maxLifetimeMs: 100, maxStreams: 1 }, 3);
    assert.deepEqual(results.map((entry) => entry.status).sort(), [200, 503, 503]);
});
