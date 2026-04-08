/**
 * DAO for `model_children`.
 *
 * Cascade models have an ordered list of child models they dispatch to.
 * This DAO manages that list — it is the per-parent fallback order
 * that the cascade middleware walks.  The runtime reads this through
 * the snapshot loader; the management API mutates it directly.
 */

const TABLE = 'soul_gateway.model_children';

export async function create(
    pool,
    { parentModelId, childModelId, priority, enabled = true, settings = {} }
) {
    const { rows } = await pool.query(
        `INSERT INTO ${TABLE}
       (parent_model_id, child_model_id, priority, enabled, settings)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
        [
            parentModelId,
            childModelId,
            priority,
            enabled,
            JSON.stringify(settings),
        ]
    );
    return rows[0];
}

export async function listForParent(
    pool,
    parentModelId,
    { enabledOnly = false } = {}
) {
    const enabledClause = enabledOnly ? 'AND mc.enabled = true' : '';
    const { rows } = await pool.query(
        `SELECT mc.*, m.model_key AS child_model_key,
            m.display_name AS child_display_name,
            m.enabled AS child_enabled,
            m.strategy_kind AS child_strategy_kind
     FROM ${TABLE} mc
     JOIN soul_gateway.models m ON m.id = mc.child_model_id
     WHERE mc.parent_model_id = $1 ${enabledClause}
     ORDER BY mc.priority ASC`,
        [parentModelId]
    );
    return rows;
}

export async function listAll(pool) {
    const { rows } = await pool.query(
        `SELECT mc.*, parent.model_key AS parent_model_key,
            child.model_key AS child_model_key
     FROM ${TABLE} mc
     JOIN soul_gateway.models parent ON parent.id = mc.parent_model_id
     JOIN soul_gateway.models child  ON child.id  = mc.child_model_id
     ORDER BY mc.parent_model_id, mc.priority ASC`
    );
    return rows;
}

export async function removeChild(pool, parentModelId, childModelId) {
    const { rowCount } = await pool.query(
        `DELETE FROM ${TABLE}
     WHERE parent_model_id = $1 AND child_model_id = $2`,
        [parentModelId, childModelId]
    );
    return rowCount > 0;
}

export async function reorderChildren(pool, parentModelId, orderedChildIds) {
    const client = pool.connect ? await pool.connect() : pool;
    try {
        await client.query('BEGIN');
        // Two-step reorder so we do not collide with the UNIQUE
        // (parent_model_id, priority) index.  First move every child to a
        // negative priority (which cannot collide), then set the final
        // positive priorities in order.
        for (let i = 0; i < orderedChildIds.length; i++) {
            await client.query(
                `UPDATE ${TABLE} SET priority = $3, updated_at = now()
         WHERE parent_model_id = $1 AND child_model_id = $2`,
                [parentModelId, orderedChildIds[i], -(i + 1)]
            );
        }
        for (let i = 0; i < orderedChildIds.length; i++) {
            await client.query(
                `UPDATE ${TABLE} SET priority = $3, updated_at = now()
         WHERE parent_model_id = $1 AND child_model_id = $2`,
                [parentModelId, orderedChildIds[i], i + 1]
            );
        }
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        if (pool.connect) client.release();
    }
}

export async function replaceChildren(pool, parentModelId, children) {
    const client = pool.connect ? await pool.connect() : pool;
    try {
        await client.query('BEGIN');
        await client.query(`DELETE FROM ${TABLE} WHERE parent_model_id = $1`, [
            parentModelId,
        ]);
        for (const child of children) {
            await client.query(
                `INSERT INTO ${TABLE}
           (parent_model_id, child_model_id, priority, enabled, settings)
         VALUES ($1, $2, $3, $4, $5)`,
                [
                    parentModelId,
                    child.childModelId,
                    child.priority,
                    child.enabled ?? true,
                    JSON.stringify(child.settings || {}),
                ]
            );
        }
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        if (pool.connect) client.release();
    }
}
