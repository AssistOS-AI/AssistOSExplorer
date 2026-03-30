import { createLogger } from '../utils/logger.mjs';
import * as store from './credential-store.mjs';

const log = createLogger('auth-manager');

// Registered adapters: name -> adapter module
const adapters = new Map();

// Coalesce concurrent refresh requests: "provider:index" -> Promise
const refreshInProgress = new Map();

// Active device flow polling: providerName -> { deviceCode, interval, polling }
const activeFlows = new Map();

let refreshInterval = null;

// ---- Registration ----

export function registerAdapter(adapter) {
  adapters.set(adapter.name, adapter);
  log.info(`Registered auth adapter: ${adapter.name} (${adapter.authType})`);
}

export function getAdapter(providerName) {
  return adapters.get(providerName) || null;
}

// ---- Credentials ----

/**
 * Get credentials for the active account of a provider.
 * Handles token refresh if needed.
 * @returns {{ token, headers, formatConverter }} or null if not authenticated
 */
export async function getCredentials(providerName) {
  const adapter = adapters.get(providerName);
  if (!adapter) return null;

  const state = await store.readState(providerName);
  const accounts = await store.readAccounts(providerName);

  if (accounts.length === 0) return null;

  // Find active account (skip exhausted)
  let account = accounts.find(a => a._index === state.activeIndex);
  if (!account || account.quotaExhausted) {
    // Try to find any non-exhausted account
    account = accounts.find(a => !a.quotaExhausted);
    if (!account) return null; // All exhausted
    state.activeIndex = account._index;
    await store.writeState(providerName, state);
  }

  // Refresh if needed
  if (account.expiresAt && Date.now() + (adapter.refreshMarginMs || 60000) > account.expiresAt) {
    await refreshAccountToken(providerName, account._index, adapter, account);
    // Re-read after refresh
    const refreshed = await store.readAccounts(providerName);
    account = refreshed.find(a => a._index === state.activeIndex) || account;
  }

  const headers = adapter.getHeaders ? await adapter.getHeaders(account) : {};

  return {
    token: account.accessToken,
    headers,
    formatConverter: adapter.formatConverter || null,
  };
}

// ---- Account Rotation ----

/**
 * Mark current account as quota-exhausted and rotate to next available.
 * @returns {boolean} true if rotation succeeded, false if all accounts exhausted
 */
export async function rotateAccount(providerName) {
  const state = await store.readState(providerName);
  const accounts = await store.readAccounts(providerName);

  // Mark current account exhausted
  const current = accounts.find(a => a._index === state.activeIndex);
  if (current) {
    current.quotaExhausted = true;
    // Reset at next midnight UTC
    const tomorrow = new Date();
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    tomorrow.setUTCHours(0, 0, 0, 0);
    current.quotaResetAt = tomorrow.toISOString();
    await store.writeAccount(providerName, current._index, current);
    log.info(`Marked account ${current._index} as quota-exhausted for ${providerName}`);
  }

  // Find next non-exhausted account
  const next = accounts.find(a => a._index !== state.activeIndex && !a.quotaExhausted);
  if (!next) {
    log.warn(`All accounts exhausted for ${providerName}`);
    return false;
  }

  state.activeIndex = next._index;
  state.lastRotation = new Date().toISOString();
  await store.writeState(providerName, state);
  log.info(`Rotated ${providerName} to account ${next._index} (${next.email || 'unknown'})`);
  return true;
}

// ---- Token Refresh ----

async function refreshAccountToken(providerName, accountIndex, adapter, account) {
  const key = `${providerName}:${accountIndex}`;

  if (!refreshInProgress.has(key)) {
    refreshInProgress.set(key, (async () => {
      try {
        if (!adapter.refreshToken) {
          log.warn(`Adapter ${providerName} has no refreshToken method`);
          return;
        }
        log.debug(`Refreshing token for ${providerName} account ${accountIndex}`);
        const refreshed = await adapter.refreshToken(account);
        await store.writeAccount(providerName, accountIndex, { ...account, ...refreshed });
        log.info(`Token refreshed for ${providerName} account ${accountIndex}`);
      } catch (err) {
        log.error(`Token refresh failed for ${providerName} account ${accountIndex}`, { error: err.message });
        // Mark account as needing re-auth
        account.needsReauth = true;
        await store.writeAccount(providerName, accountIndex, account);
      } finally {
        refreshInProgress.delete(key);
      }
    })());
  }

  return refreshInProgress.get(key);
}

// ---- Background Refresh Loop ----

export function startRefreshLoop(intervalMs = 60_000) {
  if (refreshInterval) return;

  refreshInterval = setInterval(async () => {
    for (const [name, adapter] of adapters) {
      try {
        const accounts = await store.readAccounts(name);
        for (const account of accounts) {
          // Reset quota if reset time has passed
          if (account.quotaExhausted && account.quotaResetAt && new Date(account.quotaResetAt) <= new Date()) {
            account.quotaExhausted = false;
            account.quotaResetAt = null;
            await store.writeAccount(name, account._index, account);
            log.info(`Quota reset for ${name} account ${account._index}`);
          }

          // Refresh token if expiring soon
          if (account.expiresAt && !account.needsReauth &&
              Date.now() + (adapter.refreshMarginMs || 60000) > account.expiresAt) {
            await refreshAccountToken(name, account._index, adapter, account);
          }
        }
      } catch (err) {
        log.error(`Refresh loop error for ${name}`, { error: err.message });
      }
    }
  }, intervalMs);

  refreshInterval.unref();
  log.info('Auth refresh loop started');
}

export function stopRefreshLoop() {
  if (refreshInterval) {
    clearInterval(refreshInterval);
    refreshInterval = null;
    log.info('Auth refresh loop stopped');
  }
}

// ---- Auth Flow Management ----

/**
 * Start an auth flow for a provider.
 * Device flow: returns { type: 'device-flow', userCode, verificationUri }
 * PKCE flow: returns { type: 'pkce', authUrl }
 */
export async function startAuth(providerName) {
  const adapter = adapters.get(providerName);
  if (!adapter) throw new Error(`Unknown provider: ${providerName}`);

  const result = await adapter.startAuth();

  // For device flow, store the flow state so pollAuth can check it
  if (result.deviceCode) {
    activeFlows.set(providerName, {
      deviceCode: result.deviceCode,
      interval: result.interval,
      polling: false,
    });
    return { type: 'device-flow', userCode: result.userCode, verificationUri: result.verificationUri };
  }

  // For PKCE, the callback server is already listening
  return { type: 'pkce', authUrl: result.authUrl };
}

/**
 * Poll a device flow for completion.
 * @returns {{ status: 'pending' }} or {{ status: 'complete', email }}
 */
export async function pollAuth(providerName) {
  const adapter = adapters.get(providerName);
  const flow = activeFlows.get(providerName);
  if (!adapter || !flow) return { status: 'no_active_flow' };

  try {
    const creds = await adapter.pollForToken(flow.deviceCode, flow.interval);
    // Save as new account
    const index = await store.nextAccountIndex(providerName);
    await store.writeAccount(providerName, index, creds);
    activeFlows.delete(providerName);
    log.info(`New account added for ${providerName}: ${creds.email || 'account-' + index}`);
    return { status: 'complete', email: creds.email || null, index };
  } catch (err) {
    if (err.message.includes('authorization_pending') || err.message.includes('slow_down')) {
      return { status: 'pending' };
    }
    activeFlows.delete(providerName);
    return { status: 'error', error: err.message };
  }
}

/**
 * Handle PKCE callback — called when OAuth redirect arrives.
 */
export async function handlePKCECallback(providerName, code, state) {
  const adapter = adapters.get(providerName);
  if (!adapter || !adapter.exchangeCode) throw new Error(`No PKCE adapter for ${providerName}`);

  const creds = await adapter.exchangeCode(code, state);
  const index = await store.nextAccountIndex(providerName);
  await store.writeAccount(providerName, index, creds);
  log.info(`PKCE auth complete for ${providerName}: ${creds.email || 'account-' + index}`);
  return { email: creds.email || null, index };
}

// ---- Status ----

export async function getAuthStatus(providerName) {
  const adapter = adapters.get(providerName);
  if (!adapter) return { status: 'unknown', accounts: [] };

  const accounts = await store.readAccounts(providerName);
  const state = await store.readState(providerName);

  let status = 'no_accounts';
  if (accounts.length > 0) {
    const active = accounts.find(a => a._index === state.activeIndex && !a.quotaExhausted && !a.needsReauth);
    if (active) {
      const expiresIn = active.expiresAt ? active.expiresAt - Date.now() : null;
      status = expiresIn && expiresIn < (adapter.refreshMarginMs || 60000) ? 'expiring' : 'active';
    } else if (accounts.every(a => a.quotaExhausted)) {
      status = 'all_exhausted';
    } else if (accounts.some(a => a.needsReauth)) {
      status = 'needs_reauth';
    } else {
      status = 'active';
    }
  }

  return {
    status,
    activeIndex: state.activeIndex,
    accounts: accounts.map(a => ({
      index: a._index,
      email: a.email || null,
      expiresAt: a.expiresAt || null,
      quotaExhausted: !!a.quotaExhausted,
      quotaResetAt: a.quotaResetAt || null,
      needsReauth: !!a.needsReauth,
    })),
  };
}

export function getFormatConverter(providerName) {
  const adapter = adapters.get(providerName);
  return adapter?.formatConverter || null;
}

export async function removeAccount(providerName, index) {
  await store.removeAccount(providerName, index);
  log.info(`Removed account ${index} for ${providerName}`);
}

export async function resetQuota(providerName) {
  const accounts = await store.readAccounts(providerName);
  for (const account of accounts) {
    if (account.quotaExhausted) {
      account.quotaExhausted = false;
      account.quotaResetAt = null;
      await store.writeAccount(providerName, account._index, account);
    }
  }
  log.info(`Quota reset for all ${providerName} accounts`);
}
