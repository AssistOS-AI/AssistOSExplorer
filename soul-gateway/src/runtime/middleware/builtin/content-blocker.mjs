/**
 * Built-in middleware: Content Blocker
 *
 * Blocks requests whose messages match configurable blacklist patterns.
 */

export const meta = Object.freeze({
    key: 'content-blocker',
    name: 'Content Blocker',
    description:
        'Blocks requests whose messages match configurable blacklist patterns.',
    version: '2.0.0',
    scope: 'gateway',
    defaultSettings: Object.freeze({
        rules: [],
    }),
});

export function factory(settings = {}) {
    const merged = { ...meta.defaultSettings, ...settings };

    return async function contentBlocker(ctx, next) {
        const rules = merged.rules;
        if (Array.isArray(rules) && rules.length > 0) {
            const messages = ctx.request?.messages || [];
            const fullText = messages
                .map((message) =>
                    typeof message.content === 'string'
                        ? message.content
                        : JSON.stringify(message.content || '')
                )
                .join('\n');

            for (const rule of rules) {
                if (!rule.pattern) continue;

                let regex;
                try {
                    regex = new RegExp(rule.pattern, rule.flags || 'i');
                } catch {
                    ctx.log.warn('Invalid content-blocker rule pattern', {
                        pattern: rule.pattern,
                    });
                    continue;
                }

                if (regex.test(fullText)) {
                    const description = rule.description || rule.pattern;
                    ctx.log.warn('Content blocked', { rule: description });
                    ctx.abort.error(400, `Content blocked: ${description}`);
                }
            }
        }

        await next();
    };
}
