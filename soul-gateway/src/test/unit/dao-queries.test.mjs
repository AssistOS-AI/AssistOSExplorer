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
            'buildSafeKeyDisplay',
            'findSafeDisplayById',
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

    it('provisions user keys with an opaque sk-soul key hint that omits subject details', async () => {
        const keysDao = await import('../../db/dao/api-keys-dao.mjs');
        let captured = null;
        const owner = 'bob';
        const name = 'mac';
        const subjectId = `user:${owner}:${name}`;
        const pool = {
            query: async (sql, params) => {
                captured = { sql, params };
                return {
                    rows: [
                        {
                            id: 'x',
                            subject_id: subjectId,
                            subject_type: 'user',
                            source: 'signed-subject',
                            key_hint: params[4],
                            status: 'active',
                        },
                    ],
                };
            },
        };

        const row = await keysDao.provisionUserKey(pool, {
            subjectId,
            label: `${owner}/${name}`,
        });

        assert.equal(row.key_hint, captured.params[4]);
        assert.match(row.key_hint, /^sk-soul-/);
        assert.doesNotMatch(row.key_hint, /user:/);
        assert.doesNotMatch(row.key_hint, new RegExp(owner));
        assert.doesNotMatch(row.key_hint, new RegExp(name));
        assert.notEqual(row.key_hint, subjectId);
    });

    it('builds safe display fields for agent keys without hiding the subject label', async () => {
        const keysDao = await import('../../db/dao/api-keys-dao.mjs');

        const display = keysDao.buildSafeKeyDisplay({
            id: 'agent-key-id',
            label: 'agent:demo/echoAgent',
            subject_id: 'agent:demo/echoAgent',
            subject_type: 'agent',
            key_hint: 'agent:de...gent',
            status: 'active',
        });

        assert.deepEqual(display, {
            key_label: 'agent:demo/echoAgent',
            key_hint: 'agent:de...gent',
            key_status: 'active',
        });
    });

    it('builds opaque safe display fields for user keys', async () => {
        const keysDao = await import('../../db/dao/api-keys-dao.mjs');

        const display = keysDao.buildSafeKeyDisplay({
            id: 'user-key-id',
            label: 'alice/laptop',
            subject_id: 'user:alice:laptop',
            subject_type: 'user',
            key_hint: 'user:ali...ptop',
            status: 'active',
        });

        assert.equal(display.key_label, 'alice/laptop');
        assert.match(display.key_hint, /^sk-soul-/);
        assert.doesNotMatch(display.key_hint, /user:/);
        assert.doesNotMatch(display.key_hint, /alice/);
        assert.doesNotMatch(display.key_hint, /laptop/);
        assert.equal(display.key_status, 'active');
    });

    it('uses a generic label for raw user subject labels', async () => {
        const keysDao = await import('../../db/dao/api-keys-dao.mjs');
        const subjectId = 'user:alice:laptop';

        const display = keysDao.buildSafeKeyDisplay({
            id: 'user-key-id',
            label: subjectId,
            subject_id: subjectId,
            subject_type: 'user',
            key_hint: 'user:ali...ptop',
            status: 'active',
        });

        assert.equal(display.key_label, 'User key');
        assert.notEqual(display.key_label, subjectId);
        assert.doesNotMatch(display.key_label, /^user:/);

        const keyLabelDisplay = keysDao.buildSafeKeyDisplay({
            id: 'user-key-id',
            key_label: subjectId,
            subject_id: subjectId,
            subject_type: 'user',
            key_hint: 'user:ali...ptop',
            status: 'active',
        });

        assert.equal(keyLabelDisplay.key_label, 'User key');
        assert.notEqual(keyLabelDisplay.key_label, subjectId);
        assert.doesNotMatch(keyLabelDisplay.key_label, /^user:/);
    });

    it('infers user-safe display from raw display fields without subject metadata', async () => {
        const keysDao = await import('../../db/dao/api-keys-dao.mjs');
        const subjectId = 'user:alice:laptop';

        const labelDisplay = keysDao.buildSafeKeyDisplay({
            id: 'user-key-id',
            label: subjectId,
            key_hint: 'legacy-key-hint',
            status: 'active',
        });

        assert.equal(labelDisplay.key_label, 'User key');
        assert.notEqual(labelDisplay.key_label, subjectId);
        assert.doesNotMatch(labelDisplay.key_label, /^user:/);

        const keyLabelDisplay = keysDao.buildSafeKeyDisplay({
            id: 'user-key-id',
            key_label: subjectId,
            key_hint: 'legacy-key-hint',
            status: 'active',
        });

        assert.equal(keyLabelDisplay.key_label, 'User key');
        assert.notEqual(keyLabelDisplay.key_label, subjectId);
        assert.doesNotMatch(keyLabelDisplay.key_label, /^user:/);

        const hintDisplay = keysDao.buildSafeKeyDisplay({
            id: 'user-key-id',
            key_hint: subjectId,
            status: 'active',
        });

        assert.match(hintDisplay.key_hint, /^sk-soul-/);
        assert.doesNotMatch(hintDisplay.key_hint, /user:/);
        assert.doesNotMatch(hintDisplay.key_hint, /alice/);
        assert.doesNotMatch(hintDisplay.key_hint, /laptop/);
    });

    it('looks up safe display fields by internal key id', async () => {
        const keysDao = await import('../../db/dao/api-keys-dao.mjs');
        const calls = [];
        const pool = {
            async query(sql, params) {
                calls.push({ sql, params });
                return {
                    rows: [
                        {
                            id: 'agent-key-id',
                            label: 'agent:demo/echoAgent',
                            subject_id: 'agent:demo/echoAgent',
                            subject_type: 'agent',
                            key_hint: 'agent:de...gent',
                            status: 'active',
                        },
                    ],
                };
            },
        };

        const display = await keysDao.findSafeDisplayById(pool, 'agent-key-id');

        assert.match(calls[0].sql, /SELECT \* FROM api_keys WHERE id = \$1/);
        assert.deepEqual(calls[0].params, ['agent-key-id']);
        assert.equal(display.key_label, 'agent:demo/echoAgent');
        assert.equal(display.key_hint, 'agent:de...gent');
        assert.equal(display.key_status, 'active');
    });

    it('returns stable display fields for unknown and missing key ids', async () => {
        const keysDao = await import('../../db/dao/api-keys-dao.mjs');
        const pool = {
            async query() {
                return { rows: [] };
            },
        };

        assert.deepEqual(await keysDao.findSafeDisplayById(pool, null), {
            key_label: 'Unknown key',
            key_hint: '',
            key_status: 'unknown',
        });
        assert.deepEqual(await keysDao.findSafeDisplayById(pool, 'deleted-key-id'), {
            key_label: 'Missing key',
            key_hint: '',
            key_status: 'unknown',
        });
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
            'createCascade',
            'findById',
            'findByKey',
            'list',
            'update',
            'updateOperatorModel',
            'del',
            'delByProvider',
            'enable',
            'disable',
            'listByProvider',
            'updateProviderSyncedModel',
            'disableMissingProviderSyncedModel',
        ];
        for (const fn of expected) {
            assert.equal(typeof dao[fn], 'function', `missing export: ${fn}`);
        }
    });

    it('updates operator-patched enabled state while atomically clearing syncDisabled metadata', async () => {
        const dao = await import('../../db/dao/models-dao.mjs');
        const calls = [];
        const pool = {
            async query(sql, params) {
                calls.push({ sql, params });
                return {
                    rows: [
                        {
                            id: 'model-id',
                            enabled: true,
                            metadata: { preserved: 'value' },
                        },
                    ],
                };
            },
        };

        const row = await dao.updateOperatorModel(pool, 'model-id', {
            enabled: true,
            metadata: {
                preserved: 'value',
                syncDisabled: { reason: 'missing-from-discovery' },
            },
        });

        assert.equal(row.id, 'model-id');
        assert.equal(calls.length, 1);
        assert.match(calls[0].sql, /UPDATE models/);
        assert.match(calls[0].sql, /enabled = \$2/);
        assert.match(
            calls[0].sql,
            /metadata = json_remove\(COALESCE\(\$3, json_remove\(metadata, '\$\.syncDisabled'\)\), '\$\.syncDisabled'\)/
        );
        assert.match(calls[0].sql, /WHERE id = \$1/);
        assert.doesNotMatch(calls[0].sql, /^SELECT/i);
        assert.deepEqual(calls[0].params, [
            'model-id',
            true,
            JSON.stringify({ preserved: 'value' }),
        ]);
        assert.doesNotMatch(calls[0].params[2], /syncDisabled/);
    });

    it('clears syncDisabled in atomic toggle updates without pre-reading metadata', async () => {
        const dao = await import('../../db/dao/models-dao.mjs');

        for (const [fnName, enabledSql] of [
            ['enable', 'true'],
            ['disable', 'false'],
        ]) {
            const calls = [];
            const id = `${fnName}-model-id`;
            const pool = {
                async query(sql, params) {
                    calls.push({ sql, params });
                    return {
                        rows: [
                            {
                                id,
                                enabled: fnName === 'enable',
                                metadata: { kept: 'value' },
                            },
                        ],
                    };
                },
            };

            const row = await dao[fnName](pool, id);

            assert.equal(row.id, id);
            assert.equal(calls.length, 1);
            assert.match(calls[0].sql, /^UPDATE models\s+SET enabled = (true|false),/);
            assert.match(calls[0].sql, new RegExp(`enabled = ${enabledSql}`));
            assert.match(
                calls[0].sql,
                /metadata = json_remove\(metadata, '\$\.syncDisabled'\)/
            );
            assert.doesNotMatch(calls[0].sql, /^SELECT/i);
            assert.deepEqual(calls[0].params, [id]);
            assert.ok(!calls[0].params.some((param) => typeof param === 'object'));
        }
    });

    it('updates provider-synced models without forcing enabled true from stale state', async () => {
        const dao = await import('../../db/dao/models-dao.mjs');
        const calls = [];
        const pool = {
            async query(sql, params) {
                calls.push({ sql, params });
                return {
                    rows: [
                        {
                            id: 'model-id',
                            enabled: false,
                            metadata: { refreshed: true },
                        },
                    ],
                };
            },
        };

        const row = await dao.updateProviderSyncedModel(pool, 'model-id', {
            displayName: 'Fresh Name',
            providerModelId: 'fresh-model',
            metadata: { refreshed: true },
            discoverySource: 'synced',
        });

        assert.equal(row.id, 'model-id');
        assert.equal(calls.length, 1);
        assert.match(calls[0].sql, /UPDATE models/);
        assert.match(
            calls[0].sql,
            /enabled = CASE\s+WHEN json_type\(metadata, '\$\.syncDisabled'\) IS NOT NULL THEN true\s+ELSE enabled\s+END/s
        );
        assert.match(
            calls[0].sql,
            /metadata = CASE\s+WHEN json_type\(metadata, '\$\.syncDisabled'\) IS NOT NULL THEN json_remove\(\$4, '\$\.syncDisabled'\)\s+ELSE \$4\s+END/s
        );
        assert.doesNotMatch(calls[0].sql, /enabled = \$\d/);
        assert.match(calls[0].sql, /WHERE id = \$1/);
        assert.match(calls[0].sql, /discovery_source != 'manual'/);
        assert.deepEqual(calls[0].params, [
            'model-id',
            'Fresh Name',
            'fresh-model',
            JSON.stringify({ refreshed: true }),
            'synced',
        ]);
    });

    it('sync-disables missing provider rows only when the current row is enabled', async () => {
        const dao = await import('../../db/dao/models-dao.mjs');
        const calls = [];
        const marker = {
            reason: 'missing-from-discovery',
            source: 'provider.model-refresh',
            at: '2026-06-29T00:00:00.000Z',
        };
        const pool = {
            async query(sql, params) {
                calls.push({ sql, params });
                return { rows: [] };
            },
        };

        const row = await dao.disableMissingProviderSyncedModel(
            pool,
            'model-id',
            marker
        );

        assert.equal(row, null);
        assert.equal(calls.length, 1);
        assert.match(calls[0].sql, /UPDATE models/);
        assert.match(calls[0].sql, /SET enabled = false/);
        assert.match(
            calls[0].sql,
            /metadata = json_set\(COALESCE\(metadata, '\{\}'\), '\$\.syncDisabled', json\(\$2\)\)/
        );
        assert.match(calls[0].sql, /WHERE id = \$1/);
        assert.match(calls[0].sql, /enabled = true/);
        assert.match(calls[0].sql, /discovery_source != 'manual'/);
        assert.deepEqual(calls[0].params, ['model-id', JSON.stringify(marker)]);
    });
});

describe('model-aliases-dao', () => {
    it('exports all expected functions', async () => {
        const dao = await import('../../db/dao/model-aliases-dao.mjs');
        const expected = [
            'create',
            'findByAlias',
            'updateModel',
            'listByModel',
            'deleteByModel',
            'deleteByAlias',
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
            /ORDER BY logs\.requested_model DESC, logs\.started_at DESC, logs\.log_id DESC/
        );
    });

    it('enriches log queries with the resolved model key', async () => {
        const dao = await import('../../db/dao/audit-logs-dao.mjs');
        const calls = [];
        const pool = {
            async query(sql, params) {
                calls.push({ sql, params });
                return { rows: [] };
            },
        };

        await dao.query(pool, {}, { sort: 'resolved_model', order: 'ASC' });

        assert.match(
            calls[0].sql,
            /resolved\.model_key AS resolved_model/
        );
        assert.match(
            calls[0].sql,
            /LEFT JOIN models resolved\s+ON resolved\.id = logs\.resolved_model_id/
        );
        assert.match(
            calls[0].sql,
            /ORDER BY resolved_model ASC, logs\.started_at ASC, logs\.log_id ASC/
        );
    });

    it('qualifies log filters when querying with the resolved model join', async () => {
        const dao = await import('../../db/dao/audit-logs-dao.mjs');
        const calls = [];
        const pool = {
            async query(sql, params) {
                calls.push({ sql, params });
                return { rows: [] };
            },
        };

        await dao.query(pool, {
            model: 'fast',
            status: 'succeeded',
            keyword: 'hello',
            apiKeyId: 'key-1',
        });

        assert.match(calls[0].sql, /WHERE logs\.requested_model = \$1/);
        assert.match(calls[0].sql, /logs\.status = \$2/);
        assert.match(calls[0].sql, /logs\.response_excerpt LIKE \$3 COLLATE NOCASE/);
        assert.match(calls[0].sql, /logs\.error_message LIKE \$3 COLLATE NOCASE/);
        assert.match(calls[0].sql, /logs\.requested_model LIKE \$3 COLLATE NOCASE/);
        assert.match(calls[0].sql, /logs\.agent_name LIKE \$3 COLLATE NOCASE/);
        assert.match(calls[0].sql, /logs\.session_id LIKE \$3 COLLATE NOCASE/);
        assert.match(calls[0].sql, /logs\.request_id LIKE \$3 COLLATE NOCASE/);
        assert.match(calls[0].sql, /resolved\.model_key LIKE \$3 COLLATE NOCASE/);
        assert.match(calls[0].sql, /resolved\.display_name LIKE \$3 COLLATE NOCASE/);
        assert.match(calls[0].sql, /resolved\.provider_model_id LIKE \$3 COLLATE NOCASE/);
        assert.match(calls[0].sql, /logs\.api_key_id = \$4/);
        assert.deepEqual(calls[0].params.slice(0, 4), [
            'fast',
            'succeeded',
            '%hello%',
            'key-1',
        ]);
    });

    it('counts logs with the same resolved model keyword search as the list query', async () => {
        const dao = await import('../../db/dao/audit-logs-dao.mjs');
        const calls = [];
        const pool = {
            async query(sql, params) {
                calls.push({ sql, params });
                return { rows: [{ total: 0 }] };
            },
        };

        await dao.countByFilters(pool, { keyword: 'codestral' });

        assert.match(
            calls[0].sql,
            /SELECT COUNT\(\*\) AS total\s+FROM audit_logs logs\s+LEFT JOIN models resolved\s+ON resolved\.id = logs\.resolved_model_id/
        );
        assert.match(calls[0].sql, /logs\.requested_model LIKE \$1 COLLATE NOCASE/);
        assert.match(calls[0].sql, /resolved\.model_key LIKE \$1 COLLATE NOCASE/);
        assert.deepEqual(calls[0].params, ['%codestral%']);
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

    it('searches key summaries with the resolved model join available', async () => {
        const dao = await import('../../db/dao/audit-logs-dao.mjs');
        const calls = [];
        const pool = {
            async query(sql, params) {
                calls.push({ sql, params });
                return { rows: [] };
            },
        };

        await dao.summarizeByApiKey(pool, { keyword: 'codestral' });

        assert.match(
            calls[0].sql,
            /LEFT JOIN api_keys keys\s+ON keys\.id = logs\.api_key_id\s+LEFT JOIN models resolved\s+ON resolved\.id = logs\.resolved_model_id/
        );
        assert.match(calls[0].sql, /resolved\.model_key LIKE \$1 COLLATE NOCASE/);
        assert.deepEqual(calls[0].params, ['%codestral%']);
    });
});
