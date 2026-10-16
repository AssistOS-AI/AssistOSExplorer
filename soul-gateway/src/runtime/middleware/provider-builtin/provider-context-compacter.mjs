/**
 * Native provider middleware: context compacter.
 *
 * Summarizes older messages when the total estimated token count
 * exceeds a threshold, while preserving a configurable number of recent
 * messages.  Heuristic: chars / charsPerToken.
 *
 * @module runtime/middleware/provider-builtin/provider-context-compacter
 */

export const meta = Object.freeze({
    key: 'provider-context-compacter',
    name: 'Provider Context Compacter',
    description:
        'Compresses conversation context by summarizing older messages when token limit is exceeded (provider-scoped).',
    version: '2.0.0',
    scope: 'provider',
    defaultSettings: Object.freeze({
        maxTokens: 100_000,
        preserveRecent: 5,
        charsPerToken: 4,
        summaryPrefix: '[Earlier context summarized] ',
    }),
});

/**
 * @param {object} settings
 * @returns {(ctx: object, next: () => Promise<void>) => Promise<void>}
 */
export function factory(settings = {}) {
    const merged = { ...meta.defaultSettings, ...settings };
    const charsPerToken = merged.charsPerToken || 4;
    const maxTokens = merged.maxTokens || 100_000;
    const preserveRecent = merged.preserveRecent || 5;
    const prefix = merged.summaryPrefix || '[Earlier context summarized] ';

    return async function providerContextCompacter(ctx, next) {
        const messages = ctx.request?.messages;
        if (!Array.isArray(messages) || messages.length === 0) {
            await next();
            return;
        }

        // Estimate total tokens
        let totalTokens = 0;
        for (const msg of messages) {
            totalTokens += estimateTokens(messageText(msg), charsPerToken);
        }

        if (totalTokens <= maxTokens) {
            await next();
            return;
        }

        // Separate system messages from non-system messages
        const systemMessages = [];
        const nonSystemMessages = [];
        for (const msg of messages) {
            if (msg.role === 'system') systemMessages.push(msg);
            else nonSystemMessages.push(msg);
        }

        if (nonSystemMessages.length <= preserveRecent) {
            await next();
            return;
        }

        const keepRecent = nonSystemMessages.slice(-preserveRecent);
        const oldMessages = nonSystemMessages.slice(0, -preserveRecent);

        // Build a summary of old messages
        const summaryParts = [];
        for (const msg of oldMessages) {
            const text = messageText(msg);
            const excerpt =
                text.length > 200 ? text.slice(0, 200) + '...' : text;
            summaryParts.push(`[${msg.role}]: ${excerpt}`);
        }

        const summaryMsg = {
            role: 'system',
            content: `${prefix}${summaryParts.join('\n')}`,
        };

        ctx.request.messages = [...systemMessages, summaryMsg, ...keepRecent];

        await next();
    };
}

// ── helpers ────────────────────────────────────────────────────────────

function estimateTokens(text, charsPerToken) {
    if (!text) return 0;
    return Math.ceil(text.length / charsPerToken);
}

function messageText(msg) {
    if (typeof msg.content === 'string') return msg.content;
    if (Array.isArray(msg.content)) {
        return msg.content
            .filter((p) => p.type === 'text')
            .map((p) => p.text || '')
            .join(' ');
    }
    return JSON.stringify(msg.content || '');
}
