/**
 * Canonical stream representation for the gateway runtime.
 *
 * Once a transport produces a response, the kernel represents it as either
 * a buffered completion or a `CanonicalStream`.  Middlewares wrap streams
 * by replacing `ctx.response.stream` with a new async iterable that yields
 * the canonical event types defined in `runtime/providers/provider-interface`:
 *
 *   - `message_start`
 *   - `text_delta`
 *   - `tool_call_delta`
 *   - `usage`
 *   - `done`
 *   - `error`
 *
 * This module deliberately stays small.  It does not own protocol parsing
 * (that lives in transports) or buffering (that lives in `response-buffer.mjs`,
 * once Phase 3 lands).  It only provides:
 *
 *   - a constructor for the canonical-stream wrapper
 *   - helpers to detect a streaming response
 *   - a passthrough generator that lets a middleware tee the events without
 *     consuming the underlying stream
 *
 * @module runtime/kernel/canonical-stream
 */

const CANONICAL_STREAM = Symbol('soulgw.kernel.canonicalStream');

/**
 * Wrap an async iterable of canonical events as a `CanonicalStream`.
 *
 * @param {AsyncIterable<object>} source
 * @param {object} [meta] - free-form metadata (model, account, etc.)
 * @returns {object} CanonicalStream
 */
export function createCanonicalStream(source, meta = {}) {
    if (!source || typeof source[Symbol.asyncIterator] !== 'function') {
        throw new TypeError(
            'createCanonicalStream: source must be an async iterable'
        );
    }
    return {
        [CANONICAL_STREAM]: true,
        meta: { ...meta },
        [Symbol.asyncIterator]() {
            return source[Symbol.asyncIterator]();
        },
    };
}

/**
 * @param {*} value
 * @returns {boolean} true if value is a `CanonicalStream` produced by this module
 */
export function isCanonicalStream(value) {
    return (
        value !== null &&
        typeof value === 'object' &&
        value[CANONICAL_STREAM] === true
    );
}

/**
 * Build a generator that yields the events of `source` while invoking
 * `tap(event)` for each one.  This is the basic primitive a stream-wrapping
 * middleware uses to record metrics or accumulate state without altering
 * the events themselves.
 *
 * @param {AsyncIterable<object>} source
 * @param {(event: object) => void | Promise<void>} tap
 * @returns {AsyncGenerator<object>}
 */
export async function* tapStream(source, tap) {
    for await (const event of source) {
        try {
            await tap(event);
        } catch {
            // tap failures must never break the stream
        }
        yield event;
    }
}

/**
 * Build a generator that maps every event of `source` through `transform`.
 * Returning `null`/`undefined` from the transform drops the event.
 *
 * @param {AsyncIterable<object>} source
 * @param {(event: object) => object | null | undefined | Promise<object | null | undefined>} transform
 * @returns {AsyncGenerator<object>}
 */
export async function* mapStream(source, transform) {
    for await (const event of source) {
        const next = await transform(event);
        if (next != null) yield next;
    }
}
