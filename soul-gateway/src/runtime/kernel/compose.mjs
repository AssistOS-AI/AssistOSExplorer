/**
 * Middleware composer.
 *
 * Single execution model for the gateway runtime: Koa-style around middleware.
 * Each middleware is `async (ctx, next) => any`.  Calling `next()` enters the
 * downstream chain; not calling `next()` short-circuits.  The terminal entry
 * (the last one in the chain) does not call `next()` because there is nothing
 * to invoke; if the terminal handler IS missing, calling `next()` past the
 * end is a no-op.
 *
 * Behavioral contract:
 *
 *   - Each middleware MUST call `next` at most once.  Calling it twice in
 *     the same invocation throws — this is a programming error and we
 *     surface it loudly instead of letting the chain double-execute.
 *
 *   - Mutation of `ctx` is the *only* communication channel between
 *     middlewares; the composer never reads or writes ctx fields itself.
 *
 *   - Errors thrown inside any middleware unwind the entire stack via the
 *     normal async/await mechanism. The composer does not swallow errors.
 *
 *   - The kernel-internal `KernelAbortSignal` (see `abort.mjs`) is the one
 *     exception: it is caught silently as a flow-control marker.  This lets
 *     a deeply nested helper short-circuit the chain without forcing every
 *     intermediate middleware to inspect a return value.
 *
 * @module runtime/kernel/compose
 */

import { isKernelAbortSignal } from './abort.mjs';

/**
 * Compose an ordered list of middlewares into a single dispatch function.
 *
 * @param {Array<Function>} middlewares - ordered list of `async (ctx, next) => void`
 * @returns {(ctx: object) => Promise<void>} dispatch function
 */
export function compose(middlewares) {
    if (!Array.isArray(middlewares)) {
        throw new TypeError('compose: middlewares must be an array');
    }
    for (const mw of middlewares) {
        if (typeof mw !== 'function') {
            throw new TypeError('compose: every middleware must be a function');
        }
    }

    return async function dispatch(ctx) {
        let lastIndex = -1;

        const run = async (i) => {
            if (i <= lastIndex) {
                // Calling next() twice from the same middleware is a programming bug.
                // We refuse to silently double-execute the chain.
                throw new Error(
                    `compose: next() called multiple times (index ${i})`
                );
            }
            lastIndex = i;
            const fn = middlewares[i];
            if (!fn) return; // off the end of the chain — nothing more to run
            const next = () => run(i + 1);
            try {
                await fn(ctx, next);
            } catch (err) {
                if (isKernelAbortSignal(err)) {
                    // Flow-control signal: a middleware short-circuited via abort.success.
                    // The response is already on ctx — propagate cleanly without
                    // re-throwing.
                    return;
                }
                throw err;
            }
        };

        await run(0);
    };
}
