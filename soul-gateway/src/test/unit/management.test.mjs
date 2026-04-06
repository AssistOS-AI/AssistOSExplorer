import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';

// ── Test helpers ────────────────────────────────────────────────────

function createMockPool(queryFn) {
  return {
    query: queryFn || (async () => ({ rows: [], rowCount: 0 })),
  };
}

function makeSigningKey() {
  return 'test-signing-key-' + randomBytes(8).toString('hex');
}

function signAdminToken(expiresAt, signingKey) {
  const payload = String(expiresAt);
  const sig = createHmac('sha256', signingKey).update(payload).digest('hex');
  return `${payload}.${sig}`;
}

function createMockAppCtx(overrides = {}) {
  const signingKey = overrides.signingKey || makeSigningKey();
  const services = { ...(overrides.services || {}) };

  if (!services.refreshRuntime) {
    services.refreshRuntime = async (options = {}) => {
      const result = {
        reason: options.reason || 'test',
        snapshotGeneration: 1,
        middlewareGeneration: null,
        middlewareCount: null,
        providerCatalogGeneration: null,
        providerCount: null,
      };

      if (options.middlewareCatalog && typeof services.reloadMiddlewareCatalog === 'function') {
        const middleware = await services.reloadMiddlewareCatalog();
        result.middlewareGeneration = middleware?.generation ?? null;
        result.middlewareCount = middleware?.count ?? null;
      }

      if (options.providerCatalog && typeof services.reloadProviderCatalog === 'function') {
        const providers = await services.reloadProviderCatalog();
        result.providerCatalogGeneration = providers?.generation ?? null;
        result.providerCount = providers?.count ?? null;
      }

      if (options.snapshot && typeof services.reloadRuntimeSnapshot === 'function') {
        const snapshot = await services.reloadRuntimeSnapshot();
        result.snapshotGeneration = snapshot?.generation ?? result.snapshotGeneration;
      }

      return result;
    };
  }

  if (!services.refreshRuntimeAsync) {
    services.refreshRuntimeAsync = (options = {}) => services.refreshRuntime(options);
  }

  return {
    config: {
      env: {
        DASHBOARD_PASSWORD: overrides.dashboardPassword || 'testpass',
        ADMIN_SESSION_SIGNING_KEY: signingKey,
        ENCRYPTION_KEY: null,
        API_KEY_HASH_PEPPER: 'test-pepper',
        DATA_DIR: '/tmp/soul-gateway-test',
        DASHBOARD_STATIC_DIR: '/tmp/soul-gateway-test/dashboard',
      },
      defaults: {
        adminSessionTtlMs: 43_200_000,
        apiKeyPrefix: 'sk-soul-',
        requestIdPrefix: 'chatcmpl-',
        systemMetricsSampleMs: 15_000,
      },
    },
    pool: overrides.pool || createMockPool(),
    log: { info() {}, warn() {}, error() {}, debug() {} },
    services,
    draining: false,
    snapshotGeneration: 1,
    startedAt: Date.now(),
    _signingKey: signingKey,
  };
}

function createMockReq({ method = 'GET', headers = {}, body = null } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.headers = headers;
  req.url = '/';
  req.destroy = () => {};

  // Simulate readable body
  if (body) {
    const json = JSON.stringify(body);
    process.nextTick(() => {
      req.emit('data', Buffer.from(json));
      req.emit('end');
    });
  } else {
    process.nextTick(() => req.emit('end'));
  }

  return req;
}

function createMockRes() {
  const res = {
    statusCode: null,
    headers: {},
    body: null,
    destroyed: false,
    writeHead(status, headers) {
      res.statusCode = status;
      Object.assign(res.headers, headers);
    },
    setHeader(key, value) {
      res.headers[key] = value;
    },
    write(data) {
      if (!res.body) res.body = '';
      res.body += data;
    },
    end(data) {
      if (data) {
        if (!res.body) res.body = '';
        res.body += data;
      }
    },
    on() {},
  };
  return res;
}

function parseJsonResponse(res) {
  return JSON.parse(res.body);
}

function addAdminAuth(req, appCtx) {
  const token = signAdminToken(Date.now() + 3_600_000, appCtx._signingKey);
  req.headers.authorization = `Bearer ${token}`;
  return token;
}

// ── Auth route tests ────────────────────────────────────────────────

describe('management/auth-route', () => {
  let handleLogin, handleLogout, handleSession;

  beforeEach(async () => {
    ({ handleLogin, handleLogout, handleSession } = await import('../../management/auth-route.mjs'));
  });

  it('handleLogin returns token for valid password', async () => {
    const appCtx = createMockAppCtx();
    const req = createMockReq({ method: 'POST', body: { password: 'testpass' } });
    const res = createMockRes();

    await handleLogin({ req, res, params: {}, query: {}, appCtx });

    assert.equal(res.statusCode, 200);
    const body = parseJsonResponse(res);
    assert.equal(body.ok, true);
    assert.ok(body.token);
    assert.ok(body.expiresAt);
    assert.ok(body.csrfToken);
  });

  it('handleLogin rejects wrong password', async () => {
    const appCtx = createMockAppCtx();
    const req = createMockReq({ method: 'POST', body: { password: 'wrong' } });
    const res = createMockRes();

    await assert.rejects(
      () => handleLogin({ req, res, params: {}, query: {}, appCtx }),
      (err) => err.httpStatus === 401,
    );
  });

  it('handleLogin rejects missing password field', async () => {
    const appCtx = createMockAppCtx();
    const req = createMockReq({ method: 'POST', body: {} });
    const res = createMockRes();

    await assert.rejects(
      () => handleLogin({ req, res, params: {}, query: {}, appCtx }),
      (err) => err.httpStatus === 400,
    );
  });

  it('handleSession returns authenticated: true for valid session', async () => {
    const appCtx = createMockAppCtx();
    const req = createMockReq();
    addAdminAuth(req, appCtx);
    const res = createMockRes();

    await handleSession({ req, res, params: {}, query: {}, appCtx });

    assert.equal(res.statusCode, 200);
    const body = parseJsonResponse(res);
    assert.equal(body.authenticated, true);
  });

  it('handleSession returns authenticated: false for missing session', async () => {
    const appCtx = createMockAppCtx();
    const req = createMockReq();
    const res = createMockRes();

    await handleSession({ req, res, params: {}, query: {}, appCtx });

    assert.equal(res.statusCode, 200);
    const body = parseJsonResponse(res);
    assert.equal(body.authenticated, false);
  });

  it('handleLogout clears the session cookie', async () => {
    const appCtx = createMockAppCtx();
    const req = createMockReq();
    addAdminAuth(req, appCtx);
    const res = createMockRes();

    await handleLogout({ req, res, params: {}, query: {}, appCtx });

    assert.equal(res.statusCode, 200);
    assert.ok(res.headers['Set-Cookie'].includes('Max-Age=0'));
  });
});

// ── Keys route tests ────────────────────────────────────────────────

describe('management/keys-route', () => {
  let handleListKeys, handleCreateKey, handleGetKey, handleUpdateKey, handleRevokeKey;

  beforeEach(async () => {
    ({ handleListKeys, handleCreateKey, handleGetKey, handleUpdateKey, handleRevokeKey } =
      await import('../../management/keys-route.mjs'));
  });

  it('handleListKeys returns key list', async () => {
    const mockRow = {
      id: 'k1', label: 'Test Key', status: 'active',
      key_hash: 'h', key_ciphertext: 'c', key_iv: 'i', key_auth_tag: 't',
      key_hint: 'sk-s...1234', rpm_limit: 60,
    };
    const pool = createMockPool(async () => ({ rows: [mockRow] }));
    const appCtx = createMockAppCtx({ pool });
    const res = createMockRes();

    await handleListKeys({ req: createMockReq(), res, params: {}, query: {}, appCtx });

    assert.equal(res.statusCode, 200);
    const body = parseJsonResponse(res);
    assert.equal(body.data.length, 1);
    // Sensitive fields should be stripped
    assert.equal(body.data[0].key_hash, undefined);
    assert.equal(body.data[0].key_ciphertext, undefined);
  });

  it('handleGetKey returns 404 for unknown key', async () => {
    const pool = createMockPool(async () => ({ rows: [] }));
    const appCtx = createMockAppCtx({ pool });
    const res = createMockRes();

    await handleGetKey({ req: createMockReq(), res, params: { keyId: 'unknown' }, query: {}, appCtx });

    assert.equal(res.statusCode, 404);
  });

  it('handleRevokeKey returns 404 for already revoked', async () => {
    const pool = createMockPool(async () => ({ rows: [] }));
    const appCtx = createMockAppCtx({ pool });
    const res = createMockRes();

    await handleRevokeKey({ req: createMockReq(), res, params: { keyId: 'k1' }, query: {}, appCtx });

    assert.equal(res.statusCode, 404);
  });
});

// ── Models route tests ──────────────────────────────────────────────

describe('management/models-route', () => {
  let handleListModels, handleCreateModel, handleGetModel, handleUpdateModel, handleDeleteModel;

  beforeEach(async () => {
    ({ handleListModels, handleCreateModel, handleGetModel, handleUpdateModel, handleDeleteModel } =
      await import('../../management/models-route.mjs'));
  });

  it('handleListModels returns model list', async () => {
    const mockRow = { id: 'm1', model_key: 'gpt-4o', display_name: 'GPT-4o', enabled: true };
    const pool = createMockPool(async () => ({ rows: [mockRow] }));
    const appCtx = createMockAppCtx({ pool });
    const res = createMockRes();

    await handleListModels({ req: createMockReq(), res, params: {}, query: {}, appCtx });

    assert.equal(res.statusCode, 200);
    const body = parseJsonResponse(res);
    assert.equal(body.data.length, 1);
    assert.equal(body.data[0].model_key, 'gpt-4o');
  });

  it('handleCreateModel rejects missing required fields', async () => {
    const appCtx = createMockAppCtx();
    const req = createMockReq({ method: 'POST', body: { modelKey: 'test' } });
    const res = createMockRes();

    await assert.rejects(
      () => handleCreateModel({ req, res, params: {}, query: {}, appCtx }),
      (err) => err.httpStatus === 400,
    );
  });

  it('handleGetModel returns 404 for missing model', async () => {
    const pool = createMockPool(async () => ({ rows: [] }));
    const appCtx = createMockAppCtx({ pool });
    const res = createMockRes();

    await handleGetModel({ req: createMockReq(), res, params: { modelId: 'x' }, query: {}, appCtx });

    assert.equal(res.statusCode, 404);
  });

  it('handleUpdateModel rejects empty body', async () => {
    const appCtx = createMockAppCtx();
    const req = createMockReq({ method: 'PATCH', body: {} });
    const res = createMockRes();

    await assert.rejects(
      () => handleUpdateModel({ req, res, params: { modelId: 'm1' }, query: {}, appCtx }),
      (err) => err.httpStatus === 400,
    );
  });

  it('handleDeleteModel returns 404 for missing model', async () => {
    const pool = createMockPool(async () => ({ rows: [], rowCount: 0 }));
    const appCtx = createMockAppCtx({ pool });
    const res = createMockRes();

    await handleDeleteModel({ req: createMockReq(), res, params: { modelId: 'x' }, query: {}, appCtx });

    assert.equal(res.statusCode, 404);
  });
});

// ── Providers route tests ───────────────────────────────────────────

describe('management/providers-route', () => {
  let handleListProviders;
  let handleCreateProvider;
  let handleGetProvider;
  let handleUpdateProvider;
  let handleDeleteProvider;
  let handleAuthCallback;
  let handleListAccounts;
  let handleTestConnection;

  beforeEach(async () => {
    ({ handleListProviders, handleCreateProvider, handleGetProvider, handleUpdateProvider, handleDeleteProvider, handleAuthCallback, handleListAccounts, handleTestConnection } =
      await import('../../management/providers-route.mjs'));
  });

  it('handleListProviders returns provider list', async () => {
    const mockRow = { id: 'p1', provider_key: 'openai', display_name: 'OpenAI' };
    const pool = createMockPool(async () => ({ rows: [mockRow] }));
    const appCtx = createMockAppCtx({ pool });
    const res = createMockRes();

    await handleListProviders({ req: createMockReq(), res, params: {}, query: {}, appCtx });

    assert.equal(res.statusCode, 200);
    const body = parseJsonResponse(res);
    assert.equal(body.data.length, 1);
  });

  it('handleCreateProvider rejects missing fields', async () => {
    const appCtx = createMockAppCtx();
    const req = createMockReq({ method: 'POST', body: { providerKey: 'test' } });
    const res = createMockRes();

    await assert.rejects(
      () => handleCreateProvider({ req, res, params: {}, query: {}, appCtx }),
      (err) => err.httpStatus === 400,
    );
  });

  it('handleCreateProvider derives kind from provider_mode and infers oauth strategy from managed auth type', async () => {
    const pool = createMockPool(async (_sql, params) => ({
      rows: [{
        id: 'p1',
        provider_key: params[0],
        display_name: params[1],
        kind: params[2],
        adapter_key: params[3],
        auth_strategy: params[4],
        provider_mode: params[5],
        executor_key: params[6],
        oauth_adapter_key: params[7],
        base_url: params[8],
      }],
    }));
    const appCtx = createMockAppCtx({ pool });
    const req = createMockReq({
      method: 'POST',
      body: {
        name: 'gemini-oauth',
        display_name: 'Google Gemini (OAuth)',
        kind: 'wrapper',
        adapter_key: 'gemini-openai',
        auth_type: 'managed',
        provider_mode: 'custom',
        executor_key: 'browser-executor',
        oauth_adapter_key: 'google-gemini',
        base_url: 'https://generativelanguage.googleapis.com/v1beta/openai',
      },
    });
    const res = createMockRes();

    await handleCreateProvider({ req, res, params: {}, query: {}, appCtx });

    assert.equal(res.statusCode, 201);
    const body = parseJsonResponse(res);
    assert.equal(body.provider.provider_key, 'gemini-oauth');
    assert.equal(body.provider.kind, 'custom');
    assert.equal(body.provider.adapter_key, 'gemini-openai');
    assert.equal(body.provider.auth_strategy, 'oauth');
    assert.equal(body.provider.provider_mode, 'custom');
    assert.equal(body.provider.executor_key, 'browser-executor');
    assert.equal(body.provider.oauth_adapter_key, 'google-gemini');
  });

  it('handleUpdateProvider accepts an api_key only PATCH and creates a provider_accounts row', async () => {
    // Regression: an earlier version of the handler returned "Provider
    // not found" when the PATCH body carried only `api_key`. The
    // `allowed` field list excluded api_key, so the DAO was called with
    // an empty fields object, returned null, and the handler mapped
    // that null to a 404 — even though the provider clearly existed.
    // The fix loads the provider first (so 404 is honest), only calls
    // the DAO when there is something to update, and always runs the
    // api-key upsert separately.
    const providerRow = {
      id: 'p-nv',
      provider_key: 'nvidia',
      display_name: 'NVIDIA',
      kind: 'external_api',
      adapter_key: 'openai-api',
      auth_strategy: 'api_key',
      base_url: 'https://integrate.api.nvidia.com/v1',
      enabled: true,
      settings: {},
      metadata: {},
    };

    const calls = [];
    const pool = createMockPool(async (sql, params) => {
      calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });

      if (sql.includes('FROM soul_gateway.providers') && sql.includes('WHERE id')) {
        return { rows: [providerRow] };
      }
      if (sql.includes('FROM soul_gateway.provider_accounts') && sql.includes('provider_id = $1')) {
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO soul_gateway.provider_accounts')) {
        return {
          rows: [{
            id: 'acc-new',
            provider_id: 'p-nv',
            auth_type: 'api_key',
            status: 'active',
          }],
        };
      }
      // Defensive: any UPDATE on the providers table is a regression — the
      // handler must NOT touch the providers row when only api_key is sent.
      if (sql.includes('UPDATE soul_gateway.providers')) {
        throw new Error('Unexpected UPDATE on providers table for api_key-only PATCH');
      }
      return { rows: [], rowCount: 0 };
    });

    const appCtx = createMockAppCtx({
      pool,
      services: { encryptionKey: randomBytes(32) },
    });
    const req = createMockReq({
      method: 'PATCH',
      body: { api_key: 'sk-test-12345' },
    });
    const res = createMockRes();

    await handleUpdateProvider({
      req,
      res,
      params: { providerId: 'p-nv' },
      query: {},
      appCtx,
    });

    assert.equal(res.statusCode, 200, 'PATCH should succeed even when only api_key is sent');
    const body = parseJsonResponse(res);
    assert.equal(body.provider.id, 'p-nv');
    assert.equal(body.provider.provider_key, 'nvidia');

    const inserted = calls.find((c) => c.sql.includes('INSERT INTO soul_gateway.provider_accounts'));
    assert.ok(inserted, 'expected an INSERT into provider_accounts to back the api_key upsert');
  });

  it('handleUpdateProvider returns 404 when the provider id does not exist', async () => {
    // The honest 404: we now look up the provider before deciding
    // anything else, so a missing id surfaces a real not-found error
    // instead of the previous "fields object is empty" false negative.
    const pool = createMockPool(async (sql) => {
      if (sql.includes('FROM soul_gateway.providers') && sql.includes('WHERE id')) {
        return { rows: [] };
      }
      return { rows: [], rowCount: 0 };
    });
    const appCtx = createMockAppCtx({ pool });
    const req = createMockReq({
      method: 'PATCH',
      body: { display_name: 'Anything' },
    });
    const res = createMockRes();

    await handleUpdateProvider({
      req,
      res,
      params: { providerId: 'missing' },
      query: {},
      appCtx,
    });

    assert.equal(res.statusCode, 404);
  });

  it('handleUpdateProvider rejects an empty PATCH body with 400', async () => {
    const appCtx = createMockAppCtx();
    const req = createMockReq({ method: 'PATCH', body: {} });
    const res = createMockRes();

    await assert.rejects(
      () => handleUpdateProvider({ req, res, params: { providerId: 'p1' }, query: {}, appCtx }),
      (err) => err.httpStatus === 400,
    );
  });

  it('handleDeleteProvider returns 409 when models depend on it', async () => {
    let callCount = 0;
    const pool = createMockPool(async (sql) => {
      callCount++;
      // First call: listByProvider returns models
      if (sql.includes('provider_id')) {
        return { rows: [{ id: 'm1' }] };
      }
      return { rows: [], rowCount: 0 };
    });
    const appCtx = createMockAppCtx({ pool });
    const res = createMockRes();

    await handleDeleteProvider({ req: createMockReq(), res, params: { providerId: 'p1' }, query: {}, appCtx });

    assert.equal(res.statusCode, 409);
    const body = parseJsonResponse(res);
    assert.ok(body.error.message.includes('model'));
  });

  it('handleAuthCallback returns dashboard-compatible completion shape', async () => {
    const appCtx = createMockAppCtx({
      services: {
        oauthManager: {
          async handleCallback(providerId, query) {
            assert.equal(providerId, 'p1');
            assert.equal(query.code, 'code-1');
            assert.equal(query.state, 'state-1');
            return { accountId: 'acc-1', status: 'active' };
          },
        },
      },
    });
    const res = createMockRes();

    await handleAuthCallback({
      req: createMockReq(),
      res,
      params: { providerId: 'p1' },
      query: { code: 'code-1', state: 'state-1' },
      appCtx,
    });

    assert.equal(res.statusCode, 200);
    const body = parseJsonResponse(res);
    assert.equal(body.status, 'complete');
    assert.equal(body.account.accountId, 'acc-1');
  });

  it('handleListAccounts returns both data and accounts keys for dashboard compatibility', async () => {
    const pool = createMockPool(async () => ({
      rows: [{ id: 'a1', account_label: 'Test Account' }],
    }));
    const appCtx = createMockAppCtx({ pool });
    const res = createMockRes();

    await handleListAccounts({
      req: createMockReq(),
      res,
      params: { providerId: 'p1' },
      query: {},
      appCtx,
    });

    assert.equal(res.statusCode, 200);
    const body = parseJsonResponse(res);
    assert.equal(body.data.length, 1);
    assert.equal(body.accounts.length, 1);
  });

  describe('handleTestConnection', () => {
    function createProviderCatalogMock(testConnectionImpl) {
      return {
        testConnection: testConnectionImpl,
      };
    }

    function buildCtx({ providerRow, catalog }) {
      const pool = createMockPool(async () => ({ rows: [providerRow] }));
      const appCtx = createMockAppCtx({
        pool,
        services: { providerCatalog: catalog },
      });
      return {
        req: createMockReq({ method: 'POST' }),
        res: createMockRes(),
        params: { providerId: providerRow.id },
        query: {},
        appCtx,
      };
    }

    it('translates a successful plugin result to { ok:true, message }', async () => {
      const catalog = createProviderCatalogMock(async () => ({
        ok: true,
        detail: 'Codex OAuth credentials present',
      }));
      const ctx = buildCtx({
        providerRow: { id: 'p1', provider_key: 'codex', oauth_adapter_key: 'openai-codex' },
        catalog,
      });

      await handleTestConnection(ctx);

      assert.equal(ctx.res.statusCode, 200);
      const body = parseJsonResponse(ctx.res);
      assert.equal(body.ok, true);
      assert.equal(body.message, 'Codex OAuth credentials present');
      assert.equal(typeof body.latencyMs, 'number');
      assert.equal(body.detail, undefined);
      assert.equal(body.error, undefined);
    });

    it('translates a failed plugin result to { ok:false, error }', async () => {
      const catalog = createProviderCatalogMock(async () => ({
        ok: false,
        detail: 'HTTP 403',
      }));
      const ctx = buildCtx({
        providerRow: { id: 'p1', provider_key: 'codex' },
        catalog,
      });

      await handleTestConnection(ctx);

      const body = parseJsonResponse(ctx.res);
      assert.equal(body.ok, false);
      assert.equal(body.error, 'HTTP 403');
      assert.equal(body.message, undefined);
    });

    it('supplies a default error when the plugin returns no detail string', async () => {
      const catalog = createProviderCatalogMock(async () => ({ ok: false }));
      const ctx = buildCtx({ providerRow: { id: 'p1' }, catalog });

      await handleTestConnection(ctx);
      const body = parseJsonResponse(ctx.res);
      assert.equal(body.ok, false);
      assert.equal(body.error, 'Connection failed');
    });

    it('supplies a default message when the plugin returns ok without a detail string', async () => {
      const catalog = createProviderCatalogMock(async () => ({ ok: true }));
      const ctx = buildCtx({ providerRow: { id: 'p1' }, catalog });

      await handleTestConnection(ctx);
      const body = parseJsonResponse(ctx.res);
      assert.equal(body.ok, true);
      assert.equal(body.message, 'Connected');
    });

    it('flattens an object-shaped detail into a string', async () => {
      const catalog = createProviderCatalogMock(async () => ({
        ok: false,
        detail: { error: 'credentials missing' },
      }));
      const ctx = buildCtx({ providerRow: { id: 'p1' }, catalog });

      await handleTestConnection(ctx);
      const body = parseJsonResponse(ctx.res);
      assert.equal(body.ok, false);
      assert.equal(body.error, 'credentials missing');
    });

    it('returns { ok:false, error } when the plugin throws', async () => {
      const catalog = createProviderCatalogMock(async () => {
        throw new Error('plugin blew up');
      });
      const ctx = buildCtx({ providerRow: { id: 'p1' }, catalog });

      await handleTestConnection(ctx);
      const body = parseJsonResponse(ctx.res);
      assert.equal(body.ok, false);
      assert.equal(body.error, 'plugin blew up');
    });

    it('responds with a helpful error when the provider catalog is not installed', async () => {
      const pool = createMockPool(async () => ({ rows: [{ id: 'p1' }] }));
      const appCtx = createMockAppCtx({ pool }); // no providerCatalog in services
      const res = createMockRes();

      await handleTestConnection({
        req: createMockReq({ method: 'POST' }),
        res,
        params: { providerId: 'p1' },
        query: {},
        appCtx,
      });

      const body = parseJsonResponse(res);
      assert.equal(body.ok, false);
      assert.ok(body.error, 'error field should be populated');
      assert.equal(body.message, undefined);
    });
  });
});

// ── Tiers route tests ───────────────────────────────────────────────

describe('management/tiers-route', () => {
  let handleListTiers, handleCreateTier, handleGetTier;

  beforeEach(async () => {
    ({ handleListTiers, handleCreateTier, handleGetTier } =
      await import('../../management/tiers-route.mjs'));
  });

  it('handleCreateTier rejects missing required fields', async () => {
    const appCtx = createMockAppCtx();
    const req = createMockReq({ method: 'POST', body: {} });
    const res = createMockRes();

    await assert.rejects(
      () => handleCreateTier({ req, res, params: {}, query: {}, appCtx }),
      (err) => err.httpStatus === 400,
    );
  });

  it('handleGetTier returns 404 for missing tier', async () => {
    const pool = createMockPool(async () => ({ rows: [] }));
    const appCtx = createMockAppCtx({ pool });
    const res = createMockRes();

    await handleGetTier({ req: createMockReq(), res, params: { tierId: 'x' }, query: {}, appCtx });

    assert.equal(res.statusCode, 404);
  });
});

// ── Blacklist route tests ───────────────────────────────────────────

describe('management/blacklist-route', () => {
  let handleListRules, handleCreateRule, handleGetRule, handleDeleteRule;

  beforeEach(async () => {
    ({ handleListRules, handleCreateRule, handleGetRule, handleDeleteRule } =
      await import('../../management/blacklist-route.mjs'));
  });

  it('handleListRules returns rules list', async () => {
    const mockRow = { id: 'r1', rule_key: 'no-pii', match_type: 'regex', enabled: true };
    const pool = createMockPool(async () => ({ rows: [mockRow] }));
    const appCtx = createMockAppCtx({ pool });
    const res = createMockRes();

    await handleListRules({ req: createMockReq(), res, params: {}, query: {}, appCtx });

    assert.equal(res.statusCode, 200);
    const body = parseJsonResponse(res);
    assert.equal(body.data.length, 1);
  });

  it('handleCreateRule rejects missing fields', async () => {
    const appCtx = createMockAppCtx();
    const req = createMockReq({ method: 'POST', body: { ruleKey: 'test' } });
    const res = createMockRes();

    await assert.rejects(
      () => handleCreateRule({ req, res, params: {}, query: {}, appCtx }),
      (err) => err.httpStatus === 400,
    );
  });

  it('handleGetRule returns 404 for missing rule', async () => {
    const pool = createMockPool(async () => ({ rows: [] }));
    const appCtx = createMockAppCtx({ pool });
    const res = createMockRes();

    await handleGetRule({ req: createMockReq(), res, params: { ruleId: 'x' }, query: {}, appCtx });

    assert.equal(res.statusCode, 404);
  });

  it('handleDeleteRule returns 404 for missing rule', async () => {
    const pool = createMockPool(async () => ({ rows: [], rowCount: 0 }));
    const appCtx = createMockAppCtx({ pool });
    const res = createMockRes();

    await handleDeleteRule({ req: createMockReq(), res, params: { ruleId: 'x' }, query: {}, appCtx });

    assert.equal(res.statusCode, 404);
  });
});

// ── Cooldowns route tests ───────────────────────────────────────────

describe('management/cooldowns-route', () => {
  let handleListCooldowns, handleClearAll, handleClearModel;

  beforeEach(async () => {
    ({ handleListCooldowns, handleClearAll, handleClearModel } =
      await import('../../management/cooldowns-route.mjs'));
  });

  it('handleListCooldowns returns active cooldowns', async () => {
    const mockRow = { id: 'c1', model_id: 'm1', model_key: 'gpt-4o', expires_at: new Date().toISOString() };
    const pool = createMockPool(async () => ({ rows: [mockRow] }));
    const appCtx = createMockAppCtx({ pool });
    const res = createMockRes();

    await handleListCooldowns({ req: createMockReq(), res, params: {}, query: {}, appCtx });

    assert.equal(res.statusCode, 200);
    const body = parseJsonResponse(res);
    assert.equal(body.data.length, 1);
  });

  it('handleClearAll clears all cooldowns', async () => {
    const pool = createMockPool(async () => ({ rows: [], rowCount: 3 }));
    const appCtx = createMockAppCtx({ pool });
    const res = createMockRes();

    await handleClearAll({ req: createMockReq(), res, params: {}, query: {}, appCtx });

    assert.equal(res.statusCode, 200);
    const body = parseJsonResponse(res);
    assert.equal(body.cleared, 3);
  });

  it('handleClearModel clears cooldown for one model', async () => {
    const pool = createMockPool(async () => ({ rows: [], rowCount: 1 }));
    const appCtx = createMockAppCtx({ pool });
    const res = createMockRes();

    await handleClearModel({ req: createMockReq(), res, params: { modelId: 'm1' }, query: {}, appCtx });

    assert.equal(res.statusCode, 200);
    const body = parseJsonResponse(res);
    assert.equal(body.ok, true);
  });
});

// ── Logs route tests ────────────────────────────────────────────────

describe('management/logs-route', () => {
  let handleListLogs, handleGetLog;

  beforeEach(async () => {
    ({ handleListLogs, handleGetLog } = await import('../../management/logs-route.mjs'));
  });

  it('handleListLogs returns paginated logs', async () => {
    const mockRow = { log_id: 'l1', request_id: 'r1', status: 'succeeded' };
    let callIdx = 0;
    const pool = createMockPool(async (sql) => {
      callIdx++;
      if (sql.includes('COUNT')) return { rows: [{ total: 1 }] };
      return { rows: [mockRow] };
    });
    const appCtx = createMockAppCtx({ pool });
    const res = createMockRes();

    await handleListLogs({
      req: createMockReq(), res, params: {}, appCtx,
      query: { limit: '10', offset: '0' },
    });

    assert.equal(res.statusCode, 200);
    const body = parseJsonResponse(res);
    assert.equal(body.data.length, 1);
    assert.equal(body.total, 1);
  });

  it('handleGetLog returns 404 for missing log', async () => {
    const pool = createMockPool(async () => ({ rows: [] }));
    const appCtx = createMockAppCtx({ pool });
    const res = createMockRes();

    await handleGetLog({ req: createMockReq(), res, params: { logId: 'x' }, query: {}, appCtx });

    assert.equal(res.statusCode, 404);
  });
});

// ── Metrics route tests ─────────────────────────────────────────────

describe('management/metrics-route', () => {
  let handleCostMetrics, handleUsageMetrics, handleErrorMetrics;

  beforeEach(async () => {
    ({ handleCostMetrics, handleUsageMetrics, handleErrorMetrics } =
      await import('../../management/metrics-route.mjs'));
  });

  it('handleCostMetrics rejects missing date range', async () => {
    const appCtx = createMockAppCtx();
    const res = createMockRes();

    await assert.rejects(
      () => handleCostMetrics({ req: createMockReq(), res, params: {}, query: {}, appCtx }),
      (err) => err.httpStatus === 400,
    );
  });

  it('handleCostMetrics returns data for valid date range', async () => {
    const mockRow = { period: '2026-04-01', total_cost_usd: '1.50', request_count: 10 };
    const pool = createMockPool(async () => ({ rows: [mockRow] }));
    const appCtx = createMockAppCtx({ pool });
    const res = createMockRes();

    await handleCostMetrics({
      req: createMockReq(), res, params: {}, appCtx,
      query: { from: '2026-04-01', to: '2026-04-02' },
    });

    assert.equal(res.statusCode, 200);
    const body = parseJsonResponse(res);
    assert.equal(body.data.length, 1);
  });
});

// ── Sessions route tests ────────────────────────────────────────────

describe('management/sessions-route', () => {
  let handleListSessions, handleGetSession, handleGetSessionLogs;

  beforeEach(async () => {
    ({ handleListSessions, handleGetSession, handleGetSessionLogs } = await import('../../management/sessions-route.mjs'));
  });

  it('handleListSessions returns session list', async () => {
    const mockRow = { id: 's1', agent_name: 'coral-agent', status: 'open' };
    const pool = createMockPool(async () => ({ rows: [mockRow] }));
    const appCtx = createMockAppCtx({ pool });
    const res = createMockRes();

    await handleListSessions({ req: createMockReq(), res, params: {}, query: {}, appCtx });

    assert.equal(res.statusCode, 200);
    const body = parseJsonResponse(res);
    assert.equal(body.data.length, 1);
  });

  it('handleGetSession returns 404 for missing session', async () => {
    const pool = createMockPool(async () => ({ rows: [] }));
    const appCtx = createMockAppCtx({ pool });
    const res = createMockRes();

    await handleGetSession({ req: createMockReq(), res, params: { sessionId: 'x' }, query: {}, appCtx });

    assert.equal(res.statusCode, 404);
  });

  it('handleGetSessionLogs returns recent logs for an existing session', async () => {
    const responses = [
      { rows: [{ id: 's1', agent_name: 'coral-agent' }] },
      { rows: [{ request_id: 'req-1', session_id: 's1' }] },
    ];
    const pool = createMockPool(async () => responses.shift() || { rows: [] });
    const appCtx = createMockAppCtx({ pool });
    const res = createMockRes();

    await handleGetSessionLogs({
      req: createMockReq(),
      res,
      params: { sessionId: 's1' },
      query: { limit: '25' },
      appCtx,
    });

    assert.equal(res.statusCode, 200);
    const body = parseJsonResponse(res);
    assert.equal(body.sessionId, 's1');
    assert.equal(body.data.length, 1);
  });
});

// ── Middlewares route tests ─────────────────────────────────────────

describe('management/middlewares-route', () => {
  let handleListMiddlewares, handleCreateAssignment, handleUpdateAssignment, handleDeleteAssignment, handleRescan;

  beforeEach(async () => {
    ({ handleListMiddlewares, handleCreateAssignment, handleUpdateAssignment, handleDeleteAssignment, handleRescan } =
      await import('../../management/middlewares-route.mjs'));
  });

  it('handleListMiddlewares returns catalog', async () => {
    const mockRow = { id: 'mw1', middleware_key: 'rate-limiter', display_name: 'Rate Limiter' };
    const pool = createMockPool(async () => ({ rows: [mockRow] }));
    const appCtx = createMockAppCtx({ pool });
    const res = createMockRes();

    await handleListMiddlewares({ req: createMockReq(), res, params: {}, query: {}, appCtx });

    assert.equal(res.statusCode, 200);
    const body = parseJsonResponse(res);
    assert.equal(body.catalog.length, 1);
  });

  it('handleCreateAssignment rejects missing fields', async () => {
    const appCtx = createMockAppCtx();
    const req = createMockReq({ method: 'POST', body: {} });
    const res = createMockRes();

    await assert.rejects(
      () => handleCreateAssignment({ req, res, params: {}, query: {}, appCtx }),
      (err) => err.httpStatus === 400,
    );
  });

  it('handleCreateAssignment rejects tier assignment without tierId', async () => {
    const appCtx = createMockAppCtx();
    const req = createMockReq({ method: 'POST', body: { middlewareId: 'mw1', targetType: 'tier' } });
    const res = createMockRes();

    await assert.rejects(
      () => handleCreateAssignment({ req, res, params: {}, query: {}, appCtx }),
      (err) => err.httpStatus === 400 && err.message.includes('tierId'),
    );
  });

  it('handleDeleteAssignment returns 404 for missing assignment', async () => {
    const pool = createMockPool(async () => ({ rows: [], rowCount: 0 }));
    const appCtx = createMockAppCtx({ pool });
    const res = createMockRes();

    await handleDeleteAssignment({ req: createMockReq(), res, params: { assignmentId: 'x' }, query: {}, appCtx });

    assert.equal(res.statusCode, 404);
  });

  it('handleCreateAssignment triggers runtime snapshot reload', async () => {
    const pool = createMockPool(async () => ({
      rows: [{ id: 'a1', middleware_id: 'mw1', target_type: 'tier', tier_id: 't1' }],
      rowCount: 1,
    }));
    let reloads = 0;
    const appCtx = createMockAppCtx({
      pool,
      services: {
        reloadRuntimeSnapshot: async () => {
          reloads += 1;
          return { generation: 2 };
        },
      },
    });
    const req = createMockReq({
      method: 'POST',
      body: { middlewareId: 'mw1', targetType: 'tier', tierId: 't1' },
    });
    const res = createMockRes();

    await handleCreateAssignment({ req, res, params: {}, query: {}, appCtx });

    assert.equal(res.statusCode, 201);
    assert.equal(reloads, 1);
  });

  it('handleRescan reloads the middleware catalog and runtime snapshot', async () => {
    let snapshotReloads = 0;
    const appCtx = createMockAppCtx({
      services: {
        reloadMiddlewareCatalog: async () => ({ generation: 3, count: 8 }),
        reloadRuntimeSnapshot: async () => {
          snapshotReloads += 1;
          return { generation: 4 };
        },
      },
    });
    const res = createMockRes();

    await handleRescan({ req: createMockReq({ method: 'POST' }), res, params: {}, query: {}, appCtx });

    assert.equal(res.statusCode, 200);
    assert.equal(snapshotReloads, 1);
    const body = parseJsonResponse(res);
    assert.equal(body.middlewareGeneration, 3);
    assert.equal(body.snapshotGeneration, 4);
  });
});

// ── Router integration tests ────────────────────────────────────────

describe('management/router', () => {
  let buildManagementRouter;

  beforeEach(async () => {
    ({ buildManagementRouter } = await import('../../management/router.mjs'));
  });

  it('builds http and ws routers', () => {
    const appCtx = createMockAppCtx();
    const { httpRouter, wsRouter } = buildManagementRouter(appCtx);

    assert.ok(httpRouter);
    assert.ok(wsRouter);
    assert.ok(typeof httpRouter.match === 'function');
    assert.ok(typeof wsRouter.match === 'function');
  });

  it('matches auth login route without admin guard', () => {
    const appCtx = createMockAppCtx();
    const { httpRouter } = buildManagementRouter(appCtx);
    const match = httpRouter.match('POST', '/management/auth/login');
    assert.ok(match);
    assert.ok(typeof match.handler === 'function');
  });

  it('matches key management routes', () => {
    const appCtx = createMockAppCtx();
    const { httpRouter } = buildManagementRouter(appCtx);

    assert.ok(httpRouter.match('GET', '/management/keys'));
    assert.ok(httpRouter.match('POST', '/management/keys'));
    assert.ok(httpRouter.match('GET', '/management/keys/some-id'));
    assert.ok(httpRouter.match('PATCH', '/management/keys/some-id'));
    assert.ok(httpRouter.match('POST', '/management/keys/some-id/revoke'));
    assert.ok(httpRouter.match('GET', '/management/keys/some-id/spend'));
  });

  it('matches model management routes', () => {
    const appCtx = createMockAppCtx();
    const { httpRouter } = buildManagementRouter(appCtx);

    assert.ok(httpRouter.match('GET', '/management/models'));
    assert.ok(httpRouter.match('POST', '/management/models'));
    assert.ok(httpRouter.match('GET', '/management/models/m1'));
    assert.ok(httpRouter.match('PATCH', '/management/models/m1'));
    assert.ok(httpRouter.match('DELETE', '/management/models/m1'));
    assert.ok(httpRouter.match('POST', '/management/models/m1/enable'));
    assert.ok(httpRouter.match('POST', '/management/models/m1/disable'));
  });

  it('matches provider management routes', () => {
    const appCtx = createMockAppCtx();
    const { httpRouter } = buildManagementRouter(appCtx);

    assert.ok(httpRouter.match('GET', '/management/providers/templates'));
    assert.ok(httpRouter.match('GET', '/management/providers'));
    assert.ok(httpRouter.match('POST', '/management/providers'));
    assert.ok(httpRouter.match('GET', '/management/providers/p1'));
    assert.ok(httpRouter.match('PATCH', '/management/providers/p1'));
    assert.ok(httpRouter.match('DELETE', '/management/providers/p1'));
    assert.ok(httpRouter.match('POST', '/management/providers/p1/test'));
    assert.ok(httpRouter.match('POST', '/management/providers/p1/discover-models'));
    assert.ok(httpRouter.match('POST', '/management/providers/p1/sync-models'));
    assert.ok(httpRouter.match('POST', '/management/providers/p1/auth/start'));
    assert.ok(httpRouter.match('GET', '/management/providers/p1/auth/callback'));
    assert.ok(httpRouter.match('GET', '/management/providers/p1/auth/pending/flow1'));
    assert.ok(httpRouter.match('GET', '/management/providers/p1/accounts'));
    assert.ok(httpRouter.match('DELETE', '/management/providers/p1/accounts/a1'));
    assert.ok(httpRouter.match('POST', '/management/providers/p1/accounts/a1/reset-quota'));
    assert.ok(httpRouter.match('POST', '/management/providers/rescan'));
  });

  it('matches tier management routes', () => {
    const appCtx = createMockAppCtx();
    const { httpRouter } = buildManagementRouter(appCtx);

    assert.ok(httpRouter.match('GET', '/management/tiers'));
    assert.ok(httpRouter.match('POST', '/management/tiers'));
    assert.ok(httpRouter.match('GET', '/management/tiers/t1'));
    assert.ok(httpRouter.match('PATCH', '/management/tiers/t1'));
    assert.ok(httpRouter.match('DELETE', '/management/tiers/t1'));
    assert.ok(httpRouter.match('POST', '/management/tiers/t1/enable'));
    assert.ok(httpRouter.match('POST', '/management/tiers/t1/disable'));
  });

  it('matches middleware routes', () => {
    const appCtx = createMockAppCtx();
    const { httpRouter } = buildManagementRouter(appCtx);

    assert.ok(httpRouter.match('GET', '/management/middlewares'));
    assert.ok(httpRouter.match('POST', '/management/middlewares/rescan'));
    assert.ok(httpRouter.match('GET', '/management/middlewares/mw1'));
    assert.ok(httpRouter.match('PATCH', '/management/middlewares/mw1'));
    assert.ok(httpRouter.match('POST', '/management/middlewares/assignments'));
    assert.ok(httpRouter.match('PATCH', '/management/middlewares/assignments/a1'));
    assert.ok(httpRouter.match('DELETE', '/management/middlewares/assignments/a1'));
  });

  it('matches tier-scoped middleware routes', () => {
    const appCtx = createMockAppCtx();
    const { httpRouter } = buildManagementRouter(appCtx);

    assert.ok(httpRouter.match('GET', '/management/tiers/t1/middlewares'));
    assert.ok(httpRouter.match('POST', '/management/tiers/t1/middlewares'));
    assert.ok(httpRouter.match('POST', '/management/tiers/t1/middlewares/reorder'));
    assert.ok(httpRouter.match('PATCH', '/management/tiers/t1/middlewares/a1'));
    assert.ok(httpRouter.match('DELETE', '/management/tiers/t1/middlewares/a1'));
  });

  it('matches model-scoped middleware routes', () => {
    const appCtx = createMockAppCtx();
    const { httpRouter } = buildManagementRouter(appCtx);

    assert.ok(httpRouter.match('GET', '/management/models/m1/middlewares'));
    assert.ok(httpRouter.match('POST', '/management/models/m1/middlewares'));
    assert.ok(httpRouter.match('POST', '/management/models/m1/middlewares/reorder'));
    assert.ok(httpRouter.match('PATCH', '/management/models/m1/middlewares/a1'));
    assert.ok(httpRouter.match('DELETE', '/management/models/m1/middlewares/a1'));
  });

  it('matches blacklist routes', () => {
    const appCtx = createMockAppCtx();
    const { httpRouter } = buildManagementRouter(appCtx);

    assert.ok(httpRouter.match('GET', '/management/blacklist/rules'));
    assert.ok(httpRouter.match('POST', '/management/blacklist/rules'));
    assert.ok(httpRouter.match('GET', '/management/blacklist/rules/r1'));
    assert.ok(httpRouter.match('PATCH', '/management/blacklist/rules/r1'));
    assert.ok(httpRouter.match('DELETE', '/management/blacklist/rules/r1'));
    assert.ok(httpRouter.match('POST', '/management/blacklist/rules/r1/enable'));
    assert.ok(httpRouter.match('POST', '/management/blacklist/rules/r1/disable'));
  });

  it('matches cooldown routes', () => {
    const appCtx = createMockAppCtx();
    const { httpRouter } = buildManagementRouter(appCtx);

    assert.ok(httpRouter.match('GET', '/management/cooldowns'));
    assert.ok(httpRouter.match('DELETE', '/management/cooldowns'));
    assert.ok(httpRouter.match('DELETE', '/management/cooldowns/m1'));
  });

  it('matches log routes', () => {
    const appCtx = createMockAppCtx();
    const { httpRouter } = buildManagementRouter(appCtx);

    assert.ok(httpRouter.match('GET', '/management/logs'));
    assert.ok(httpRouter.match('GET', '/management/logs/some-request-id'));
  });

  it('matches metrics routes', () => {
    const appCtx = createMockAppCtx();
    const { httpRouter } = buildManagementRouter(appCtx);

    assert.ok(httpRouter.match('GET', '/management/metrics/cost'));
    assert.ok(httpRouter.match('GET', '/management/metrics/usage'));
    assert.ok(httpRouter.match('GET', '/management/metrics/errors'));
    assert.ok(httpRouter.match('GET', '/management/metrics/activity'));
    assert.ok(httpRouter.match('GET', '/management/metrics/tokens'));
  });

  it('matches export routes', () => {
    const appCtx = createMockAppCtx();
    const { httpRouter } = buildManagementRouter(appCtx);

    assert.ok(httpRouter.match('GET', '/management/export/logs.csv'));
    assert.ok(httpRouter.match('GET', '/management/export/logs.json'));
    assert.ok(httpRouter.match('GET', '/management/export/logs'));
  });

  it('matches session and agent routes', () => {
    const appCtx = createMockAppCtx();
    const { httpRouter } = buildManagementRouter(appCtx);

    assert.ok(httpRouter.match('GET', '/management/sessions'));
    assert.ok(httpRouter.match('GET', '/management/sessions/s1'));
    assert.ok(httpRouter.match('GET', '/management/sessions/s1/logs'));
    assert.ok(httpRouter.match('GET', '/management/agents/tree'));
  });

  it('matches SSE streaming routes', () => {
    const appCtx = createMockAppCtx();
    const { httpRouter } = buildManagementRouter(appCtx);

    assert.ok(httpRouter.match('GET', '/management/logs/stream/sse'));
    assert.ok(httpRouter.match('GET', '/management/logs/stream/soul/soul-123'));
  });

  it('matches WebSocket streaming routes', () => {
    const appCtx = createMockAppCtx();
    const { wsRouter } = buildManagementRouter(appCtx);

    assert.ok(wsRouter.match('GET', '/ws/logs'));
    assert.ok(wsRouter.match('GET', '/ws/logs/soul/soul-123'));
  });

  it('route params are populated correctly', () => {
    const appCtx = createMockAppCtx();
    const { httpRouter } = buildManagementRouter(appCtx);

    const match = httpRouter.match('GET', '/management/keys/abc-123');
    assert.ok(match);
    assert.equal(match.params.keyId, 'abc-123');

    const match2 = httpRouter.match('GET', '/management/providers/p1/accounts');
    assert.ok(match2);
    assert.equal(match2.params.providerId, 'p1');

    const match3 = httpRouter.match('DELETE', '/management/providers/p1/accounts/a2');
    assert.ok(match3);
    assert.equal(match3.params.providerId, 'p1');
    assert.equal(match3.params.accountId, 'a2');
  });

  it('returns null for unregistered paths', () => {
    const appCtx = createMockAppCtx();
    const { httpRouter } = buildManagementRouter(appCtx);

    assert.equal(httpRouter.match('GET', '/management/nonexistent'), null);
    assert.equal(httpRouter.match('PUT', '/management/keys'), null);
  });
});
