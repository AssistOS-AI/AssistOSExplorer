import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { aggregateIdePlugins } from '../../utils/ide-plugins.mjs';
import { processMediaUpload } from '../../IDE-plugins/document-media/mediaUpload.js';

const pluginRoot = new URL('../../IDE-plugins/', import.meta.url);
const components = ['scripta-variants', 'image-plugin', 'audio-plugin', 'video-plugin'];

test('clean Explorer discovers all built-in document plugins without another agent repository', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'explorer-document-plugins-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const installed = path.join(root, '.ploinky/repos/AchillesIDE/explorer/IDE-plugins');
    await fs.mkdir(installed, { recursive: true });
    for (const component of components) await fs.cp(new URL(component, pluginRoot), path.join(installed, component), { recursive: true });
    const plugins = (await aggregateIdePlugins(root)).document;
    for (const component of components) {
        const paragraph = plugins.paragraph.filter(plugin => plugin.component === component);
        assert.equal(paragraph.length, 1, component);
        assert.equal(paragraph[0].agent, 'explorer');
        await fs.access(path.join(installed, component, 'icon.svg'));
        for (const extension of ['js', 'css', 'html']) await fs.access(path.join(installed, component, `${component}.${extension}`));
    }
    for (const component of components.slice(1)) assert.ok(plugins.chapter.some(plugin => plugin.component === component));
    const earlier = path.join(root, '.ploinky/repos/legacy-agents/multimedia/IDE-plugins');
    await fs.mkdir(earlier, { recursive: true });
    for (const component of components) await fs.cp(new URL(component, pluginRoot), path.join(earlier, component), { recursive: true });
    const withOlderCopy = (await aggregateIdePlugins(root)).document;
    for (const component of components) {
        const paragraph = withOlderCopy.paragraph.filter(plugin => plugin.component === component);
        assert.equal(paragraph.length, 1, component);
        assert.equal(paragraph[0].agent, 'explorer');
    }
});

test('built-in media uploads retain metadata and the Explorer blob endpoint', async t => {
    const file = new File(['image'], 'image.png', { type: 'image/png' });
    const requests = [];
    t.mock.method(globalThis, 'fetch', async (url, options) => {
        requests.push({ url, options });
        return { ok: true, json: async () => ({ id: 'blob-1' }) };
    });
    const result = await processMediaUpload({ file, maxFileSize: 20,
        metadataReader: async selected => { assert.equal(selected, file); return { width: 20, height: 10 }; },
    });
    assert.equal(result.uploadResult.id, 'blob-1');
    assert.equal(result.metadata.width, 20);
    assert.equal(requests[0].url, '/blobs/explorer');
    assert.equal(requests[0].options.body, file);
    await assert.rejects(processMediaUpload({ file, maxFileSize: 1 }), { code: 'too-large' });
    assert.equal(requests.length, 1);
});
