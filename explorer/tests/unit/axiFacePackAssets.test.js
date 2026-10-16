import assert from 'node:assert/strict';
import test from 'node:test';
import { siblingUrl } from '../../../tests/helpers/sibling-roots.mjs';

const clients = [
    ['Explorer', new URL('../../services/profileAvatar/avatarApi.js', import.meta.url)],
    ['WebMeet', siblingUrl('webmeet', 'webmeetAgent', 'IDE-plugins', 'webmeet-tool-button', 'components', 'webmeet-dashboard', 'services', 'webmeet-profile-avatar-runtime.js')]
];

for (const [name, url] of clients) {
    test(`${name} loads the generated Explorer index and preserves vendored pack URLs`, async () => {
        const originalFetch = globalThis.fetch;
        const requests = [];
        globalThis.fetch = async (input, options) => {
            requests.push({ input, options });
            return {
                ok: true,
                json: async () => ({ packs: [
                    { id: 'explicit', manifestSrc: '/explorer/shared/vendor/axi-face/packs/explicit/manifest.json' },
                    { id: 'fallback' },
                    { id: 'legacy', manifestSrc: '/axi-face/packs/legacy/manifest.json' }
                ] })
            };
        };
        try {
            const { loadAxiFacePacks } = await import(`${url.href}?pack-assets-test`);
            const packs = await loadAxiFacePacks();
            assert.deepEqual(requests, [{
                input: '/explorer/shared/generated/axi-face-packs.json',
                options: { credentials: 'include', headers: { Accept: 'application/json' } }
            }]);
            assert.deepEqual(packs.map(({ manifestSrc }) => manifestSrc), [
                '/explorer/shared/vendor/axi-face/packs/explicit/manifest.json',
                '/explorer/shared/vendor/axi-face/packs/fallback/manifest.json',
                '/explorer/shared/vendor/axi-face/packs/legacy/manifest.json'
            ]);
            assert.strictEqual(await loadAxiFacePacks(), packs);
            assert.equal(requests.length, 1);
        } finally {
            globalThis.fetch = originalFetch;
        }
    });
}
