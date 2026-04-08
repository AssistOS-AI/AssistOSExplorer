/**
 * Built-in middleware: Request Logger
 *
 * Logs request ingress and completion metadata.
 */

export const meta = Object.freeze({
    key: 'request-logger',
    name: 'Request Logger',
    description: 'Logs request start and response metadata for observability.',
    version: '2.0.0',
    scope: 'gateway',
    defaultSettings: Object.freeze({
        logRequestBody: false,
        logResponseBody: false,
        excerptChars: 200,
    }),
});

export function factory(settings = {}) {
    const merged = { ...meta.defaultSettings, ...settings };

    return async function requestLogger(ctx, next) {
        const request = ctx.request || {};
        ctx.state?.set?.('request-logger:startMs', Date.now());

        const entry = {
            model: request.model,
            messageCount: request.messages?.length ?? 0,
            keyId: ctx.auth?.keyId || 'anonymous',
            stream: !!request.stream,
        };

        if (merged.logRequestBody && request.messages?.length > 0) {
            const last = request.messages[request.messages.length - 1];
            const text =
                typeof last.content === 'string'
                    ? last.content
                    : JSON.stringify(last.content || '');
            const maxChars = merged.excerptChars || 200;
            entry.lastMessageExcerpt =
                text.length > maxChars ? text.slice(0, maxChars) + '...' : text;
        }

        ctx.log.info('Request start', entry);

        await next();

        const startMs = ctx.state?.get?.('request-logger:startMs') || Date.now();
        const latencyMs = Date.now() - startMs;
        const usage = ctx.response?.usage ?? ctx.usage;
        const responseEntry = {
            model: request.model,
            keyId: ctx.auth?.keyId || 'anonymous',
            latencyMs,
        };

        if (usage) {
            responseEntry.promptTokens =
                usage.prompt_tokens ?? usage.promptTokens ?? 0;
            responseEntry.completionTokens =
                usage.completion_tokens ?? usage.completionTokens ?? 0;
            responseEntry.totalTokens =
                usage.total_tokens ?? usage.totalTokens ?? 0;
        }

        if (merged.logResponseBody && ctx.response) {
            const text = extractResponseText(ctx.response);
            const maxChars = merged.excerptChars || 200;
            responseEntry.responseExcerpt =
                text.length > maxChars ? text.slice(0, maxChars) + '...' : text;
        }

        ctx.log.info('Request complete', responseEntry);
    };
}

function extractResponseText(response) {
    if (!response) return '';
    if (typeof response === 'string') return response;
    const choices = response.choices || [];
    if (choices.length > 0) {
        const message = choices[0].message || {};
        return typeof message.content === 'string' ? message.content : '';
    }
    return '';
}
