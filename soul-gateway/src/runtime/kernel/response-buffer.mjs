/**
 * Response buffering for the kernel.
 *
 * The gateway runtime is moving toward a "canonical stream first" model:
 * transports return a `CanonicalStream`, gateway middlewares can wrap or
 * tee the stream, and only post-processing that genuinely needs a full
 * body materializes it.
 *
 * This module provides:
 *
 *   - `bufferCanonicalStream(stream)` — drain a CanonicalStream into a
 *     buffered completion shape using the existing `collectNormalizedStream`
 *     helper.
 *
 *   - `bufferingMiddleware(options?)` — a kernel middleware that, after
 *     `next()`, inspects `ctx.response`.  If it is a `CanonicalStream`
 *     (or carries one as a `.stream` property), it drains the stream and
 *     replaces `ctx.response` with the buffered shape.  If the response is
 *     already buffered, it is a no-op.  Bind this *outside* (i.e. earlier
 *     in the chain than) any post-only middleware that needs `ctx.response`
 *     in buffered form.
 *
 * Why a middleware and not an unconditional drain?  Because some
 * downstream middlewares deliberately want to keep streaming — e.g.
 * a response cache that streams to the client AND records the events
 * via a tee.  Buffering needs to be opt-in at the chain level.
 *
 * @module runtime/kernel/response-buffer
 */

import { collectNormalizedStream } from '../execution/stream-collector.mjs';
import {
    createCanonicalStream,
    isCanonicalStream,
} from './canonical-stream.mjs';

/**
 * @typedef {Object} BufferedCompletion
 * @property {object|null} message       - { role, content, tool_calls? }
 * @property {string|null} content
 * @property {string} excerpt
 * @property {string|null} finishReason
 * @property {object} usage              - { input_tokens, output_tokens, total_tokens }
 * @property {Array<object>} toolCalls
 * @property {*} [rawResponse]
 * @property {object} [responseMeta]
 */

/**
 * Drain a canonical stream into a buffered completion.  Thin wrapper around
 * the existing `collectNormalizedStream` collector so the kernel does not
 * own the collection algorithm.
 *
 * @param {AsyncIterable<object>} stream
 * @param {object} [options]
 * @param {number} [options.maxExcerptChars]
 * @returns {Promise<BufferedCompletion>}
 */
export function bufferCanonicalStream(stream, options = {}) {
    if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') {
        throw new TypeError(
            'bufferCanonicalStream: stream must be an async iterable'
        );
    }
    return collectNormalizedStream(stream, options);
}

/**
 * Build a kernel middleware that drains a streaming `ctx.response` into a
 * buffered shape after `next()` returns.  Bind this earlier in the chain
 * than any post-only middleware that requires a buffered completion.
 *
 * Recognized response shapes:
 *
 *   1. `ctx.response` IS a `CanonicalStream`             → drain to buffered
 *   2. `ctx.response` has a `.stream` (CanonicalStream)  → drain stream,
 *                                                          merge buffered
 *                                                          fields onto the
 *                                                          existing object
 *   3. anything else                                     → no-op
 *
 * The middleware never throws on its own — drain failures propagate as
 * the original error from the underlying transport.
 *
 * @param {object} [options]
 * @param {number} [options.maxExcerptChars]
 * @returns {(ctx: object, next: () => Promise<void>) => Promise<void>}
 */
export function bufferingMiddleware(options = {}) {
    return async function bufferingMw(ctx, next) {
        await next();

        const response = ctx.response;
        if (!response) return;

        if (isCanonicalStream(response)) {
            ctx.response = await bufferCanonicalStream(response, options);
            return;
        }

        if (response.stream && isCanonicalStream(response.stream)) {
            const buffered = await bufferCanonicalStream(
                response.stream,
                options
            );
            // Merge the buffered fields onto the original envelope so any
            // metadata the transport set (accountId, model, …) is preserved.
            ctx.response = {
                ...response,
                ...buffered,
                stream: null,
            };
            return;
        }
    };
}

/**
 * Build a stream-wrapping middleware that intercepts the canonical events
 * produced downstream by a transport.  The wrapper runs after `next()`
 * returns and replaces `ctx.response.stream` (or `ctx.response` itself if
 * it is a CanonicalStream) with the result of `wrap(stream, ctx)`.
 *
 * The wrapped iterable is always re-wrapped as a `CanonicalStream` so an
 * outer middleware (or `bufferingMiddleware`) can still detect it.  This
 * makes wrappers stack cleanly: in compose order `[outer, inner, terminal]`,
 * the inner wrapper runs first (closer to the terminal), the outer wraps
 * the inner's output.
 *
 * @example
 *   const logEvents = wrappingStreamMiddleware(async function* (stream) {
 *     for await (const event of stream) {
 *       console.log(event.type);
 *       yield event;
 *     }
 *   });
 *
 * @param {(stream: AsyncIterable<object>, ctx: object) => AsyncIterable<object>} wrap
 * @returns {(ctx: object, next: () => Promise<void>) => Promise<void>}
 */
export function wrappingStreamMiddleware(wrap) {
    if (typeof wrap !== 'function') {
        throw new TypeError(
            'wrappingStreamMiddleware: wrap must be a function'
        );
    }
    return async function streamWrapMw(ctx, next) {
        await next();
        const response = ctx.response;
        if (!response) return;

        if (isCanonicalStream(response)) {
            const wrapped = wrap(response, ctx);
            ctx.response = createCanonicalStream(wrapped, response.meta || {});
            return;
        }
        if (response.stream && isCanonicalStream(response.stream)) {
            const wrapped = wrap(response.stream, ctx);
            ctx.response = {
                ...response,
                stream: createCanonicalStream(
                    wrapped,
                    response.stream.meta || {}
                ),
            };
        }
    };
}
