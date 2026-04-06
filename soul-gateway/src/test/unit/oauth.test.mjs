import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

import { OAuthCredentialStore } from '../../runtime/providers/oauth/credential-store.mjs';
import { OAuthManager } from '../../runtime/providers/oauth-manager.mjs';
import { CredentialManager } from '../../runtime/providers/credential-manager.mjs';

const log = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};

describe('OAuthCredentialStore', () => {
  it('round-trips encrypted credential payloads', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sg-oauth-store-'));
    try {
      const store = new OAuthCredentialStore({
        baseDir: dir,
        encryptionKey: randomBytes(32),
        log,
      });

      const file = await store.allocatePath('provider-1', 'acct-1');
      await store.write(file, {
        accessToken: 'access-123',
        refreshToken: 'refresh-456',
        metadata: { email: 'user@example.com' },
      });

      const loaded = await store.read(file);
      assert.equal(loaded.accessToken, 'access-123');
      assert.equal(loaded.refreshToken, 'refresh-456');
      assert.equal(loaded.metadata.email, 'user@example.com');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('OAuthManager', () => {
  let dir;
  let store;
  let accountsDao;
  let accountPool;
  let pool;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sg-oauth-manager-'));
    store = new OAuthCredentialStore({
      baseDir: dir,
      encryptionKey: randomBytes(32),
      log,
    });
    accountsDao = {
      async upsertOAuth(_pool, payload) {
        return { id: 'acc-1', provider_id: payload.providerId, credentials_path: payload.credentialsPath, metadata: payload.metadata };
      },
      async findById() {
        return null;
      },
      async updateStatus() {
        return null;
      },
    };
    accountPool = {
      async markRefreshing() {},
      async markActive() {},
      async markErrored() {},
    };
    pool = {
      async query() {
        return { rows: [], rowCount: 1 };
      },
    };
  });

  it('starts and completes a device flow, persisting credentials to disk', async () => {
    const manager = new OAuthManager({
      pool,
      accountsDao,
      accountPool,
      oauthCredentialStore: store,
      log,
    });

    manager.registerAdapter({
      key: 'device-test',
      flowType: 'device_code',
      refreshMarginSeconds: 123,
      async startFlow() {
        return {
          type: 'device-flow',
          deviceCode: 'dev-123',
          userCode: 'USER-CODE',
          verificationUri: 'https://example.test/device',
          interval: 5,
        };
      },
      async pollDeviceFlow() {
        return {
          label: 'Test Device',
          externalAccountId: 'external-1',
          accessToken: 'access-token',
          refreshToken: 'refresh-token',
          accessTokenExpiresAt: '2026-05-01T00:00:00.000Z',
          metadata: { email: 'device@example.com' },
        };
      },
      async refreshTokens() {
        throw new Error('not used');
      },
    });

    const flow = await manager.startAuthFlow('provider-1', 'device-test');
    assert.equal(flow.type, 'device-flow');
    assert.equal(flow.flowType, 'device_code');
    assert.equal(flow.userCode, 'USER-CODE');

    const completed = await manager.completeAuthFlow('provider-1', { flowId: flow.flowId });
    assert.equal(completed.status, 'active');

    const providerDir = join(dir, 'provider-1');
    const entries = await import('node:fs/promises').then((fs) => fs.readdir(providerDir));
    assert.equal(entries.length, 1);
    const persisted = await store.read(join(providerDir, entries[0]));
    assert.equal(persisted.accessToken, 'access-token');
    assert.equal(persisted.refreshToken, 'refresh-token');
    assert.equal(persisted.metadata.email, 'device@example.com');

    await rm(dir, { recursive: true, force: true });
  });

  it('refreshes tokens from persisted credential files and rewrites the store', async () => {
    const path = await store.allocatePath('provider-1', 'external-1');
    await store.write(path, {
      accessToken: 'old-access',
      refreshToken: 'old-refresh',
      accessTokenExpiresAt: '2026-04-01T00:00:00.000Z',
      tokenType: 'Bearer',
      metadata: { email: 'refresh@example.com' },
    });

    let markActivePayload = null;
    accountPool = {
      async markRefreshing() {},
      async markActive(_accountId, payload) {
        markActivePayload = payload;
      },
      async markErrored() {
        throw new Error('should not mark errored');
      },
    };

    accountsDao = {
      async findById() {
        return {
          id: 'acc-1',
          metadata: { access_token: 'old-access', refresh_token: 'old-refresh', token_type: 'Bearer' },
          credentials_path: path,
          access_token_expires_at: '2026-04-01T00:00:00.000Z',
          refresh_token_expires_at: null,
        };
      },
      async updateStatus() {
        return null;
      },
    };

    const queries = [];
    pool = {
      async query(sql, params) {
        queries.push({ sql, params });
        return { rows: [], rowCount: 1 };
      },
    };

    const manager = new OAuthManager({
      pool,
      accountsDao,
      accountPool,
      oauthCredentialStore: store,
      log,
    });

    manager.registerAdapter({
      key: 'refresh-test',
      flowType: 'auth_code_pkce',
      async startFlow() {
        return { type: 'pkce', authUrl: 'https://example.test/auth' };
      },
      async handleCallback() {
        throw new Error('not used');
      },
      async refreshTokens(tokens) {
        assert.equal(tokens.accessToken, 'old-access');
        assert.equal(tokens.refreshToken, 'old-refresh');
        return {
          accessToken: 'new-access',
          refreshToken: 'new-refresh',
          accessTokenExpiresAt: '2026-06-01T00:00:00.000Z',
          tokenType: 'Bearer',
        };
      },
    });

    await manager.refreshTokens('acc-1', 'refresh-test');

    const persisted = await store.read(path);
    assert.equal(persisted.accessToken, 'new-access');
    assert.equal(persisted.refreshToken, 'new-refresh');
    assert.equal(markActivePayload.accessTokenExpiresAt, '2026-06-01T00:00:00.000Z');
    assert.equal(queries.length, 1);

    await rm(dir, { recursive: true, force: true });
  });
});

describe('CredentialManager OAuth file support', () => {
  it('prefers encrypted file-backed OAuth credentials when present', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sg-oauth-lease-'));
    try {
      const store = new OAuthCredentialStore({
        baseDir: dir,
        encryptionKey: randomBytes(32),
        log,
      });
      const path = await store.allocatePath('provider-1', 'acct-1');
      await store.write(path, {
        accessToken: 'file-access',
        refreshToken: 'file-refresh',
        accessTokenExpiresAt: '2026-07-01T00:00:00.000Z',
        metadata: { email: 'file@example.com' },
      });

      const manager = new CredentialManager({
        pool: {},
        accountsDao: {},
        providersDao: { async findById() { return null; } },
        accountPool: {
          async getNextAccount() {
            return {
              id: 'acc-1',
              auth_type: 'oauth',
              metadata: { access_token: 'db-access', refresh_token: 'db-refresh' },
              credentials_path: path,
              access_token_expires_at: '2027-07-01T00:00:00.000Z',
            };
          },
        },
        encryptionKey: randomBytes(32),
        oauthCredentialStore: store,
        oauthManager: { needsRefresh() { return false; }, async refreshTokens() {} },
        log,
      });

      const lease = await manager.getCredentials('provider-1');
      assert.equal(lease.oauth.accessToken, 'file-access');
      assert.equal(lease.oauth.refreshToken, 'file-refresh');
      assert.equal(lease.metadata.email, 'file@example.com');
      manager.release(lease);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
