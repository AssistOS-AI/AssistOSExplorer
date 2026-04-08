/**
 * DAO for the model_aliases table.
 * Pure data-access functions — no business logic.
 */

const TABLE = 'soul_gateway.model_aliases';

export async function create(pool, { alias, modelId }) {
    const { rows } = await pool.query(
        `INSERT INTO ${TABLE} (alias, model_id) VALUES ($1, $2) RETURNING *`,
        [alias, modelId]
    );
    return rows[0];
}

export async function findByAlias(pool, alias) {
    const { rows } = await pool.query(
        `SELECT ma.*, m.model_key
     FROM ${TABLE} ma
     JOIN soul_gateway.models m ON m.id = ma.model_id
     WHERE ma.alias = $1`,
        [alias]
    );
    return rows[0] || null;
}

export async function listByModel(pool, modelId) {
    const { rows } = await pool.query(
        `SELECT * FROM ${TABLE} WHERE model_id = $1 ORDER BY alias ASC`,
        [modelId]
    );
    return rows;
}

export async function deleteByModel(pool, modelId) {
    const { rowCount } = await pool.query(
        `DELETE FROM ${TABLE} WHERE model_id = $1`,
        [modelId]
    );
    return rowCount;
}
