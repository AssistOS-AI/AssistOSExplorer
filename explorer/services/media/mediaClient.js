import { DOCUMENT_MEDIA_URL_ROOT } from '../storage/documentMediaStorageResolver.js';
import { withRetry } from '../utils/retry.js';

export const AUDIO_FILE_EXTENSION = '.mp3';
export const VIDEO_FILE_EXTENSION = '.mp4';

const generateRandomId = (prefix = 'id') => `${prefix}-${Math.random().toString(36).slice(2, 10)}`;

const toBase64 = (uint8Array) => {
    if (typeof Buffer !== 'undefined' && Buffer.from) {
        return Buffer.from(uint8Array).toString('base64');
    }
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < uint8Array.length; i += chunkSize) {
        const chunk = uint8Array.subarray(i, i + chunkSize);
        binary += String.fromCharCode.apply(null, chunk);
    }
    if (typeof btoa === 'function') {
        return btoa(binary);
    }
    throw new Error('Base64 encoding is not supported in this environment.');
};

const buildMediaPath = (context, mediaId, extension) => {
    if (!context) {
        return `/${mediaId}`;
    }
    const mediaPath = `${DOCUMENT_MEDIA_URL_ROOT}/${context.folder}/${mediaId}${extension}`;
    return `/${mediaPath}`;
};

const buildLegacyBlobPath = (mediaId) => `/blobs/explorer/${mediaId}`;

/**
 * @typedef {Object} MediaClient
 * @property {(imageId: string) => Promise<string>} getImageURL
 * @property {(audioId: string) => Promise<string>} getAudioURL
 * @property {(payload: Uint8Array) => Promise<string>} putAudio
 * @property {(videoId: string) => Promise<string>} getVideoURL
 * @property {(payload: Uint8Array) => Promise<string>} putVideo
 * @property {(payload: Uint8Array) => Promise<string>} putImage
 */

/**
 * @param {Object} deps
 * @param {(toolName: string, args?: Record<string, unknown>) => Promise<any>} deps.callExplorerTool
 * @param {() => { folder: string } | null} deps.getDocumentContext
 * @param {() => Promise<string>} deps.getDocumentMediaStorageRoot
 * @param {number} [deps.retries]
 * @returns {MediaClient}
 */
export function createMediaClient({
    callExplorerTool,
    getDocumentContext,
    getDocumentMediaStorageRoot,
    retries = 2
}) {
    if (typeof callExplorerTool !== 'function') {
        throw new Error('callExplorerTool must be provided.');
    }
    if (typeof getDocumentMediaStorageRoot !== 'function') {
        throw new Error('getDocumentMediaStorageRoot must be provided.');
    }

    const ensureDirectory = async (directoryPath) => {
        await withRetry(() => callExplorerTool('create_directory', { path: directoryPath }), { retries });
    };

    const legacyBlobAvailability = new Map();

    const hasLegacyBlob = async (mediaId) => {
        if (!mediaId) {
            return false;
        }
        if (legacyBlobAvailability.has(mediaId)) {
            return legacyBlobAvailability.get(mediaId);
        }
        try {
            await withRetry(() => callExplorerTool('read_text_file', { path: `/blobs/${mediaId}.json` }), {
                retries
            });
            legacyBlobAvailability.set(mediaId, true);
            return true;
        } catch (_) {
            legacyBlobAvailability.set(mediaId, false);
            return false;
        }
    };

    const resolveStoredMediaUrl = async (mediaId, extension) => {
        if (!mediaId) {
            return '';
        }
        // Router uploads use 24-byte hexadecimal blob IDs. Resolve them through
        // the authenticated blob route, without reading private sidecar metadata.
        if (/^[a-f0-9]{48}$/i.test(mediaId) || await hasLegacyBlob(mediaId)) {
            return buildLegacyBlobPath(mediaId);
        }
        const context = getDocumentContext();
        return buildMediaPath(context, mediaId, extension);
    };

    const writeBinaryFile = async (relativePath, data) => {
        await withRetry(() => callExplorerTool('write_binary_file', {
            path: relativePath,
            content: toBase64(data),
            encoding: 'base64'
        }), { retries });
    };

    const putBinaryMedia = async (kind, extension, payload) => {
        if (!(payload instanceof Uint8Array)) {
            throw new Error(`${kind} payload must be a Uint8Array.`);
        }
        const context = getDocumentContext();
        if (!context) {
            throw new Error(`No active document context. Open a document before uploading ${kind}.`);
        }
        const mediaId = generateRandomId(kind);
        const mediaStorageRoot = await getDocumentMediaStorageRoot();
        const directory = `${mediaStorageRoot}/${context.folder}`;
        await ensureDirectory(directory);
        const relativePath = `${directory}/${mediaId}${extension}`;
        await writeBinaryFile(relativePath, payload);
        return mediaId;
    };

    return {
        async getImageURL(imageId) {
            return imageId ? `/blobs/explorer/${imageId}` : '';
        },
        async getAudioURL(audioId) {
            return resolveStoredMediaUrl(audioId, AUDIO_FILE_EXTENSION);
        },
        async putAudio(uint8Array) {
            return putBinaryMedia('audio', AUDIO_FILE_EXTENSION, uint8Array);
        },
        async getVideoURL(videoId) {
            return resolveStoredMediaUrl(videoId, VIDEO_FILE_EXTENSION);
        },
        async putVideo(uint8Array) {
            return putBinaryMedia('video', VIDEO_FILE_EXTENSION, uint8Array);
        },
        async putImage() {
            return 'image-placeholder';
        }
    };
}
