/**
 * Native provider middleware: output compressor.
 *
 * Truncates verbose tool/function output in messages before sending to
 * the upstream provider.  Targets tool-role and function-role messages
 * with string content, plus array-style multimodal content text parts.
 *
 * @module runtime/middleware/provider-builtin/provider-output-compressor
 */

export const meta = Object.freeze({
    key: 'provider-output-compressor',
    name: 'Provider Output Compressor',
    description:
        'Truncates verbose tool output in messages to save context window tokens (provider-scoped).',
    version: '2.0.0',
    scope: 'provider',
    defaultSettings: Object.freeze({
        maxOutputLength: 5000,
        truncationMarker: '... [truncated]',
        compressToolMessages: true,
    }),
});

/**
 * @param {object} settings
 * @returns {(ctx: object, next: () => Promise<void>) => Promise<void>}
 */
export function factory(settings = {}) {
    const merged = { ...meta.defaultSettings, ...settings };
    const compressToolMessages = merged.compressToolMessages !== false;
    const maxLen = merged.maxOutputLength || 5000;
    const marker = merged.truncationMarker || '... [truncated]';

    return async function providerOutputCompressor(ctx, next) {
        if (compressToolMessages) {
            const messages = ctx.request?.messages;
            if (Array.isArray(messages)) {
                for (const msg of messages) {
                    // Tool/function role with string content
                    if (
                        (msg.role === 'tool' || msg.role === 'function') &&
                        typeof msg.content === 'string'
                    ) {
                        if (msg.content.length > maxLen) {
                            msg.content =
                                msg.content.slice(0, maxLen - marker.length) +
                                marker;
                        }
                    }

                    // Array-style content (multimodal messages)
                    if (Array.isArray(msg.content)) {
                        for (const part of msg.content) {
                            if (
                                part.type === 'text' &&
                                typeof part.text === 'string' &&
                                part.text.length > maxLen
                            ) {
                                part.text =
                                    part.text.slice(0, maxLen - marker.length) +
                                    marker;
                            }
                        }
                    }
                }
            }
        }
        await next();
    };
}
