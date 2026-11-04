import test from 'node:test';
import assert from 'node:assert/strict';
import { activateMarketplaceAgent } from '../../services/infrastructure/marketplaceActivation.mjs';

const body = { action: 'enable_agent', agentRef: 'repo/worker', mode: 'global' };
const operation = { id: '11111111-1111-4111-8111-111111111111', agentRef: body.agentRef, mode: body.mode, state: 'pending' };
const payload = (state = 'pending', extra = {}) => ({ ok: true, action: 'enable_agent', operation: { ...operation, state, ...extra } });
const options = { pollIntervalMs: 1, requestTimeoutMs: 100, observationTimeoutMs: 500, proofFetcher: async () => ({ header: 'x-proof', csrfToken: 'proof' }) };
function fixture(t, implementation) {
    const original = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, init = {}) => { calls.push({ url, ...init }); return implementation(url, init, calls.length); };
    t.after(() => { globalThis.fetch = original; });
    return calls;
}

test('activation observes pending until success, polls one fixed URL and never repeats the POST', async t => {
    let polls = 0;
    let inFlight = 0;
    let maximum = 0;
    const calls = fixture(t, async (url, init) => {
        if (init.method === 'POST') return Response.json(payload(), { status: 202 });
        assert.equal(url, `/api/marketplace/agents?operation=${operation.id}`);
        assert.equal(init.cache, 'no-store');
        assert.equal(init.credentials, 'include');
        maximum = Math.max(maximum, ++inFlight);
        await new Promise(resolve => setTimeout(resolve, 2));
        inFlight--;
        return Response.json(payload(++polls === 2 ? 'succeeded' : 'pending'));
    });
    const result = await activateMarketplaceAgent(body, options);
    assert.equal(result.operation.state, 'succeeded');
    assert.equal(calls.filter(call => call.method === 'POST').length, 1);
    assert.equal(calls[0].headers.Prefer, 'respond-async');
    assert.equal(maximum, 1);
});

test('legacy 200 completes with its authoritative inventory without polling', async t => {
    const calls = fixture(t, () => Response.json({ ok: true, marketplace: { agents: [{ running: false, status: 'starting' }] } }));
    const result = await activateMarketplaceAgent(body, options);
    assert.equal(result.marketplace.agents[0].running, false);
    assert.equal(calls.length, 1);
});

test('only one CSRF refusal replays activation, with a fresh proof', async t => {
    let proofs = 0;
    const calls = fixture(t, (_url, _init, count) => count <= 2
        ? Response.json({ ok: false, error: 'browser_csrf_invalid' }, { status: 403 })
        : assert.fail('second CSRF refusal replayed'));
    await assert.rejects(activateMarketplaceAgent(body, { ...options, proofFetcher: async () => ({ header: 'proof', csrfToken: `${++proofs}` }) }), /browser_csrf_invalid/);
    assert.equal(calls.length, 2);
    assert.equal(proofs, 2);
    assert.equal(calls[1].headers.proof, '2');
});

test('POST transport failure and timeout never replay the mutation', async t => {
    const calls = fixture(t, () => { throw new TypeError('network lost after acceptance'); });
    await assert.rejects(activateMarketplaceAgent(body, options), /network lost/);
    assert.equal(calls.length, 1);
    globalThis.fetch = (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    await assert.rejects(activateMarketplaceAgent(body, { ...options, requestTimeoutMs: 5 }), { name: 'TimeoutError' });
});

test('status transport and 502/503/504 failures retry observation only', async t => {
    let polls = 0;
    const calls = fixture(t, (_url, init) => {
        if (init.method === 'POST') return Response.json(payload(), { status: 202 });
        polls++;
        if (polls === 1) throw new TypeError('temporary network loss');
        if (polls < 5) return Response.json({}, { status: [502, 503, 504][polls - 2] });
        return Response.json(payload('succeeded'));
    });
    await activateMarketplaceAgent(body, options);
    assert.equal(polls, 5);
    assert.equal(calls.filter(call => call.method === 'POST').length, 1);
});

test('authorization, unknown receipts and terminal failure stop observation', async t => {
    for (const status of [400, 401, 403, 404, 429, 500]) {
        let calls = 0;
        const original = globalThis.fetch;
        globalThis.fetch = async (_url, init) => {
            calls++;
            return init.method === 'POST' ? Response.json(payload(), { status: 202 }) : Response.json({ ok: false, error: 'refused' }, { status });
        };
        try { await assert.rejects(activateMarketplaceAgent(body, options), /refused/); assert.equal(calls, 2); }
        finally { globalThis.fetch = original; }
    }
    const calls = fixture(t, (_url, init) => init.method === 'POST'
        ? Response.json(payload(), { status: 202 }) : Response.json(payload('failed', { error: { message: 'Safe lifecycle failure.' } })));
    await assert.rejects(activateMarketplaceAgent(body, options), /Safe lifecycle failure/);
    assert.equal(calls.length, 2);
});

test('malformed acceptance and mismatched status stop without trusting a returned URL', async t => {
    const cases = [{ id: 'bad' }, { agentRef: 'other/agent' }, { mode: 'isolated' }, { state: 'succeeded' }];
    for (const changed of cases) {
        let calls = 0;
        const original = globalThis.fetch;
        globalThis.fetch = async () => { calls++; return Response.json(payload('pending', changed), { status: 202 }); };
        try { await assert.rejects(activateMarketplaceAgent(body, options), /Invalid Marketplace activation receipt/); assert.equal(calls, 1); }
        finally { globalThis.fetch = original; }
    }
    const calls = fixture(t, (_url, init) => init.method === 'POST'
        ? Response.json({ ...payload(), statusUrl: 'https://evil.test/' }, { status: 202 })
        : Response.json(payload('succeeded', { id: '22222222-2222-4222-8222-222222222222' })));
    await assert.rejects(activateMarketplaceAgent(body, options), /Invalid Marketplace operation status/);
    assert.equal(calls[1].url, `/api/marketplace/agents?operation=${operation.id}`);
});

test('abort during an accepted operation cancels only observation and never replays POST', async t => {
    const controller = new AbortController();
    let started;
    const polling = new Promise(resolve => { started = resolve; });
    const calls = fixture(t, (_url, init) => {
        if (init.method === 'POST') return Response.json(payload(), { status: 202 });
        started();
        return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
    });
    const pending = activateMarketplaceAgent(body, { ...options, signal: controller.signal });
    await polling;
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(calls.length, 2);
    assert.equal(calls[1].signal.aborted, true);
});

test('a stuck status request times out and observation has its own finite deadline', async t => {
    const calls = fixture(t, (_url, init) => {
        if (init.method === 'POST') return Response.json(payload(), { status: 202 });
        return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
    });
    await assert.rejects(activateMarketplaceAgent(body, { ...options, requestTimeoutMs: 5, observationTimeoutMs: 30 }), { name: 'TimeoutError' });
    assert.ok(calls.length > 2);
    assert.equal(calls.filter(call => call.method === 'POST').length, 1);
});
