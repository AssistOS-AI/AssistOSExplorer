/**
 * Shared DAO query helpers.
 *
 * Eliminates the duplicated update-query-building pattern across DAOs.
 */
import { toSnake } from './case-convert.mjs';

/**
 * Build and execute a parameterized UPDATE query against a table.
 *
 * @param {{ query(sql: string, params?: unknown[]): Promise<{ rows: object[] }> }} pool
 * @param {string} table          - fully qualified table name
 * @param {string|number} id      - row primary key
 * @param {object} fields         - camelCase field map from the API caller
 * @param {object} opts
 * @param {Set<string>} opts.allowedFields - only these keys are accepted
 * @param {Set<string>} [opts.jsonFields]  - these values get JSON.stringify()
 * @returns {Promise<object|null>} the updated row, or null if no allowed fields
 */
export async function updateRow(pool, table, id, fields, { allowedFields, jsonFields = new Set() }) {
    const keys = Object.keys(fields).filter((k) => allowedFields.has(k));
    if (keys.length === 0) return null;

    const setClauses = keys.map((k, i) => `${toSnake(k)} = $${i + 2}`);
    const values = keys.map((k) =>
        jsonFields.has(k) ? JSON.stringify(fields[k]) : fields[k]
    );

    const { rows } = await pool.query(
        `UPDATE ${table} SET ${setClauses.join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`,
        [id, ...values]
    );
    return rows[0] || null;
}
