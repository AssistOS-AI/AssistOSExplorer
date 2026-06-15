/**
 * DAO for the api_keys table.
 * Pure data-access functions — no business logic.
 *
 * api_keys is signed-subject-only: every row is a deterministic, server-derived
 * record for a Ploinky-signed subject. Rows never store the plaintext key or any
 * ciphertext — only the HMAC `key_hash` (for fast lookup) plus the subject
 * identity, limits, budgets, and status. The subject_id column is UNIQUE, so a
 * given subject maps to exactly one row.
 */
import { randomUUID } from 'node:crypto';
import { updateRow } from './helpers/query-builder.mjs';

const TABLE = 'api_keys';

/**
 * Insert a signed-subject api_keys row.
 *
 * No ciphertext columns exist on this table; callers pass the precomputed
 * `keyHash` (HMAC of the bearer token) and the classified subject identity.
 */
export async function create(
    pool,
    {
        id,
        label,
        keyHash,
        keyHint,
        subjectId,
        subjectType,
        source = 'signed-subject',
        status = 'active',
        rpmLimit = 60,
        tpmLimit = 100000,
        dailyBudgetUsd = null,
        monthlyBudgetUsd = null,
        expiresAt = null,
        metadata = {},
    }
) {
    const rowId = id || randomUUID();
    const { rows } = await pool.query(
        `INSERT INTO ${TABLE}
       (label, subject_id, subject_type, source, key_hash, key_hint,
        rpm_limit, tpm_limit, daily_budget_usd, monthly_budget_usd,
        expires_at, status, metadata, id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     RETURNING *`,
        [
            label,
            subjectId,
            subjectType,
            source,
            keyHash,
            keyHint,
            rpmLimit,
            tpmLimit,
            dailyBudgetUsd,
            monthlyBudgetUsd,
            expiresAt,
            status,
            JSON.stringify(metadata),
            rowId,
        ]
    );
    return rows[0];
}

/**
 * Idempotently create (or re-read) the signed-subject row for a key.
 *
 * The bearer token is deterministic per subject, so two concurrent first uses
 * of the same key both try to INSERT and one loses the race on the
 * `subject_id` / `key_hash` UNIQUE indexes. On a unique violation we re-read the
 * row the winner inserted instead of failing the request, giving every caller
 * one logical row.
 *
 * Revocation semantics (see DS / api-key-auth):
 *   - Revoking the row blocks that deterministic key (caller denies on
 *     status === 'revoked'); this function never reactivates a revoked row.
 *   - Deleting the row permits recreation on the next valid signed request.
 *   - Per-subject rotation requires changing the subject id.
 *   - Rotating the Ploinky signing key invalidates all signed-subject keys.
 *
 * @param {object} pool
 * @param {object} params
 * @param {string} params.keyHash    HMAC of the raw bearer token (precomputed
 *                                    by the auth layer so the pepper stays out
 *                                    of the DAO).
 * @param {string} params.subjectId
 * @param {'agent'|'user'} params.subjectType
 * @param {string} params.keyHint
 */
export async function createSignedSubjectKeyRecord(
    pool,
    {
        keyHash,
        subjectId,
        subjectType,
        keyHint,
        rpmLimit = 60,
        tpmLimit = 100000,
        dailyBudgetUsd = null,
        monthlyBudgetUsd = null,
        metadata = {},
    }
) {
    try {
        return await create(pool, {
            label: subjectId,
            keyHash,
            keyHint,
            subjectId,
            subjectType,
            source: 'signed-subject',
            status: 'active',
            rpmLimit,
            tpmLimit,
            dailyBudgetUsd,
            monthlyBudgetUsd,
            metadata: { ...metadata, subjectId, subjectType, source: 'signed-subject' },
        });
    } catch (error) {
        if (!isUniqueConstraintError(error)) throw error;
        // A concurrent writer won the race; re-read the existing row. The
        // caller is responsible for denying it when status === 'revoked'.
        return await findByHash(pool, keyHash);
    }
}

/**
 * Detect a SQLite UNIQUE-constraint violation surfaced by the embedded
 * node:sqlite facade. node:sqlite raises ERR_SQLITE_ERROR with the message
 * "UNIQUE constraint failed: ..." and the extended result code 2067
 * (SQLITE_CONSTRAINT_UNIQUE). We match on the SQLite shape only — not a
 * Postgres 23505 / "duplicate key" shape — since this deployment is SQLite.
 */
export function isUniqueConstraintError(error) {
    if (!error) return false;
    const message = String(error.message || '');
    const code = String(error.code || '');
    return (
        /UNIQUE constraint failed/i.test(message) ||
        /SQLITE_CONSTRAINT/i.test(code) ||
        /SQLITE_CONSTRAINT/i.test(message) ||
        error.errcode === 2067 ||
        error.errcode === 1555 ||
        error.errcode === 19
    );
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

export async function findBySubjectId(pool, subjectId) {
    const { rows } = await pool.query(
        `SELECT * FROM ${TABLE} WHERE subject_id = $1`,
        [subjectId]
    );
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
