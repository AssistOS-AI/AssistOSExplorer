import test from 'node:test';
import assert from 'node:assert/strict';
import { readCodingSessionsReadiness, watchCodingSessionsReadiness } from '../../services/infrastructure/codingSessionsReadiness.js';

test('readiness requires explicit success and handles unavailable services', async () => {
    for (const response of [{ ok: false }, { ok: true, json: async () => ({ ok: true, ready: false }) }]) {
        assert.equal((await readCodingSessionsReadiness({ fetchImpl: async () => response })).ready, false);
    }
    assert.equal((await readCodingSessionsReadiness({ fetchImpl: async (url, options) => {
        assert.equal(url, '/webtty/coding-sessions/readiness');
        assert.equal(options.cache, 'no-store');
        return { ok: true, json: async () => ({ ok: true, ready: true }) };
    } })).ready, true);
});

test('observer enables automatically, slows checks when ready and stops on unload', async () => {
    const results = [], delays = [];
    let next, signal, ready = false;
    const stop = watchCodingSessionsReadiness({
        read: async options => { signal = options.signal; return { ready }; },
        onChange: value => results.push(value.ready),
        schedule: (fn, delay) => { next = fn; delays.push(delay); return 7; },
        cancel: id => assert.equal(id, 7),
    });
    await new Promise(resolve => setImmediate(resolve));
    ready = true;
    await next();
    assert.deepEqual(results, [false, true]);
    assert.deepEqual(delays, [2000, 15000]);
    stop();
    assert.equal(signal.aborted, true);
    await next();
    assert.deepEqual(results, [false, true]);
    assert.deepEqual(delays, [2000, 15000]);
});

test('observer does not probe for non-administrators or publish after disposal', async () => {
    let reads = 0, changes = 0;
    const stop = watchCodingSessionsReadiness({ allowed: () => false, read: async () => { reads++; },
        onChange: () => changes++, schedule: () => 1, cancel: () => {} });
    stop();
    assert.equal(reads, 0);
    let resolve;
    const dispose = watchCodingSessionsReadiness({ read: () => new Promise(done => { resolve = done; }),
        onChange: () => changes++, schedule: () => assert.fail('disposed'), cancel: () => {} });
    const before = changes;
    dispose();
    resolve({ ready: true });
    await new Promise(done => setImmediate(done));
    assert.equal(changes, before);
});
