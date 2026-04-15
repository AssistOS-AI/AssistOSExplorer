/**
 * In-memory sliding-window RPM limiter.
 *
 * Tracks per-key request counts in a 60-slot ring buffer (one slot per second).
 * No database writes on the hot path — purely in-memory.
 */

import { SlidingWindow, WINDOW_SECONDS } from './sliding-window.mjs';

export class SlidingWindowLimiter extends SlidingWindow {
    /**
     * @param {{ nowSeconds?: () => number }} [opts]
     */
    constructor(opts = {}) {
        super({ ...opts, ArrayType: Int32Array });
    }

    /**
     * Check whether a key is within its rate limit.
     *
     * @param {string} keyId
     * @param {number} limit  Maximum requests per 60-second window
     * @returns {{ allowed: boolean, remaining: number, retryAfterMs: number }}
     */
    check(keyId, limit) {
        const now = this._nowSeconds();
        const entry = this._getOrCreate(keyId, now);
        this._advance(entry, now);

        const total = this._sum(entry);
        const remaining = Math.max(0, limit - total);
        const allowed = total < limit;

        let retryAfterMs = 0;
        if (!allowed) {
            retryAfterMs = this._computeRetryAfter(entry);
        }

        return { allowed, remaining, retryAfterMs };
    }

    /**
     * Record one request for the given key.
     *
     * @param {string} keyId
     */
    record(keyId) {
        const now = this._nowSeconds();
        const entry = this._getOrCreate(keyId, now);
        this._advance(entry, now);
        entry.slots[entry.head]++;
    }

    /**
     * Estimate how long the caller must wait before a slot frees up.
     * Walk from the oldest slot (one past head) forward.
     */
    _computeRetryAfter(entry) {
        for (let i = 1; i <= WINDOW_SECONDS; i++) {
            const idx = (entry.head + i) % WINDOW_SECONDS;
            if (entry.slots[idx] > 0) {
                return i * 1000;
            }
        }
        return 1000;
    }
}
