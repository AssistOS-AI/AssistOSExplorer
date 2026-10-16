/**
 * Built-in middleware: Session Context
 *
 * Maintains a rolling in-memory session summary and injects it into
 * subsequent requests.
 */

export const meta = Object.freeze({
    key: 'session-context',
    name: 'Session Context',
    description:
        'Maintains and injects a rolling session summary across requests.',
    version: '2.0.0',
    scope: 'gateway',
    defaultSettings: Object.freeze({
        maxSummaryTokens: 1000,
        charsPerToken: 4,
        summaryRole: 'system',
        summaryPrefix: '[Session summary] ',
    }),
});

const _summaries = new Map();

export function factory(settings = {}) {
    const merged = { ...meta.defaultSettings, ...settings };

    return async function sessionContext(ctx, next) {
        const sessionId = ctx.session?.key || 'default';
        const summary = _summaries.get(sessionId);

        if (summary) {
            const prefix = merged.summaryPrefix || '[Session summary] ';
            if (!Array.isArray(ctx.request?.messages)) {
                ctx.request.messages = [];
            }

            ctx.request.messages.unshift({
                role: merged.summaryRole || 'system',
                content: `${prefix}${summary}`,
            });

            ctx.log.debug('Session context injected', {
                sessionId,
                summaryLength: summary.length,
            });
        }

        await next();

        const maxChars =
            (merged.maxSummaryTokens || 1000) * (merged.charsPerToken || 4);
        const responseText = extractResponseText(ctx.response);
        if (!responseText) {
            return;
        }

        const excerpt =
            responseText.length > 500 ? responseText.slice(0, 500) : responseText;
        const existing = _summaries.get(sessionId) || '';
        let updated = existing ? `${existing}\n- ${excerpt}` : excerpt;

        if (updated.length > maxChars) {
            updated = updated.slice(-maxChars);
            const nl = updated.indexOf('\n');
            if (nl > 0 && nl < 200) {
                updated = updated.slice(nl + 1);
            }
        }

        _summaries.set(sessionId, updated);
        ctx.log.debug('Session context updated', {
            sessionId,
            summaryLength: updated.length,
        });
    };
}

function extractResponseText(response) {
    if (!response) return '';
    if (typeof response === 'string') return response;
    const choices = response.choices || [];
    if (choices.length > 0) {
        const message = choices[0].message || choices[0].delta || {};
        return typeof message.content === 'string' ? message.content : '';
    }
    return '';
}

export function _resetSummaries() {
    _summaries.clear();
}

export function _getSummary(sessionId) {
    return _summaries.get(sessionId) || null;
}

export function _setSummary(sessionId, text) {
    _summaries.set(sessionId, text);
}
