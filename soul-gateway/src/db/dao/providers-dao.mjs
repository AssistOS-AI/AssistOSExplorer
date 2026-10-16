/**
 * DAO for the providers table.
 * Pure data-access functions — no business logic.
 */
import { randomUUID } from 'node:crypto';
import { updateRow } from './helpers/query-builder.mjs';

const TABLE = 'providers';

export async function create(
    pool,
    {
        providerKey,
        displayName,
        kind,
        adapterKey,
        authStrategy,
        providerMode = 'external_api',
        oauthAdapterKey = null,
        baseUrl = null,
        enabled = true,
        supportsStreaming = true,
        supportsTools = true,
        supportsMessagesApi = false,
        supportsResponsesApi = false,
        settings = {},
        metadata = {},
    }
) {
    const id = randomUUID();
    const { rows } = await pool.query(
        `INSERT INTO ${TABLE}
       (provider_key, display_name, kind, adapter_key, auth_strategy,
        provider_mode,
        oauth_adapter_key, base_url, enabled,
        supports_streaming, supports_tools,
        supports_messages_api, supports_responses_api,
        settings, metadata, id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
     RETURNING *`,
        [
            providerKey,
            displayName,
            kind,
            adapterKey,
            authStrategy,
            providerMode,
            oauthAdapterKey,
            baseUrl,
            enabled,
            supportsStreaming,
            supportsTools,
            supportsMessagesApi,
            supportsResponsesApi,
            JSON.stringify(settings),
            JSON.stringify(metadata),
            id,
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

export async function findByKey(pool, providerKey) {
    const { rows } = await pool.query(
        `SELECT * FROM ${TABLE} WHERE provider_key = $1`,
        [providerKey]
    );
    return rows[0] || null;
}

export async function list(
    pool,
    { enabled = null, kind = null, limit = 200, offset = 0 } = {}
) {
    const conditions = [];
    const params = [];
    let idx = 1;

    if (enabled !== null) {
        conditions.push(`enabled = $${idx++}`);
        params.push(enabled);
    }
    if (kind !== null) {
        conditions.push(`kind = $${idx++}`);
        params.push(kind);
    }

    const where =
        conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(limit, offset);

    const { rows } = await pool.query(
        `SELECT * FROM ${TABLE} ${where} ORDER BY display_name ASC LIMIT $${idx++} OFFSET $${idx}`,
        params
    );
    return rows;
}

const ALLOWED_UPDATE_FIELDS = new Set([
    'displayName', 'kind', 'adapterKey', 'authStrategy', 'providerMode',
    'oauthAdapterKey', 'baseUrl', 'enabled',
    'supportsStreaming', 'supportsTools',
    'supportsMessagesApi', 'supportsResponsesApi',
    'settings', 'metadata',
]);

const JSON_FIELDS = new Set(['settings', 'metadata']);

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

