/**
 * Management SSE log streaming routes.
 *
 * GET /management/logs/stream/sse         — redacted live log stream
 * GET /management/logs/stream/soul/:soulId — unredacted stream for one soul
 */

import { createSseStream } from '../core/sse-stream.mjs';
import { sendJson } from '../core/responses.mjs';

/**
 * GET /management/logs/stream/sse
 * Redacted live log stream over SSE.
 */
export async function handleLogStreamSse(ctx) {
  const { res, query, appCtx } = ctx;

  if (!appCtx.services.broadcastHub) {
    sendJson(res, 503, { error: { message: 'Broadcast hub not initialized', type: 'service_unavailable' } });
    return;
  }

  const filters = {};
  if (query.soul_id) filters.soul_id = query.soul_id;
  if (query.model)   filters.model = query.model;
  if (query.status)  filters.status = query.status;

  const stream = createSseStream(res);
  stream.comment('connected');

  appCtx.services.broadcastHub.addSseSubscriber(stream, filters, false);
}

/**
 * GET /management/logs/stream/soul/:soulId
 * Unredacted SSE stream for one soul.
 */
export async function handleLogStreamSoul(ctx) {
  const { res, params, appCtx } = ctx;

  if (!appCtx.services.broadcastHub) {
    sendJson(res, 503, { error: { message: 'Broadcast hub not initialized', type: 'service_unavailable' } });
    return;
  }

  const filters = { soul_id: params.soulId };
  const stream = createSseStream(res);
  stream.comment('connected');

  appCtx.services.broadcastHub.addSseSubscriber(stream, filters, true);
}
