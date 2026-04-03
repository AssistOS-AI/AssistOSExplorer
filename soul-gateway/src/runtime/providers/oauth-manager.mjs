/**
 * OAuthManager — orchestrates OAuth flows and token refresh for
 * provider accounts.
 *
 * Registers OAuth adapters (one per OAuth provider type), manages
 * device/auth-code flows, deduplicates concurrent refresh requests,
 * and persists credentials to the account pool.
 */

export class OAuthManager {
  /**
   * @param {object} deps
   * @param {object} deps.pool          pg Pool
   * @param {object} deps.accountsDao   provider-accounts DAO
   * @param {object} deps.accountPool   AccountPool instance
   * @param {object} [deps.oauthCredentialStore]
   * @param {object} [deps.appCtx]      Application context (for auto-provisioning)
   * @param {object} deps.log
   */
  constructor({ pool, accountsDao, accountPool, oauthCredentialStore = null, appCtx = null, log }) {
    this._pool = pool;
    this._accountsDao = accountsDao;
    this._accountPool = accountPool;
    this._oauthCredentialStore = oauthCredentialStore;
    this._appCtx = appCtx;
    this._log = log;

    /** Registered adapters. Map<adapterKey, OAuthAdapter> */
    this._adapters = new Map();

    /** In-flight refresh dedup. Map<accountId, Promise<void>> */
    this._inflightRefreshes = new Map();

    /** Active device flows. Map<flowId, { adapter, context }> */
    this._activeFlows = new Map();
    this._flowCounter = 0;
  }

  /**
   * Register an OAuth adapter.
   *
   * @param {object} adapter  Conforms to the OAuthAdapter interface (design doc 8.2)
   */
  registerAdapter(adapter) {
    if (!adapter?.key) {
      throw new Error('OAuth adapter must have a key');
    }
    this._adapters.set(adapter.key, adapter);
    this._log.info('oauth_adapter_registered', { key: adapter.key, flowType: adapter.flowType });
  }

  /**
   * Get a registered adapter by key.
   *
   * @param {string} adapterKey
   * @returns {object|null}
   */
  getAdapter(adapterKey) {
    return this._adapters.get(adapterKey) || null;
  }

  /**
   * Start an OAuth flow for a provider account.
   *
   * @param {string} providerId
   * @param {string} adapterKey
   * @param {object} [options]
   * @returns {Promise<OAuthFlowResult>}
   */
  async startAuthFlow(providerId, adapterKey, options = {}) {
    const adapter = this._adapters.get(adapterKey);
    if (!adapter) {
      throw new Error(`No OAuth adapter registered for key: ${adapterKey}`);
    }

    const flowId = String(++this._flowCounter);
    const ctx = {
      flowId,
      providerId,
      ...options,
    };

    const result = await adapter.startFlow(ctx);

    this._activeFlows.set(flowId, { adapter, context: { ...ctx, ...result } });

    this._log.info('oauth_flow_started', {
      flowId,
      providerId,
      adapterKey,
      flowType: adapter.flowType,
    });

    return {
      flowId,
      type: adapter.flowType === 'device_code' ? 'device-flow' : 'pkce',
      flowType: adapter.flowType,
      // Device code flow returns these
      deviceCode: result.deviceCode || null,
      userCode: result.userCode || null,
      verificationUri: result.verificationUri || null,
      verificationUriComplete: result.verificationUriComplete || null,
      // Auth code flow returns this
      authUrl: result.authUrl || null,
      authorizeUrl: result.authUrl || null,
      expiresIn: result.expiresIn || null,
      interval: result.interval || null,
    };
  }

  /**
   * Complete an OAuth flow.
   *
   * For device_code flows: polls until user authorizes.
   * For auth_code flows: exchanges code for tokens.
   *
   * @param {string} providerId
   * @param {object} params  { flowId, code, callbackUrl }
   * @returns {Promise<{ accountId: string, status: string }>}
   */
  async completeAuthFlow(providerId, params = {}) {
    const flow = params.flowId ? this._activeFlows.get(params.flowId) : null;
    const adapter = flow?.adapter;
    if (!adapter) {
      throw new Error('No active flow found — start a flow first');
    }

    let credentials;
    if (adapter.flowType === 'device_code') {
      credentials = await adapter.pollDeviceFlow({
        ...flow.context,
        ...params,
      });
    } else {
      credentials = await adapter.handleCallback({
        ...flow.context,
        ...params,
      });
    }

    // Clean up the active flow
    this._activeFlows.delete(params.flowId);

    const credentialsPath = await this._allocateCredentialsPath(
      providerId,
      credentials.externalAccountId || null,
      `${adapter.key}-${params.flowId || 'account'}`,
    );

    const persistedCredentials = {
      accessToken: credentials.accessToken || null,
      refreshToken: credentials.refreshToken || null,
      accessTokenExpiresAt: credentials.accessTokenExpiresAt || null,
      refreshTokenExpiresAt: credentials.refreshTokenExpiresAt || null,
      scope: credentials.scope || null,
      tokenType: credentials.tokenType || 'Bearer',
      externalAccountId: credentials.externalAccountId || null,
      label: credentials.label || `oauth-${adapter.key}`,
      metadata: credentials.metadata || {},
    };

    if (this._oauthCredentialStore) {
      await this._oauthCredentialStore.write(credentialsPath, persistedCredentials);
    }

    // Create or update the provider account
    const account = await this._accountsDao.upsertOAuth(this._pool, {
      providerId,
      accountLabel: persistedCredentials.label,
      externalAccountId: persistedCredentials.externalAccountId,
      credentialsPath,
      accessTokenExpiresAt: persistedCredentials.accessTokenExpiresAt,
      refreshTokenExpiresAt: persistedCredentials.refreshTokenExpiresAt,
      refreshMarginSeconds: adapter.refreshMarginSeconds || 300,
      metadata: {
        access_token: persistedCredentials.accessToken,
        refresh_token: persistedCredentials.refreshToken,
        scope: persistedCredentials.scope,
        token_type: persistedCredentials.tokenType,
        ...(persistedCredentials.metadata || {}),
      },
    });

    this._log.info('oauth_flow_completed', {
      providerId,
      accountId: account.id,
      adapterKey: adapter.key,
    });

    // Auto-provision models for this provider if needed
    if (this._appCtx) {
      try {
        const { autoProvisionAfterOAuth } = await import('./auto-provisioner.mjs');
        const providersDao = await import('../../db/dao/providers-dao.mjs');
        const provider = await providersDao.findById(this._pool, providerId);
        if (provider) {
          await autoProvisionAfterOAuth(this._appCtx, provider, adapter.key);
        }
      } catch (err) {
        this._log.warn('auto-provision after OAuth failed', { error: err.message });
      }
    }

    return { accountId: account.id, status: 'active' };
  }

  /**
   * Compatibility wrapper used by management routes.
   *
   * @param {object} providerRecord
   * @param {object} [options]
   * @returns {Promise<OAuthFlowResult>}
   */
  async startFlow(providerRecord, options = {}) {
    if (!providerRecord?.id) {
      throw new Error('providerRecord.id is required to start an OAuth flow');
    }

    const adapterKey = providerRecord.oauth_adapter_key
      || providerRecord.oauthAdapterKey
      || providerRecord.adapter_key
      || providerRecord.adapterKey;

    if (!adapterKey) {
      throw new Error('Provider does not define an OAuth adapter');
    }

    return this.startAuthFlow(providerRecord.id, adapterKey, options);
  }

  /**
   * Compatibility wrapper for auth-code callbacks.
   *
   * @param {string} providerId
   * @param {object} query
   * @returns {Promise<object>}
   */
  async handleCallback(providerId, query = {}) {
    const flowId = query.flowId || query.flow_id || query.state;
    if (!flowId) {
      throw new Error('Missing flowId/state in OAuth callback');
    }

    return this.completeAuthFlow(providerId, {
      flowId,
      code: query.code || null,
      callbackUrl: query.callbackUrl || query.callback_url || null,
    });
  }

  /**
   * Compatibility wrapper for polling device-code flows.
   *
   * @param {string} providerId
   * @param {string} flowId
   * @returns {Promise<object>}
   */
  async pollPending(providerId, flowId) {
    const flow = this._activeFlows.get(flowId);
    if (!flow) {
      throw new Error('OAuth flow not found');
    }

    try {
      const result = await this.completeAuthFlow(providerId, { flowId });
      return { status: 'complete', result };
    } catch (err) {
      const pending = err.code === 'authorization_pending'
        || err.error === 'authorization_pending'
        || /authorization pending/i.test(err.message)
        || /slow down/i.test(err.message);

      if (pending) {
        return { status: 'pending', flowId };
      }

      throw err;
    }
  }

  /**
   * Refresh tokens for an account.  Deduplicates concurrent refreshes
   * for the same account.
   *
   * @param {string} accountId
   * @param {string} adapterKey
   * @returns {Promise<void>}
   */
  async refreshTokens(accountId, adapterKey) {
    // Dedup: if there's already an in-flight refresh for this account, await it
    const inflight = this._inflightRefreshes.get(accountId);
    if (inflight) {
      await inflight;
      return;
    }

    const refreshPromise = this._doRefresh(accountId, adapterKey);
    this._inflightRefreshes.set(accountId, refreshPromise);

    try {
      await refreshPromise;
    } finally {
      this._inflightRefreshes.delete(accountId);
    }
  }

  /**
   * Check whether an account needs a proactive refresh.
   *
   * @param {object} account  Account row
   * @returns {boolean}
   */
  needsRefresh(account) {
    if (!account.access_token_expires_at) return false;
    const expiresAt = new Date(account.access_token_expires_at).getTime();
    const marginMs = (account.refresh_margin_seconds || 300) * 1000;
    return Date.now() >= expiresAt - marginMs;
  }

  /**
   * Revoke an OAuth account's tokens.
   *
   * @param {string} accountId
   * @param {string} adapterKey
   */
  async revoke(accountId, adapterKey) {
    const adapter = this._adapters.get(adapterKey);
    if (!adapter?.revoke) {
      this._log.warn('oauth_revoke_not_supported', { adapterKey });
      return;
    }

    const account = await this._accountsDao.findById(this._pool, accountId);
    if (!account) return;

    try {
      await adapter.revoke({
        accessToken: account.metadata?.access_token,
        refreshToken: account.metadata?.refresh_token,
      });
    } catch (err) {
      this._log.error('oauth_revoke_failed', { accountId, error: err.message });
    }

    await this._accountsDao.updateStatus(this._pool, accountId, 'disabled');
  }

  /**
   * Number of in-flight token refreshes.
   */
  get inflightRefreshCount() {
    return this._inflightRefreshes.size;
  }

  /**
   * Number of active (incomplete) auth flows.
   */
  get activeFlowCount() {
    return this._activeFlows.size;
  }

  // ── Internal ────────────────────────────────────────────────────────

  async _doRefresh(accountId, adapterKey) {
    const adapter = this._adapters.get(adapterKey);
    if (!adapter?.refreshTokens) {
      throw new Error(`OAuth adapter ${adapterKey} does not support token refresh`);
    }

    // Mark refreshing in account pool
    await this._accountPool.markRefreshing(accountId);

    const account = await this._accountsDao.findById(this._pool, accountId);
    if (!account) {
      throw new Error(`Account ${accountId} not found for refresh`);
    }

    try {
      const storedTokens = await this._readStoredCredentials(account);
      const newTokens = await adapter.refreshTokens({
        accessToken: storedTokens.accessToken || account.metadata?.access_token,
        refreshToken: storedTokens.refreshToken || account.metadata?.refresh_token,
        accessTokenExpiresAt: storedTokens.accessTokenExpiresAt || account.access_token_expires_at || null,
        refreshTokenExpiresAt: storedTokens.refreshTokenExpiresAt || account.refresh_token_expires_at || null,
        tokenType: storedTokens.tokenType || account.metadata?.token_type || 'Bearer',
        scope: storedTokens.scope || account.metadata?.scope || null,
        metadata: {
          ...(storedTokens.metadata || {}),
          ...(account.metadata || {}),
        },
      });

      // Update the account with new tokens
      const refreshedPayload = {
        ...storedTokens,
        accessToken: newTokens.accessToken,
        refreshToken: newTokens.refreshToken || storedTokens.refreshToken || account.metadata?.refresh_token,
        accessTokenExpiresAt: newTokens.accessTokenExpiresAt || storedTokens.accessTokenExpiresAt || account.access_token_expires_at || null,
        refreshTokenExpiresAt: newTokens.refreshTokenExpiresAt || storedTokens.refreshTokenExpiresAt || account.refresh_token_expires_at || null,
        tokenType: newTokens.tokenType || storedTokens.tokenType || account.metadata?.token_type || 'Bearer',
        scope: newTokens.scope || storedTokens.scope || account.metadata?.scope || null,
        metadata: {
          ...(storedTokens.metadata || {}),
          ...(newTokens.metadata || {}),
        },
      };

      if (this._oauthCredentialStore && account.credentials_path) {
        await this._oauthCredentialStore.write(account.credentials_path, refreshedPayload);
      }

      const updatedMetadata = {
        ...(account.metadata || {}),
        access_token: refreshedPayload.accessToken,
        refresh_token: refreshedPayload.refreshToken,
        token_type: refreshedPayload.tokenType,
        scope: refreshedPayload.scope,
        ...(refreshedPayload.metadata || {}),
      };

      await this._pool.query(
        `UPDATE soul_gateway.provider_accounts
         SET metadata = $2,
             access_token_expires_at = $3,
             refresh_token_expires_at = $4,
             status = 'active',
             updated_at = now()
         WHERE id = $1 AND deleted_at IS NULL`,
        [
          accountId,
          JSON.stringify(updatedMetadata),
          refreshedPayload.accessTokenExpiresAt,
          refreshedPayload.refreshTokenExpiresAt,
        ],
      );

      await this._accountPool.markActive(accountId, {
        accessTokenExpiresAt: refreshedPayload.accessTokenExpiresAt || null,
        refreshTokenExpiresAt: refreshedPayload.refreshTokenExpiresAt || null,
      });

      this._log.info('oauth_tokens_refreshed', { accountId, adapterKey });
    } catch (err) {
      await this._accountPool.markErrored(accountId, 'refresh_failed', err.message);
      this._log.error('oauth_refresh_failed', { accountId, adapterKey, error: err.message });
      throw err;
    }
  }

  async _allocateCredentialsPath(providerId, externalAccountId, fallbackName) {
    if (!this._oauthCredentialStore) return null;
    return this._oauthCredentialStore.allocatePath(providerId, externalAccountId, fallbackName);
  }

  async _readStoredCredentials(account) {
    if (!this._oauthCredentialStore || !account?.credentials_path) {
      return {};
    }
    try {
      return await this._oauthCredentialStore.read(account.credentials_path) || {};
    } catch {
      return {};
    }
  }
}

/**
 * @typedef {Object} OAuthFlowResult
 * @property {string} flowId
 * @property {'device_code'|'auth_code_pkce'} flowType
 * @property {string|null} deviceCode
 * @property {string|null} userCode
 * @property {string|null} verificationUri
 * @property {string|null} verificationUriComplete
 * @property {string|null} authUrl
 * @property {number|null} expiresIn
 * @property {number|null} interval
 */
