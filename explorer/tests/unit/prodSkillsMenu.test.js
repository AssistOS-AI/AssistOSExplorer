import test from 'node:test';
import assert from 'node:assert/strict';
import { getMenuItems, executeMenuAction } from '../../IDE-plugins/edit-skills-manifest/menu-contributions.js';

test('skills menu and action require a non-production permission', async () => {
    const originalFetch = globalThis.fetch;
    const originalAssistOS = globalThis.assistOS;
    let opened = 0;
    globalThis.assistOS = { UI: { showModal: async () => { opened++; return {}; } } };
    const input = { context: { isDirectory: true, selectedFsPath: '/workspace' }, plugin: {} };
    try {
        for (const production of [true, false]) {
            globalThis.fetch = async () => ({ ok: true, json: async () => ({ marketplace: { permissions: { production } } }) });
            assert.equal((await getMenuItems(input)).length, production ? 0 : 1);
            await executeMenuAction({ action: 'edit-skills-manifest', context: input.context });
            assert.equal(opened, production ? 0 : 1);
        }
        globalThis.fetch = async () => { throw new Error('offline'); };
        assert.deepEqual(await getMenuItems(input), []);
    } finally {
        globalThis.fetch = originalFetch;
        globalThis.assistOS = originalAssistOS;
    }
});
