import test from 'node:test';
import assert from 'node:assert/strict';
import { createMediaClient } from '../../services/media/mediaClient.js';

const blobId = '3e2241f7aa28bfeebc1d18b3960511b24f807463d07f42ba';

test('preview resolves Router audio and video blobs without private file lookups', async () => {
    const client = createMediaClient({
        callExplorerTool: async () => { throw new Error('Blob URL resolution must not read private sidecars'); },
        getDocumentContext: () => { throw new Error('A blob does not need the current document folder'); },
        getDocumentMediaStorageRoot: async () => { throw new Error('A blob does not need document storage'); },
        retries: 0,
    });
    assert.equal(await client.getAudioURL(blobId), `/blobs/explorer/${blobId}`);
    assert.equal(await client.getVideoURL(blobId), `/blobs/explorer/${blobId}`);
    assert.equal(await client.getAudioURL(''), '');
});

test('non-Router IDs retain legacy blob and document media resolution', async () => {
    const client = createMediaClient({
        callExplorerTool: async (_name, { path }) => {
            if (path === '/blobs/legacy-id.json') return { text: '{}' };
            throw new Error('Not found');
        },
        getDocumentContext: () => ({ folder: 'doc-test' }),
        getDocumentMediaStorageRoot: async () => 'document-multimedia',
        retries: 0,
    });
    assert.equal(await client.getAudioURL('legacy-id'), '/blobs/explorer/legacy-id');
    assert.equal(await client.getAudioURL('audio-local'), '/document-multimedia/doc-test/audio-local.mp3');
    assert.equal(await client.getVideoURL('video-local'), '/document-multimedia/doc-test/video-local.mp4');
});
