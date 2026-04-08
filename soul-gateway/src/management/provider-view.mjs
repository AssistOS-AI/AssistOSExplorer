/**
 * View transform for provider DB rows exposed to the dashboard.
 *
 * The dashboard (and the old gateway's HTTP contract) uses `name` as
 * the provider identifier; the new `providers` table stores it in
 * `provider_key`. Rather than touching every dashboard call site —
 * or renaming the column — alias `name` in the view layer so both
 * resolve to the same value.
 *
 * All other columns are passed through unchanged. If the backend
 * catalog or another layer starts adding derived fields to provider
 * rows (e.g. `has_accounts`, `health`), this is the natural place
 * to thread them through.
 */

/**
 * @param {object} row  Raw providers DB row
 * @returns {object|null}
 */
export function toProviderView(row) {
    if (!row) return null;
    return {
        ...row,
        name: row.provider_key || row.name || null,
    };
}

/**
 * @param {Array<object>} rows
 * @returns {Array<object>}
 */
export function toProviderList(rows) {
    if (!Array.isArray(rows)) return [];
    return rows.map(toProviderView).filter(Boolean);
}
