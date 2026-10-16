/**
 * Built-in middleware: Output Compressor
 *
 * Truncates verbose tool/function output in request messages.
 */

export const meta = Object.freeze({
    key: 'output-compressor',
    name: 'Output Compressor',
    description:
        'Truncates verbose tool output in messages to save context window tokens.',
    version: '2.0.0',
    scope: 'gateway',
    defaultSettings: Object.freeze({
        maxOutputLength: 8000,
        truncationMarker: '\n... [output truncated] ...',
    }),
});

export function factory(settings = {}) {
    const merged = { ...meta.defaultSettings, ...settings };
    const maxLen = merged.maxOutputLength || 8000;
    const marker = merged.truncationMarker || '\n... [output truncated] ...';

    return async function outputCompressor(ctx, next) {
        const messages = ctx.request?.messages;
        let truncatedCount = 0;

        if (Array.isArray(messages)) {
            for (const message of messages) {
                if (
                    (message.role === 'tool' || message.role === 'function') &&
                    typeof message.content === 'string' &&
                    message.content.length > maxLen
                ) {
                    message.content =
                        message.content.slice(0, maxLen - marker.length) + marker;
                    truncatedCount++;
                }

                if (Array.isArray(message.content)) {
                    for (const part of message.content) {
                        if (
                            part.type === 'text' &&
                            typeof part.text === 'string' &&
                            part.text.length > maxLen
                        ) {
                            part.text =
                                part.text.slice(0, maxLen - marker.length) + marker;
                            truncatedCount++;
                        }
                    }
                }
            }
        }

        if (truncatedCount > 0) {
            ctx.log.debug('Output compressed', {
                truncatedMessages: truncatedCount,
                maxLength: maxLen,
            });
        }

        await next();
    };
}
