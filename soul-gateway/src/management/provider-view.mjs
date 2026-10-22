/**
 * View transform for provider DB rows exposed to the management API.
 *
 * All columns are passed through unchanged. If the backend catalog
 * or another layer starts adding derived fields to provider rows
 * (e.g. `has_accounts`, `health`), this is the natural place to
 * thread them through.
 */

/**
 * @param {object} row  Raw providers DB row
 * @returns {object|null}
 */
const PROVIDER_VIEW_FIELDS = [
    'id',
    'provider_key',
    'display_name',
    'kind',
    'adapter_key',
    'auth_strategy',
    'provider_mode',
    'oauth_adapter_key',
    'base_url',
    'enabled',
    'supports_streaming',
    'supports_tools',
    'supports_messages_api',
    'supports_responses_api',
    'settings',
    'metadata',
    'created_at',
    'updated_at',
];

export function toProviderView(row) {
    if (!row) return null;
    const view = {};
    for (const field of PROVIDER_VIEW_FIELDS) {
        if (field in row) view[field] = row[field];
    }
    return view;
}

/**
 * @param {Array<object>} rows
 * @returns {Array<object>}
 */
export function toProviderList(rows) {
    if (!Array.isArray(rows)) return [];
    return rows.map(toProviderView).filter(Boolean);
}
