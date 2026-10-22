/**
 * DAO for `model_tombstones`: provider-synced model keys an administrator
 * deleted, so a later catalog sync does not recreate them.
 */

const TABLE = 'model_tombstones';

/**
 * Delete a model row and, when the row was created by a catalog sync, record
 * its tombstone in the same transaction, so a crash between the two steps
 * can never leave a deleted synced model recreatable.
 *
 * @returns {Promise<{ deleted: boolean, tombstoned: boolean }>}
 */
export async function deleteModelRecordingTombstone(pool, modelId) {
    const client = pool.connect ? await pool.connect() : pool;
    try {
        await client.query('BEGIN IMMEDIATE');
        const { rows } = await client.query(
            `SELECT model_key, provider_id, discovery_source
               FROM models WHERE id = $1`,
            [modelId]
        );
        const row = rows[0];
        if (!row) {
            await client.query('ROLLBACK');
            return { deleted: false, tombstoned: false };
        }
        await client.query('DELETE FROM models WHERE id = $1', [modelId]);
        const tombstoned =
            row.discovery_source !== 'manual' && row.provider_id != null;
        if (tombstoned) {
            await client.query(
                `INSERT INTO ${TABLE} (provider_id, model_key)
                 VALUES ($1, $2)
                 ON CONFLICT (provider_id, model_key) DO NOTHING`,
                [row.provider_id, row.model_key]
            );
        }
        await client.query('COMMIT');
        return { deleted: true, tombstoned };
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        if (pool.connect) client.release();
    }
}

/**
 * @returns {Promise<Set<string>>} tombstoned model keys of one provider
 */
export async function listKeysForProvider(db, providerId) {
    const { rows } = await db.query(
        `SELECT model_key FROM ${TABLE} WHERE provider_id = $1`,
        [providerId]
    );
    return new Set(rows.map((row) => row.model_key));
}

export async function clear(db, { providerId, modelKey }) {
    const { rowCount } = await db.query(
        `DELETE FROM ${TABLE} WHERE provider_id = $1 AND model_key = $2`,
        [providerId, modelKey]
    );
    return rowCount > 0;
}
