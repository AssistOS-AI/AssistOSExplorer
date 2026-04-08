/**
 * Route middleware: validate the normalized request.
 *
 * Runs the existing `validateNormalizedRequest` checks (model present,
 * messages array shape, parameter ranges) on `ctx.request`.  Throws
 * `ValidationError` on failure, which the error boundary middleware
 * converts into an HTTP error.
 *
 * @module runtime/route/validate-request
 */

import { validateNormalizedRequest } from '../../request/validator.mjs';

/**
 * @returns {(ctx: object, next: () => Promise<void>) => Promise<void>}
 */
export function validateRequestMiddleware() {
    return async function validateRequest(ctx, next) {
        validateNormalizedRequest(ctx.request);
        await next();
    };
}
