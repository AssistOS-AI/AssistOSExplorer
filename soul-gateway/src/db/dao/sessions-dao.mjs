/**
 * DAO for the sessions table.
 * Pure data-access functions — no business logic.
 */

import { randomUUID } from 'node:crypto';

const TABLE = 'sessions';

export async function create(
    pool,
    {
        groupKey,
        groupDisplay,
        sequenceNo,
        apiKeyId,
        soulId = null,
        agentName,
        explicitSessionId = null,
        metadata = {},
    }
) {
    const { rows } = await pool.query(
        `INSERT INTO ${TABLE}
       (group_key, group_display, sequence_no,
        api_key_id, soul_id, agent_name,
        explicit_session_id, metadata, id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
        [
            groupKey,
            groupDisplay,
            sequenceNo,
            apiKeyId,
            soulId,
            agentName,
            explicitSessionId,
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

/**
 * Find or create an implicit session for the given api key + agent pair.
 * An implicit session is the most recent open session without an explicit session ID,
 * that has had activity within the timeout window.
 *
 * If none exists, creates a new one.
 */
export async function findOrCreateImplicit(
    pool,
    { apiKeyId, agentName, soulId = null, timeoutMinutes = 30 }
) {
    const groupKey = `implicit:${apiKeyId}:${agentName}`;

    // Compute the activity cutoff in JS so the comparison uses the same
    // ISO-8601 string format the stored rows use.
    const cutoffIso = new Date(Date.now() - timeoutMinutes * 60_000).toISOString();

    // SQLite is a single connection. Hold an exclusive write transaction
    // (BEGIN IMMEDIATE) for the whole find-or-create so two racing requests
    // for the same (api_key, agent) cannot both insert. The facade serializes
    // a connect()ed client against all other database access, so the recheck/
    // ON CONFLICT dance the previous advisory-lock path needed is unnecessary.
    const client = pool.connect ? await pool.connect() : pool;
    const owned = !!pool.connect;
    try {
        await client.query('BEGIN IMMEDIATE');

        const existing = await client.query(
            `SELECT *
             FROM ${TABLE}
             WHERE api_key_id = $1
               AND agent_name = $2
               AND explicit_session_id IS NULL
               AND status = 'open'
               AND last_activity_at > $3
             ORDER BY last_activity_at DESC
             LIMIT 1`,
            [apiKeyId, agentName, cutoffIso]
        );
        if (existing.rows[0]) {
            await client.query('COMMIT');
            return { session: existing.rows[0], created: false };
        }

        const seqResult = await client.query(
            `SELECT COALESCE(MAX(sequence_no), 0) + 1 AS seq
             FROM ${TABLE}
             WHERE group_key = $1`,
            [groupKey]
        );
        const sequenceNo = seqResult.rows[0]?.seq || 1;

        const inserted = await client.query(
            `INSERT INTO ${TABLE}
                 (id, group_key, group_display, sequence_no,
                  api_key_id, soul_id, agent_name)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             RETURNING *`,
            [
                randomUUID(),
                groupKey,
                `${agentName} #${sequenceNo}`,
                sequenceNo,
                apiKeyId,
                soulId,
                agentName,
            ]
        );
        await client.query('COMMIT');
        return { session: inserted.rows[0], created: true };
    } catch (err) {
        try {
            await client.query('ROLLBACK');
        } catch (rollbackErr) {
            // Connection is already broken; log and surface the
            // original error (which is the actionable one) below.
            console.error('findOrCreateImplicit: ROLLBACK failed', rollbackErr);
        }
        throw err;
    } finally {
        if (owned) client.release();
    }
}

export async function updateActivity(
    pool,
    id,
    { inputTokens = 0, outputTokens = 0 } = {}
) {
    const { rows } = await pool.query(
        `UPDATE ${TABLE}
     SET last_activity_at = now(),
         request_count = request_count + 1,
         input_tokens_total = input_tokens_total + $2,
         output_tokens_total = output_tokens_total + $3
     WHERE id = $1
     RETURNING *`,
        [id, inputTokens, outputTokens]
    );
    return rows[0] || null;
}

export async function close(pool, id) {
    const { rows } = await pool.query(
        `UPDATE ${TABLE}
     SET status = 'closed', ended_at = now()
     WHERE id = $1 AND status = 'open'
     RETURNING *`,
        [id]
    );
    return rows[0] || null;
}

export async function listRecent(
    pool,
    { limit = 50, offset = 0, status = null } = {}
) {
    if (status) {
        const { rows } = await pool.query(
            `SELECT * FROM ${TABLE}
       WHERE status = $1
       ORDER BY last_activity_at DESC
       LIMIT $2 OFFSET $3`,
            [status, limit, offset]
        );
        return rows;
    }
    const { rows } = await pool.query(
        `SELECT * FROM ${TABLE}
     ORDER BY last_activity_at DESC
     LIMIT $1 OFFSET $2`,
        [limit, offset]
    );
    return rows;
}

export async function listByAgent(
    pool,
    agentName,
    { limit = 50, offset = 0 } = {}
) {
    const { rows } = await pool.query(
        `SELECT * FROM ${TABLE}
     WHERE agent_name = $1
     ORDER BY last_activity_at DESC
     LIMIT $2 OFFSET $3`,
        [agentName, limit, offset]
    );
    return rows;
}
