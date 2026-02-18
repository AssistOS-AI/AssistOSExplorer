import { createLogger } from '../utils/logger.mjs';

const log = createLogger('ws-soul');

/** @type {Map<string, Set<object>>} */
const soulSubscribers = new Map();

/**
 * Handle a new WebSocket connection for /ws/v1/soul/:soulId.
 */
export function handleSoulStream(ws, soulId, query) {
  if (!soulSubscribers.has(soulId)) {
    soulSubscribers.set(soulId, new Set());
  }
  const subs = soulSubscribers.get(soulId);
  subs.add(ws);
  log.info('Soul stream subscriber connected', { soulId, total: subs.size });

  ws.send(JSON.stringify({ type: 'connected', soul_id: soulId }));

  ws.onClose = () => {
    subs.delete(ws);
    if (subs.size === 0) soulSubscribers.delete(soulId);
    log.info('Soul stream subscriber disconnected', { soulId });
  };
}

/**
 * Broadcast a log entry to subscribers of a specific soul.
 */
export function broadcastToSoul(soulId, logEntry) {
  const subs = soulSubscribers.get(soulId);
  if (!subs || subs.size === 0) return;

  const payload = JSON.stringify({ type: 'log', data: logEntry });
  for (const ws of subs) {
    if (!ws.alive) {
      subs.delete(ws);
      continue;
    }
    ws.send(payload);
  }
}
