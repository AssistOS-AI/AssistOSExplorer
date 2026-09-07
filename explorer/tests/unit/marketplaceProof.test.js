import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchMarketplaceProof } from '../../services/infrastructure/authApi.js';

const origin = 'https://explorer.example.test';
function fetchProof(payload) {
    return fetchMarketplaceProof({ expectedOrigin: origin, fetchImplementation: async (url, options) => {
        assert.equal(url, '/auth/token');
        assert.equal(options.cache, 'no-store');
        assert.equal(options.credentials, 'include');
        return { ok: true, json: async () => ({ ok: true, ...payload }) };
    } });
}
const browserMutation = { origin, csrfToken: 'v2.fixture', hostRouteKey: 'workspace', generation: 'generation-a' };
test('Marketplace accepts the routed public proof without local adminControl', async () => {
    assert.deepEqual(await fetchProof({ browserMutation }), { origin, csrfToken: 'v2.fixture', header: 'x-ploinky-browser-csrf-token' });
});
test('Marketplace keeps local control proof separate', async () => {
    assert.equal((await fetchProof({ adminControl: { origin, csrfToken: 'v1.fixture' } })).header, 'x-ploinky-csrf-token');
});
test('Marketplace rejects incomplete, cross-origin and malformed proofs without fallback', async () => {
    for (const payload of [{}, { browserMutation: { ...browserMutation, origin: 'https://other.test' } },
        { browserMutation: { ...browserMutation, generation: '' } },
        { browserMutation: { ...browserMutation, hostRouteKey: '' } },
        { browserMutation: { ...browserMutation, csrfToken: '' } },
        { adminControl: {}, browserMutation }]) {
        await assert.rejects(fetchProof(payload), /unavailable for this origin/);
    }
});
