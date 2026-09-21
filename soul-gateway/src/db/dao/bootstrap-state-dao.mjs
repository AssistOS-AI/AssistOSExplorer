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

export async function markComplete(db, { bootstrapKey, version = 1, metadata = {} }) {
    await db.query(
        `INSERT INTO ${TABLE} (bootstrap_key, version, metadata)
         VALUES ($1, $2, $3)
         ON CONFLICT (bootstrap_key) DO NOTHING`,
        [bootstrapKey, version, JSON.stringify(metadata)]
    );
}
