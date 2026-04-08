/**
 * In-memory sliding-window TPM (tokens-per-minute) tracker.
 *
 * Same ring-buffer approach as the RPM limiter, but tracks token counts
 * instead of request counts. Provides a soft limit — the caller decides
 * whether to block.
 */

const WINDOW_SECONDS = 60;

export class TpmTracker {
    /**
     * @param {{ nowSeconds?: () => number }} [opts]
     */
    constructor(opts = {}) {
        /** @type {Map<string, { slots: Float64Array, head: number, headTime: number }>} */
        this._keys = new Map();
        this._nowSeconds =
            opts.nowSeconds || (() => Math.floor(Date.now() / 1000));
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

    // ── internals ───────────────────────────────────────────────────────

    _getOrCreate(keyId, now) {
        let entry = this._keys.get(keyId);
        if (!entry) {
            entry = {
                slots: new Float64Array(WINDOW_SECONDS),
                head: 0,
                headTime: now,
            };
            this._keys.set(keyId, entry);
        }
        return entry;
    }

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
