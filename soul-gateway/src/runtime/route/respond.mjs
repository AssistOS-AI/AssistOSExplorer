/**
 * Route middleware: serialize and send the response.
 *
 * Runs in the post phase.  After the gateway dispatch terminal sets
 * `ctx.response`, this middleware serializes it back to the client in
 * the format the client requested:
 *
 *   - If `ctx.response` is a buffered chat completion (or the
 *     gateway-dispatch terminal already normalized one onto ctx.response),
 *     serialize it as a single JSON body via `serializeBufferedResponse`.
 *
 *   - If `ctx.response` is a `CanonicalStream` (direct terminal or
 *     unwrapped from `{ stream }`), stream Server-Sent Events to the
 *     client via `canonicalStreamToSse`, framing them for the route
 *     kind (`openai_chat`, `anthropic_messages`, `openai_responses`).
 *
 * Choice of branch is determined by `ctx.request.stream === true`:
 *
 *   - Client `stream: true`        → streaming path
 *   - Client `stream: false`/absent → buffered path
 *
 * Upstream middleware (gateway dispatch) is responsible for leaving
 * `ctx.response` in the right shape for each mode.  When the client
 * wants streaming, upstream skips the provider-chain buffering so
 * ctx.response stays as a CanonicalStream.  When the client wants a
 * buffered response, upstream runs the buffering middleware and wraps
 * the buffered completion in the chat completion envelope.
 *
 * This middleware also owns every stream primed for the request: it
 * installs `ctx.streamOwner` before dispatch and disposes it when it
 * finishes, so a stream that is never read still releases its backend
 * generation and upstream request.  A client disconnect, including one
 * during a back-pressure wait, ends the streaming loop, so the audit row
 * is still written with the partial response.
 *
 * @module runtime/route/respond
 */

import { once } from 'node:events';
import { sendJson } from '../../core/responses.mjs';
import { serializeBufferedResponse } from '../../request/format-serializers.mjs';
import {
    createStreamOwner,
    isCanonicalStream,
    tapStream,
} from '../kernel/index.mjs';
import { canonicalStreamToSse } from './canonical-stream-to-sse.mjs';
import { createStreamCapture } from '../../observability/response-capture.mjs';
import { CONTENT_TYPES, HEADER_NAMES } from '../../core/constants.mjs';
import { InternalServerError } from '../../core/errors.mjs';

/**
 * @returns {(ctx: object, next: () => Promise<void>) => Promise<void>}
 */
export function respondMiddleware() {
    return async function respond(ctx, next) {
        const streamOwner = createStreamOwner();
        ctx.streamOwner = streamOwner;
        try {
            await sendResponse(ctx, next);
        } finally {
            const stream = streamOf(ctx.response);
            if (stream) streamOwner.adopt(stream);
            // Not awaited: closing an upstream must never hold up the audit.
            void streamOwner.dispose();
        }
    };
}

async function sendResponse(ctx, next) {
    await next();

    const totalMs = Date.now() - ctx.startedAt;
    ctx.metadata.totalMs = totalMs;

    ctx.log?.info?.('request complete', {
        requestId: ctx.requestId,
        model: ctx.request?.model,
        agent: ctx.identity?.agentName,
        durationMs: totalMs,
        streaming: !!ctx.metadata.streamingResponse,
    });

    const res = ctx.http?.res;
    if (!res) return;
    if (res.writableEnded || res.headersSent) return;

    const routeKind = ctx.route?.kind || 'openai_chat';

    // Streaming branch — ctx.response is a CanonicalStream, or an
    // envelope with a CanonicalStream under .stream.
    const canonicalStream = streamOf(ctx.response);
    if (canonicalStream) {
        const capture = createStreamCapture({
            maxExcerptChars:
                ctx.appCtx?.config?.defaults?.responseExcerptChars ?? 2000,
        });
        await streamSseResponse(
            res,
            tapStream(canonicalStream, (event) => {
                observeStreamEvent(ctx, event);
                capture.observe(event);
            }),
            routeKind,
            ctx.requestId,
            ctx,
            capture
        );
        return;
    }

    // Buffered branch — ctx.response is a chat completion envelope.
    if (!ctx.response) {
        throw new InternalServerError('No response set by gateway dispatch');
    }
    captureBufferedResponseMetadata(ctx, totalMs);
    const serialized = serializeBufferedResponse(
        ctx.response,
        routeKind,
        ctx.requestId,
        { toolAdapters: ctx.request?.responses_tool_adapters }
    );
    sendJson(res, 200, serialized);
}

function streamOf(response) {
    if (isCanonicalStream(response)) return response;
    if (response?.stream && isCanonicalStream(response.stream)) {
        return response.stream;
    }
    return null;
}

/**
 * Write the SSE headers and stream the converted canonical events to
 * the client.  Stops iterating when the client disconnects: `res`
 * emitting `close` (or the request signal aborting) also ends a
 * back-pressure wait, because a destroyed socket never emits `drain`.
 * A client that left before the first write is never written to.
 */
async function streamSseResponse(
    res,
    canonicalStream,
    routeKind,
    requestId,
    ctx,
    capture
) {
    let clientAborted = isClientGone(res, ctx);
    let finishedNaturally = false;
    const closed = new AbortController();
    const onClose = () => {
        clientAborted = true;
        closed.abort();
    };
    let captured = null;
    let streamFailed = false;

    try {
        if (!clientAborted) {
            res.writeHead(200, {
                [HEADER_NAMES.CONTENT_TYPE]: CONTENT_TYPES.EVENT_STREAM,
                'Cache-Control': 'no-cache, no-transform',
                Connection: 'keep-alive',
                'X-Accel-Buffering': 'no',
            });
            res.once('close', onClose);
            const drainSignal = ctx.signal
                ? AbortSignal.any([closed.signal, ctx.signal])
                : closed.signal;

            for await (const chunk of canonicalStreamToSse(
                canonicalStream,
                routeKind,
                requestId,
                { toolAdapters: ctx.request?.responses_tool_adapters }
            )) {
                if (clientAborted) break;
                if (res.writableEnded) break;
                if (ctx.metadata.ttfbMs == null) {
                    ctx.metadata.ttfbMs = Date.now() - ctx.startedAt;
                }
                if (res.write(chunk) === false) {
                    if (res.writableEnded) break;
                    if (!(await waitForDrain(res, drainSignal))) {
                        clientAborted = true;
                        break;
                    }
                }
            }
        }
        finishedNaturally = !clientAborted;
    } catch (err) {
        streamFailed = true;
        throw err;
    } finally {
        res.off?.('close', onClose);
        if (capture) {
            captured = capture.result();
            ctx.metadata.responseCapture = captured;
            ctx.metadata.aborted = clientAborted && !finishedNaturally;
        }
        // A committed stream that fails is left open so the error boundary
        // can terminate it with a route-specific SSE error event instead of
        // a silently truncated body.
        if (!res.writableEnded && !(streamFailed && !clientAborted)) {
            res.end();
        }
    }

    if (captured?.error) {
        throw captured.error;
    }
}

function isClientGone(res, ctx) {
    return res.destroyed === true || ctx.signal?.aborted === true;
}

// Back-pressure: resolves true once `res` drains and false when the client
// is gone.  A write can fail on a socket that is already destroyed before
// its `close` event has been delivered, so `destroyed` is checked first.
async function waitForDrain(res, signal) {
    if (res.destroyed) return false;
    try {
        await once(res, 'drain', { signal });
        return true;
    } catch {
        // Aborted by `close` or the request signal, or `res` emitted `error`.
        return false;
    }
}

function captureBufferedResponseMetadata(ctx, totalMs) {
    const usage = normalizeUsage(ctx.response?.usage);
    if (usage) {
        ctx.metadata.usage = usage;
        ctx.usage = {
            prompt_tokens: usage.inputTokens,
            completion_tokens: usage.outputTokens,
            total_tokens: usage.totalTokens,
        };
    }
    if (ctx.metadata.ttfbMs == null) {
        ctx.metadata.ttfbMs = totalMs;
    }
}

function observeStreamEvent(ctx, event) {
    if (!event || event.type !== 'usage') return;

    const usage = normalizeUsage(event.data || event);
    if (!usage) return;

    ctx.metadata.usage = usage;
    ctx.usage = {
        prompt_tokens: usage.inputTokens,
        completion_tokens: usage.outputTokens,
        total_tokens: usage.totalTokens,
    };
}

function normalizeUsage(usage) {
    if (!usage) return null;

    const inputTokens =
        usage.inputTokens ??
        usage.input_tokens ??
        usage.promptTokens ??
        usage.prompt_tokens ??
        0;
    const outputTokens =
        usage.outputTokens ??
        usage.output_tokens ??
        usage.completionTokens ??
        usage.completion_tokens ??
        0;

    return {
        inputTokens,
        outputTokens,
        totalTokens:
            usage.totalTokens ??
            usage.total_tokens ??
            inputTokens + outputTokens,
    };
}
