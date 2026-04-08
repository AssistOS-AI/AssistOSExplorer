/**
 * Built-in middleware: Context Compressor
 *
 * Compresses older conversation context when the prompt grows past a
 * heuristic token threshold.
 */

export const meta = Object.freeze({
    key: 'context-compressor',
    name: 'Context Compressor',
    description:
        'Compresses conversation context by summarizing older messages when token limit is exceeded.',
    version: '2.0.0',
    scope: 'gateway',
    defaultSettings: Object.freeze({
        maxTokens: 100_000,
        preserveRecent: 10,
        charsPerToken: 4,
        summaryPrefix: '[Earlier context summarized] ',
    }),
});

export function factory(settings = {}) {
    const merged = { ...meta.defaultSettings, ...settings };
    const charsPerToken = merged.charsPerToken || 4;
    const maxTokens = merged.maxTokens || 100_000;
    const preserveRecent = merged.preserveRecent || 10;
    const prefix = merged.summaryPrefix || '[Earlier context summarized] ';

    return async function contextCompressor(ctx, next) {
        const messages = ctx.request?.messages;
        if (!Array.isArray(messages) || messages.length === 0) {
            await next();
            return;
        }

        let totalTokens = 0;
        for (const message of messages) {
            totalTokens += estimateTokens(messageText(message), charsPerToken);
        }

        if (totalTokens > maxTokens) {
            ctx.log.info('Context compression triggered', {
                estimatedTokens: totalTokens,
                maxTokens,
                messageCount: messages.length,
            });

            const systemMessages = [];
            const nonSystemMessages = [];
            for (const message of messages) {
                if (message.role === 'system') {
                    systemMessages.push(message);
                } else {
                    nonSystemMessages.push(message);
                }
            }

            if (nonSystemMessages.length > preserveRecent) {
                const keepRecent = nonSystemMessages.slice(-preserveRecent);
                const oldMessages = nonSystemMessages.slice(0, -preserveRecent);
                const summaryParts = [];

                for (const message of oldMessages) {
                    const text = messageText(message);
                    const excerpt =
                        text.length > 200 ? text.slice(0, 200) + '...' : text;
                    summaryParts.push(`[${message.role}]: ${excerpt}`);
                }

                const summaryMsg = {
                    role: 'system',
                    content: `${prefix}${summaryParts.join('\n')}`,
                };

                ctx.request.messages = [...systemMessages, summaryMsg, ...keepRecent];

                ctx.log.info('Context compressed', {
                    originalCount: messages.length,
                    newCount: ctx.request.messages.length,
                    removedMessages: oldMessages.length,
                });
            }
        }

        await next();
    };
}

function estimateTokens(text, charsPerToken) {
    if (!text) return 0;
    return Math.ceil(text.length / charsPerToken);
}

function messageText(message) {
    if (typeof message.content === 'string') return message.content;
    if (Array.isArray(message.content)) {
        return message.content
            .filter((part) => part.type === 'text')
            .map((part) => part.text || '')
            .join(' ');
    }
    return JSON.stringify(message.content || '');
}
