import { ModelQueueTimeoutError } from '../../core/errors.mjs';

/**
 * Per-model concurrency controller using semaphores with queueing.
 *
 * Each model has a configurable max concurrent requests.
 * Excess requests wait in a FIFO queue with a timeout.
 */
export class ConcurrencyController {
    constructor() {
        /** @type {Map<string, { max: number, active: number, queue: Array<{resolve, reject, timer}> }>} */
        this._models = new Map();
    }

    /**
     * Configure concurrency for a model. Can be called at any time to resize.
     */
    configure(modelKey, maxConcurrency) {
        const existing = this._models.get(modelKey);
        if (existing) {
            existing.max = maxConcurrency;
            this._drain(modelKey);
        } else {
            this._models.set(modelKey, {
                max: maxConcurrency,
                active: 0,
                queue: [],
            });
        }
    }

    /**
     * Acquire a concurrency slot. Resolves when a slot is available.
     * Rejects with ModelQueueTimeoutError if timeoutMs expires.
     *
     * Returns a release function that MUST be called when done.
     */
    async acquire(modelKey, timeoutMs) {
        let state = this._models.get(modelKey);
        if (!state) {
            state = { max: 3, active: 0, queue: [] };
            this._models.set(modelKey, state);
        }

        if (state.active < state.max) {
            state.active++;
            return this._createRelease(modelKey);
        }

        // Queue and wait
        return new Promise((resolve, reject) => {
            const entry = { resolve, reject, timer: null };
            entry.timer = setTimeout(() => {
                const idx = state.queue.indexOf(entry);
                if (idx >= 0) state.queue.splice(idx, 1);
                reject(new ModelQueueTimeoutError(modelKey));
            }, timeoutMs);

            state.queue.push(entry);
        });
    }

    _createRelease(modelKey) {
        let released = false;
        return () => {
            if (released) return;
            released = true;
            const state = this._models.get(modelKey);
            if (!state) return;
            state.active--;
            this._drain(modelKey);
        };
    }

    _drain(modelKey) {
        const state = this._models.get(modelKey);
        if (!state) return;

        while (state.active < state.max && state.queue.length > 0) {
            const entry = state.queue.shift();
            clearTimeout(entry.timer);
            state.active++;
            entry.resolve(this._createRelease(modelKey));
        }
    }

    /** Get current queue depth for a model. */
    queueDepth(modelKey) {
        const state = this._models.get(modelKey);
        return state ? state.queue.length : 0;
    }

    /** Get active count for a model. */
    activeCount(modelKey) {
        const state = this._models.get(modelKey);
        return state ? state.active : 0;
    }

    /** Get a snapshot of all model states for metrics. */
    snapshot() {
        const result = {};
        for (const [key, state] of this._models) {
            result[key] = {
                max: state.max,
                active: state.active,
                queued: state.queue.length,
            };
        }
        return result;
    }
}
