/**
 * DAO for the blacklist_rules table.
 * Pure data-access functions — no business logic.
 */
import { randomUUID } from 'node:crypto';
import { updateRow } from './helpers/query-builder.mjs';

const TABLE = 'blacklist_rules';

export async function create(
    pool,
    {
        ruleKey,
        description,
        matchType,
        pattern,
        caseSensitive = false,
        priority = 100,
        enabled = true,
        metadata = {},
    }
) {
    const { rows } = await pool.query(
        `INSERT INTO ${TABLE}
       (rule_key, description, match_type, pattern, case_sensitive, priority, enabled, metadata, id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
        [
            ruleKey,
            description,
            matchType,
            pattern,
            caseSensitive,
            priority,
            enabled,
            JSON.stringify(metadata),
            randomUUID(),
        ]
    );
    return rows[0];
}

export async function findById(pool, id) {
    const { rows } = await pool.query(`SELECT * FROM ${TABLE} WHERE id = $1`, [
        id,
    ]);
    return rows[0] || null;
}

export async function list(pool, { limit = 500, offset = 0 } = {}) {
    const { rows } = await pool.query(
        `SELECT * FROM ${TABLE} ORDER BY priority ASC, rule_key ASC LIMIT $1 OFFSET $2`,
        [limit, offset]
    );
    return rows;
}

const ALLOWED_UPDATE_FIELDS = new Set([
    'description', 'matchType', 'pattern', 'caseSensitive',
    'priority', 'enabled', 'metadata',
]);

const JSON_FIELDS = new Set(['metadata']);

export async function update(pool, id, fields) {
    return updateRow(pool, TABLE, id, fields, {
        allowedFields: ALLOWED_UPDATE_FIELDS,
        jsonFields: JSON_FIELDS,
    });
}

export async function del(pool, id) {
    const { rowCount } = await pool.query(
        `DELETE FROM ${TABLE} WHERE id = $1`,
        [id]
    );
    return rowCount > 0;
}

export async function listEnabled(pool) {
    const { rows } = await pool.query(
        `SELECT * FROM ${TABLE} WHERE enabled = true ORDER BY priority ASC, rule_key ASC`
    );
    return rows;
}

