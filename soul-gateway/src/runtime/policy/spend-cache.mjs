/**
 * In-memory cache for per-key daily and monthly spend.
 *
 * Avoids hitting the database on every request by caching spend totals
 * with a configurable TTL. Supports optimistic updates so a DB re-query
 * is only needed when the cache goes stale.
 */

const TABLE = 'soul_gateway.audit_logs';

export class SpendCache {
  /**
   * @param {{ ttlMs?: number, cleanupIdleMs?: number, now?: () => number }} [opts]
   */
  constructor(opts = {}) {
    this._ttlMs = opts.ttlMs ?? 10_000;
    this._cleanupIdleMs = opts.cleanupIdleMs ?? 30 * 60_000;
    this._now = opts.now || (() => Date.now());
    /**
     * @type {Map<string, {
     *   daily: number,
     *   monthly: number,
     *   fetchedAt: number,
     *   lastAccessAt: number,
     *   stale: boolean
     * }>}
     */
    this._entries = new Map();
  }

  /**
   * Get cached daily spend for a key, or null if stale / missing.
   *
   * @param {string} keyId
   * @returns {number|null}
   */
  getDailySpend(keyId) {
    const entry = this._getEntry(keyId);
    if (!entry || this._isStale(entry)) return null;
    return entry.daily;
  }

  /**
   * Get cached monthly spend for a key, or null if stale / missing.
   *
   * @param {string} keyId
   * @returns {number|null}
   */
  getMonthlySpend(keyId) {
    const entry = this._getEntry(keyId);
    if (!entry || this._isStale(entry)) return null;
    return entry.monthly;
  }

  /**
   * Get both daily and monthly spend values in one call.
   *
   * @param {string} keyId
   * @returns {{ dailySpendUsd: number|null, monthlySpendUsd: number|null } | null}
   */
  getForKey(keyId) {
    const entry = this._getEntry(keyId);
    if (!entry || this._isStale(entry)) return null;
    return {
      dailySpendUsd: entry.daily,
      monthlySpendUsd: entry.monthly,
    };
  }

  /**
   * Refresh cache for a key by querying the database.
   *
   * @param {string} keyId
   * @param {object} pool  pg Pool
   */
  async refresh(keyId, pool) {
    const now = new Date();

    // Midnight UTC today
    const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    // First of current month UTC
    const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

    const [dailyResult, monthlyResult] = await Promise.all([
      pool.query(
        `SELECT COALESCE(SUM(total_cost_usd), 0)::float AS total
         FROM ${TABLE}
         WHERE api_key_id = $1 AND started_at >= $2`,
        [keyId, startOfDay],
      ),
      pool.query(
        `SELECT COALESCE(SUM(total_cost_usd), 0)::float AS total
         FROM ${TABLE}
         WHERE api_key_id = $1 AND started_at >= $2`,
        [keyId, startOfMonth],
      ),
    ]);

    this._entries.set(keyId, {
      daily: dailyResult.rows[0].total,
      monthly: monthlyResult.rows[0].total,
      fetchedAt: this._now(),
      lastAccessAt: this._now(),
      stale: false,
    });
  }

  /**
   * Mark a key's cache entry as stale (next read will return null).
   *
   * @param {string} keyId
   */
  invalidate(keyId) {
    const entry = this._entries.get(keyId);
    if (entry) entry.stale = true;
  }

  /**
   * Optimistically add cost to the cached values without re-querying.
   * This avoids a DB round-trip after every request.
   *
   * @param {string} keyId
   * @param {number} costUsd
   */
  recordCost(keyId, costUsd) {
    const entry = this._entries.get(keyId);
    if (!entry) return;
    entry.daily += costUsd;
    entry.monthly += costUsd;
  }

  /**
   * Zero out the daily spend for a key (manual reset).
   *
   * @param {string} keyId
   */
  resetDaily(keyId) {
    const entry = this._getEntry(keyId);
    if (entry) entry.daily = 0;
  }

  /**
   * Clear or reset cached spend for a key.
   * Used by management endpoints after manual budget resets.
   *
   * @param {string} keyId
   */
  clearForKey(keyId) {
    this.resetDaily(keyId);
  }

  /**
   * Evict entries that have not been accessed recently.
   *
   * @returns {number}
   */
  cleanup() {
    const now = this._now();
    let removed = 0;
    for (const [keyId, entry] of this._entries) {
      if ((now - entry.lastAccessAt) >= this._cleanupIdleMs) {
        this._entries.delete(keyId);
        removed += 1;
      }
    }
    return removed;
  }

  // ── internals ───────────────────────────────────────────────────────

  _getEntry(keyId) {
    const entry = this._entries.get(keyId);
    if (entry) {
      entry.lastAccessAt = this._now();
    }
    return entry;
  }

  _isStale(entry) {
    if (entry.stale) return true;
    return (this._now() - entry.fetchedAt) >= this._ttlMs;
  }
}
