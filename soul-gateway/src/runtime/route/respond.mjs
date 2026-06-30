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
 * @module runtime/route/respond
 */

import { sendJson } from '../../core/responses.mjs';
import { serializeBufferedResponse } from '../../request/format-serializers.mjs';
import { isCanonicalStream, tapStream } from '../kernel/index.mjs';
import { canonicalStreamToSse } from './canonical-stream-to-sse.mjs';
import { createStreamCapture } from '../../observability/response-capture.mjs';
import { CONTENT_TYPES, HEADER_NAMES } from '../../core/constants.mjs';
import { InternalServerError } from '../../core/errors.mjs';

/**
 * @returns {(ctx: object, next: () => Promise<void>) => Promise<void>}
 */
export function respondMiddleware() {
    return async function respond(ctx, next) {
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
        const candidate = ctx.response;
        if (
            candidate &&
            (isCanonicalStream(candidate) ||
                (candidate.stream && isCanonicalStream(candidate.stream)))
        ) {
            const canonicalStream = isCanonicalStream(candidate)
                ? candidate
                : candidate.stream;
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
            ctx.requestId
        );
        sendJson(res, 200, serialized);
    };
}

/**
 * Write the SSE headers and stream the converted canonical events to
 * the client.  Handles client-disconnect abort by stopping iteration
 * when `res` emits `close` before the stream finishes.
 */
async function streamSseResponse(
    res,
    canonicalStream,
    routeKind,
    requestId,
    ctx,
    capture
) {
    res.writeHead(200, {
        [HEADER_NAMES.CONTENT_TYPE]: CONTENT_TYPES.EVENT_STREAM,
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
    });

    let clientAborted = false;
    let finishedNaturally = false;
    const onClose = () => {
        clientAborted = true;
    };
    res.once('close', onClose);
    let captured = null;

    try {
        for await (const chunk of canonicalStreamToSse(
            canonicalStream,
            routeKind,
            requestId
        )) {
            if (clientAborted) break;
            if (res.writableEnded) break;
            if (ctx.metadata.ttfbMs == null) {
                ctx.metadata.ttfbMs = Date.now() - ctx.startedAt;
            }
            const ok = res.write(chunk);
            if (ok === false) {
                // Back-pressure: wait for drain
                await new Promise((resolve) => res.once('drain', resolve));
            }
        }
        finishedNaturally = !clientAborted;
    } finally {
        res.off?.('close', onClose);
        if (capture) {
            captured = capture.result();
            ctx.metadata.responseCapture = captured;
            ctx.metadata.aborted = clientAborted && !finishedNaturally;
        }
        if (!res.writableEnded) res.end();
    }

    if (captured?.error) {
        throw captured.error;
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
