/**
 * Built-in middleware: System Prompt Injector
 *
 * Injects a system message into the request message list.
 */

export const meta = Object.freeze({
    key: 'system-prompt-injector',
    name: 'System Prompt Injector',
    description:
        'Injects a system message at the beginning or end of the messages array.',
    version: '2.0.0',
    scope: 'gateway',
    defaultSettings: Object.freeze({
        content: '',
        position: 'prepend',
        role: 'system',
    }),
});

export function factory(settings = {}) {
    const merged = { ...meta.defaultSettings, ...settings };

    return async function systemPromptInjector(ctx, next) {
        const content = merged.content;
        if (content) {
            if (!Array.isArray(ctx.request?.messages)) {
                ctx.request.messages = [];
            }

            const injected = {
                role: merged.role || 'system',
                content,
            };

            if (merged.position === 'append') {
                ctx.request.messages.push(injected);
            } else {
                let insertIdx = 0;
                while (
                    insertIdx < ctx.request.messages.length &&
                    ctx.request.messages[insertIdx].role === 'system'
                ) {
                    insertIdx++;
                }
                ctx.request.messages.splice(insertIdx, 0, injected);
            }

            ctx.log.debug('System prompt injected', {
                position: merged.position || 'prepend',
                length: content.length,
            });
        }

        await next();
    };
}
