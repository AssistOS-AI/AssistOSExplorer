import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const pluginRoot = new URL('../../IDE-plugins/webmeet-tool-button/', import.meta.url);

test('WebMeet toolbar opens the shared expanded modal with a tab fallback', async () => {
    const config = JSON.parse(await fs.readFile(new URL('config.json', pluginRoot), 'utf8'));
    const source = await fs.readFile(new URL('webmeet-tool-button.js', pluginRoot), 'utf8');

    assert.equal(config.toolbarModal.mode, 'iframe');
    assert.equal(config.toolbarModal.url, '/webmeetAgent/roomLoader.html');
    assert.equal(config.toolbarModal.agentRef, 'AchillesIDE/webmeetAgent');
    assert.match(source, /openExpandedModal/);
    assert.match(source, /pluginToolbarModal/);
    assert.match(source, /window\.open\(/);
    assert.match(source, /\/roomLoader\.html/);
});
