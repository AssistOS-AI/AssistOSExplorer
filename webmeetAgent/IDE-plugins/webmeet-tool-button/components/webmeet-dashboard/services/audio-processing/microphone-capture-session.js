import { createProcessedMicrophoneTrack } from './microphone-track-factory.js';

export const CAPTURE_SESSION_STATES = Object.freeze([
    'stopped',
    'starting',
    'captured',
    'published',
    'error'
]);

export class MicrophoneCaptureSession {
    constructor(options = {}) {
        this.createCapture = typeof options.createCapture === 'function'
            ? options.createCapture
            : createProcessedMicrophoneTrack;
        this.onError = typeof options.onError === 'function' ? options.onError : (() => {});
        this.capture = null;
        this.state = 'stopped';
        this.generation = 0;
    }

    get activeCapture() {
        return this.capture;
    }

    isActive() {
        return this.state === 'captured' || this.state === 'published';
    }

    async start(settings = {}) {
        const generation = ++this.generation;
        const previous = this.capture;
        this.capture = null;
        if (previous) {
            await this.disposeCapture(previous);
        }
        if (this.generation !== generation) {
            return null;
        }
        this.state = 'starting';
        let capture = null;
        try {
            capture = await this.createCapture(settings);
        } catch (error) {
            if (this.generation === generation) {
                this.state = 'error';
            }
            throw error;
        }
        if (this.generation !== generation) {
            await this.disposeCapture(capture);
            return null;
        }
        this.capture = capture;
        this.state = 'captured';
        return capture;
    }

    markPublished() {
        if (this.state === 'captured') {
            this.state = 'published';
            return true;
        }
        return false;
    }

    async stop(unpublish = null) {
        this.generation += 1;
        const capture = this.capture;
        this.capture = null;
        this.state = 'stopped';
        if (capture && typeof unpublish === 'function') {
            try {
                await unpublish(capture);
            } catch (_) {
                // publishing cleanup is best-effort; local resources are still released below
            }
        }
        await this.disposeCapture(capture);
        return capture;
    }

    async disposeCapture(capture) {
        if (!capture) return;
        if (typeof capture.cleanup === 'function') {
            try {
                await capture.cleanup();
            } catch (_) {
                // ignore cleanup failures after a failed or superseded capture
            }
            return;
        }
        for (const track of [capture.track, ...(capture.sourceStream?.getTracks?.() || [])]) {
            try { track?.stop?.(); } catch (_) {}
        }
    }
}
