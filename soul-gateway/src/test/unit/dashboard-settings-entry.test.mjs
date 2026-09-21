import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const pluginRoot = new URL('../../../IDE-plugins/', import.meta.url);
const toolButtonRoot = new URL('soul-gateway-tool-button/', pluginRoot);

async function readJson(url) {
    return JSON.parse(await readFile(url, 'utf8'));
}

describe('Soul Gateway Explorer settings entry', () => {
    it('opens the dashboard in an embedded Explorer popup', async () => {
        const settings = await readJson(new URL('soul-gateway-settings/config.json', pluginRoot));

        assert.equal(settings.settingsUrl, '/base-agent-additional-server/soul-gateway/7000/management/');
        assert.equal(settings.settingsEmbedded, true);
        assert.equal(settings.settingsEmbeddedFullscreen, true);
        assert.equal(settings.adminOnly, true);
    });

    it('does not declare a modal component dependency for the toolbar button', async () => {
        const config = await readJson(new URL('config.json', toolButtonRoot));

        assert.deepEqual(config.dependencies, []);
        assert.equal(config.adminOnly, true);
        assert.equal(config.component, 'soul-gateway-tool-button');
    });

    it('keeps the agent-served dashboard theme integration', async () => {
        const html = await readFile(new URL('../../dashboard/index.html', import.meta.url), 'utf8');

        assert.match(html, /\/explorer\/shared\/ui\/ui-common\.css/);
        assert.match(html, /\.\/js\/theme\.mjs/);
    });
});
