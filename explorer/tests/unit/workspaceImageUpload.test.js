import test from 'node:test';
import assert from 'node:assert/strict';
import { uploadWorkspaceImage } from '../../services/media/workspaceImageUpload.js';
import { isScriptaImageWorkspaceUrl, normalizeScriptaVariantImages, serializeScriptaVariant } from '../../shared/document/scripta-state.js';

test('SCRIPTA preserves safe local Markdown assets and rejects private, remote and traversal paths', () => {
    for (const path of ['/docs/notes.assets/photo-id.png', '/.ploinky/repos/demo/docs/notes.assets/photo-id.jpg', '/WebMeet/room/assets/asset_one/photo.png']) {
        assert.equal(isScriptaImageWorkspaceUrl(path), true, path);
        const images = normalizeScriptaVariantImages([{ imageId: 'image-one', assetId: 'asset-one', workspaceUrl: path }]);
        assert.equal(images.length, 1);
        assert.match(serializeScriptaVariant({ text: 'hello', images }), /!\[Image\]/);
    }
    for (const path of ['https://remote/image.png', '/.data/a.assets/secret.png', '/.git/a.assets/secret.png', '/docs/../a.assets/image.png', '/docs/a.assets/image.svg', '/docs/a.assets/%2e%2e.png']) {
        assert.equal(isScriptaImageWorkspaceUrl(path), false, path);
    }
});

test('image upload validates before network operations and returns a persistent workspace asset', async () => {
    const calls = [];
    const file = { name: 'Diagram.png', type: 'image/png', size: 24 };
    const deps = {
        createId: () => '01234567-89ab-cdef-0123-456789abcdef',
        callTool: async (...args) => { calls.push(args); return {}; },
        upload: async (...args) => { calls.push(args); return { ok: true, json: async () => ({ ok: true }) }; },
    };
    const result = await uploadWorkspaceImage('/docs/Notes.md', file, deps);
    assert.equal(calls[0][0], 'create_directory');
    assert.match(calls[1][0], /^\/upload\?path=/);
    assert.equal(calls[1][1].body, file);
    assert.match(result.workspaceUrl, /^\/docs\/Notes.assets\/Diagram-01234567-89a\.png$/i);
    const count = calls.length;
    await assert.rejects(uploadWorkspaceImage('/docs/Notes.md', { ...file, type: 'image/svg+xml' }, deps), /supported/);
    await assert.rejects(uploadWorkspaceImage('/.data/Notes.md', file, deps), /public workspace/);
    assert.equal(calls.length, count);
});
