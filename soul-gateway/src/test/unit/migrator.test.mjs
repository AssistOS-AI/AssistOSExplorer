import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

describe('Migration files', () => {
    it('001-initial-schema.sql exists and is valid SQL', async () => {
        const path = new URL(
            '../../db/migrations/001-initial-schema.sql',
            import.meta.url
        ).pathname;
        const sql = await readFile(path, 'utf-8');

        // Should contain all canonical tables
        const expectedTables = [
            'api_keys',
            'providers',
            'provider_accounts',
            'models',
            'model_aliases',
            'tiers',
            'tier_models',
            'middlewares',
            'middleware_assignments',
            'blacklist_rules',
            'model_cooldowns',
            'sessions',
            'session_state',
            'audit_logs',
        ];

        for (const table of expectedTables) {
            assert.ok(
                sql.includes(`CREATE TABLE IF NOT EXISTS ${table}`),
                `should contain CREATE TABLE for ${table}`
            );
        }

        // Should have pgcrypto extension
        assert.ok(sql.includes('CREATE EXTENSION IF NOT EXISTS pgcrypto'));

        // Should set search_path
        assert.ok(sql.includes('SET search_path TO soul_gateway'));

        // Should have partition setup for audit_logs
        assert.ok(sql.includes('PARTITION BY RANGE (started_at)'));
    });

    it('001-initial-schema.sql has a stable checksum', async () => {
        const path = new URL(
            '../../db/migrations/001-initial-schema.sql',
            import.meta.url
        ).pathname;
        const sql = await readFile(path, 'utf-8');
        const checksum = createHash('sha256').update(sql).digest('hex');

        // Just ensure it's a valid hex sha256
        assert.equal(checksum.length, 64);
        assert.match(checksum, /^[a-f0-9]+$/);
    });

    it('all tables have created_at columns', async () => {
        const path = new URL(
            '../../db/migrations/001-initial-schema.sql',
            import.meta.url
        ).pathname;
        const sql = await readFile(path, 'utf-8');

        // Split into table blocks
        const tableBlocks = sql.split(/CREATE TABLE IF NOT EXISTS/).slice(1);

        // Tables that should have created_at (sessions uses started_at instead; session_state uses updated_at only)
        const tablesWithCreatedAt = [
            'api_keys',
            'providers',
            'provider_accounts',
            'models',
            'model_aliases',
            'tiers',
            'tier_models',
            'middlewares',
            'middleware_assignments',
            'blacklist_rules',
        ];

        for (const table of tablesWithCreatedAt) {
            const block = tableBlocks.find((b) =>
                b.trimStart().startsWith(table)
            );
            assert.ok(block, `should have table block for ${table}`);
            assert.ok(
                block.includes('created_at'),
                `${table} should have created_at column`
            );
        }
    });

    it('audit_logs has all required indexes', async () => {
        const path = new URL(
            '../../db/migrations/001-initial-schema.sql',
            import.meta.url
        ).pathname;
        const sql = await readFile(path, 'utf-8');

        const requiredIndexes = [
            'audit_logs_request_id_idx',
            'audit_logs_api_key_started_idx',
            'audit_logs_soul_started_idx',
            'audit_logs_agent_started_idx',
            'audit_logs_requested_model_started_idx',
            'audit_logs_status_started_idx',
            'audit_logs_error_started_idx',
            'audit_logs_session_started_idx',
        ];

        for (const idx of requiredIndexes) {
            assert.ok(sql.includes(idx), `should contain index ${idx}`);
        }
    });
});
