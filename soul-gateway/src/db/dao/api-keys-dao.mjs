/**
 * DAO for the api_keys table.
 * Pure data-access functions — no business logic.
 *
 * api_keys is signed-subject-only: every row is a deterministic, server-derived
 * record for a Ploinky-signed subject. Rows never store the plaintext key or any
 * ciphertext. The subject_id column is UNIQUE, so a given subject maps to
 * exactly one row.
 */
import { randomUUID } from 'node:crypto';
import { updateRow } from './helpers/query-builder.mjs';

const TABLE = 'api_keys';

/**
 * Insert a signed-subject api_keys row. No key material is stored; the row is
 * the deterministic record for a subject, keyed uniquely by subject_id.
 */
export async function create(
    pool,
    {
        id,
        label,
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
       (label, subject_id, subject_type, source, key_hint,
        rpm_limit, tpm_limit, daily_budget_usd, monthly_budget_usd,
        expires_at, status, metadata, id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING *`,
        [
            label,
            subjectId,
            subjectType,
            source,
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
 * Find-or-create the signed-subject row for a subject, keyed on subject_id.
 *
 * - If a row already exists, return it UNCHANGED (operator-edited limits and
 *   budgets are never overwritten by a later discovery pass or request).
 * - Otherwise insert one with a derived key_hint and default limits.
 * - On a concurrent first-use race, the loser re-reads the winner's row via the
 *   subject_id UNIQUE index.
 *
 * Revocation semantics (enforced by callers, see api-key-auth.mjs):
 *   - A revoked row is never reactivated here.
 *   - Deleting the row permits recreation on the next valid signed request.
 */
export async function upsertSignedSubjectKey(
    pool,
    {
        subjectId,
        subjectType,
        label = subjectId,
        rpmLimit = 60,
        tpmLimit = 100000,
    }
) {
    const existing = await findBySubjectId(pool, subjectId);
    if (existing) return existing;
    try {
        return await create(pool, {
            label,
            keyHint: buildKeyHint(subjectId),
            subjectId,
            subjectType,
            source: 'signed-subject',
            status: 'active',
            rpmLimit,
            tpmLimit,
            metadata: { subjectId, subjectType, source: 'signed-subject' },
        });
    } catch (error) {
        if (!isUniqueConstraintError(error)) throw error;
        return await findBySubjectId(pool, subjectId);
    }
}

/**
 * Provision a policy row for an admin-created user key. The signed-subject key
 * itself is minted by the router; this records only the subject + limits so the
 * key is listed, limited, and revocable. No key material is stored. Throws the
 * unique-constraint error (see isUniqueConstraintError) if subject_id exists.
 */
export async function provisionUserKey(
    pool,
    {
        subjectId,
        label = subjectId,
        rpmLimit = 60,
        tpmLimit = 100000,
        dailyBudgetUsd = null,
        monthlyBudgetUsd = null,
        expiresAt = null,
    }
) {
    return create(pool, {
        label,
        keyHint: buildKeyHint(subjectId),
        subjectId,
        subjectType: 'user',
        source: 'signed-subject',
        status: 'active',
        rpmLimit,
        tpmLimit,
        dailyBudgetUsd,
        monthlyBudgetUsd,
        expiresAt,
        metadata: { subjectId, subjectType: 'user', source: 'signed-subject' },
    });
}

/** Short, non-secret display hint derived from the subject id. */
function buildKeyHint(value) {
    const str = String(value || '');
    if (str.length <= 12) return str;
    return `${str.slice(0, 8)}...${str.slice(-4)}`;
}

/**
 * Detect a SQLite UNIQUE-constraint violation surfaced by node:sqlite
 * (ERR_SQLITE_ERROR / "UNIQUE constraint failed" / extended code 2067).
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
