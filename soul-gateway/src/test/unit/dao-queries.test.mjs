import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Verify that every DAO module exports the expected functions.
 * No live database required — pure import checks.
 */

describe('api-keys-dao', () => {
    it('exports all expected functions', async () => {
        const dao = await import('../../db/dao/api-keys-dao.mjs');
        const expected = [
            'create',
            'findByHash',
            'findById',
            'list',
            'update',
            'revoke',
            'updateLastUsed',
        ];
        for (const fn of expected) {
            assert.equal(typeof dao[fn], 'function', `missing export: ${fn}`);
        }
    });
});

describe('providers-dao', () => {
    it('exports all expected functions', async () => {
        const dao = await import('../../db/dao/providers-dao.mjs');
        const expected = [
            'create',
            'findById',
            'findByKey',
            'list',
            'update',
            'del',
        ];
        for (const fn of expected) {
            assert.equal(typeof dao[fn], 'function', `missing export: ${fn}`);
        }
    });
});

describe('provider-accounts-dao', () => {
    it('exports all expected functions', async () => {
        const dao = await import('../../db/dao/provider-accounts-dao.mjs');
        const expected = [
            'create',
            'findById',
            'listByProvider',
            'updateStatus',
            'markExhausted',
            'markRefreshing',
            'updateTokenExpiry',
            'del',
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
            'create',
            'findById',
            'findByKey',
            'list',
            'update',
            'del',
            'enable',
            'disable',
            'listByProvider',
        ];
        for (const fn of expected) {
            assert.equal(typeof dao[fn], 'function', `missing export: ${fn}`);
        }
    });
});

describe('model-aliases-dao', () => {
    it('exports all expected functions', async () => {
        const dao = await import('../../db/dao/model-aliases-dao.mjs');
        const expected = [
            'create',
            'findByAlias',
            'listByModel',
            'deleteByModel',
        ];
        for (const fn of expected) {
            assert.equal(typeof dao[fn], 'function', `missing export: ${fn}`);
        }
    });
});

// tiers-dao and middleware-assignments-dao were deleted in
// Workstream F2+F3.  The unified replacements are models-dao with
// strategy_kind support and middleware-bindings-dao.

describe('model-children-dao', () => {
    it('exports all expected functions', async () => {
        const dao = await import('../../db/dao/model-children-dao.mjs');
        const expected = [
            'create',
            'listForParent',
            'listAll',
            'removeChild',
            'reorderChildren',
            'replaceChildren',
        ];
        for (const fn of expected) {
            assert.equal(typeof dao[fn], 'function', `missing export: ${fn}`);
        }
    });
});

describe('middleware-bindings-dao', () => {
    it('exports all expected functions', async () => {
        const dao = await import('../../db/dao/middleware-bindings-dao.mjs');
        const expected = [
            'create',
            'findById',
            'listAll',
            'listByScope',
            'listByTarget',
            'update',
            'del',
            'reorder',
            'listEnabledWithMiddleware',
        ];
        for (const fn of expected) {
            assert.equal(typeof dao[fn], 'function', `missing export: ${fn}`);
        }
    });
});

describe('middlewares-dao', () => {
    it('exports all expected functions', async () => {
        const dao = await import('../../db/dao/middlewares-dao.mjs');
        const expected = [
            'create',
            'findById',
            'findByKey',
            'list',
            'update',
            'upsertFromDiscovery',
        ];
        for (const fn of expected) {
            assert.equal(typeof dao[fn], 'function', `missing export: ${fn}`);
        }
    });
});

describe('blacklist-dao', () => {
    it('exports all expected functions', async () => {
        const dao = await import('../../db/dao/blacklist-dao.mjs');
        const expected = [
            'create',
            'findById',
            'list',
            'update',
            'del',
            'listEnabled',
        ];
        for (const fn of expected) {
            assert.equal(typeof dao[fn], 'function', `missing export: ${fn}`);
        }
    });
});

describe('cooldowns-dao', () => {
    it('exports all expected functions', async () => {
        const dao = await import('../../db/dao/cooldowns-dao.mjs');
        const expected = [
            'create',
            'findActiveByModel',
            'listActive',
            'clearByModel',
            'clearAll',
            'deleteExpired',
        ];
        for (const fn of expected) {
            assert.equal(typeof dao[fn], 'function', `missing export: ${fn}`);
        }
    });
});

describe('sessions-dao', () => {
    it('exports all expected functions', async () => {
        const dao = await import('../../db/dao/sessions-dao.mjs');
        const expected = [
            'create',
            'findById',
            'findOrCreateImplicit',
            'updateActivity',
            'close',
            'listRecent',
            'listByAgent',
        ];
        for (const fn of expected) {
            assert.equal(typeof dao[fn], 'function', `missing export: ${fn}`);
        }
    });

    it('runs an explicit READ COMMITTED transaction with advisory-lock, recheck, and COMMIT on one checked-out client', async () => {
        const dao = await import('../../db/dao/sessions-dao.mjs');
        const queries = [];
        const client = {
            async query(sql) {
                queries.push(sql);
                if (/^SELECT \*\s+FROM soul_gateway\.sessions/.test(sql)) {
                    return {
                        rows: [
                            {
                                id: 'session-1',
                                group_key: 'implicit:key:agent',
                                sequence_no: 1,
                            },
                        ],
                    };
                }
                return { rows: [] };
            },
            release() {},
        };
        const pool = {
            async connect() {
                return client;
            },
        };

        const result = await dao.findOrCreateImplicit(pool, {
            apiKeyId: 'key',
            agentName: 'agent',
            soulId: 'soul-1',
            timeoutMinutes: 30,
        });

        assert.equal(result.session.id, 'session-1');
        assert.equal(result.created, false);
        assert.equal(queries[0], 'BEGIN ISOLATION LEVEL READ COMMITTED');
        assert.match(queries[1], /pg_advisory_xact_lock\(hashtext\(\$1\)\)/);
        assert.match(queries[2], /SELECT \*\s+FROM soul_gateway\.sessions/);
        assert.equal(queries[3], 'COMMIT');
    });

    it('inserts with ON CONFLICT DO NOTHING when no eligible open session exists', async () => {
        const dao = await import('../../db/dao/sessions-dao.mjs');
        const queries = [];
        const client = {
            async query(sql) {
                queries.push(sql);
                if (
                    sql === 'BEGIN ISOLATION LEVEL READ COMMITTED' ||
                    sql === 'COMMIT'
                ) {
                    return { rows: [] };
                }
                if (/pg_advisory_xact_lock/.test(sql)) return { rows: [] };
                if (/^SELECT \*\s+FROM soul_gateway\.sessions/.test(sql)) {
                    return { rows: [] };
                }
                if (/INSERT INTO soul_gateway\.sessions/.test(sql)) {
                    assert.match(sql, /ON CONFLICT \(group_key, sequence_no\) DO NOTHING/);
                    return {
                        rows: [
                            {
                                id: 'session-new',
                                group_key: 'implicit:key:agent',
                                sequence_no: 1,
                            },
                        ],
                    };
                }
                return { rows: [] };
            },
            release() {},
        };
        const pool = { async connect() { return client; } };

        const result = await dao.findOrCreateImplicit(pool, {
            apiKeyId: 'key',
            agentName: 'agent',
            soulId: null,
            timeoutMinutes: 30,
        });

        assert.equal(result.session.id, 'session-new');
        assert.equal(result.created, true);
        assert.equal(queries.at(-1), 'COMMIT');
    });

    it('rechecks and reuses the open session when the insert conflict branch is hit', async () => {
        const dao = await import('../../db/dao/sessions-dao.mjs');
        const queries = [];
        let selectCount = 0;
        const client = {
            async query(sql) {
                queries.push(sql);
                if (
                    sql === 'BEGIN ISOLATION LEVEL READ COMMITTED' ||
                    sql === 'COMMIT'
                ) {
                    return { rows: [] };
                }
                if (/pg_advisory_xact_lock/.test(sql)) return { rows: [] };
                if (/^SELECT \*\s+FROM soul_gateway\.sessions/.test(sql)) {
                    selectCount += 1;
                    if (selectCount === 1) {
                        return { rows: [] };
                    }
                    return {
                        rows: [
                            {
                                id: 'session-reused',
                                group_key: 'implicit:key:agent',
                                sequence_no: 1,
                            },
                        ],
                    };
                }
                if (/INSERT INTO soul_gateway\.sessions/.test(sql)) {
                    return { rows: [] };
                }
                return { rows: [] };
            },
            release() {},
        };
        const pool = { async connect() { return client; } };

        const result = await dao.findOrCreateImplicit(pool, {
            apiKeyId: 'key',
            agentName: 'agent',
            soulId: null,
            timeoutMinutes: 30,
        });

        assert.equal(result.session.id, 'session-reused');
        assert.equal(result.created, false);
        assert.ok(
            queries.some((sql) =>
                /ON CONFLICT \(group_key, sequence_no\) DO NOTHING/.test(sql)
            )
        );
        assert.equal(queries.at(-1), 'COMMIT');
    });

    it('rolls back and rethrows when a transactional step fails', async () => {
        const dao = await import('../../db/dao/sessions-dao.mjs');
        const queries = [];
        const client = {
            async query(sql) {
                queries.push(sql);
                if (sql === 'ROLLBACK') return { rows: [] };
                if (sql === 'BEGIN ISOLATION LEVEL READ COMMITTED') {
                    return { rows: [] };
                }
                if (/pg_advisory_xact_lock/.test(sql)) return { rows: [] };
                if (/^SELECT \*\s+FROM soul_gateway\.sessions/.test(sql)) {
                    return { rows: [] };
                }
                if (/INSERT INTO soul_gateway\.sessions/.test(sql)) {
                    throw new Error('insert failed');
                }
                return { rows: [] };
            },
            release() {},
        };
        const pool = { async connect() { return client; } };

        await assert.rejects(
            () =>
                dao.findOrCreateImplicit(pool, {
                    apiKeyId: 'key',
                    agentName: 'agent',
                    soulId: null,
                    timeoutMinutes: 30,
                }),
            /insert failed/
        );
        assert.equal(queries.at(-1), 'ROLLBACK');
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

// Provider bindings live in middleware_bindings with scope='provider'.

describe('audit-logs-dao', () => {
    it('exports all expected functions', async () => {
        const dao = await import('../../db/dao/audit-logs-dao.mjs');
        const expected = [
            'insertCompleted',
            'insertStart',
            'finalize',
            'findByRequestId',
            'query',
            'countByFilters',
            'summarizeByApiKey',
            'ensurePartition',
            'dropExpiredPartitions',
        ];
        for (const fn of expected) {
            assert.equal(typeof dao[fn], 'function', `missing export: ${fn}`);
        }
    });

    it('orders log queries deterministically with tie breakers', async () => {
        const dao = await import('../../db/dao/audit-logs-dao.mjs');
        const calls = [];
        const pool = {
            async query(sql, params) {
                calls.push({ sql, params });
                return { rows: [] };
            },
        };

        await dao.query(pool, {}, { sort: 'requested_model', order: 'DESC' });

        assert.match(
            calls[0].sql,
            /ORDER BY requested_model DESC, started_at DESC, log_id DESC/
        );
    });

    it('orders key summaries by last activity before request count', async () => {
        const dao = await import('../../db/dao/audit-logs-dao.mjs');
        const calls = [];
        const pool = {
            async query(sql, params) {
                calls.push({ sql, params });
                return { rows: [] };
            },
        };

        await dao.summarizeByApiKey(pool, {});

        assert.match(
            calls[0].sql,
            /ORDER BY last_activity DESC NULLS LAST, request_count DESC, key_label ASC/
        );
    });
});
