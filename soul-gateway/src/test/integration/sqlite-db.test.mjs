import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase, initializeSchema } from '../../db/sqlite-db.mjs';

describe('sqlite database', () => {
    it('opens a fresh database, initializes schema, and returns row results', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'soul-sqlite-'));
        try {
            const sqlitePath = join(dir, 'gateway.sqlite3');
            const db = await openDatabase({ SQLITE_PATH: sqlitePath });
            assert.equal(db.isNewDatabase, true);
            await initializeSchema(db);
            const result = await db.query('SELECT name FROM sqlite_master WHERE type = $1 ORDER BY name', ['table']);
            assert.ok(result.rows.some((row) => row.name === 'api_keys'));
            assert.ok(result.rows.some((row) => row.name === 'audit_logs'));
            await db.end();

            const reopenedDb = await openDatabase({ SQLITE_PATH: sqlitePath });
            assert.equal(reopenedDb.isNewDatabase, false);
            await reopenedDb.end();
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it('disables persisted providers for retired built-in search backends', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'soul-sqlite-'));
        try {
            const sqlitePath = join(dir, 'gateway.sqlite3');
            const db = await openDatabase({ SQLITE_PATH: sqlitePath });
            await initializeSchema(db);
            await db.query(`
                INSERT INTO providers (
                    id, provider_key, display_name, kind, adapter_key,
                    auth_strategy, enabled
                ) VALUES
                    ('p-search', 'duckduckgo', 'DuckDuckGo', 'external_api',
                     'search-builtin', 'none', true),
                    ('p-openai', 'openai', 'OpenAI', 'external_api',
                     'openai-api', 'api_key', true)
            `);
            await db.query(`
                INSERT INTO models (
                    id, model_key, display_name, provider_id,
                    provider_model_id, enabled
                ) VALUES (
                    'm-search', 'duckduckgo/search', 'DuckDuckGo Search',
                    'p-search', 'search', true
                )
            `);
            await db.query(`
                INSERT INTO middleware_bindings (
                    id, scope, target_id, middleware_key, enabled
                ) VALUES
                    ('b-provider', 'provider', 'p-search', 'retry', true),
                    ('b-model', 'model', 'm-search', 'retry', true)
            `);

            const result = await initializeSchema(db);
            assert.deepEqual(result, {
                retiredProviderCount: 1,
                retiredModelCount: 1,
                retiredBindingCount: 2,
            });

            const providers = await db.query(`
                SELECT provider_key, enabled
                FROM providers
                ORDER BY provider_key
            `);
            assert.deepEqual(providers.rows, [
                { provider_key: 'duckduckgo', enabled: false },
                { provider_key: 'openai', enabled: true },
            ]);
            const models = await db.query(`
                SELECT enabled FROM models WHERE id = 'm-search'
            `);
            assert.equal(models.rows[0].enabled, false);
            const bindings = await db.query(`
                SELECT enabled FROM middleware_bindings ORDER BY id
            `);
            assert.deepEqual(
                bindings.rows.map((row) => row.enabled),
                [false, false]
            );
            await db.end();
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});
