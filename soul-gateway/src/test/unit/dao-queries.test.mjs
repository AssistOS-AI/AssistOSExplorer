import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Verify that every DAO module exports the expected functions.
 * No live database required — pure import checks.
 */

describe('api-keys-dao', () => {
  it('exports all expected functions', async () => {
    const dao = await import('../../db/dao/api-keys-dao.mjs');
    const expected = ['create', 'findByHash', 'findById', 'list', 'update', 'revoke', 'updateLastUsed'];
    for (const fn of expected) {
      assert.equal(typeof dao[fn], 'function', `missing export: ${fn}`);
    }
  });
});

describe('providers-dao', () => {
  it('exports all expected functions', async () => {
    const dao = await import('../../db/dao/providers-dao.mjs');
    const expected = ['create', 'findById', 'findByKey', 'list', 'update', 'del'];
    for (const fn of expected) {
      assert.equal(typeof dao[fn], 'function', `missing export: ${fn}`);
    }
  });
});

describe('provider-accounts-dao', () => {
  it('exports all expected functions', async () => {
    const dao = await import('../../db/dao/provider-accounts-dao.mjs');
    const expected = [
      'create', 'findById', 'listByProvider', 'updateStatus',
      'markExhausted', 'markRefreshing', 'updateTokenExpiry', 'del',
    ];
    for (const fn of expected) {
      assert.equal(typeof dao[fn], 'function', `missing export: ${fn}`);
    }
  });
});

describe('models-dao', () => {
  it('exports all expected functions', async () => {
    const dao = await import('../../db/dao/models-dao.mjs');
    const expected = [
      'create', 'findById', 'findByKey', 'list', 'update', 'del',
      'enable', 'disable', 'listByProvider', 'syncFromDiscovery',
    ];
    for (const fn of expected) {
      assert.equal(typeof dao[fn], 'function', `missing export: ${fn}`);
    }
  });
});

describe('model-aliases-dao', () => {
  it('exports all expected functions', async () => {
    const dao = await import('../../db/dao/model-aliases-dao.mjs');
    const expected = ['create', 'findByAlias', 'listByModel', 'deleteByModel'];
    for (const fn of expected) {
      assert.equal(typeof dao[fn], 'function', `missing export: ${fn}`);
    }
  });
});

describe('tiers-dao', () => {
  it('exports all expected functions', async () => {
    const dao = await import('../../db/dao/tiers-dao.mjs');
    const expected = [
      'create', 'findById', 'findByKey', 'list', 'update', 'del',
      'enable', 'disable', 'addModel', 'removeModel', 'reorderModels', 'listModelsForTier',
    ];
    for (const fn of expected) {
      assert.equal(typeof dao[fn], 'function', `missing export: ${fn}`);
    }
  });
});

describe('middlewares-dao', () => {
  it('exports all expected functions', async () => {
    const dao = await import('../../db/dao/middlewares-dao.mjs');
    const expected = ['create', 'findById', 'findByKey', 'list', 'update', 'upsertFromDiscovery'];
    for (const fn of expected) {
      assert.equal(typeof dao[fn], 'function', `missing export: ${fn}`);
    }
  });
});

describe('middleware-assignments-dao', () => {
  it('exports all expected functions', async () => {
    const dao = await import('../../db/dao/middleware-assignments-dao.mjs');
    const expected = ['create', 'listForTier', 'listForModel', 'update', 'del', 'reorder'];
    for (const fn of expected) {
      assert.equal(typeof dao[fn], 'function', `missing export: ${fn}`);
    }
  });
});

describe('blacklist-dao', () => {
  it('exports all expected functions', async () => {
    const dao = await import('../../db/dao/blacklist-dao.mjs');
    const expected = ['create', 'findById', 'list', 'update', 'del', 'listEnabled'];
    for (const fn of expected) {
      assert.equal(typeof dao[fn], 'function', `missing export: ${fn}`);
    }
  });
});

describe('cooldowns-dao', () => {
  it('exports all expected functions', async () => {
    const dao = await import('../../db/dao/cooldowns-dao.mjs');
    const expected = ['create', 'findActiveByModel', 'listActive', 'clearByModel', 'clearAll', 'deleteExpired'];
    for (const fn of expected) {
      assert.equal(typeof dao[fn], 'function', `missing export: ${fn}`);
    }
  });
});

describe('sessions-dao', () => {
  it('exports all expected functions', async () => {
    const dao = await import('../../db/dao/sessions-dao.mjs');
    const expected = [
      'create', 'findById', 'findOrCreateImplicit',
      'updateActivity', 'close', 'listRecent', 'listByAgent',
    ];
    for (const fn of expected) {
      assert.equal(typeof dao[fn], 'function', `missing export: ${fn}`);
    }
  });
});

describe('session-state-dao', () => {
  it('exports all expected functions', async () => {
    const dao = await import('../../db/dao/session-state-dao.mjs');
    const expected = ['upsert', 'findBySessionId'];
    for (const fn of expected) {
      assert.equal(typeof dao[fn], 'function', `missing export: ${fn}`);
    }
  });
});

describe('provider-hook-assignments-dao', () => {
  it('exports all expected functions', async () => {
    const dao = await import('../../db/dao/provider-hook-assignments-dao.mjs');
    const expected = ['create', 'listByProvider', 'listByProviderAndPhase', 'update', 'del', 'reorder'];
    for (const fn of expected) {
      assert.equal(typeof dao[fn], 'function', `missing export: ${fn}`);
    }
  });
});

describe('audit-logs-dao', () => {
  it('exports all expected functions', async () => {
    const dao = await import('../../db/dao/audit-logs-dao.mjs');
    const expected = [
      'insertStart', 'finalize', 'findByRequestId', 'query',
      'countByFilters', 'ensurePartition', 'dropExpiredPartitions',
    ];
    for (const fn of expected) {
      assert.equal(typeof dao[fn], 'function', `missing export: ${fn}`);
    }
  });
});
