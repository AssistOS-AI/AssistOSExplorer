/**
 * Timeout middleware.
 *
 * Installs a per-attempt `AbortSignal` on `ctx.signal`.  The signal is
 * linked to the caller's signal (client disconnect, cascade budget) so an
 * outer abort always reaches the upstream transport, and it fires on its own
 * when the attempt deadline expires.
 *
 * Buffered attempts finish inside `next()`, so the deadline covers the whole
 * upstream exchange and the timer is cleared when `next()` settles.
 *
 * A streamed attempt returns a lazy `CanonicalStream` from `next()`.  The
 * attempt lease is then handed to that stream: the total deadline stops, the
 * two deadlines below bound what is left, and the upstream request is
 * aborted when the consumer stops reading (client disconnect or an early
 * `return()`).  Without this hand-off a stalled upstream stream could hold a
 * connection open forever after the chain had already returned.
 *
 *   - The idle deadline restarts on every event, liveness events (model
 *     reasoning) included, so a model that is visibly working is not cut off.
 *   - The content-gap deadline restarts only on content events (`text_delta`
 *     and `tool_call_delta`), so an upstream that keeps reasoning, or keeps
 *     sending usage or metadata events, after it has committed still ends.
 *     It is `max(streamIdleTimeoutMs, firstContentTimeoutMs)`, so a model
 *     without a first-content cap is cut one idle deadline after its last
 *     content event, whatever it emits in between.
 *
 * Every delay handed to a timer is clamped to `MAX_TIMER_DELAY_MS`: a larger
 * one would overflow and fire after a millisecond instead of practically
 * never.
 *
 * The prime-stream layer consumes liveness events and reports each one
 * through `ctx.noteAttemptActivity`, which restarts the idle deadline only;
 * any that still reach the lease are dropped here so no client ever sees one.
 * A buffered attempt holds no lease: it finishes inside `next()` under the
 * total deadline.
 *
 * Reads:
 *   - `ctx.target.model.requestTimeoutMs`
 *   - `ctx.target.model.retryPolicy.streamIdleTimeoutMs`
 *   - `ctx.target.model.retryPolicy.firstContentTimeoutMs`
 *   - `ctx.appCtx.config.env.DEFAULT_REQUEST_TIMEOUT_MS`
 *   - `ctx.appCtx.config.env.STREAM_IDLE_TIMEOUT_MS`
 *
 * Writes:
 *   - `ctx.signal` (restored after `next()`)
 *   - `ctx.abortAttempt(reason)` (restored after `next()`)
 *   - `ctx.noteAttemptActivity()` (restored after `next()`)
 *
 * @module runtime/execution/timeout-middleware
 */

import { ProviderTimeoutError } from '../../core/errors.mjs';
import {
    createCanonicalStream,
    isCanonicalStream,
    isContentEvent,
    isLivenessEvent,
} from '../kernel/canonical-stream.mjs';
import { clampTimerDelay } from './timer-delay.mjs';

const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000;

function positiveNumber(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function linkSignals(parentSignal, ownSignal) {
    if (!parentSignal) return ownSignal;
    return AbortSignal.any([parentSignal, ownSignal]);
}

async function* leaseStream(
    source,
    { idleMs, contentGapMs, controller, providerKey, activity }
) {
    let idleTimer = null;
    let contentTimer = null;
    let finished = false;
    const armIdle = () => {
        if (finished) return;
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
            controller.abort(new ProviderTimeoutError(providerKey));
        }, clampTimerDelay(idleMs));
        idleTimer.unref?.();
    };
    // Only a content event calls this, so neither reasoning nor a trickle of
    // usage or metadata events can extend it: a committed stream ends
    // `contentGapMs` after its last content event.
    const armContentGap = () => {
        if (finished) return;
        if (contentTimer) clearTimeout(contentTimer);
        contentTimer = setTimeout(() => {
            controller.abort(new ProviderTimeoutError(providerKey));
        }, clampTimerDelay(contentGapMs));
        contentTimer.unref?.();
    };
    activity.onActivity = armIdle;
    let completed = false;
    try {
        armIdle();
        armContentGap();
        for await (const event of source) {
            armIdle();
            if (isLivenessEvent(event)) continue;
            if (isContentEvent(event)) armContentGap();
            yield event;
        }
        completed = true;
    } finally {
        finished = true;
        activity.onActivity = null;
        if (idleTimer) clearTimeout(idleTimer);
        if (contentTimer) clearTimeout(contentTimer);
        if (!completed && !controller.signal.aborted) {
            // The consumer stopped early; cancel the upstream request.
            controller.abort(new ProviderTimeoutError(providerKey));
        }
    }
}

function streamOf(response) {
    if (isCanonicalStream(response)) return response;
    if (response?.stream && isCanonicalStream(response.stream)) {
        return response.stream;
    }
    return null;
}

/**
 * @returns {(ctx: object, next: () => Promise<void>) => Promise<void>}
 */
export function timeoutMiddleware() {
    return async function timeout(ctx, next) {
        const model = ctx.target?.model;
        if (!model) {
            throw new TypeError(
                'timeoutMiddleware: ctx.target.model is required'
            );
        }
        const env = ctx.appCtx?.config?.env || {};
        const timeoutMs =
            positiveNumber(model.requestTimeoutMs) ||
            positiveNumber(model.request_timeout_ms) ||
            positiveNumber(env.DEFAULT_REQUEST_TIMEOUT_MS) ||
            120_000;
        const retryPolicy = model.retryPolicy || model.retry_policy || {};
        const idleMs =
            positiveNumber(retryPolicy.streamIdleTimeoutMs) ||
            positiveNumber(env.STREAM_IDLE_TIMEOUT_MS) ||
            DEFAULT_STREAM_IDLE_TIMEOUT_MS;
        const contentGapMs = Math.max(
            idleMs,
            positiveNumber(retryPolicy.firstContentTimeoutMs) || 0
        );
        const providerKey =
            model.providerKey || model.provider_key || model.modelKey;

        const previousSignal = ctx.signal;
        const previousAbort = ctx.abortAttempt;
        const previousNoteActivity = ctx.noteAttemptActivity;
        // Set by the stream lease once the caller reads a streamed response.
        const activity = { onActivity: null };
        const controller = new AbortController();
        const timer = setTimeout(() => {
            controller.abort(new ProviderTimeoutError(providerKey));
        }, clampTimerDelay(timeoutMs));
        timer.unref?.();

        ctx.signal = linkSignals(previousSignal, controller.signal);
        ctx.abortAttempt = (reason) => {
            if (!controller.signal.aborted) {
                controller.abort(
                    reason ?? new ProviderTimeoutError(providerKey)
                );
            }
        };
        ctx.noteAttemptActivity = () => activity.onActivity?.();

        try {
            await next();
            const stream = streamOf(ctx.response);
            if (stream) {
                const leased = createCanonicalStream(
                    leaseStream(stream, {
                        idleMs,
                        contentGapMs,
                        controller,
                        providerKey,
                        activity,
                    }),
                    stream.meta || {}
                );
                ctx.response = isCanonicalStream(ctx.response)
                    ? leased
                    : { ...ctx.response, stream: leased };
            }
        } finally {
            clearTimeout(timer);
            ctx.signal = previousSignal;
            ctx.abortAttempt = previousAbort;
            ctx.noteAttemptActivity = previousNoteActivity;
        }
    };
}
