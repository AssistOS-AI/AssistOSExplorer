import test from 'node:test';
import assert from 'node:assert/strict';

import { launchAgentSettings } from '../../web-components/modals/settings-modal/settings-agent-launcher.js';

const MANAGEMENT_URL = '/base-agent-additional-server/soul-gateway/7000/management/';

test('launchAgentSettings ensures the agent runs before opening a settings URL', async () => {
    const runtime = { ref: 'soul-gateway-1', running: true };
    const calls = [];
    const result = await launchAgentSettings({
        key: 'soul-gateway',
        ownerAgent: 'soul-gateway',
        settingsUrl: MANAGEMENT_URL
    }, {
        ensureRunning: async (ref) => {
            calls.push(['ensure', ref]);
            return runtime;
        },
        openSettingsUrl: (item) => {
            calls.push(['open', item.settingsUrl]);
            return true;
        }
    });

    assert.equal(result, runtime);
    assert.deepEqual(calls, [
        ['ensure', 'soul-gateway'],
        ['open', MANAGEMENT_URL]
    ]);
});

test('launchAgentSettings opens the embedded settings popup when declared', async () => {
    const runtime = { ref: 'soul-gateway-1' };
    const calls = [];
    const result = await launchAgentSettings({
        key: 'soul-gateway',
        ownerAgent: 'soul-gateway',
        label: 'Soul Gateway',
        settingsUrl: MANAGEMENT_URL,
        settingsEmbedded: true,
        settingsEmbeddedFullscreen: true
    }, {
        ensureRunning: async (ref) => {
            calls.push(['ensure', ref]);
            return runtime;
        },
        openSettingsUrl: () => {
            calls.push(['url']);
            return true;
        },
        openSettingsPopup: (item) => {
            calls.push(['popup', item.settingsUrl, item.settingsEmbeddedFullscreen]);
        }
    });

    assert.equal(result, runtime);
    assert.deepEqual(calls, [
        ['popup', MANAGEMENT_URL, true],
        ['ensure', 'soul-gateway']
    ]);
});

test('launchAgentSettings rejects an invalid settings URL', async () => {
    await assert.rejects(
        () => launchAgentSettings(
            { key: 'soul-gateway', ownerAgent: 'soul-gateway', settingsUrl: 'https://example.test/management/' },
            {
                ensureRunning: async () => ({ ref: 'soul-gateway-1' }),
                openSettingsUrl: () => false
            }
        ),
        /Invalid settings URL for soul-gateway/
    );
});

test('launchAgentSettings requires a settings target', async () => {
    await assert.rejects(
        () => launchAgentSettings(
            { key: 'soul-gateway', ownerAgent: 'soul-gateway' },
            { ensureRunning: async () => ({ ref: 'soul-gateway-1' }) }
        ),
        /has no settings target/
    );
});
