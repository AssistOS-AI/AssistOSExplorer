export function isJsonLikeInput(value) {
    const text = String(value ?? '').trim();
    return (text.startsWith('{') && text.endsWith('}')) || (text.startsWith('[') && text.endsWith(']'));
}

export function rejectJsonInput(usage) {
    return `Error: JSON input is not supported. Use positional syntax: ${usage}`;
}

export function normalizeStringInput(promptText, usage) {
    if (typeof promptText !== 'string') {
        return {
            error: `Error: object input is no longer supported. Use positional syntax: ${usage}`,
            text: '',
        };
    }

    const text = promptText.trim();
    if (isJsonLikeInput(text)) {
        return { error: rejectJsonInput(usage), text: '' };
    }

    return { error: null, text };
}

export function tokenizePositionalArgs(text) {
    const args = [];
    let current = '';
    let quote = null;
    let escaping = false;

    for (const char of String(text ?? '')) {
        if (escaping) {
            current += char;
            escaping = false;
            continue;
        }

        if (char === '\\') {
            escaping = true;
            continue;
        }

        if (quote) {
            if (char === quote) {
                quote = null;
            } else {
                current += char;
            }
            continue;
        }

        if (char === '"' || char === "'") {
            quote = char;
            continue;
        }

        if (/\s/.test(char)) {
            if (current) {
                args.push(current);
                current = '';
            }
            continue;
        }

        current += char;
    }

    if (escaping) {
        current += '\\';
    }

    if (quote) {
        return { args: [], error: `Error: unterminated ${quote} quote.` };
    }

    if (current) {
        args.push(current);
    }

    return { args, error: null };
}

export function extractTrailingBlock(text, usage) {
    const input = String(text ?? '');
    const match = input.match(/--begin-([A-Za-z0-9_-]+)--/);
    if (!match) {
        return {
            before: input.trim(),
            content: null,
            token: null,
            error: null,
        };
    }

    const token = match[1];
    const endMarker = `--end-${token}--`;
    const contentStart = match.index + match[0].length;
    const contentEnd = input.indexOf(endMarker, contentStart);

    if (contentEnd === -1) {
        return {
            before: '',
            content: null,
            token,
            error: `Error: missing ${endMarker}. Use positional syntax: ${usage}`,
        };
    }

    const after = input.slice(contentEnd + endMarker.length);
    if (after.trim()) {
        return {
            before: '',
            content: null,
            token,
            error: `Error: multiline block must be the final argument. Use positional syntax: ${usage}`,
        };
    }

    let content = input.slice(contentStart, contentEnd);
    content = content.replace(/^\r?\n/, '').replace(/\r?\n$/, '');

    return {
        before: input.slice(0, match.index).trim(),
        content,
        token,
        error: null,
    };
}

export function parsePositionalInput(promptText, {
    usage,
    minArgs = 0,
    maxArgs = Infinity,
    block = false,
    blockRequired = false,
} = {}) {
    const normalized = normalizeStringInput(promptText, usage);
    if (normalized.error) {
        return { error: normalized.error, args: [], content: null, token: null };
    }

    const extracted = block
        ? extractTrailingBlock(normalized.text, usage)
        : { before: normalized.text, content: null, token: null, error: null };

    if (extracted.error) {
        return { error: extracted.error, args: [], content: null, token: extracted.token };
    }

    if (blockRequired && extracted.content === null) {
        return {
            error: `Error: content block is required. Use positional syntax: ${usage}`,
            args: [],
            content: null,
            token: null,
        };
    }

    const tokenized = tokenizePositionalArgs(extracted.before);
    if (tokenized.error) {
        return { error: tokenized.error, args: [], content: null, token: extracted.token };
    }

    if (tokenized.args.length < minArgs) {
        return {
            error: `Error: expected at least ${minArgs} argument(s). Use positional syntax: ${usage}`,
            args: tokenized.args,
            content: extracted.content,
            token: extracted.token,
        };
    }

    if (tokenized.args.length > maxArgs) {
        return {
            error: `Error: expected at most ${maxArgs} argument(s). Use positional syntax: ${usage}`,
            args: tokenized.args,
            content: extracted.content,
            token: extracted.token,
        };
    }

    return {
        error: null,
        args: tokenized.args,
        content: extracted.content,
        token: extracted.token,
    };
}

export function parseSingleArgInput(promptText, usage) {
    const parsed = parsePositionalInput(promptText, { usage, minArgs: 1, maxArgs: 1 });
    if (parsed.error) {
        return { error: parsed.error, value: null };
    }
    return { error: null, value: parsed.args[0] };
}
