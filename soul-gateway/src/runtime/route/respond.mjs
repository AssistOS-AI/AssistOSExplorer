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
import { isCanonicalStream } from '../kernel/canonical-stream.mjs';
import { canonicalStreamToSse } from './canonical-stream-to-sse.mjs';
import { CONTENT_TYPES, HEADER_NAMES } from '../../core/constants.mjs';

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
            await streamSseResponse(
                res,
                canonicalStream,
                routeKind,
                ctx.requestId
            );
            return;
        }

        // Buffered branch — ctx.response is a chat completion envelope.
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
async function streamSseResponse(res, canonicalStream, routeKind, requestId) {
    res.writeHead(200, {
        [HEADER_NAMES.CONTENT_TYPE]: CONTENT_TYPES.EVENT_STREAM,
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
    });

    let clientAborted = false;
    const onClose = () => {
        clientAborted = true;
    };
    res.once('close', onClose);

    try {
        for await (const chunk of canonicalStreamToSse(
            canonicalStream,
            routeKind,
            requestId
        )) {
            if (clientAborted) break;
            if (res.writableEnded) break;
            const ok = res.write(chunk);
            if (ok === false) {
                // Back-pressure: wait for drain
                await new Promise((resolve) => res.once('drain', resolve));
            }
        }
    } finally {
        res.off?.('close', onClose);
        if (!res.writableEnded) res.end();
    }
}
