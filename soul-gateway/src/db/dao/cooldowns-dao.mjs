/**
 * DAO for the model_cooldowns table.
 * Pure data-access functions — no business logic.
 */

import { randomUUID } from 'node:crypto';

const TABLE = 'model_cooldowns';

export async function create(
    pool,
    {
        modelId,
        sourceAccountId = null,
        requestId = null,
        reasonType,
        reasonMessage = null,
        expiresAt,
        metadata = {},
    }
) {
    const { rows } = await pool.query(
        `INSERT INTO ${TABLE}
       (model_id, source_account_id, request_id,
        reason_type, reason_message, expires_at, metadata, id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
        [
            modelId,
            sourceAccountId,
            requestId,
            reasonType,
            reasonMessage,
            expiresAt,
            JSON.stringify(metadata),
            randomUUID(),
        ]
    );
    return rows[0];
}

/**
 * Find the active (un-cleared, non-expired) cooldown for a model.
 * Returns null if the model is not currently in cooldown.
 */
export async function findActiveByModel(pool, modelId) {
    const { rows } = await pool.query(
        `SELECT * FROM ${TABLE}
     WHERE model_id = $1
       AND cleared_at IS NULL
       AND expires_at > now()
     LIMIT 1`,
        [modelId]
    );
    return rows[0] || null;
}

/**
 * List all currently active cooldowns (un-cleared and not expired).
 */
export async function listActive(pool) {
    const { rows } = await pool.query(
        `SELECT cd.*, m.model_key
     FROM ${TABLE} cd
     JOIN models m ON m.id = cd.model_id
     WHERE cd.cleared_at IS NULL
       AND cd.expires_at > now()
     ORDER BY cd.expires_at ASC`
    );
    return rows;
}

export async function clearByModel(pool, modelId, clearedBy = 'system') {
    const { rowCount } = await pool.query(
        `UPDATE ${TABLE}
     SET cleared_at = now(), cleared_by = $2
     WHERE model_id = $1 AND cleared_at IS NULL`,
        [modelId, clearedBy]
    );
    return rowCount;
}

export async function clearAll(pool, clearedBy = 'system') {
    const { rowCount } = await pool.query(
        `UPDATE ${TABLE}
     SET cleared_at = now(), cleared_by = $1
     WHERE cleared_at IS NULL`,
        [clearedBy]
    );
    return rowCount;
}

/**
 * Delete cooldowns whose expires_at has passed (housekeeping).
 */
export async function deleteExpired(pool) {
    const { rowCount } = await pool.query(
        `DELETE FROM ${TABLE} WHERE expires_at < now()`
    );
    return rowCount;
}
