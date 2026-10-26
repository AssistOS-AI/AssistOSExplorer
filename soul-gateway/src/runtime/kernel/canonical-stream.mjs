/**
 * Canonical stream representation for the gateway runtime.
 *
 * Once a backend terminal produces a response, the kernel represents it as
 * either a buffered completion or a `CanonicalStream`.  Middlewares wrap
 * streams by replacing `ctx.response.stream` with a new async iterable that
 * yields the canonical event types defined in `runtime/backends/backend-interface`:
 *
 *   - `message_start`
 *   - `text_delta`
 *   - `tool_call_delta`
 *   - `usage`
 *   - `done`
 *   - `error`
 *   - `activity` — upstream liveness before or between output (for example
 *     model reasoning). It carries no client-visible content: the direct
 *     attempt chain consumes it for its deadlines and never forwards it.
 *
 * Of those, `text_delta` and `tool_call_delta` are the content events
 * (`CONTENT_EVENT_TYPES`): the execution deadlines are defined against them.
 *
 * This module deliberately stays small.  It does not own protocol parsing
 * (that lives in transports) or buffering (that lives in `response-buffer.mjs`,
 * once Phase 3 lands).  It only provides:
 *
 *   - a constructor for the canonical-stream wrapper
 *   - helpers to detect a streaming response
 *   - a passthrough generator that lets a middleware tee the events without
 *     consuming the underlying stream
 *   - disposal helpers: a wrapper that releases a lease even when its
 *     stream is disposed unread, and the request-scoped owner that disposes
 *     every primed stream
 *
 * @module runtime/kernel/canonical-stream
 */

const CANONICAL_STREAM = Symbol('soulgw.kernel.canonicalStream');

export const LIVENESS_EVENT_TYPE = 'activity';

// The only events that carry answer content. They decide both when an
// attempt is committed and when a committed stream is still producing an
// answer, so the two layers share one definition: a stream that reaches its
// end without one of these is an empty answer, and a committed stream that
// stops producing them is finished for the caller whatever else it emits.
export const CONTENT_EVENT_TYPES = Object.freeze([
    'text_delta',
    'tool_call_delta',
]);

const CONTENT_EVENT_TYPE_SET = new Set(CONTENT_EVENT_TYPES);

/**
 * @param {object} event
 * @returns {boolean} true for an upstream liveness event (never client-visible)
 */
export function isLivenessEvent(event) {
    return event?.type === LIVENESS_EVENT_TYPE;
}

/**
 * @param {object} event
 * @returns {boolean} true for an event carrying answer content
 */
export function isContentEvent(event) {
    return CONTENT_EVENT_TYPE_SET.has(event?.type);
}

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
 * Make `release` run when a stream wrapper is disposed before it is read.
 *
 * An async generator whose body never started completes on `return()` or
 * `throw()` without running its own `finally`.  A wrapper that holds a lease
 * (a backend generation, an upstream request, an inner iterator it already
 * pulled from) would then keep it forever when its consumer disposes it
 * unread.  Before the first `next()` this iterator completes the generator
 * and then calls `release`; afterwards it only delegates, because the
 * generator's own `finally` owns the release.  `release` therefore runs at
 * most once through this wrapper, and must be safe to call after that
 * `finally` as well.
 *
 * @param {AsyncGenerator<object>} generator
 * @param {() => unknown | Promise<unknown>} release
 * @returns {AsyncIterableIterator<object>}
 */
export function releaseOnEarlyReturn(generator, release) {
    let started = false;
    const complete = async (settle) => {
        if (started) return settle();
        started = true;
        try {
            return await settle();
        } finally {
            await release();
        }
    };
    return {
        [Symbol.asyncIterator]() {
            return this;
        },
        next(value) {
            started = true;
            return generator.next(value);
        },
        return(value) {
            return complete(() => generator.return(value));
        },
        throw(error) {
            return complete(() => generator.throw(error));
        },
    };
}

/**
 * Request-scoped owner of primed streams.
 *
 * Stream priming adopts every stream it returns, and the route's respond
 * step disposes the owner once the request is finished, whether or not the
 * streams were read.  A stream that is never read (the client left before
 * the first write, or an error was thrown between priming and the response)
 * still releases its backend generation and upstream request, without
 * depending on every wrapper above it passing on an early `return()`.
 * Disposing a stream that was read to its end is a no-op.
 *
 * @returns {{ adopt(stream: object): void, dispose(): Promise<void> }}
 */
export function createStreamOwner() {
    const streams = new Set();
    let disposed = false;
    return {
        adopt(stream) {
            if (disposed) {
                void disposeStream(stream);
                return;
            }
            streams.add(stream);
        },
        async dispose() {
            disposed = true;
            const pending = [...streams].map(disposeStream);
            streams.clear();
            await Promise.all(pending);
        },
    };
}

async function disposeStream(stream) {
    try {
        await stream[Symbol.asyncIterator]().return?.();
    } catch {
        // a failing stream must not stop the others from being disposed
    }
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
