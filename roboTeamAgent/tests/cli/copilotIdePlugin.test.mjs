import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pluginsRoot = path.join(repoRoot, 'achilles-cli', 'IDE-plugins');

async function readConfig(pluginName) {
    const raw = await fs.readFile(path.join(pluginsRoot, pluginName, 'config.json'), 'utf8');
    return JSON.parse(raw);
}

describe('Achilles CLI Copilot IDE plugin', () => {
    it('contributes one logical plugin to Tools and the directory context menu', async () => {
        const toolbarConfig = await readConfig('achilles-cli-tool-button');
        const menuConfig = await readConfig('achilles-cli-menu-contributions');

        assert.equal(toolbarConfig.id, 'achilles-cli-copilot');
        assert.equal(toolbarConfig.contributionType ?? 'mount', 'mount');
        assert.deepEqual(toolbarConfig.location, ['file-exp:toolbar-plugins-dropdown']);
        assert.equal(toolbarConfig.label, 'Open Copilot here');

        assert.equal(menuConfig.id, toolbarConfig.id);
        assert.equal(menuConfig.contributionType, 'menu');
        assert.deepEqual(menuConfig.location, ['file-exp:context-menu:directory']);
        assert.equal(menuConfig.label, toolbarConfig.label);
        assert.equal(menuConfig.menuModule, 'menu-contributions.js');
    });

    it('keeps the context-menu action limited to selected directories', async () => {
        const modulePath = path.join(
            pluginsRoot,
            'achilles-cli-menu-contributions',
            'menu-contributions.js'
        );
        const menuModule = await import(pathToFileURL(modulePath));
        const plugin = { icon: '/copilot.svg' };

        assert.deepEqual(await menuModule.getMenuItems({
            context: { isDirectory: false, selectedFsPath: '/workspace/file.txt' },
            plugin
        }), []);

        const items = await menuModule.getMenuItems({
            context: { isDirectory: true, selectedFsPath: '/workspace/folder' },
            plugin
        });
        assert.equal(items.length, 1);
        assert.equal(items[0].label, 'Open Copilot here');
        assert.equal(items[0].action, 'open-copilot-here');
    });
});
