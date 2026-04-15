/**
 * DAO for the sessions table.
 * Pure data-access functions — no business logic.
 */

const TABLE = 'soul_gateway.sessions';

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
        explicit_session_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
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

    // Concurrency model:
    //   1. Open an explicit READ COMMITTED transaction on a checked-out
    //      client so every statement shares one connection.
    //   2. Take pg_advisory_xact_lock(hashtext(group_key)) — serialized
    //      per group for the lifetime of this transaction.
    //   3. Each subsequent statement observes a FRESH snapshot of
    //      committed data (READ COMMITTED re-reads per statement), so
    //      the recheck below sees any row a peer committed while we
    //      were blocked on the advisory lock.
    //   4. Insert with ON CONFLICT (group_key, sequence_no) DO NOTHING.
    //      Under the lock this should never collide, but the clause is
    //      kept as defense-in-depth. If it ever does, we retry once by
    //      reading the existing open row again.
    //
    // A single-statement CTE is NOT sufficient here: the SELECT part of
    // a CTE freezes its snapshot BEFORE the advisory lock inside the
    // same statement grants, so a concurrent commit during the wait
    // would be invisible to the recheck.
    const client = pool.connect ? await pool.connect() : pool;
    const owned = !!pool.connect;
    try {
        await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
            groupKey,
        ]);

        const existing = await client.query(
            `SELECT *
             FROM ${TABLE}
             WHERE api_key_id = $1
               AND agent_name = $2
               AND explicit_session_id IS NULL
               AND status = 'open'
               AND last_activity_at > now() - ($3 || ' minutes')::interval
             ORDER BY last_activity_at DESC
             LIMIT 1`,
            [apiKeyId, agentName, String(timeoutMinutes)]
        );
        if (existing.rows[0]) {
            await client.query('COMMIT');
            return { session: existing.rows[0], created: false };
        }

        const inserted = await client.query(
            `WITH next AS (
                 SELECT COALESCE(MAX(sequence_no), 0) + 1 AS seq
                 FROM ${TABLE}
                 WHERE group_key = $1
             )
             INSERT INTO ${TABLE}
                 (group_key, group_display, sequence_no,
                  api_key_id, soul_id, agent_name)
             SELECT $1, $2 || ' #' || next.seq, next.seq, $3, $4, $2
             FROM next
             ON CONFLICT (group_key, sequence_no) DO NOTHING
             RETURNING *`,
            [groupKey, agentName, apiKeyId, soulId]
        );
        if (inserted.rows[0]) {
            await client.query('COMMIT');
            return { session: inserted.rows[0], created: true };
        }

        // Defense-in-depth: advisory lock should have prevented this,
        // but if a conflict happened, another session now exists for
        // the computed sequence_no. Re-read the open row and return it.
        const recheck = await client.query(
            `SELECT *
             FROM ${TABLE}
             WHERE api_key_id = $1
               AND agent_name = $2
               AND explicit_session_id IS NULL
               AND status = 'open'
             ORDER BY last_activity_at DESC
             LIMIT 1`,
            [apiKeyId, agentName]
        );
        await client.query('COMMIT');
        if (!recheck.rows[0]) {
            throw new Error(
                `findOrCreateImplicit: insert conflicted on (${groupKey}, sequence_no) but no open session exists after recheck`
            );
        }
        return { session: recheck.rows[0], created: false };
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
