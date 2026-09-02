import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    executeMenuAction,
    getMenuItems,
} from '../achilles-cli/IDE-plugins/achilles-cli-menu-contributions/menu-contributions.js';

const agentRoot = fileURLToPath(new URL('../achilles-cli/', import.meta.url));
const pluginsRoot = path.join(agentRoot, 'IDE-plugins');

// The editor was removed. DS010's supported interface selects a workspace
// through Open Copilot here; it does not create a skills manifest or task.
test('the retired skills manifest editor is absent from the agent and plugin catalog', () => {
    assert.equal(fs.existsSync(path.join(pluginsRoot, 'edit-skills-manifest')), false);
    const manifest = JSON.parse(fs.readFileSync(path.join(agentRoot, 'manifest.json'), 'utf8'));
    assert.doesNotMatch(JSON.stringify(manifest), /edit-skills-manifest|ploinky-skills-manifest/);
});

test('the supported directory action replaces editor-specific menu actions', async () => {
    const context = { isDirectory: true, selectedFsPath: '/workspace/project' };
    const items = await getMenuItems({ context, plugin: { icon: '/copilot.svg' } });
    assert.deepEqual(items, [{
        id: 'achilles-cli:open-copilot-here',
        label: 'Open Copilot here',
        icon: '/copilot.svg',
        action: 'open-copilot-here',
    }]);
    assert.deepEqual(await getMenuItems({ context: { ...context, isDirectory: false } }), []);
    assert.deepEqual(await getMenuItems({ context: { ...context, selectedFsPath: '' } }), []);
});

test('opening Copilot selects context without creating a manifest or other workspace data', async (t) => {
    const workingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-launch-boundary-'));
    const originalWindow = globalThis.window;
    const calls = [];
    globalThis.window = { open: (...args) => calls.push(args) };
    t.after(() => {
        globalThis.window = originalWindow;
        fs.rmSync(workingDir, { recursive: true, force: true });
    });
    await executeMenuAction({
        action: 'open-copilot-here',
        context: { isDirectory: true, selectedFsPath: workingDir },
    });
    assert.deepEqual(calls, [[
        `/webchat?agent=achilles-cli&dir=${encodeURIComponent(workingDir)}`,
        '_blank',
        'noopener,noreferrer',
    ]]);
    assert.deepEqual(fs.readdirSync(workingDir), []);
});

test('the generic launch plugin does not handle the retired editor action', async (t) => {
    const originalWindow = globalThis.window;
    const calls = [];
    globalThis.window = { open: (...args) => calls.push(args) };
    t.after(() => { globalThis.window = originalWindow; });
    await executeMenuAction({
        action: 'edit-skills-manifest',
        context: { isDirectory: true, selectedFsPath: '/workspace/project' },
    });
    assert.deepEqual(calls, []);
});

test('both supported plugin contributions expose generic labels without provider policy', () => {
    for (const name of ['achilles-cli-menu-contributions', 'achilles-cli-tool-button']) {
        const config = JSON.parse(fs.readFileSync(path.join(pluginsRoot, name, 'config.json'), 'utf8'));
        assert.equal(config.id, 'achilles-cli-copilot');
        assert.equal(config.label, 'Open Copilot here');
        assert.deepEqual(config.dependencies, []);
        assert.doesNotMatch(JSON.stringify(config), /edit-skills-manifest|provider|backend|mcpTool/);
    }
});
