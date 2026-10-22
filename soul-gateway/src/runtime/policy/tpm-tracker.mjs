/**
 * In-memory sliding-window TPM (tokens-per-minute) tracker.
 *
 * Same ring-buffer approach as the RPM limiter, but tracks token counts
 * instead of request counts. Provides a soft limit — the caller decides
 * whether to block.
 */

import { SlidingWindow } from './sliding-window.mjs';

export class TpmTracker extends SlidingWindow {
    /**
     * @param {{ nowSeconds?: () => number }} [opts]
     */
    constructor(opts = {}) {
        super({ ...opts, ArrayType: Float64Array });
    }

    /**
     * Record token usage for the given key.
     *
     * @param {string} keyId
     * @param {number} tokens  Number of tokens consumed
     */
    record(keyId, tokens) {
        const now = this._nowSeconds();
        const entry = this._getOrCreate(keyId, now);
        this._advance(entry, now);
        entry.slots[entry.head] += tokens;
    }

    /**
     * Check current token usage against a limit.
     *
     * Soft limit: returns exceeded=true but does NOT block.
     * The caller decides what action to take.
     *
     * @param {string} keyId
     * @param {number} limit  Maximum tokens per 60-second window
     * @returns {{ current: number, limit: number, exceeded: boolean }}
     */
    check(keyId, limit) {
        const now = this._nowSeconds();
        const entry = this._getOrCreate(keyId, now);
        this._advance(entry, now);

        const current = this._sum(entry);
        return { current, limit, exceeded: current >= limit };
    }
}
