/**
 * Shared camelCase → snake_case converter for DAO update queries.
 *
 * @param {string} camel  camelCase column alias (e.g. "displayName")
 * @returns {string}      snake_case column name (e.g. "display_name")
 */
export function toSnake(camel) {
    return camel.replace(/[A-Z]/g, (ch) => '_' + ch.toLowerCase());
}
