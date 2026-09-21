/**
 * Prime-stream middleware.
 *
 * Backends return lazy canonical streams: the upstream request is only sent
 * when the first event is pulled.  Without priming, a streamed attempt
 * "succeeds" as soon as the lazy iterator exists, so retry and cascade
 * commit to that attempt before the upstream has answered, and a 404, 429,
 * or stalled upstream can no longer fall back to the next model.
 *
 * This middleware pulls events from the backend stream inside the attempt,
 * until the first content-bearing event (`text_delta` or `tool_call_delta`).
 * A stream that ends first is an empty answer and fails the attempt, unless
 * the token limit cut it off (see below).  Failures before that point
 * propagate as ordinary attempt errors, so retry and cascade handle them.
 * The pulled events are replayed at the head of the returned stream.  Once
 * the first content-bearing event exists the response is committed:
 * later failures terminate the client stream and are never silently
 * replaced by another model's output.
 *
 * Two optional deadlines bound the wait for that first content event more
 * tightly than the whole-attempt deadline:
 *
 *   - `retryPolicy.firstEventTimeoutMs` is a silence window. It starts with
 *     the attempt and restarts on liveness events (`activity`, for example
 *     model reasoning), so a model that is visibly working is not treated as
 *     stalled, while a trickle of other events cannot extend it. SSE comments
 *     such as `: keepalive` never reach this layer: on routers they prove
 *     only that the router is alive, not the model.
 *   - `retryPolicy.firstContentTimeoutMs` is an absolute cap from the start
 *     of the attempt to the first `text_delta` or `tool_call_delta`, so an
 *     upstream that reasons forever still yields to the next model.
 *
 * Liveness events are consumed here, before and after commit, and are never
 * part of the returned stream: provider middlewares, buffering, response
 * capture, and the client only see content events. After commit each
 * liveness event is reported through `ctx.noteAttemptActivity` so the stream
 * lease idle deadline counts it; the lease's content-gap deadline does not,
 * which is what bounds a committed stream that keeps reasoning.
 *
 * @module runtime/execution/prime-stream-middleware
 */

import {
    ProviderServerError,
    ProviderTimeoutError,
} from '../../core/errors.mjs';
import {
    createCanonicalStream,
    isCanonicalStream,
    isContentEvent,
    isLivenessEvent,
} from '../kernel/canonical-stream.mjs';
import { clampTimerDelay } from './timer-delay.mjs';

// Only real output commits an attempt: `isContentEvent`, the definition the
// stream lease also uses. A stream that reaches `done` (or its end) without
// any text or tool call is an empty answer and fails before commit so a
// cascade can try the next model instead of returning nothing.
//
// One exception: a reply that the token limit cut off before any text or
// tool call (finish reason `length`, typically a model that spent its budget
// reasoning) is returned as a completion, because its finish reason tells
// the caller to raise its token limit. A cascade child whose policy sets
// `lengthWithoutContentFails` treats it as an empty answer instead, so the
// next child may answer within the limit; the free-model execution policy
// sets it because in a cascade the gateway, not the caller, chose the model.
// A direct request always keeps the length finish: no other model is tried.

function endsCutOffByLength(head) {
    const last = head[head.length - 1];
    return last?.type === 'done' && last.data?.finish_reason === 'length';
}

function emptyResponseError(providerKey) {
    const error = new ProviderServerError(providerKey, 'empty');
    error.message = `Provider returned an empty response: ${providerKey}`;
    error.retryable = false;
    error.cascade = true;
    return error;
}

function positiveNumber(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function streamOf(response) {
    if (isCanonicalStream(response)) return response;
    if (response?.stream && isCanonicalStream(response.stream)) {
        return response.stream;
    }
    return null;
}

function nextWithDeadline(iterator, deadlineAt, onTimeout) {
    if (deadlineAt === null) return iterator.next();
    const remaining = clampTimerDelay(Math.max(0, deadlineAt - Date.now()));
    let timer = null;
    const expired = new Promise((_, reject) => {
        timer = setTimeout(() => reject(onTimeout()), remaining);
        timer.unref?.();
    });
    return Promise.race([iterator.next(), expired]).finally(() => {
        clearTimeout(timer);
    });
}

async function* replay(head, iterator, exhausted, onActivity) {
    try {
        for (const event of head) yield event;
        if (exhausted) return;
        while (true) {
            const { value, done } = await iterator.next();
            if (done) return;
            if (isLivenessEvent(value)) {
                onActivity();
                continue;
            }
            yield value;
        }
    } finally {
        await iterator.return?.().catch(() => {});
    }
}

/**
 * @returns {(ctx: object, next: () => Promise<void>) => Promise<void>}
 */
export function primeStreamMiddleware() {
    return async function primeStream(ctx, next) {
        await next();
        const stream = streamOf(ctx.response);
        if (!stream) return;

        const model = ctx.target?.model || {};
        const retryPolicy = model.retryPolicy || model.retry_policy || {};
        const silenceMs = positiveNumber(retryPolicy.firstEventTimeoutMs);
        const contentMs = positiveNumber(retryPolicy.firstContentTimeoutMs);
        const startedAt = Date.now();
        const contentAt = contentMs === null ? null : startedAt + contentMs;
        let silenceAt = silenceMs === null ? null : startedAt + silenceMs;
        const deadline = () => {
            if (silenceAt === null) return contentAt;
            if (contentAt === null) return silenceAt;
            return Math.min(silenceAt, contentAt);
        };
        const providerKey =
            model.providerKey || model.provider_key || model.modelKey;
        const onTimeout = () => {
            const error = new ProviderTimeoutError(providerKey);
            ctx.abortAttempt?.(error);
            return error;
        };
        // Captured now: the timeout middleware restores its hooks once the
        // attempt chain returns, while the replayed stream is read later.
        const noteActivity = ctx.noteAttemptActivity;
        const onActivity = () => noteActivity?.();

        const iterator = stream[Symbol.asyncIterator]();
        const head = [];
        let exhausted = false;
        try {
            while (true) {
                const { value, done } = await nextWithDeadline(
                    iterator,
                    deadline(),
                    onTimeout
                );
                if (done) {
                    exhausted = true;
                    break;
                }
                if (isLivenessEvent(value)) {
                    if (silenceMs !== null) silenceAt = Date.now() + silenceMs;
                    continue;
                }
                head.push(value);
                if (isContentEvent(value)) break;
                if (value?.type === 'done') {
                    exhausted = true;
                    break;
                }
            }
            const lengthFailsOver =
                model.cascadeChild === true &&
                retryPolicy.lengthWithoutContentFails === true;
            const answerable =
                head.some(isContentEvent) ||
                (endsCutOffByLength(head) && !lengthFailsOver);
            if (!answerable) {
                throw emptyResponseError(providerKey);
            }
        } catch (err) {
            ctx.abortAttempt?.(err);
            iterator.return?.().catch(() => {});
            throw err;
        }

        const primed = createCanonicalStream(
            replay(head, iterator, exhausted, onActivity),
            stream.meta || {}
        );
        ctx.response = isCanonicalStream(ctx.response)
            ? primed
            : { ...ctx.response, stream: primed };
    };
}
