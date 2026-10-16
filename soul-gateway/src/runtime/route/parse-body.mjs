/**
 * Route middleware: JSON body parser.
 *
 * Reads `ctx.http.req`, parses the JSON body up to the configured byte
 * limit, and stores the parsed payload on `ctx.body`.
 *
 * Subsequent middlewares (e.g. ingress normalization) read `ctx.body`.
 *
 * @module runtime/route/parse-body
 */

import { readJsonBody } from '../../core/json-body.mjs';

/**
 * @param {{ bodyLimitBytes?: number }} [options]
 * @returns {(ctx: object, next: () => Promise<void>) => Promise<void>}
 */
export function parseBodyMiddleware(options = {}) {
    return async function parseBody(ctx, next) {
        if (!ctx.http?.req) {
            throw new TypeError(
                'parseBodyMiddleware: ctx.http.req is required'
            );
        }
        const limit =
            options.bodyLimitBytes ??
            ctx.appCtx?.config?.env?.BODY_LIMIT_BYTES ??
            5_242_880;

        const start = Date.now();
        ctx.body = await readJsonBody(ctx.http.req, limit);
        ctx.metadata.parseMs = Date.now() - start;

        await next();
    };
}
