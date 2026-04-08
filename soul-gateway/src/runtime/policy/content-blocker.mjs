/**
 * Content blacklist evaluator.
 *
 * Checks incoming message content against a set of blocking rules.
 * Supports exact, substring, and regex match types.
 */

/**
 * Evaluate message content against blacklist rules.
 *
 * @param {Array<{ pattern: string, matchType: string, caseSensitive?: boolean }>} rules
 * @param {Array<{ role: string, content: string }>} messages
 * @returns {{ blocked: boolean, matchedRule?: object, matchedText?: string }}
 */
export function evaluateBlacklist(rules, messages) {
    if (!Array.isArray(rules) || rules.length === 0) return { blocked: false };
    if (!Array.isArray(messages) || messages.length === 0)
        return { blocked: false };

    for (const msg of messages) {
        const content = typeof msg.content === 'string' ? msg.content : '';
        if (!content) continue;

        for (const rule of rules) {
            const matched = testRule(rule, content);
            if (matched) {
                return {
                    blocked: true,
                    matchedRule: rule,
                    matchedText: matched,
                };
            }
        }
    }

    return { blocked: false };
}

// ── internals ─────────────────────────────────────────────────────────

/**
 * Test a single rule against a content string.
 *
 * @param {{ pattern: string, matchType: string, caseSensitive?: boolean }} rule
 * @param {string} content
 * @returns {string|null} The matched text, or null
 */
function testRule(rule, content) {
    const { pattern, matchType, caseSensitive = true } = rule;

    if (matchType === 'exact') {
        if (caseSensitive) {
            return content === pattern ? content : null;
        }
        return content.toLowerCase() === pattern.toLowerCase() ? content : null;
    }

    if (matchType === 'substring') {
        const haystack = caseSensitive ? content : content.toLowerCase();
        const needle = caseSensitive ? pattern : pattern.toLowerCase();
        const idx = haystack.indexOf(needle);
        if (idx !== -1) {
            return content.substring(idx, idx + pattern.length);
        }
        return null;
    }

    if (matchType === 'regex') {
        try {
            const flags = caseSensitive ? '' : 'i';
            const re = new RegExp(pattern, flags);
            const match = re.exec(content);
            return match ? match[0] : null;
        } catch {
            // Invalid regex — treat as no match
            return null;
        }
    }

    return null;
}
