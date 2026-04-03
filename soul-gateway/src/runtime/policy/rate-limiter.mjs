/**
 * In-memory sliding-window RPM limiter.
 *
 * Tracks per-key request counts in a 60-slot ring buffer (one slot per second).
 * No database writes on the hot path — purely in-memory.
 */

const WINDOW_SECONDS = 60;

export class SlidingWindowLimiter {
  /**
   * @param {{ nowSeconds?: () => number }} [opts]
   */
  constructor(opts = {}) {
    /** @type {Map<string, { slots: Int32Array, head: number, headTime: number }>} */
    this._keys = new Map();
    this._nowSeconds = opts.nowSeconds || (() => Math.floor(Date.now() / 1000));
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

  // ── internals ───────────────────────────────────────────────────────

  _getOrCreate(keyId, now) {
    let entry = this._keys.get(keyId);
    if (!entry) {
      entry = {
        slots: new Int32Array(WINDOW_SECONDS),
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
