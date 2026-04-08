/**
 * PostgreSQL advisory lock for migration serialization.
 * Uses a fixed lock ID so only one process runs migrations at a time.
 */
const MIGRATION_LOCK_ID = 7_301_042; // arbitrary unique int

export async function withMigrationLock(pool, fn) {
    const client = await pool.connect();
    try {
        // Blocking advisory lock — waits until acquired
        await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
        try {
            return await fn(client);
        } finally {
            await client.query('SELECT pg_advisory_unlock($1)', [
                MIGRATION_LOCK_ID,
            ]);
        }
    } finally {
        client.release();
    }
}
