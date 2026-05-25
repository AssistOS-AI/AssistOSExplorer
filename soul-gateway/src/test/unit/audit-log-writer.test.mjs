import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { AuditLogWriter } from '../../observability/audit-log-writer.mjs';

describe('AuditLogWriter', () => {
    it('creates the monthly partition before writing a completed audit row', async () => {
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
        assert.match(
            calls[0].sql,
            /CREATE TABLE IF NOT EXISTS soul_gateway\.audit_logs_2026_05/
        );
        assert.match(calls[0].sql, /FOR VALUES FROM \('2026-05-01'\) TO \('2026-06-01'\)/);
        assert.match(calls[1].sql, /INSERT INTO soul_gateway\.audit_logs/);
    });

    it('creates the monthly partition before writing a legacy start row', async () => {
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
        assert.match(
            calls[0].sql,
            /CREATE TABLE IF NOT EXISTS soul_gateway\.audit_logs_2026_05/
        );
        assert.match(calls[1].sql, /INSERT INTO soul_gateway\.audit_logs/);
    });
});
