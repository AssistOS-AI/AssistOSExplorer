import test from 'node:test';
import assert from 'node:assert/strict';
import {
    fetchMarketplaceSnapshot,
    isRetryableMarketplaceStatusError,
} from '../../services/infrastructure/runtimeStatusEvents.js';

test('Marketplace status reads use only the authorized JSON catalog with session, abort and no cache', async () => {
    const controller = new AbortController();
    const catalog = {repositories: [], agents: [], enabledAgents: [], permissions: {canManage: true}};
    const calls = [];
    const result = await fetchMarketplaceSnapshot({
        signal: controller.signal,
        fetchImplementation: async (...args) => {
            calls.push(args);
            return {ok: true, status: 200, json: async () => ({ok: true, marketplace: catalog})};
        },
    });
    assert.equal(result, catalog);
    assert.deepEqual(calls, [['/api/marketplace', {
        credentials: 'include', cache: 'no-store', signal: controller.signal,
        headers: {Accept: 'application/json'},
    }]]);
});

test('Marketplace status preserves permanent authorization failures and retries only transient errors', async () => {
    for (const status of [401, 403, 404, 502, 503, 504]) {
        await assert.rejects(fetchMarketplaceSnapshot({
            fetchImplementation: async () => ({ok: false, status, json: async () => ({error: 'unavailable'})}),
        }), error => {
            assert.equal(error.status, status);
            assert.equal(isRetryableMarketplaceStatusError(error), status >= 502);
            return true;
        });
    }
    assert.equal(isRetryableMarketplaceStatusError(new TypeError('Failed to fetch')), true);
    assert.equal(isRetryableMarketplaceStatusError(new DOMException('Aborted', 'AbortError')), false);
    await assert.rejects(fetchMarketplaceSnapshot({
        fetchImplementation: async () => ({ok: true, status: 200, json: async () => { throw new SyntaxError('HTML login'); }}),
    }), error => error.status === 200 && !isRetryableMarketplaceStatusError(error));
});
