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
});
