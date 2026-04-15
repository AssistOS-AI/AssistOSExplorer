/**
 * Shared ring-buffer sliding window for per-key counters.
 *
 * Both the RPM limiter (request counts) and the TPM tracker (token counts)
 * use identical 60-slot ring buffers that advance one slot per second.
 * This base class captures the common logic; subclasses add their own
 * recording and checking semantics.
 */

const WINDOW_SECONDS = 60;

export { WINDOW_SECONDS };

export class SlidingWindow {
    /**
     * @param {{ nowSeconds?: () => number, ArrayType?: typeof Int32Array | typeof Float64Array }} [opts]
     */
    constructor(opts = {}) {
        /** @type {Map<string, { slots: Int32Array|Float64Array, head: number, headTime: number }>} */
        this._keys = new Map();
        this._nowSeconds =
            opts.nowSeconds || (() => Math.floor(Date.now() / 1000));
        this._ArrayType = opts.ArrayType || Int32Array;
    }

    _getOrCreate(keyId, now) {
        let entry = this._keys.get(keyId);
        if (!entry) {
            entry = {
                slots: new this._ArrayType(WINDOW_SECONDS),
                head: 0,
                headTime: now,
            };
            this._keys.set(keyId, entry);
        }
        return entry;
    }

    /**
     * Advance the head pointer to the current second, zeroing out any
     * slots that have been passed since the last update.
     */
    _advance(entry, now) {
        const elapsed = now - entry.headTime;
        if (elapsed <= 0) return;

        const steps = Math.min(elapsed, WINDOW_SECONDS);
        for (let i = 1; i <= steps; i++) {
            const idx = (entry.head + i) % WINDOW_SECONDS;
            entry.slots[idx] = 0;
        }
        entry.head = (entry.head + steps) % WINDOW_SECONDS;
        entry.headTime = now;
    }

    _sum(entry) {
        let total = 0;
        for (let i = 0; i < WINDOW_SECONDS; i++) {
            total += entry.slots[i];
        }
        return total;
    }
}
