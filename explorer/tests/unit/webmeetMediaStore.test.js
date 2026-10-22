import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createWebMeetMediaStore, inspectImage } from '../../utils/server/webmeet-media-store.mjs';

function png(width = 2, height = 3) {
    const buffer = Buffer.alloc(24);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(buffer);
    buffer.writeUInt32BE(width, 16);
    buffer.writeUInt32BE(height, 20);
    return buffer;
}

test('WebMeet media validates images and moves one staged blob into the room asset tree', async () => {
    // The tool runtime hands the store canonical paths.
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'explorer-webmeet-media-')));
    const workspaceRoot = path.join(root, 'workspace');
    await fs.mkdir(path.join(workspaceRoot, '.data', 'explorer', 'blobs'), { recursive: true });
    const blobId = 'a'.repeat(48);
    await fs.writeFile(path.join(workspaceRoot, '.data', 'explorer', 'blobs', blobId), png());
    await fs.writeFile(path.join(workspaceRoot, '.data', 'explorer', 'blobs', `${blobId}.json`), JSON.stringify({
        id: blobId,
        agent: 'explorer',
        localPath: `.data/explorer/blobs/${blobId}`,
        filename: 'diagram.png',
        mime: 'image/png',
        size: 24
    }));
    const store = createWebMeetMediaStore({
        fs,
        path,
        agentName: 'explorer',
        workspaceRoot,
        validatePath: async (value) => path.join(workspaceRoot, String(value).replace(/^\/+/, ''))
    });
    const asset = await store.commit({
        roomId: 'room_1',
        roomFolderPath: '/WebMeet/story-room-1',
        blobRef: { id: blobId, agent: 'explorer', localPath: `.data/explorer/blobs/${blobId}` }
    });
    assert.equal(asset.mimeType, 'image/png');
    assert.equal(asset.width, 2);
    assert.equal(asset.height, 3);
    assert.match(asset.workspaceUrl, /^\/WebMeet\/story-room-1\/assets\/asset_.+\/diagram\.png$/);
    assert.deepEqual(await store.read({roomId: 'room_1', roomFolderPath: '/WebMeet/story-room-1', assetId: asset.assetId}), asset);
    await assert.rejects(fs.stat(path.join(workspaceRoot, '.data', 'explorer', 'blobs', blobId)));
});

test('WebMeet media rejects blob references for another agent or path', async () => {
    // The tool runtime hands the store canonical paths.
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'explorer-webmeet-media-ref-')));
    const store = createWebMeetMediaStore({
        fs,
        path,
        agentName: 'explorer',
        workspaceRoot: root,
        validatePath: async (value) => path.join(root, String(value).replace(/^\/+/, ''))
    });
    const id = 'b'.repeat(48);
    await assert.rejects(
        store.commit({ roomId: 'room_1', blobRef: { id, agent: 'explorer', localPath: `.data/explorer/blobs/${id}` } }),
        /room folder path/
    );
    await assert.rejects(
        store.commit({ roomId: 'room_1', roomFolderPath: '/document-multimedia/webmeet/room_1', blobRef: { id, agent: 'explorer', localPath: `.data/explorer/blobs/${id}` } }),
        /room folder path/
    );
    await assert.rejects(
        store.commit({ roomId: 'room_1', roomFolderPath: '/WebMeet/story-room-1', blobRef: { id, agent: 'other', localPath: `.data/other/blobs/${id}` } }),
        /different agent/
    );
    await assert.rejects(
        store.commit({ roomId: 'room_1', roomFolderPath: '/WebMeet/story-room-1', blobRef: { id, agent: 'explorer', localPath: 'other/file' } }),
        /does not match its id/
    );
    await assert.rejects(
        store.commit({ roomId: 'room_1', roomFolderPath: '/WebMeet/story-room-1', blobRef: { id, agent: 'AchillesIDE/explorer', localPath: `.data/AchillesIDE/explorer/blobs/${id}` } }),
        /short agent name/
    );
});

test('WebMeet media rejects unsupported image content', () => {
    assert.throws(() => inspectImage(Buffer.from('<svg></svg>')), /Only PNG, JPEG, WebP, and GIF/);
});

test('WebMeet media commits arbitrary files and does not trust an image MIME declaration', async () => {
    // The tool runtime hands the store canonical paths.
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'explorer-webmeet-file-')));
    const workspaceRoot = path.join(root, 'workspace');
    await fs.mkdir(path.join(workspaceRoot, '.data', 'explorer', 'blobs'), {recursive: true});
    const blobId = 'c'.repeat(48);
    const content = Buffer.from('%PDF-1.7\nexample');
    await fs.writeFile(path.join(workspaceRoot, '.data', 'explorer', 'blobs', blobId), content);
    await fs.writeFile(path.join(workspaceRoot, '.data', 'explorer', 'blobs', `${blobId}.json`), JSON.stringify({
        id: blobId,
        agent: 'explorer',
        localPath: `.data/explorer/blobs/${blobId}`,
        filename: '../report.pdf',
        mime: 'image/png',
        size: content.length
    }));
    const store = createWebMeetMediaStore({
        fs,
        path,
        agentName: 'explorer',
        workspaceRoot,
        validatePath: async (value) => path.join(workspaceRoot, String(value).replace(/^\/+/, ''))
    });
    const asset = await store.commit({
        roomId: 'room_1',
        roomFolderPath: '/WebMeet/story-room-1',
        blobRef: {id: blobId, agent: 'explorer', localPath: `.data/explorer/blobs/${blobId}`}
    });
    assert.equal(asset.kind, 'file');
    assert.equal(asset.filename, 'report.pdf');
    assert.equal(asset.extension, 'pdf');
    assert.equal(asset.mimeType, 'application/pdf');
    assert.equal(asset.width, undefined);
    assert.match(asset.workspaceUrl, /^\/WebMeet\/story-room-1\/assets\/asset_.+\/report\.pdf$/);
    assert.deepEqual(
        await fs.readFile(path.join(workspaceRoot, asset.workspaceUrl.replace(/^\/+/, ''))),
        content
    );
    assert.deepEqual(await store.read({roomId: 'room_1', roomFolderPath: '/WebMeet/story-room-1', assetId: asset.assetId}), asset);
});

test('WebMeet media stores one real file per asset without sidecar metadata', async () => {
    // The tool runtime hands the store canonical paths.
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'explorer-webmeet-json-')));
    const workspaceRoot = path.join(root, 'workspace');
    await fs.mkdir(path.join(workspaceRoot, '.data', 'explorer', 'blobs'), {recursive: true});
    const blobId = 'd'.repeat(48);
    const content = Buffer.from('{"answer":42}\n');
    await fs.writeFile(path.join(workspaceRoot, '.data', 'explorer', 'blobs', blobId), content);
    await fs.writeFile(path.join(workspaceRoot, '.data', 'explorer', 'blobs', `${blobId}.json`), JSON.stringify({
        id: blobId,
        agent: 'explorer',
        localPath: `.data/explorer/blobs/${blobId}`,
        filename: 'payload.json',
        mime: 'application/json',
        size: content.length
    }));
    const store = createWebMeetMediaStore({
        fs,
        path,
        agentName: 'explorer',
        workspaceRoot,
        validatePath: async (value) => path.join(workspaceRoot, String(value).replace(/^\/+/, ''))
    });
    const asset = await store.commit({
        roomId: 'room_json',
        roomFolderPath: '/WebMeet/json-room',
        blobRef: {id: blobId, agent: 'explorer', localPath: `.data/explorer/blobs/${blobId}`}
    });
    const assetPath = path.join(workspaceRoot, asset.workspaceUrl.replace(/^\/+/, ''));
    assert.equal(asset.extension, 'json');
    assert.equal(asset.mimeType, 'application/json');
    assert.match(asset.workspaceUrl, /\/payload\.json$/);
    assert.deepEqual(await fs.readFile(assetPath), content);
    assert.deepEqual(await fs.readdir(path.dirname(assetPath)), ['payload.json']);
    assert.deepEqual(await store.read({roomId: 'room_json', roomFolderPath: '/WebMeet/json-room', assetId: asset.assetId}), asset);
});

test('WebMeet media preserves a sanitized real filename for arbitrary files', async () => {
    // The tool runtime hands the store canonical paths.
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'explorer-webmeet-active-file-')));
    const workspaceRoot = path.join(root, 'workspace');
    await fs.mkdir(path.join(workspaceRoot, '.data', 'explorer', 'blobs'), {recursive: true});
    const blobId = 'e'.repeat(48);
    const content = Buffer.from('<script>globalThis.compromised = true</script>');
    await fs.writeFile(path.join(workspaceRoot, '.data', 'explorer', 'blobs', blobId), content);
    await fs.writeFile(path.join(workspaceRoot, '.data', 'explorer', 'blobs', `${blobId}.json`), JSON.stringify({
        id: blobId,
        agent: 'explorer',
        localPath: `.data/explorer/blobs/${blobId}`,
        filename: 'page.html',
        mime: 'text/html',
        size: content.length
    }));
    const store = createWebMeetMediaStore({
        fs,
        path,
        agentName: 'explorer',
        workspaceRoot,
        validatePath: async (value) => path.join(workspaceRoot, String(value).replace(/^\/+/, ''))
    });
    const asset = await store.commit({
        roomId: 'room_html',
        roomFolderPath: '/WebMeet/html-room',
        blobRef: {id: blobId, agent: 'explorer', localPath: `.data/explorer/blobs/${blobId}`}
    });
    assert.equal(asset.filename, 'page.html');
    assert.equal(asset.extension, 'html');
    assert.equal(asset.mimeType, 'application/octet-stream');
    assert.match(asset.workspaceUrl, /\/page\.html$/);
    assert.deepEqual(
        await fs.readFile(path.join(workspaceRoot, asset.workspaceUrl.replace(/^\/+/, ''))),
        content
    );
});

test('WebMeet media rejects an asset directory that does not contain exactly one file', async () => {
    // The tool runtime hands the store canonical paths.
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'explorer-webmeet-invalid-asset-')));
    const assetFolder = path.join(root, 'WebMeet', 'invalid-room', 'assets', 'asset_invalid');
    await fs.mkdir(assetFolder, {recursive: true});
    await fs.writeFile(path.join(assetFolder, 'one.txt'), 'one');
    await fs.writeFile(path.join(assetFolder, 'two.txt'), 'two');
    const store = createWebMeetMediaStore({
        fs,
        path,
        agentName: 'explorer',
        workspaceRoot: root,
        validatePath: async (value) => path.join(root, String(value).replace(/^\/+/, ''))
    });
    await assert.rejects(
        store.read({roomId: 'room_invalid', roomFolderPath: '/WebMeet/invalid-room', assetId: 'asset_invalid'}),
        /exactly one regular file/
    );
});
