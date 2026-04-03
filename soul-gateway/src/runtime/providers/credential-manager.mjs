/**
 * CredentialManager — leases active account credentials for provider
 * execution.  Decrypts API key secrets or returns OAuth access tokens.
 *
 * Providers never read credential files directly — they request a
 * credential lease from this manager, use it for the duration of the
 * request, then release it.
 */

import { decrypt } from '../security/encryption.mjs';

export class CredentialManager {
  /**
   * @param {object} deps
   * @param {object} deps.pool                  pg Pool
   * @param {object} deps.accountsDao           provider-accounts DAO
   * @param {object} deps.accountPool           AccountPool instance
   * @param {Buffer} deps.encryptionKey         32-byte AES key
   * @param {object} [deps.oauthCredentialStore]
   * @param {object} deps.log
   */
  constructor({ pool, accountsDao, accountPool, encryptionKey, oauthCredentialStore = null, log }) {
    this._pool = pool;
    this._accountsDao = accountsDao;
    this._accountPool = accountPool;
    this._encryptionKey = encryptionKey;
    this._oauthCredentialStore = oauthCredentialStore;
    this._log = log;
    /** Track active leases for release/accounting. Map<leaseId, lease> */
    this._activeLeases = new Map();
    this._leaseCounter = 0;
  }

  /**
   * Lease credentials for a provider.
   *
   * @param {string} providerId       UUID of the provider
   * @param {object} [options]
   * @param {Set<string>} [options.excludeAccountIds]  Accounts already tried in this request
   * @returns {Promise<CredentialLease|null>}  null if provider requires no auth
   */
  async getCredentials(providerId, options = {}) {
    const { excludeAccountIds = new Set() } = options;

    // Ask account pool for the next available account
    const account = await this._accountPool.getNextAccount(providerId, { excludeAccountIds });
    if (!account) return null;

    const oauthPayload = await this._readOAuthPayload(account);

    const lease = {
      leaseId: String(++this._leaseCounter),
      accountId: account.id,
      authType: account.auth_type,
      secret: null,
      oauth: null,
      metadata: {
        ...(account.metadata || {}),
        ...(oauthPayload?.metadata || {}),
        credentialsPath: account.credentials_path || null,
      },
    };

    // Decrypt secret for api_key accounts
    if (account.auth_type === 'api_key' && account.secret_ciphertext) {
      try {
        lease.secret = decrypt(
          account.secret_ciphertext,
          account.secret_iv,
          account.secret_auth_tag,
          this._encryptionKey,
        );
      } catch (err) {
        this._log.error('credential_decrypt_failed', {
          accountId: account.id,
          error: err.message,
        });
        return null;
      }
    }

    // Build OAuth lease for oauth accounts
    if (account.auth_type === 'oauth') {
      lease.oauth = {
        accessToken: oauthPayload?.accessToken || account.metadata?.access_token || null,
        refreshToken: oauthPayload?.refreshToken || account.metadata?.refresh_token || null,
        expiresAt: oauthPayload?.accessTokenExpiresAt || account.access_token_expires_at || null,
      };
    }

    // For hybrid auth, populate both
    if (account.auth_type === 'hybrid') {
      if (account.secret_ciphertext) {
        try {
          lease.secret = decrypt(
            account.secret_ciphertext,
            account.secret_iv,
            account.secret_auth_tag,
            this._encryptionKey,
          );
        } catch { /* fallback to oauth */ }
      }
      lease.oauth = {
        accessToken: oauthPayload?.accessToken || account.metadata?.access_token || null,
        refreshToken: oauthPayload?.refreshToken || account.metadata?.refresh_token || null,
        expiresAt: oauthPayload?.accessTokenExpiresAt || account.access_token_expires_at || null,
      };
    }

    this._activeLeases.set(lease.leaseId, lease);
    return lease;
  }

  /**
   * Release a credential lease.  Should be called after the provider
   * execution completes (success or failure).
   *
   * @param {CredentialLease} lease
   */
  release(lease) {
    if (!lease) return;
    // Wipe secret from memory
    if (lease.secret) lease.secret = null;
    if (lease.oauth) {
      lease.oauth.accessToken = null;
      lease.oauth.refreshToken = null;
    }
    this._activeLeases.delete(lease.leaseId);
  }

  /**
   * Get the number of currently active (unreleased) leases.
   * Useful for diagnostics and shutdown drain checks.
   *
   * @returns {number}
   */
  get activeLeaseCount() {
    return this._activeLeases.size;
  }

  async _readOAuthPayload(account) {
    if (!account?.credentials_path || !this._oauthCredentialStore) {
      return null;
    }

    try {
      return await this._oauthCredentialStore.read(account.credentials_path);
    } catch (err) {
      this._log.warn('oauth_credentials_fallback_to_db_metadata', {
        accountId: account.id,
        error: err.message,
      });
      return null;
    }
  }
}

/**
 * @typedef {Object} CredentialLease
 * @property {string} leaseId           Internal tracking ID
 * @property {string} accountId         provider_accounts.id
 * @property {'api_key'|'oauth'|'hybrid'|'none'} authType
 * @property {string|null} secret       Decrypted API key (plaintext, in memory only)
 * @property {OAuthLease|null} oauth
 * @property {object} metadata          Account metadata
 */

/**
 * @typedef {Object} OAuthLease
 * @property {string|null} accessToken
 * @property {string|null} refreshToken
 * @property {string|null} expiresAt
 */
