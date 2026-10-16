/**
 * Parse command line input - handles quoted strings, escape sequences
 */

export function parseCommandLine(prompt) {
    const input = String(prompt || '').trim();
    if (!input) return { command: null, args: [], raw: '' };

    const tokens = tokenize(input);
    if (tokens.length === 0) return { command: null, args: [], raw: input };

    return {
        command: tokens[0],
        args: tokens.slice(1),
        raw: input
    };
}

function tokenize(input) {
    const tokens = [];
    let current = '';
    let inQuote = false;
    let quoteChar = null;
    let escape = false;

    for (const char of input) {
        if (escape) {
            current += char;
            escape = false;
            continue;
        }
        if (char === '\\') {
            escape = true;
            continue;
        }
        if ((char === '"' || char === "'") && !inQuote) {
            inQuote = true;
            quoteChar = char;
        } else if (char === quoteChar && inQuote) {
            inQuote = false;
            quoteChar = null;
        } else if (char === ' ' && !inQuote) {
            if (current) {
                tokens.push(current);
                current = '';
            }
        } else {
            current += char;
        }
    }

    if (current) tokens.push(current);
    return tokens;
}
