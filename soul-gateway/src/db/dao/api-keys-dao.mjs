/**
 * DAO for the api_keys table.
 * Pure data-access functions — no business logic.
 */
import { updateRow } from './helpers/query-builder.mjs';

const TABLE = 'soul_gateway.api_keys';

export async function create(
    pool,
    {
        label,
        keyHash,
        keyCiphertext,
        keyIv,
        keyAuthTag,
        keyHint,
        rpmLimit = 60,
        tpmLimit = 100000,
        dailyBudgetUsd = null,
        monthlyBudgetUsd = null,
        expiresAt = null,
        metadata = {},
    }
) {
    const { rows } = await pool.query(
        `INSERT INTO ${TABLE}
       (label, key_hash, key_ciphertext, key_iv, key_auth_tag, key_hint,
        rpm_limit, tpm_limit, daily_budget_usd, monthly_budget_usd,
        expires_at, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING *`,
        [
            label,
            keyHash,
            keyCiphertext,
            keyIv,
            keyAuthTag,
            keyHint,
            rpmLimit,
            tpmLimit,
            dailyBudgetUsd,
            monthlyBudgetUsd,
            expiresAt,
            JSON.stringify(metadata),
        ]
    );
    return rows[0];
}

export async function findByHash(pool, keyHash) {
    const { rows } = await pool.query(
        `SELECT * FROM ${TABLE} WHERE key_hash = $1`,
        [keyHash]
    );
    return rows[0] || null;
}

export async function findById(pool, id) {
    const { rows } = await pool.query(`SELECT * FROM ${TABLE} WHERE id = $1`, [
        id,
    ]);
    return rows[0] || null;
}

export async function list(
    pool,
    { status = null, limit = 100, offset = 0 } = {}
) {
    if (status) {
        const { rows } = await pool.query(
            `SELECT * FROM ${TABLE} WHERE status = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
            [status, limit, offset]
        );
        return rows;
    }
    const { rows } = await pool.query(
        `SELECT * FROM ${TABLE} ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
        [limit, offset]
    );
    return rows;
}

const ALLOWED_UPDATE_FIELDS = new Set([
    'label', 'rpmLimit', 'tpmLimit', 'dailyBudgetUsd', 'monthlyBudgetUsd',
    'expiresAt', 'status', 'metadata',
]);

const JSON_FIELDS = new Set(['metadata']);

export async function update(pool, id, fields) {
    return updateRow(pool, TABLE, id, fields, {
        allowedFields: ALLOWED_UPDATE_FIELDS,
        jsonFields: JSON_FIELDS,
    });
}

export async function revoke(pool, id) {
    const { rows } = await pool.query(
        `UPDATE ${TABLE}
     SET status = 'revoked', revoked_at = now(), updated_at = now()
     WHERE id = $1 AND status = 'active'
     RETURNING *`,
        [id]
    );
    return rows[0] || null;
}

export async function updateLastUsed(pool, id) {
    await pool.query(`UPDATE ${TABLE} SET last_used_at = now() WHERE id = $1`, [
        id,
    ]);
}

