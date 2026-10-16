import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { AuditLogWriter } from '../../observability/audit-log-writer.mjs';

describe('AuditLogWriter', () => {
    it('writes a completed audit row and publishes it', async () => {
        const calls = [];
        const pool = {
            async query(sql, params) {
                calls.push({ sql, params });
                if (/RETURNING \*/.test(sql)) {
                    return { rows: [{ log_id: 'log-1' }] };
                }
                return { rows: [] };
            },
        };
        const published = [];
        const writer = new AuditLogWriter({
            pool,
            log: { error() {} },
        });
        writer.setBroadcastHub({ publish: (row) => published.push(row) });

        const row = await writer.write({
            startedAt: new Date('2026-05-25T16:39:55.000Z'),
            requestId: 'req-1',
            requestFormat: 'chat',
            status: 'succeeded',
            apiKeyId: 'key-1',
            requestedModel: 'fast',
            completedAt: new Date('2026-05-25T16:40:00.000Z'),
        });

        assert.equal(row.log_id, 'log-1');
        assert.equal(published.length, 1);
        assert.match(calls[0].sql, /INSERT INTO audit_logs/);
    });

    it('writes a legacy start row', async () => {
        const calls = [];
        const pool = {
            async query(sql, params) {
                calls.push({ sql, params });
                if (/RETURNING \*/.test(sql)) {
                    return { rows: [{ log_id: 'log-2' }] };
                }
                return { rows: [] };
            },
        };
        const writer = new AuditLogWriter({
            pool,
            log: { error() {} },
        });

        const row = await writer.start({
            startedAt: '2026-05-25T16:39:55.000Z',
            requestId: 'req-2',
            requestFormat: 'chat',
            apiKeyId: 'key-1',
            requestedModel: 'fast',
        });

        assert.equal(row.log_id, 'log-2');
        assert.match(calls[0].sql, /INSERT INTO audit_logs/);
    });

    it('publishes completed rows with safe key display fields when subscribers exist', async () => {
        const calls = [];
        const pool = {
            async query(sql, params) {
                calls.push({ sql, params });
                if (/INSERT INTO audit_logs/i.test(sql)) {
                    return {
                        rows: [
                            {
                                log_id: 'log-1',
                                api_key_id: 'agent-key-id',
                                requested_model: 'fast',
                                status: 'succeeded',
                            },
                        ],
                    };
                }
                if (/SELECT \* FROM api_keys WHERE id = \$1/i.test(sql)) {
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
                }
                return { rows: [] };
            },
        };
        const published = [];
        const writer = new AuditLogWriter({
            pool,
            log: { error() {}, warn() {} },
        });
        writer.setBroadcastHub({
            subscriberCount: 1,
            publish: (row) => published.push(row),
        });

        const row = await writer.write({
            startedAt: new Date('2026-05-25T16:39:55.000Z'),
            requestId: 'req-1',
            requestFormat: 'chat',
            status: 'succeeded',
            apiKeyId: 'agent-key-id',
            requestedModel: 'fast',
            completedAt: new Date('2026-05-25T16:40:00.000Z'),
        });

        assert.equal(row.key_label, undefined);
        assert.equal(published.length, 1);
        assert.equal(published[0].key_label, 'agent:demo/echoAgent');
        assert.equal(published[0].key_hint, 'agent:de...gent');
        assert.equal(published[0].key_status, 'active');
    });

    it('does not query key display fields when no live subscribers exist', async () => {
        const calls = [];
        const pool = {
            async query(sql, params) {
                calls.push({ sql, params });
                if (/INSERT INTO audit_logs/i.test(sql)) {
                    return {
                        rows: [
                            {
                                log_id: 'log-1',
                                api_key_id: 'agent-key-id',
                                requested_model: 'fast',
                                status: 'succeeded',
                            },
                        ],
                    };
                }
                throw new Error(`unexpected query: ${sql}`);
            },
        };
        const published = [];
        const writer = new AuditLogWriter({
            pool,
            log: { error() {}, warn() {} },
        });
        writer.setBroadcastHub({
            subscriberCount: 0,
            publish: (row) => published.push(row),
        });

        await writer.write({
            startedAt: new Date('2026-05-25T16:39:55.000Z'),
            requestId: 'req-1',
            requestFormat: 'chat',
            status: 'succeeded',
            apiKeyId: 'agent-key-id',
            requestedModel: 'fast',
            completedAt: new Date('2026-05-25T16:40:00.000Z'),
        });

        assert.equal(calls.length, 1);
        assert.equal(published[0].key_label, undefined);
    });
});
