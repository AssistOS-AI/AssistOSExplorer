/**
 * AccountPool — manages multi-account credential rotation and
 * exhaustion tracking.
 *
 * Selection algorithm (per design doc 8.3):
 *   1. Filter accounts by status IN ('active', 'refreshing')
 *   2. Exclude accounts with quota_resets_at > now
 *   3. Prefer accounts with oldest last_used_at
 *   4. Exclude accounts already attempted in this client request
 *   5. Return the first candidate
 */

export class AccountPool {
    /**
     * @param {object} deps
     * @param {object} deps.pool          database query facade
     * @param {object} deps.accountsDao   provider-accounts DAO
     * @param {object} deps.log
     */
    constructor({ pool, accountsDao, log }) {
        this._pool = pool;
        this._accountsDao = accountsDao;
        this._log = log;

        /**
         * In-memory exhaustion tracker.
         * Map<accountId, { resetTime: Date|null, exhaustedAt: Date }>
         */
        this._exhausted = new Map();

        /**
         * In-memory refreshing lock.
         * Set<accountId>
         */
        this._refreshing = new Set();

        /**
         * Round-robin index per provider. Map<providerId, number>
         */
        this._roundRobinIndex = new Map();
    }

    /**
     * Get the next available account for a provider.
     *
     * @param {string} providerId
     * @param {object} [options]
     * @param {Set<string>} [options.excludeAccountIds]
     * @returns {Promise<object|null>}  Account row or null
     */
    async getNextAccount(providerId, options = {}) {
        const { excludeAccountIds = new Set() } = options;
        const now = new Date();

        // Fetch all non-deleted accounts for this provider ordered by last_used_at ASC
        const accounts = await this._accountsDao.listByProvider(
            this._pool,
            providerId
        );

        // Filter to eligible candidates
        const candidates = accounts.filter((acc) => {
            // Must be active or refreshing
            if (acc.status !== 'active' && acc.status !== 'refreshing')
                return false;

            // Exclude already-tried accounts in this request
            if (excludeAccountIds.has(acc.id)) return false;

            // Exclude in-memory exhausted accounts whose reset time is in the future
            const exhaustion = this._exhausted.get(acc.id);
            if (exhaustion) {
                if (!exhaustion.resetTime || exhaustion.resetTime > now)
                    return false;
                // Expired exhaustion — clean up
                this._exhausted.delete(acc.id);
            }

            // Exclude DB-level quota exhausted accounts
            if (acc.quota_resets_at && new Date(acc.quota_resets_at) > now)
                return false;

            return true;
        });

        if (candidates.length === 0) return null;

        // Round-robin selection
        const idx = this._roundRobinIndex.get(providerId) || 0;
        const selected = candidates[idx % candidates.length];
        this._roundRobinIndex.set(providerId, (idx + 1) % candidates.length);

        // Update last_used_at asynchronously (fire-and-forget)
        this._touchLastUsed(selected.id).catch(() => {});

        return selected;
    }

    /**
     * Mark an account as quota exhausted.
     *
     * @param {string} providerId
     * @param {string} accountId
     * @param {Date|null} resetTime  When the quota is expected to reset
     */
    async markExhausted(providerId, accountId, resetTime = null) {
        this._exhausted.set(accountId, {
            resetTime,
            exhaustedAt: new Date(),
        });

        try {
            await this._accountsDao.markExhausted(
                this._pool,
                accountId,
                resetTime
            );
        } catch (err) {
            this._log.error('account_mark_exhausted_failed', {
                accountId,
                error: err.message,
            });
        }

        this._log.info('account_exhausted', {
            providerId,
            accountId,
            resetTime,
        });
    }

    /**
     * Mark an account as refreshing (locked during token refresh).
     *
     * @param {string} accountId
     */
    async markRefreshing(accountId) {
        this._refreshing.add(accountId);

        try {
            await this._accountsDao.markRefreshing(this._pool, accountId);
        } catch (err) {
            this._log.error('account_mark_refreshing_failed', {
                accountId,
                error: err.message,
            });
        }
    }

    /**
     * Mark an account as active again (after refresh completes).
     *
     * @param {string} accountId
     * @param {object} [tokenInfo]
     * @param {Date|null} [tokenInfo.accessTokenExpiresAt]
     * @param {Date|null} [tokenInfo.refreshTokenExpiresAt]
     */
    async markActive(accountId, tokenInfo = {}) {
        this._refreshing.delete(accountId);
        this._exhausted.delete(accountId);

        try {
            await this._accountsDao.updateTokenExpiry(
                this._pool,
                accountId,
                tokenInfo
            );
        } catch (err) {
            this._log.error('account_mark_active_failed', {
                accountId,
                error: err.message,
            });
        }
    }

    /**
     * Mark an account as errored.
     *
     * @param {string} accountId
     * @param {string} errorType
     * @param {string} errorMessage
     */
    async markErrored(accountId, errorType, errorMessage) {
        try {
            await this._accountsDao.updateStatus(
                this._pool,
                accountId,
                'reauth_required',
                {
                    lastErrorType: errorType,
                    lastErrorMessage: errorMessage,
                }
            );
        } catch (err) {
            this._log.error('account_mark_errored_failed', {
                accountId,
                error: err.message,
            });
        }
    }

    /**
     * Clear expired exhaustion entries from the in-memory tracker.
     * Called periodically by the cleanup background job.
     */
    purgeExpiredExhaustions() {
        const now = new Date();
        let purged = 0;
        for (const [accountId, entry] of this._exhausted) {
            if (entry.resetTime && entry.resetTime <= now) {
                this._exhausted.delete(accountId);
                purged++;
            }
        }
        return purged;
    }

    /**
     * Clear specific exhausted accounts from the in-memory tracker,
     * or clear the entire tracker when no ids are provided.
     *
     * @param {string[]|Set<string>|null} [accountIds]
     * @returns {number}
     */
    clearExhaustions(accountIds = null) {
        if (!accountIds) {
            const cleared = this._exhausted.size;
            this._exhausted.clear();
            return cleared;
        }

        let cleared = 0;
        for (const accountId of accountIds) {
            if (this._exhausted.delete(accountId)) {
                cleared += 1;
            }
        }
        return cleared;
    }

    /**
     * Number of accounts currently tracked as exhausted.
     */
    get exhaustedCount() {
        return this._exhausted.size;
    }

    /**
     * Number of accounts currently in refreshing state.
     */
    get refreshingCount() {
        return this._refreshing.size;
    }

    // ── Internal ────────────────────────────────────────────────────────

    async _touchLastUsed(accountId) {
        await this._pool.query(
            `UPDATE provider_accounts
       SET last_used_at = now()
       WHERE id = $1 AND deleted_at IS NULL`,
            [accountId]
        );
    }
}
