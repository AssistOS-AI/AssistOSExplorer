/**
 * Native provider middleware: response filter.
 *
 * Applies regex find/replace patterns to the assistant response after
 * the transport has finished and the buffering middleware has produced
 * a buffered shape on `ctx.response`.  Reads from
 * `ctx.response.choices[0].message.content` (chat completion envelope)
 * or `ctx.response.content` (raw buffered shape).
 *
 * This middleware needs `ctx.response` to be in the buffered shape, so
 * it inline-buffers any remaining canonical stream before it runs.
 *
 * @module runtime/middleware/provider-builtin/provider-response-filter
 */

import { isCanonicalStream } from '../../kernel/canonical-stream.mjs';
import { bufferCanonicalStream } from '../../kernel/response-buffer.mjs';

export const meta = Object.freeze({
    key: 'provider-response-filter',
    name: 'Provider Response Filter',
    description:
        'Applies configurable regex patterns to filter or transform response content (provider-scoped).',
    version: '2.0.0',
    scope: 'provider',
    defaultSettings: Object.freeze({
        patterns: [],
        replacement: '[REDACTED]',
    }),
});

/**
 * @param {object} settings
 * @returns {(ctx: object, next: () => Promise<void>) => Promise<void>}
 */
export function factory(settings = {}) {
    const merged = { ...meta.defaultSettings, ...settings };
    const patterns = Array.isArray(merged.patterns) ? merged.patterns : [];
    const defaultReplacement = merged.replacement;

    return async function providerResponseFilter(ctx, next) {
        await next();

        if (patterns.length === 0) return;
        if (!ctx.response) return;

        // If the chain is in streaming-passthrough mode, ctx.response is
        // still a canonical stream when we reach the post phase.  Drain
        // it inline so the filter can operate on the buffered shape.
        if (isCanonicalStream(ctx.response)) {
            ctx.response = await bufferCanonicalStream(ctx.response);
        } else if (
            ctx.response.stream &&
            isCanonicalStream(ctx.response.stream)
        ) {
            const buffered = await bufferCanonicalStream(ctx.response.stream);
            ctx.response = { ...ctx.response, ...buffered, stream: null };
        }

        // Direct buffered shape: { content }
        if (typeof ctx.response.content === 'string') {
            ctx.response.content = applyPatterns(
                ctx.response.content,
                patterns,
                defaultReplacement
            );
            // Mirror onto message.content if present
            if (
                ctx.response.message &&
                typeof ctx.response.message.content === 'string'
            ) {
                ctx.response.message.content = ctx.response.content;
            }
        }

        // Chat completion envelope: { choices: [{ message: { content } }] }
        const choices = ctx.response.choices;
        if (Array.isArray(choices)) {
            for (const choice of choices) {
                const msg = choice.message || choice.delta;
                if (!msg || typeof msg.content !== 'string') continue;
                msg.content = applyPatterns(
                    msg.content,
                    patterns,
                    defaultReplacement
                );
            }
        }
    };
}

function applyPatterns(text, patterns, defaultReplacement) {
    let result = text;
    for (const pat of patterns) {
        if (!pat.find) continue;
        let regex;
        try {
            regex = new RegExp(pat.find, pat.flags || 'g');
        } catch {
            continue;
        }
        result = result.replace(regex, pat.replace ?? defaultReplacement ?? '');
    }
    return result;
}
