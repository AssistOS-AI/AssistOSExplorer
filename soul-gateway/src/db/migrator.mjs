import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { withMigrationLock } from './advisory-lock.mjs';

/**
 * Run numbered SQL migrations from a directory.
 *
 * Migration files must be named `NNN-description.sql` (e.g., `001-initial-schema.sql`).
 * Each is applied at most once. The `schema_migrations` table tracks applied versions.
 *
 * @param {import('pg').Pool} pool
 * @param {string} migrationsDir - path to the migrations directory
 * @param {object} log - logger
 */
export async function runMigrations(pool, migrationsDir, log) {
    await withMigrationLock(pool, async (client) => {
        // Ensure the tracking table exists
        await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now(),
        checksum   text NOT NULL
      )
    `);

        // Load already-applied versions
        const { rows: applied } = await client.query(
            'SELECT version, checksum FROM schema_migrations ORDER BY version'
        );
        const appliedMap = new Map(applied.map((r) => [r.version, r.checksum]));

        // Read migration files
        const files = await readMigrationFiles(migrationsDir);

        let newCount = 0;
        for (const { version, filename, filePath } of files) {
            const sql = await readFile(filePath, 'utf-8');
            const checksum = createHash('sha256').update(sql).digest('hex');

            if (appliedMap.has(version)) {
                // Verify checksum matches — a changed migration is a fatal error
                if (appliedMap.get(version) !== checksum) {
                    throw new Error(
                        `Migration ${filename} checksum mismatch: applied=${appliedMap.get(version)}, current=${checksum}. ` +
                            `Changing an already-applied migration is not allowed.`
                    );
                }
                continue;
            }

            log.info('applying migration', { version, filename });

            // Run migration in a transaction
            await client.query('BEGIN');
            try {
                await client.query(sql);
                await client.query(
                    'INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)',
                    [version, checksum]
                );
                await client.query('COMMIT');
                newCount++;
            } catch (err) {
                await client.query('ROLLBACK');
                throw new Error(`Migration ${filename} failed: ${err.message}`, { cause: err });
            }
        }

        if (newCount > 0) {
            log.info('migrations complete', { applied: newCount });
        } else {
            log.info('migrations up to date');
        }
    });
}

/**
 * Read and sort migration files from directory.
 */
async function readMigrationFiles(dir) {
    let entries;
    try {
        entries = await readdir(dir);
    } catch (err) {
        if (err.code === 'ENOENT') return [];
        throw err;
    }

    return entries
        .filter((f) => f.endsWith('.sql'))
        .sort()
        .map((filename) => {
            const version = filename.replace(/\.sql$/, '');
            return { version, filename, filePath: join(dir, filename) };
        });
}
