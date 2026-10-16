/**
 * DAO for `gateway_bootstrap_state`: durable completion markers for one-time
 * initialization steps. Functions accept either the pool or a transaction
 * client, so a step can write its marker in the same transaction as its
 * records.
 */

const TABLE = 'gateway_bootstrap_state';

export async function isComplete(db, bootstrapKey) {
    const { rows } = await db.query(
        `SELECT bootstrap_key FROM ${TABLE} WHERE bootstrap_key = $1`,
        [bootstrapKey]
    );
    return rows.length > 0;
}

/**
 * The marker of a step, or `null` when the step never completed.
 *
 * @returns {Promise<{ bootstrapKey: string, version: number, metadata: object }|null>}
 */
export async function getState(db, bootstrapKey) {
    const { rows } = await db.query(
        `SELECT bootstrap_key, version, metadata FROM ${TABLE} WHERE bootstrap_key = $1`,
        [bootstrapKey]
    );
    const row = rows[0];
    if (!row) return null;
    const metadata =
        row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
    return { bootstrapKey: row.bootstrap_key, version: row.version, metadata };
}

export async function markComplete(db, { bootstrapKey, version = 1, metadata = {} }) {
    await db.query(
        `INSERT INTO ${TABLE} (bootstrap_key, version, metadata)
         VALUES ($1, $2, $3)
         ON CONFLICT (bootstrap_key) DO NOTHING`,
        [bootstrapKey, version, JSON.stringify(metadata)]
    );
}

/**
 * Replace the metadata of an existing marker, for a step that records its
 * per-item progress there.
 */
export async function updateMetadata(db, bootstrapKey, metadata = {}) {
    await db.query(
        `UPDATE ${TABLE} SET metadata = $2 WHERE bootstrap_key = $1`,
        [bootstrapKey, JSON.stringify(metadata)]
    );
}
