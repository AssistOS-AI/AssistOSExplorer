/**
 * Native provider middleware: prompt injector.
 *
 * Inserts a system message into `ctx.request.messages` before the
 * terminal backend runs. Configurable content, position (prepend or append),
 * and role.
 *
 * @module runtime/middleware/provider-builtin/provider-prompt-injector
 */

export const meta = Object.freeze({
    key: 'provider-prompt-injector',
    name: 'Provider Prompt Injector',
    description:
        'Injects a system message at the beginning or end of the messages array (provider-scoped).',
    version: '2.0.0',
    scope: 'provider',
    defaultSettings: Object.freeze({
        content: '',
        position: 'prepend', // 'prepend' | 'append'
        role: 'system',
    }),
});

/**
 * @param {object} settings - merged settings for this assignment
 * @returns {(ctx: object, next: () => Promise<void>) => Promise<void>}
 */
export function factory(settings = {}) {
    const merged = { ...meta.defaultSettings, ...settings };
    const content = merged.content || '';
    const position = merged.position || 'prepend';
    const role = merged.role || 'system';

    return async function providerPromptInjector(ctx, next) {
        if (content) {
            const messages = ctx.request?.messages;
            if (Array.isArray(messages)) {
                const injected = { role, content };
                if (position === 'append') {
                    messages.push(injected);
                } else {
                    // Prepend after any existing system messages at the head
                    let insertIdx = 0;
                    while (
                        insertIdx < messages.length &&
                        messages[insertIdx].role === 'system'
                    ) {
                        insertIdx++;
                    }
                    messages.splice(insertIdx, 0, injected);
                }
            }
        }
        await next();
    };
}
