/**
 * Management WebSocket log streaming routes.
 *
 * WS /ws/logs             — redacted live log stream
 * WS /ws/logs/soul/:soulId — unredacted stream for one soul
 */

import { completeUpgrade, sendTextFrame } from '../core/websocket-frame-codec.mjs';
import { parseUrl } from '../core/router.mjs';

/**
 * WS /ws/logs
 * Redacted live log stream over WebSocket.
 */
export function handleLogStreamWs(ctx) {
  const { req, socket, head, params, appCtx } = ctx;

  if (!appCtx.services.broadcastHub) {
    socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
    socket.destroy();
    return;
  }

  const ok = completeUpgrade(req, socket);
  if (!ok) {
    socket.destroy();
    return;
  }

  // Parse initial filters from query string
  const { query } = parseUrl(req);
  const filters = {};
  if (query.soul_id) filters.soul_id = query.soul_id;
  if (query.model)   filters.model = query.model;
  if (query.status)  filters.status = query.status;

  appCtx.services.broadcastHub.addWsSubscriber(socket, filters, false);

  // Send welcome message
  sendTextFrame(socket, JSON.stringify({ type: 'connected', filters }));
}

/**
 * WS /ws/logs/soul/:soulId
 * Unredacted live log stream for one soul over WebSocket.
 */
export function handleLogStreamWsSoul(ctx) {
  const { req, socket, head, params, appCtx } = ctx;

  if (!appCtx.services.broadcastHub) {
    socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
    socket.destroy();
    return;
  }

  const ok = completeUpgrade(req, socket);
  if (!ok) {
    socket.destroy();
    return;
  }

  const filters = { soul_id: params.soulId };
  appCtx.services.broadcastHub.addWsSubscriber(socket, filters, true);

  sendTextFrame(socket, JSON.stringify({ type: 'connected', soulId: params.soulId }));
}
