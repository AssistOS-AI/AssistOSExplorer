import assert from 'node:assert/strict';
import test from 'node:test';
import { cacheAccessDenied, createCacheApi } from '../../services/infrastructure/cacheApi.js';

const origin = 'https://explorer.example.test';
const endpoint = '/api/marketplace/cache';
const agent = 'example/app';
const host = 'app.example.test';
const application = { agent, enabled: false, pageSeconds: 120, held: null, routes: [{ path: '/', cache: 'page' }], hosts: [host] };
const accepted = { host, outcome: 'accepted' };
const controlProof = (csrfToken) => ({ ok: true, adminControl: { origin, csrfToken } });
const publicProof = (csrfToken) => ({ ok: true, browserMutation: { origin, csrfToken, generation: 'g1', hostRouteKey: 'explorer' } });
const reply = (payload, status = 200) => Response.json(payload, { status });

function fixture(...responses) {
    const calls = [];
    const api = createCacheApi({
        expectedOrigin: origin,
        fetchImplementation: async (url, options) => {
            calls.push({ url, ...options });
            assert.ok(responses.length, 'Unexpected request');
            return responses.shift();
        },
    });
    return { api, calls };
}

test('cache reads the authenticated resource and posts only the selected operation fields', async () => {
    const snapshot = { applications: [application], hosts: [{ host, purgeConfigured: true, lastPurge: null }] };
    const update = { application, purges: [accepted] };
    const clear = { purge: { host, outcome: 'cooldown', retryAfterSeconds: 15 } };
    const { api, calls } = fixture(reply(snapshot), reply(controlProof('first')), reply(update), reply(publicProof('second')), reply(clear));
    assert.deepEqual(await api.read(), snapshot);
    assert.deepEqual(await api.setApplication(application), update);
    assert.deepEqual(await api.purgeHost({ host, outcome: 'accepted' }), clear);
    assert.deepEqual(calls.map((request) => [request.method ?? 'GET', request.url]), [
        ['GET', endpoint], ['GET', '/auth/token'], ['POST', endpoint], ['GET', '/auth/token'], ['POST', endpoint],
    ]);
    for (const request of calls) {
        assert.equal(request.credentials, 'include');
        assert.equal(request.cache, 'no-store');
    }
    for (const index of [0, 1, 3]) {
        assert.deepEqual(calls[index].headers, { Accept: 'application/json' });
        assert.equal(calls[index].body, undefined);
    }
    const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
    assert.deepEqual(calls[2].headers, { ...headers, 'x-ploinky-csrf-token': 'first' });
    assert.deepEqual(calls[4].headers, { ...headers, 'x-ploinky-browser-csrf-token': 'second' });
    assert.deepEqual(JSON.parse(calls[2].body), { op: 'set', agent, enabled: false, pageSeconds: 120 });
    assert.deepEqual(JSON.parse(calls[4].body), { op: 'purge', host });
});

test('each stale marketplace proof retries once with a fresh proof and the original operation', async () => {
    for (const [makeProof, code, header] of [
        [controlProof, 'csrf_invalid', 'x-ploinky-csrf-token'],
        [publicProof, 'browser_csrf_invalid', 'x-ploinky-browser-csrf-token'],
    ]) {
        const { api, calls } = fixture(reply(makeProof('first')), reply({ error: code }, 403), reply(makeProof('second')), reply({ purge: accepted }));
        assert.deepEqual(await api.purgeHost({ host }), { purge: accepted });
        assert.deepEqual(calls.map((request) => request.url), ['/auth/token', endpoint, '/auth/token', endpoint]);
        assert.deepEqual([calls[1].headers[header], calls[3].headers[header]], ['first', 'second']);
        assert.equal(calls[1].body, calls[3].body);
        const stale = () => reply({ error: code }, 403);
        const repeated = fixture(reply(makeProof('first')), stale(), reply(makeProof('second')), stale());
        await assert.rejects(repeated.api.purgeHost({ host }), { status: 403, code });
        assert.equal(repeated.calls.length, 4);
    }
});

test('cache preserves 401 and 403 on reads, proof acquisition and mutations without retrying authorization denials', async () => {
    for (const [status, error] of [[401, 'not_authenticated'], [403, 'admin_required']]) {
        const denial = () => reply({ error }, status);
        const denied = (err) => err.status === status && cacheAccessDenied(err);
        const read = fixture(denial());
        await assert.rejects(read.api.read(), denied);
        const proof = fixture(denial());
        await assert.rejects(proof.api.purgeHost({ host }), denied);
        assert.deepEqual(proof.calls.map((request) => request.url), ['/auth/token']);
        const mutation = fixture(reply(controlProof('fresh')), denial());
        await assert.rejects(mutation.api.setApplication(application), denied);
        assert.equal(mutation.calls.length, 2);
    }
    for (const [status, error] of [[400, 'invalid_request'], [404, 'unknown_host'], [503, 'edge_generation_changed']]) {
        const { api } = fixture(reply(publicProof('fresh')), reply({ error }, status));
        await assert.rejects(api.purgeHost({ host }), (err) => err.status === status && err.code === error && !cacheAccessDenied(err));
    }
});

test('cache rejects a proof for a different browser origin before posting', async () => {
    const { api, calls } = fixture(reply({ ok: true, adminControl: { origin: 'https://other.example.test', csrfToken: 'other' } }));
    await assert.rejects(api.setApplication(application), /unavailable for this origin/);
    assert.deepEqual(calls.map((request) => request.url), ['/auth/token']);
});
