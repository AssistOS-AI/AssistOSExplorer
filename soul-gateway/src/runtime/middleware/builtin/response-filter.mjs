/**
 * Built-in middleware: Response Filter
 *
 * Applies regex find/replace filters to buffered assistant content.
 */

export const meta = Object.freeze({
    key: 'response-filter',
    name: 'Response Filter',
    description:
        'Applies configurable regex patterns to filter or transform response content.',
    version: '2.0.0',
    scope: 'gateway',
    defaultSettings: Object.freeze({
        patterns: [],
    }),
});

export function factory(settings = {}) {
    const merged = { ...meta.defaultSettings, ...settings };

    return async function responseFilter(ctx, next) {
        await next();

        const patterns = merged.patterns;
        if (!Array.isArray(patterns) || patterns.length === 0 || !ctx.response) {
            return;
        }

        const choices = ctx.response.choices;
        if (!Array.isArray(choices)) {
            return;
        }

        let modified = false;

        for (const choice of choices) {
            const message = choice.message || choice.delta;
            if (!message || typeof message.content !== 'string') continue;

            let text = message.content;
            for (const pattern of patterns) {
                if (!pattern.find) continue;

                let regex;
                try {
                    regex = new RegExp(pattern.find, pattern.flags || 'g');
                } catch {
                    ctx.log.warn('Invalid response-filter pattern', {
                        find: pattern.find,
                    });
                    continue;
                }

                const replaced = text.replace(regex, pattern.replace ?? '');
                if (replaced !== text) {
                    text = replaced;
                    modified = true;
                }
            }

            message.content = text;
        }

        if (modified) {
            ctx.log.debug('Response filtered', { patternCount: patterns.length });
        }
    };
}
