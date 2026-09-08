/**
 * ResultFormatter - Stateless utility functions for formatting skill execution results.
 *
 * Extracted from AchillesCli to reduce file size and improve modularity.
 */

/**
 * Format slash command result for display.
 * Extracts the most relevant content from various result shapes.
 *
 * @param {*} result - The result to format
 * @returns {string} - Formatted result string
 */
export function formatSlashResult(result) {
    if (typeof result === 'string') {
        return result;
    }
    if (result?.result) {
        return typeof result.result === 'string'
            ? result.result
            : JSON.stringify(result.result, null, 2);
    }
    if (result?.output) {
        return result.output;
    }
    return JSON.stringify(result, null, 2);
}

export default {
    formatSlashResult,
};
