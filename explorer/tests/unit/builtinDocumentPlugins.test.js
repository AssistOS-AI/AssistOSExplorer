import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { aggregateIdePlugins } from '../../utils/ide-plugins.mjs';

const pluginRoot = new URL('../../IDE-plugins/', import.meta.url);
const multimediaComponents = ['image-plugin', 'audio-plugin', 'video-plugin'];

async function createWorkspace(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'explorer-document-plugins-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    // Copy the actual built-in inventory so reintroducing a media plugin is detected.
    await fs.cp(pluginRoot, path.join(root, '.ploinky/repos/AchillesIDE/explorer/IDE-plugins'), { recursive: true });
    return root;
}

test('clean Explorer bundles SCRIPTA Variants without multimedia document plugins', async t => {
    const root = await createWorkspace(t);
    const plugins = (await aggregateIdePlugins(root)).document;
    const variants = plugins.paragraph.filter(plugin => plugin.component === 'scripta-variants');
    assert.equal(variants.length, 1);
    assert.equal(variants[0].agent, 'explorer');
    for (const extension of ['js', 'css', 'html']) {
        await fs.access(new URL(`scripta-variants/scripta-variants.${extension}`, pluginRoot));
    }
    await fs.access(new URL('scripta-variants/icon.svg', pluginRoot));
    for (const name of [...multimediaComponents, 'document-media']) {
        await assert.rejects(fs.access(new URL(name, pluginRoot)), { code: 'ENOENT' });
    }
    assert.equal(Object.values(plugins).flat().some(plugin => multimediaComponents.includes(plugin.component)), false);
});

test('explicit legacy multimedia plugins remain discoverable while Explorer retains its variants component', async t => {
    const root = await createWorkspace(t);
    const legacy = path.join(root, '.ploinky/repos/legacy-agents');
    for (const component of multimediaComponents) {
        const dir = path.join(legacy, 'multimedia/IDE-plugins', component);
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify({
            pluginCategory: 'document', component, location: ['chapter', 'paragraph'],
            tooltip: component, presenter: 'LegacyMedia', type: 'modal',
        }));
    }
    const duplicate = path.join(legacy, 'soplangAgent/IDE-plugins/scripta-variants');
    await fs.cp(new URL('scripta-variants', pluginRoot), duplicate, { recursive: true });
    const plugins = (await aggregateIdePlugins(root)).document;
    for (const component of multimediaComponents) {
        for (const location of ['paragraph', 'chapter']) {
            const matches = plugins[location].filter(plugin => plugin.component === component);
            assert.equal(matches.length, 1, `${location}/${component}`);
            assert.equal(matches[0].agent, 'multimedia');
        }
    }
    const variants = plugins.paragraph.filter(plugin => plugin.component === 'scripta-variants');
    assert.equal(variants.length, 1);
    assert.equal(variants[0].agent, 'explorer');
});
