import test from 'node:test';
import assert from 'node:assert/strict';

import {
    isStaleBrowserProofResponse,
    retryOnStaleBrowserProof
} from '../../services/infrastructure/browserMutationRetry.js';

const json = (status, body) => new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
});

function sequence(...responses) {
    const calls = [];
    const send = async () => {
        calls.push(calls.length);
        return responses[calls.length - 1];
    };
    return { send, calls };
}

test('a stale proof 403 is sent once more and the second response is returned', async () => {
    const second = json(200, { ok: true });
    const { send, calls } = sequence(json(403, { error: 'browser_csrf_invalid' }), second);
    const response = await retryOnStaleBrowserProof(send);
    assert.equal(calls.length, 2);
    assert.equal(response, second);
    assert.deepEqual(await response.json(), { ok: true });
});

test('a changed edge generation 503 is sent once more', async () => {
    const { send, calls } = sequence(json(503, { error: 'edge_generation_changed' }), json(201, { ok: true }));
    const response = await retryOnStaleBrowserProof(send);
    assert.equal(calls.length, 2);
    assert.equal(response.status, 201);
});

test('a second stale answer is returned and never retried again', async () => {
    for (const [status, error] of [[403, 'browser_csrf_invalid'], [503, 'edge_generation_changed']]) {
        const { send, calls } = sequence(json(status, { error }), json(status, { error }), json(200, {}));
        const response = await retryOnStaleBrowserProof(send);
        assert.equal(calls.length, 2);
        assert.equal(response.status, status);
        assert.deepEqual(await response.json(), { error });
    }
});

test('a 403 followed by a 503 stale answer is still sent only twice', async () => {
    const { send, calls } = sequence(
        json(403, { error: 'browser_csrf_invalid' }),
        json(503, { error: 'edge_generation_changed' }),
        json(200, {})
    );
    const response = await retryOnStaleBrowserProof(send);
    assert.equal(calls.length, 2);
    assert.equal(response.status, 503);
});

test('other answers are returned untouched after one call and stay readable', async () => {
    const cases = [
        json(403, { error: 'administrator_required' }),
        json(403, { ok: false, error: 'browser_origin_required' }),
        json(503, { error: 'webtty_unavailable' }),
        json(401, { error: 'browser_csrf_invalid' }),
        json(200, { error: 'browser_csrf_invalid' }),
        new Response(null, { status: 204 }),
        new Response('<html>forbidden</html>', { status: 403, headers: { 'Content-Type': 'text/html' } }),
        new Response('', { status: 503 }),
        new Response('{"error":', { status: 403 })
    ];
    for (const original of cases) {
        const text = await original.clone().text();
        const { send, calls } = sequence(original);
        const response = await retryOnStaleBrowserProof(send);
        assert.equal(calls.length, 1);
        assert.equal(response, original);
        assert.equal(await response.text(), text);
    }
});

test('a response without clone or with an unreadable body counts as not stale', async () => {
    assert.equal(await isStaleBrowserProofResponse({ status: 403, json: async () => ({ error: 'browser_csrf_invalid' }) }), false);
    assert.equal(await isStaleBrowserProofResponse({ status: 403, clone: () => { throw new Error('locked'); } }), false);
    assert.equal(await isStaleBrowserProofResponse({ status: 403, clone: () => ({ json: async () => { throw new Error('bad'); } }) }), false);
    assert.equal(await isStaleBrowserProofResponse(null), false);
    const { send, calls } = sequence({ status: 403, ok: false, json: async () => ({}) });
    await retryOnStaleBrowserProof(send);
    assert.equal(calls.length, 1);
});

test('the stale response is only cloned, never drained', async () => {
    const first = json(403, { error: 'browser_csrf_invalid' });
    const { send } = sequence(first, json(200, { ok: true }));
    const response = await retryOnStaleBrowserProof(send);
    assert.equal(response.status, 200);
    assert.equal(first.bodyUsed, false);
});

test('send runs again for every attempt so a re-read proof header is current', async () => {
    let cookie = 'v1.old';
    const seen = [];
    const response = await retryOnStaleBrowserProof(async () => {
        seen.push(cookie);
        if (cookie === 'v1.old') {
            cookie = 'v1.fresh';
            return json(403, { error: 'browser_csrf_invalid' });
        }
        return json(200, { ok: true });
    });
    assert.deepEqual(seen, ['v1.old', 'v1.fresh']);
    assert.equal(response.status, 200);
});

test('a failed second send rejects instead of being swallowed', async () => {
    let count = 0;
    await assert.rejects(retryOnStaleBrowserProof(async () => {
        count += 1;
        if (count === 2) throw new Error('offline');
        return json(403, { error: 'browser_csrf_invalid' });
    }), /offline/);
    assert.equal(count, 2);
});

test('a synchronous throw from the first send is not turned into a retry', () => {
    let count = 0;
    assert.throws(() => retryOnStaleBrowserProof(() => {
        count += 1;
        throw new Error('sync');
    }), /sync/);
    assert.equal(count, 1);
});
