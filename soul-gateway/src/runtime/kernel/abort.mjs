/**
 * Kernel abort signals.
 *
 * The kernel supports two ways to stop a middleware chain:
 *
 *   1. **Cooperative short-circuit**: a middleware sets `ctx.response`
 *      and simply returns without calling `next()`.  This is the
 *      preferred form because it makes the control flow visible.
 *
 *   2. **Flow-control abort**: a middleware (or any helper invoked by
 *      one) calls `abortSuccess(ctx, response)`.  That sets `ctx.response`
 *      and throws a `KernelAbortSignal`, which the composer catches as
 *      pure flow control.  This is useful when a deep helper needs to
 *      stop the chain without forcing every intermediate caller to
 *      inspect a return value.
 *
 * Errors are NOT a kernel concept — they propagate through async/await as
 * normal exceptions.  Use `MiddlewareAbortError` (from `core/errors.mjs`)
 * if you want a typed gateway error to surface to the client.
 *
 * @module runtime/kernel/abort
 */

import { MiddlewareAbortError } from '../../core/errors.mjs';

const KERNEL_ABORT_SIGNAL = Symbol('soulgw.kernel.abortSignal');

/**
 * A flow-control marker thrown by `abortSuccess` and caught by the composer.
 * Not exported as a class because it should never be `instanceof`-checked
 * outside the kernel.
 */
class KernelAbortSignal extends Error {
    constructor(reason) {
        super(reason || 'kernel.abort');
        this.name = 'KernelAbortSignal';
        this[KERNEL_ABORT_SIGNAL] = true;
    }
}

/**
 * @param {unknown} value
 * @returns {boolean} true if the value is the kernel's internal abort marker
 */
export function isKernelAbortSignal(value) {
    return Boolean(
        value &&
            typeof value === 'object' &&
            value[KERNEL_ABORT_SIGNAL] === true
    );
}

/**
 * Set `ctx.response` and short-circuit the middleware chain.
 *
 * @param {object} ctx
 * @param {object} response - synthetic response payload (cache hit, override, etc.)
 * @throws {KernelAbortSignal} caught by the composer; not a real error
 */
export function abortSuccess(ctx, response) {
    if (!ctx || typeof ctx !== 'object') {
        throw new TypeError('abortSuccess: ctx must be an object');
    }
    ctx.response = response;
    throw new KernelAbortSignal('synthetic-response');
}

/**
 * Abort the chain with a typed gateway error.  This is what middlewares call
 * when they want to surface a 4xx/5xx to the caller (e.g. rate limiter).
 *
 * @param {string} middlewareName - identifier shown in the error detail
 * @param {number} httpStatus
 * @param {string} message
 * @throws {MiddlewareAbortError}
 */
export function abortError(middlewareName, httpStatus, message) {
    throw new MiddlewareAbortError(middlewareName, httpStatus, message);
}

/**
 * Convenience builder for the per-middleware abort surface, bound to the
 * middleware's identifying name so abort.error() carries it automatically.
 *
 * @param {string} middlewareName
 * @returns {{ success: (ctx: object, response: object) => never, error: (status: number, message: string) => never }}
 */
export function createAbortApi(middlewareName) {
    return Object.freeze({
        success: (ctx, response) => abortSuccess(ctx, response),
        error: (status, message) => abortError(middlewareName, status, message),
    });
}
