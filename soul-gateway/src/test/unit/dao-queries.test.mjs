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
            'upsertSignedSubjectKey',
            'findById',
            'findBySubjectId',
            'list',
            'update',
            'revoke',
            'updateLastUsed',
        ];
        for (const fn of expected) {
            assert.equal(typeof dao[fn], 'function', `missing export: ${fn}`);
        }
    });

    it('inserts a user signed-subject row with a derived key hint and no key material', async () => {
        const keysDao = await import('../../db/dao/api-keys-dao.mjs');
        let captured = null;
        const pool = {
            query: async (sql, params) => {
                captured = { sql, params };
                return {
                    rows: [
                        {
                            id: 'x',
                            subject_id: 'user:alice:laptop',
                            subject_type: 'user',
                            source: 'signed-subject',
                            status: 'active',
                        },
                    ],
                };
            },
        };
        const row = await keysDao.provisionUserKey(pool, {
            subjectId: 'user:alice:laptop',
            label: 'alice/laptop',
            rpmLimit: 30,
        });
        assert.equal(row.subject_type, 'user');
        assert.ok(/INSERT INTO api_keys/i.test(captured.sql));
        assert.ok(!/key_hash|key_ciphertext/i.test(captured.sql));
        assert.ok(captured.params.includes('user:alice:laptop'));
        assert.ok(captured.params.includes('user'));
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

    it('returns the existing open session and commits without inserting', async () => {
        const dao = await import('../../db/dao/sessions-dao.mjs');
        const queries = [];
        const client = {
            async query(sql) {
                queries.push(sql);
                if (/^SELECT \*\s+FROM sessions/.test(sql)) {
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
        assert.equal(queries[0], 'BEGIN IMMEDIATE');
        assert.match(queries[1], /SELECT \*\s+FROM sessions/);
        assert.equal(queries.at(-1), 'COMMIT');
        assert.ok(!queries.some((sql) => /INSERT INTO sessions/.test(sql)));
    });

    it('creates a new session with a generated sequence_no when none is open', async () => {
        const dao = await import('../../db/dao/sessions-dao.mjs');
        const queries = [];
        const client = {
            async query(sql) {
                queries.push(sql);
                if (/COALESCE\(MAX\(sequence_no\), 0\) \+ 1/.test(sql)) {
                    return { rows: [{ seq: 4 }] };
                }
                if (/INSERT INTO sessions/.test(sql)) {
                    return {
                        rows: [
                            {
                                id: 'session-new',
                                group_key: 'implicit:key:agent',
                                sequence_no: 4,
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
        assert.equal(queries[0], 'BEGIN IMMEDIATE');
        assert.ok(queries.some((sql) => /INSERT INTO sessions/.test(sql)));
        assert.equal(queries.at(-1), 'COMMIT');
    });

    it('rolls back and rethrows when a transactional step fails', async () => {
        const dao = await import('../../db/dao/sessions-dao.mjs');
        const queries = [];
        const client = {
            async query(sql) {
                queries.push(sql);
                if (/INSERT INTO sessions/.test(sql)) {
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
