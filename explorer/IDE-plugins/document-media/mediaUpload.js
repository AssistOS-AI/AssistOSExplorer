import { uploadBlobFile } from './blobUpload.js';

export const MEDIA_UPLOAD_ERROR_CODES = Object.freeze({
    NO_FILE: 'no-file',
    TOO_LARGE: 'too-large',
    METADATA: 'metadata-error'
});

const createError = (code, message) => {
    const error = new Error(message);
    error.code = code;
    return error;
};

const metadataError = (message) => createError(MEDIA_UPLOAD_ERROR_CODES.METADATA, message);

const createMediaElementReader = ({ createElement, loadEvent, extractMetadata, errorMessage, unsupportedMessage }) => {
    return (file) => new Promise((resolve, reject) => {
        let element;
        try {
            element = createElement();
        } catch (_) {
            reject(metadataError(unsupportedMessage || errorMessage || 'Unable to prepare media element.'));
            return;
        }
        const objectUrl = URL.createObjectURL(file);
        const cleanUp = () => {
            try {
                element.removeAttribute('src');
                if (typeof element.load === 'function') {
                    element.load();
                }
            } catch (_) {
                // noop
            }
            try {
                URL.revokeObjectURL(objectUrl);
            } catch (_) {
                // noop
            }
        };
        const handleSuccess = () => {
            try {
                resolve(extractMetadata(element));
            } catch (error) {
                error.code = error.code || MEDIA_UPLOAD_ERROR_CODES.METADATA;
                reject(error);
            } finally {
                cleanUp();
            }
        };
        const handleError = () => {
            cleanUp();
            reject(metadataError(errorMessage || 'Unable to read media metadata.'));
        };
        element.addEventListener(loadEvent, handleSuccess, { once: true });
        element.addEventListener('error', handleError, { once: true });
        element.src = objectUrl;
    });
};

export const readImageMetadata = createMediaElementReader({
    createElement: () => new Image(),
    loadEvent: 'load',
    extractMetadata: (image) => ({
        width: image.naturalWidth || 0,
        height: image.naturalHeight || 0
    }),
    errorMessage: 'Unable to read image metadata.'
});

export const readAudioMetadata = createMediaElementReader({
    createElement: () => new Audio(),
    loadEvent: 'loadedmetadata',
    extractMetadata: (audio) => ({
        duration: Number.isFinite(audio.duration) ? audio.duration : 0
    }),
    errorMessage: 'Unable to read audio metadata.'
});

export const readVideoMetadata = createMediaElementReader({
    createElement: () => {
        if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
            const video = document.createElement('video');
            video.preload = 'metadata';
            return video;
        }
        throw new Error('Video metadata extraction requires a DOM environment.');
    },
    loadEvent: 'loadedmetadata',
    extractMetadata: (video) => ({
        duration: Number.isFinite(video.duration) ? video.duration : 0
    }),
    errorMessage: 'Unable to read video metadata.',
    unsupportedMessage: 'Video metadata extraction requires a DOM environment.'
});

const validateFilePayload = (file, maxFileSize) => {
    if (!file) {
        throw createError(MEDIA_UPLOAD_ERROR_CODES.NO_FILE, 'No file selected.');
    }
    const hasName = file && typeof file.name === 'string';
    const hasSize = file && typeof file.size !== 'undefined';
    if (!hasName || !hasSize) {
        throw new Error('Invalid file payload.');
    }
    if (Number.isFinite(maxFileSize) && Number.isFinite(file.size) && file.size > maxFileSize) {
        throw createError(MEDIA_UPLOAD_ERROR_CODES.TOO_LARGE, 'File exceeds the allowed size.');
    }
    return file;
};

export async function processMediaUpload({ file, maxFileSize, metadataReader, hooks = {} }) {
    try {
        const payload = validateFilePayload(file, maxFileSize);
        hooks.onProgress?.({ phase: 'validated', file: payload });
        const uploadPromise = uploadBlobFile(payload);
        hooks.onProgress?.({ phase: 'upload-start', file: payload });
        let metadata = null;
        if (typeof metadataReader === 'function') {
            hooks.onProgress?.({ phase: 'metadata-start', file: payload });
            metadata = await metadataReader(payload);
            hooks.onProgress?.({ phase: 'metadata-complete', file: payload, metadata });
        }
        const uploadResult = await uploadPromise;
        hooks.onProgress?.({ phase: 'upload-complete', file: payload, uploadResult });
        const result = { uploadResult, metadata };
        hooks.onSuccess?.(result);
        return result;
    } catch (error) {
        hooks.onError?.(error);
        throw error;
    }
}

export class MediaUploadController {
    constructor({ maxFileSize, metadataReader } = {}) {
        this.maxFileSize = maxFileSize;
        this.metadataReader = metadataReader;
        this.listeners = new Map();
    }

    on(eventName, handler) {
        if (typeof handler !== 'function') {
            return () => {};
        }
        if (!this.listeners.has(eventName)) {
            this.listeners.set(eventName, new Set());
        }
        this.listeners.get(eventName).add(handler);
        return () => this.off(eventName, handler);
    }

    off(eventName, handler) {
        const bucket = this.listeners.get(eventName);
        if (!bucket) {
            return;
        }
        bucket.delete(handler);
        if (!bucket.size) {
            this.listeners.delete(eventName);
        }
    }

    emit(eventName, detail) {
        const bucket = this.listeners.get(eventName);
        if (!bucket) {
            return;
        }
        bucket.forEach((handler) => {
            try {
                handler(detail);
            } catch (error) {
                console.error('[mediaUpload] Listener error', error);
            }
        });
    }

    async upload(file) {
        this.emit('progress', { phase: 'start', file });
        try {
            const result = await processMediaUpload({
                file,
                maxFileSize: this.maxFileSize,
                metadataReader: this.metadataReader,
                hooks: {
                    onProgress: (payload) => this.emit('progress', payload),
                    onSuccess: (payload) => this.emit('success', payload),
                    onError: (error) => this.emit('error', { error })
                }
            });
            this.emit('progress', { phase: 'complete', file, result });
            return result;
        } catch (error) {
            this.emit('progress', { phase: 'complete', file, error });
            throw error;
        }
    }

    dispose() {
        this.listeners.clear();
    }
}
