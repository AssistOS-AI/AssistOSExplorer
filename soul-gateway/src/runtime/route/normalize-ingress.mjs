/**
 * Route middleware: normalize ingress format.
 *
 * Reads `ctx.body` (parsed JSON), uses `ctx.route.kind` to dispatch to the
 * appropriate format normalizer (`openai_chat`, `anthropic_messages`, or
 * `openai_responses`), and stores the result on `ctx.request`.  The
 * canonical request shape downstream is the OpenAI Chat Completions
 * format.
 *
 * @module runtime/route/normalize-ingress
 */

import { normalizeIncomingFormat } from '../../request/format-normalizer.mjs';

/**
 * @returns {(ctx: object, next: () => Promise<void>) => Promise<void>}
 */
export function normalizeIngressMiddleware() {
    return async function normalizeIngress(ctx, next) {
        const start = Date.now();
        const routeKind = ctx.route?.kind || 'openai_chat';
        ctx.request = normalizeIncomingFormat(routeKind, ctx.body);
        ctx.metadata.normalizeMs = Date.now() - start;
        await next();
    };
}
