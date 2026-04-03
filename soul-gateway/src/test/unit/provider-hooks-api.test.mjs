import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import { ProviderHookCatalog } from '../../runtime/hooks/provider-hook-catalog.mjs';
import { HOOK_PHASES } from '../../runtime/hooks/hook-constants.mjs';
import {
  handleListProviderHooks,
  handleListProviderHookAssignments,
  handleCreateProviderHookAssignment,
  handleUpdateProviderHookAssignment,
  handleDeleteProviderHookAssignment,
} from '../../management/provider-hooks-route.mjs';

// ── Test helpers ────────────────────────────────────────────────────

function makeHookModule(key, phases, defaultSettings = {}) {
  return {
    meta: { key, name: `${key} hook`, scope: 'provider', phases, defaultSettings },
    onRequest: phases.includes('request') ? async () => {} : undefined,
    wrapStream: phases.includes('stream') ? (s) => s : undefined,
    onResponse: phases.includes('response') ? async () => {} : undefined,
  };
}

function makeCatalog(hooks = []) {
  const catalog = new ProviderHookCatalog();
  for (const h of hooks) {
    catalog.registerHook(h.meta.key, h);
  }
  return catalog;
}

function makeAppCtx(catalog, overrides = {}) {
  const refreshCalls = [];
  return {
    pool: overrides.pool ?? null,
    config: { env: {} },
    log: { debug() {}, info() {}, warn() {}, error() {} },
    services: {
      providerHookCatalog: catalog,
      refreshRuntimeAsync: async (opts) => { refreshCalls.push(opts); return null; },
      ...overrides.services,
    },
    _refreshCalls: refreshCalls,
  };
}

function makeRes() {
  const res = {
    _status: null,
    _body: null,
    _headers: {},
    writeHead(status, headers = {}) {
      res._status = status;
      Object.assign(res._headers, headers);
    },
    end(body) {
      res._body = typeof body === 'string' ? JSON.parse(body) : body;
    },
  };
  return res;
}

function makeReq(body = null) {
  const chunks = body ? [Buffer.from(JSON.stringify(body))] : [];
  return {
    headers: { 'content-type': 'application/json' },
    on(event, cb) {
      if (event === 'data') {
        for (const c of chunks) cb(c);
      }
      if (event === 'end') {
        cb();
      }
      return this;
    },
  };
}

// ── Route registration tests ───────────────────────────────────────

describe('provider-hooks route registration', () => {

  it('all 5 provider-hook routes are registered in the management router', async () => {
    // Import the router builder
    const { buildManagementRouter } = await import('../../management/router.mjs');

    // Provide a minimal appCtx so the builder doesn't crash
    const appCtx = {
      config: { env: {} },
      services: {},
      log: { debug() {}, info() {}, warn() {}, error() {} },
    };

    const { httpRouter } = buildManagementRouter(appCtx);

    // Verify each route resolves to a handler
    const routes = [
      ['GET',    '/management/provider-hooks'],
      ['GET',    '/management/providers/p1/hooks'],
      ['POST',   '/management/providers/p1/hooks'],
      ['PATCH',  '/management/providers/p1/hooks/a1'],
      ['DELETE', '/management/providers/p1/hooks/a1'],
    ];

    for (const [method, path] of routes) {
      const match = httpRouter.match(method, path);
      assert.ok(match, `Expected route ${method} ${path} to be registered`);
      assert.equal(typeof match.handler, 'function', `Handler for ${method} ${path} must be a function`);
    }
  });

  it('parameterized routes extract providerId and assignmentId', async () => {
    const { buildManagementRouter } = await import('../../management/router.mjs');

    const appCtx = {
      config: { env: {} },
      services: {},
      log: { debug() {}, info() {}, warn() {}, error() {} },
    };

    const { httpRouter } = buildManagementRouter(appCtx);

    const patchMatch = httpRouter.match('PATCH', '/management/providers/prov-42/hooks/assign-7');
    assert.equal(patchMatch.params.providerId, 'prov-42');
    assert.equal(patchMatch.params.assignmentId, 'assign-7');

    const getMatch = httpRouter.match('GET', '/management/providers/prov-99/hooks');
    assert.equal(getMatch.params.providerId, 'prov-99');
  });
});

// ── handleListProviderHooks tests ──────────────────────────────────

describe('handleListProviderHooks', () => {

  it('returns catalog contents', async () => {
    const hooks = [
      makeHookModule('query-planner', ['request'], { maxResults: 10 }),
      makeHookModule('citation-extractor', ['response']),
    ];
    const catalog = makeCatalog(hooks);
    const appCtx = makeAppCtx(catalog);
    const res = makeRes();

    await handleListProviderHooks({ res, appCtx });

    assert.equal(res._status, 200);
    assert.equal(res._body.data.length, 2);

    const qp = res._body.data.find((h) => h.key === 'query-planner');
    assert.ok(qp);
    assert.equal(qp.name, 'query-planner hook');
    assert.equal(qp.scope, 'provider');
    assert.deepEqual(qp.phases, ['request']);
    assert.deepEqual(qp.defaultSettings, { maxResults: 10 });

    const ce = res._body.data.find((h) => h.key === 'citation-extractor');
    assert.ok(ce);
    assert.deepEqual(ce.phases, ['response']);
    assert.deepEqual(ce.defaultSettings, {});
  });

  it('returns empty array when no hooks registered', async () => {
    const catalog = makeCatalog([]);
    const appCtx = makeAppCtx(catalog);
    const res = makeRes();

    await handleListProviderHooks({ res, appCtx });

    assert.equal(res._status, 200);
    assert.deepEqual(res._body.data, []);
  });
});

// ── handleListProviderHookAssignments tests ────────────────────────

describe('handleListProviderHookAssignments', () => {

  it('returns assignments grouped by phase', async () => {
    const mockPool = {
      query: async () => ({
        rows: [
          { id: 'a1', provider_id: 'p1', hook_key: 'h1', phase: 'request', sort_order: 1, enabled: true, settings: {} },
          { id: 'a2', provider_id: 'p1', hook_key: 'h2', phase: 'response', sort_order: 1, enabled: true, settings: {} },
          { id: 'a3', provider_id: 'p1', hook_key: 'h3', phase: 'request', sort_order: 2, enabled: true, settings: {} },
        ],
      }),
    };
    const catalog = makeCatalog([]);
    const appCtx = makeAppCtx(catalog, { pool: mockPool });
    const res = makeRes();

    await handleListProviderHookAssignments({
      res, params: { providerId: 'p1' }, appCtx,
    });

    assert.equal(res._status, 200);
    assert.equal(res._body.data.request.length, 2);
    assert.equal(res._body.data.response.length, 1);
    assert.equal(res._body.data.stream.length, 0);
  });

  it('returns empty groups when provider has no assignments', async () => {
    const mockPool = { query: async () => ({ rows: [] }) };
    const catalog = makeCatalog([]);
    const appCtx = makeAppCtx(catalog, { pool: mockPool });
    const res = makeRes();

    await handleListProviderHookAssignments({
      res, params: { providerId: 'empty-provider' }, appCtx,
    });

    assert.equal(res._status, 200);
    assert.deepEqual(res._body.data, { request: [], stream: [], response: [] });
  });
});

// ── handleCreateProviderHookAssignment tests ───────────────────────

describe('handleCreateProviderHookAssignment', () => {

  it('creates assignment with valid hookKey and phase', async () => {
    const hook = makeHookModule('my-hook', ['request']);
    const catalog = makeCatalog([hook]);
    const createdRow = {
      id: 'new-1', provider_id: 'p1', hook_key: 'my-hook',
      phase: 'request', sort_order: 100, enabled: true, settings: {},
    };
    const mockPool = {
      query: async () => ({ rows: [createdRow] }),
    };
    const appCtx = makeAppCtx(catalog, { pool: mockPool });
    const res = makeRes();
    const req = makeReq({ hookKey: 'my-hook', phase: 'request' });

    await handleCreateProviderHookAssignment({
      req, res, params: { providerId: 'p1' }, appCtx,
    });

    assert.equal(res._status, 201);
    assert.equal(res._body.assignment.id, 'new-1');
    assert.equal(res._body.assignment.hook_key, 'my-hook');
  });

  it('rejects invalid hookKey', async () => {
    const catalog = makeCatalog([]);
    const appCtx = makeAppCtx(catalog);
    const res = makeRes();
    const req = makeReq({ hookKey: 'nonexistent-hook', phase: 'request' });

    await assert.rejects(
      () => handleCreateProviderHookAssignment({
        req, res, params: { providerId: 'p1' }, appCtx,
      }),
      (err) => {
        assert.match(err.message, /Unknown hook key/);
        return true;
      },
    );
  });

  it('rejects invalid phase', async () => {
    const hook = makeHookModule('valid-hook', ['request']);
    const catalog = makeCatalog([hook]);
    const appCtx = makeAppCtx(catalog);
    const res = makeRes();
    const req = makeReq({ hookKey: 'valid-hook', phase: 'invalid' });

    await assert.rejects(
      () => handleCreateProviderHookAssignment({
        req, res, params: { providerId: 'p1' }, appCtx,
      }),
      (err) => {
        assert.match(err.message, /Invalid phase/);
        return true;
      },
    );
  });

  it('rejects missing required fields', async () => {
    const catalog = makeCatalog([]);
    const appCtx = makeAppCtx(catalog);
    const res = makeRes();
    const req = makeReq({ hookKey: 'some-hook' }); // missing phase

    await assert.rejects(
      () => handleCreateProviderHookAssignment({
        req, res, params: { providerId: 'p1' }, appCtx,
      }),
      (err) => {
        assert.match(err.message, /Missing required fields/);
        return true;
      },
    );
  });

  it('passes optional fields to DAO', async () => {
    const hook = makeHookModule('opt-hook', ['stream']);
    const catalog = makeCatalog([hook]);
    const capturedArgs = [];
    const mockPool = {
      query: async (sql, params) => {
        capturedArgs.push(params);
        return {
          rows: [{
            id: 'new-2', provider_id: 'p1', hook_key: 'opt-hook',
            phase: 'stream', sort_order: 5, enabled: false, settings: { key: 'val' },
          }],
        };
      },
    };
    const appCtx = makeAppCtx(catalog, { pool: mockPool });
    const res = makeRes();
    const req = makeReq({
      hookKey: 'opt-hook', phase: 'stream',
      sortOrder: 5, enabled: false, settings: { key: 'val' },
    });

    await handleCreateProviderHookAssignment({
      req, res, params: { providerId: 'p1' }, appCtx,
    });

    assert.equal(res._status, 201);
    // Verify the DAO received the correct parameters
    assert.ok(capturedArgs.length > 0);
    const [providerId, hookKey, phase, sortOrder, enabled, settings] = capturedArgs[0];
    assert.equal(providerId, 'p1');
    assert.equal(hookKey, 'opt-hook');
    assert.equal(phase, 'stream');
    assert.equal(sortOrder, 5);
    assert.equal(enabled, false);
    assert.equal(settings, JSON.stringify({ key: 'val' }));
  });

  it('triggers snapshot refresh after create', async () => {
    const hook = makeHookModule('refresh-hook', ['request']);
    const catalog = makeCatalog([hook]);
    const mockPool = {
      query: async () => ({ rows: [{ id: 'r1' }] }),
    };
    const refreshCalls = [];
    const appCtx = makeAppCtx(catalog, { pool: mockPool });
    appCtx.services.refreshRuntimeAsync = async (opts) => { refreshCalls.push(opts); };
    const res = makeRes();
    const req = makeReq({ hookKey: 'refresh-hook', phase: 'request' });

    await handleCreateProviderHookAssignment({
      req, res, params: { providerId: 'p1' }, appCtx,
    });

    assert.equal(refreshCalls.length, 1);
    assert.equal(refreshCalls[0].snapshot, true);
    assert.equal(refreshCalls[0].providerCatalog, true);
    assert.match(refreshCalls[0].reason, /create/);
  });

  it('waits for runtime refresh before sending the response', async () => {
    const hook = makeHookModule('blocking-refresh-hook', ['request']);
    const catalog = makeCatalog([hook]);
    const mockPool = {
      query: async () => ({ rows: [{ id: 'blocking-1', hook_key: 'blocking-refresh-hook' }] }),
    };

    let releaseRefresh;
    const appCtx = makeAppCtx(catalog, { pool: mockPool });
    appCtx.services.refreshRuntimeAsync = () => new Promise((resolve) => {
      releaseRefresh = resolve;
    });

    const res = makeRes();
    const req = makeReq({ hookKey: 'blocking-refresh-hook', phase: 'request' });
    const pending = handleCreateProviderHookAssignment({
      req, res, params: { providerId: 'p1' }, appCtx,
    });

    for (let i = 0; i < 5 && typeof releaseRefresh !== 'function'; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    assert.equal(typeof releaseRefresh, 'function');
    assert.equal(res._status, null);

    releaseRefresh();
    await pending;

    assert.equal(res._status, 201);
  });
});

// ── handleUpdateProviderHookAssignment tests ───────────────────────

describe('handleUpdateProviderHookAssignment', () => {

  it('updates with partial body', async () => {
    const updatedRow = {
      id: 'a1', provider_id: 'p1', hook_key: 'h1',
      phase: 'request', sort_order: 50, enabled: true, settings: {},
    };
    const mockPool = {
      query: async () => ({ rows: [updatedRow] }),
    };
    const catalog = makeCatalog([]);
    const appCtx = makeAppCtx(catalog, { pool: mockPool });
    const res = makeRes();
    const req = makeReq({ sortOrder: 50 });

    await handleUpdateProviderHookAssignment({
      req, res, params: { providerId: 'p1', assignmentId: 'a1' }, appCtx,
    });

    assert.equal(res._status, 200);
    assert.equal(res._body.assignment.sort_order, 50);
  });

  it('returns 404 when assignment not found', async () => {
    const mockPool = {
      query: async () => ({ rows: [] }),
    };
    const catalog = makeCatalog([]);
    const appCtx = makeAppCtx(catalog, { pool: mockPool });
    const res = makeRes();
    const req = makeReq({ enabled: false });

    await handleUpdateProviderHookAssignment({
      req, res, params: { providerId: 'p1', assignmentId: 'missing' }, appCtx,
    });

    assert.equal(res._status, 404);
  });

  it('rejects empty update body', async () => {
    const catalog = makeCatalog([]);
    const appCtx = makeAppCtx(catalog);
    const res = makeRes();
    const req = makeReq({});

    await assert.rejects(
      () => handleUpdateProviderHookAssignment({
        req, res, params: { providerId: 'p1', assignmentId: 'a1' }, appCtx,
      }),
      (err) => {
        assert.match(err.message, /Empty update body/);
        return true;
      },
    );
  });

  it('triggers snapshot refresh after update', async () => {
    const mockPool = {
      query: async () => ({ rows: [{ id: 'a1' }] }),
    };
    const catalog = makeCatalog([]);
    const refreshCalls = [];
    const appCtx = makeAppCtx(catalog, { pool: mockPool });
    appCtx.services.refreshRuntimeAsync = async (opts) => { refreshCalls.push(opts); };
    const res = makeRes();
    const req = makeReq({ enabled: false });

    await handleUpdateProviderHookAssignment({
      req, res, params: { providerId: 'p1', assignmentId: 'a1' }, appCtx,
    });

    assert.equal(refreshCalls.length, 1);
    assert.equal(refreshCalls[0].snapshot, true);
    assert.equal(refreshCalls[0].providerCatalog, true);
    assert.match(refreshCalls[0].reason, /update/);
  });
});

// ── handleDeleteProviderHookAssignment tests ───────────────────────

describe('handleDeleteProviderHookAssignment', () => {

  it('deletes and returns ok', async () => {
    const mockPool = {
      query: async () => ({ rowCount: 1 }),
    };
    const catalog = makeCatalog([]);
    const appCtx = makeAppCtx(catalog, { pool: mockPool });
    const res = makeRes();

    await handleDeleteProviderHookAssignment({
      res, params: { providerId: 'p1', assignmentId: 'a1' }, appCtx,
    });

    assert.equal(res._status, 200);
    assert.equal(res._body.ok, true);
  });

  it('returns 404 when assignment not found', async () => {
    const mockPool = {
      query: async () => ({ rowCount: 0 }),
    };
    const catalog = makeCatalog([]);
    const appCtx = makeAppCtx(catalog, { pool: mockPool });
    const res = makeRes();

    await handleDeleteProviderHookAssignment({
      res, params: { providerId: 'p1', assignmentId: 'missing' }, appCtx,
    });

    assert.equal(res._status, 404);
  });

  it('triggers snapshot refresh after delete', async () => {
    const mockPool = {
      query: async () => ({ rowCount: 1 }),
    };
    const catalog = makeCatalog([]);
    const refreshCalls = [];
    const appCtx = makeAppCtx(catalog, { pool: mockPool });
    appCtx.services.refreshRuntimeAsync = async (opts) => { refreshCalls.push(opts); };
    const res = makeRes();

    await handleDeleteProviderHookAssignment({
      res, params: { providerId: 'p1', assignmentId: 'a1' }, appCtx,
    });

    assert.equal(refreshCalls.length, 1);
    assert.equal(refreshCalls[0].snapshot, true);
    assert.equal(refreshCalls[0].providerCatalog, true);
    assert.match(refreshCalls[0].reason, /delete/);
  });
});
