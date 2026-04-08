/**
 * DAO for `middleware_bindings`.
 *
 * One table holds every middleware binding the runtime consults, keyed
 * by `(scope, target_id)`:
 *
 *   - `scope='gateway'` — the binding applies to every request.
 *     `target_id` is null.
 *   - `scope='model'`   — the binding applies to a specific model
 *     (direct or cascade).  `target_id` is the model id.
 *   - `scope='provider'` — the binding applies to every request
 *     dispatched to a specific provider.  `target_id` is the provider id.
 *
 * The DAO is pure data access.  Kernel composition happens in
 * `MiddlewareCatalog.resolveBindings(...)`.
 */

const TABLE = 'soul_gateway.middleware_bindings';

export async function create(
    pool,
    {
        scope,
        targetId = null,
        middlewareKey,
        sortOrder = 100,
        enabled = true,
        settings = {},
    }
) {
    const { rows } = await pool.query(
        `INSERT INTO ${TABLE}
       (scope, target_id, middleware_key, sort_order, enabled, settings)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
        [
            scope,
            targetId,
            middlewareKey,
            sortOrder,
            enabled,
            JSON.stringify(settings),
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

export async function listAll(pool) {
    const { rows } = await pool.query(
        `SELECT * FROM ${TABLE} ORDER BY scope, target_id NULLS FIRST, sort_order ASC`
    );
    return rows;
}

export async function listByScope(pool, scope, { enabledOnly = false } = {}) {
    const enabledClause = enabledOnly ? 'AND enabled = true' : '';
    const { rows } = await pool.query(
        `SELECT * FROM ${TABLE} WHERE scope = $1 ${enabledClause} ORDER BY sort_order ASC`,
        [scope]
    );
    return rows;
}

export async function listByTarget(
    pool,
    scope,
    targetId,
    { enabledOnly = false } = {}
) {
    const enabledClause = enabledOnly ? 'AND enabled = true' : '';
    const { rows } = await pool.query(
        `SELECT * FROM ${TABLE}
     WHERE scope = $1 AND target_id = $2 ${enabledClause}
     ORDER BY sort_order ASC`,
        [scope, targetId]
    );
    return rows;
}

export async function update(pool, id, fields) {
    const keys = Object.keys(fields);
    if (keys.length === 0) return null;

    const jsonFields = new Set(['settings']);
    const setClauses = keys.map((k, i) => `${toSnake(k)} = $${i + 2}`);
    const values = keys.map((k) =>
        jsonFields.has(k) ? JSON.stringify(fields[k]) : fields[k]
    );

    const { rows } = await pool.query(
        `UPDATE ${TABLE} SET ${setClauses.join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`,
        [id, ...values]
    );
    return rows[0] || null;
}

export async function del(pool, id) {
    const { rowCount } = await pool.query(
        `DELETE FROM ${TABLE} WHERE id = $1`,
        [id]
    );
    return rowCount > 0;
}

/**
 * Reorder a set of bindings within the same scope+target.  Accepts an
 * array of `{ id, sortOrder }` and updates them transactionally.
 */
export async function reorder(pool, bindings) {
    const client = pool.connect ? await pool.connect() : pool;
    try {
        await client.query('BEGIN');
        for (const { id, sortOrder } of bindings) {
            await client.query(
                `UPDATE ${TABLE} SET sort_order = $2, updated_at = now() WHERE id = $1`,
                [id, sortOrder]
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

/**
 * Load every enabled binding joined with the middleware definition so
 * the snapshot loader gets settings + module path in one round trip.
 */
export async function listEnabledWithMiddleware(pool) {
    const { rows } = await pool.query(
        `SELECT b.*, mw.middleware_key AS mw_key, mw.module_path,
            mw.source_type, mw.default_settings AS middleware_default_settings
     FROM ${TABLE} b
     LEFT JOIN soul_gateway.middlewares mw ON mw.middleware_key = b.middleware_key
     WHERE b.enabled = true
     ORDER BY b.scope, b.target_id NULLS FIRST, b.sort_order ASC`
    );
    return rows;
}

function toSnake(camel) {
    return camel.replace(/[A-Z]/g, (ch) => '_' + ch.toLowerCase());
}
