/**
 * Response text filter.
 *
 * Applies a sequence of regex-based find/replace patterns to response text.
 * Patterns are applied in order, each one operating on the output of the previous.
 */

/**
 * Apply response filter patterns to text.
 *
 * @param {string} text  The response text to filter
 * @param {Array<{ find: string, replace: string, flags?: string }>} patterns
 * @returns {string} The filtered text
 */
export function applyResponseFilters(text, patterns) {
    if (!text || !Array.isArray(patterns) || patterns.length === 0) return text;

    let result = text;

    for (const pattern of patterns) {
        try {
            const re = new RegExp(pattern.find, pattern.flags || 'g');
            result = result.replace(re, pattern.replace);
        } catch {
            // Invalid regex — skip this pattern
            continue;
        }
    }

    return result;
}
