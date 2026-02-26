import { createLogger } from '../utils/logger.mjs';

const log = createLogger('ws-logs');

/** @type {Set<{ws: object, filters: object}>} */
const subscribers = new Set();

/** @type {Set<{res: object, filters: object, alive: boolean}>} */
const sseSubscribers = new Set();

/**
 * Handle a new WebSocket connection for /ws/v1/logs.
 */
export function handleLogStream(ws, query) {
  const filters = {
    soul_id: query.soul_id || null,
    model: query.model || null,
  };

  const sub = { ws, filters };
  subscribers.add(sub);
  log.info('Log stream subscriber connected', { filters, total: subscribers.size });

  ws.send(JSON.stringify({ type: 'connected', filters }));

  // Allow filter updates via message
  ws.onMessage = (msg) => {
    try {
      const data = JSON.parse(msg);
      if (data.type === 'filter') {
        sub.filters = { ...sub.filters, ...data.filters };
        ws.send(JSON.stringify({ type: 'filter_updated', filters: sub.filters }));
      }
    } catch { /* ignore invalid messages */ }
  };

  ws.onClose = () => {
    subscribers.delete(sub);
    log.info('Log stream subscriber disconnected', { total: subscribers.size });
  };
}

/**
 * Handle a new SSE connection for /api/v1/logs/stream.
 */
export function handleSseStream(req, res, query) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const filters = {
    soul_id: query.soul_id || null,
    model: query.model || null,
  };

  const sub = { res, filters, alive: true };
  sseSubscribers.add(sub);
  log.info('SSE subscriber connected', { filters, total: sseSubscribers.size });

  // Send initial connected event
  res.write(`data: ${JSON.stringify({ type: 'connected', filters })}\n\n`);

  // Keepalive comment every 15s to prevent proxy timeouts
  const keepalive = setInterval(() => {
    if (!sub.alive) { clearInterval(keepalive); return; }
    try { res.write(': keepalive\n\n'); } catch { sub.alive = false; clearInterval(keepalive); }
  }, 15_000);

  req.on('close', () => {
    sub.alive = false;
    clearInterval(keepalive);
    sseSubscribers.delete(sub);
    log.info('SSE subscriber disconnected', { total: sseSubscribers.size });
  });
}

export function getStreamStats() {
  return { ws: subscribers.size, sse: sseSubscribers.size };
}

/**
 * Broadcast a log entry to all matching subscribers (WS + SSE).
 */
export function broadcastLog(logEntry) {
  const payload = JSON.stringify({ type: 'log', data: sanitizeForBroadcast(logEntry) });

  for (const sub of subscribers) {
    if (!sub.ws.alive) {
      subscribers.delete(sub);
      continue;
    }
    if (matchesFilters(logEntry, sub.filters)) {
      sub.ws.send(payload);
    }
  }

  // Also broadcast to SSE subscribers
  for (const sub of sseSubscribers) {
    if (!sub.alive) {
      sseSubscribers.delete(sub);
      continue;
    }
    if (matchesFilters(logEntry, sub.filters)) {
      try { sub.res.write(`data: ${payload}\n\n`); } catch { sub.alive = false; }
    }
  }
}

function matchesFilters(entry, filters) {
  if (filters.soul_id && entry.soul_id !== filters.soul_id) return false;
  if (filters.model && entry.resolved_model !== filters.model) return false;
  return true;
}

function sanitizeForBroadcast(entry) {
  // Send a lighter version without full prompt/response content
  return {
    id: entry.id,
    soul_id: entry.soul_id,
    requested_model: entry.requested_model,
    resolved_model: entry.resolved_model,
    mode: entry.mode,
    is_streaming: entry.is_streaming,
    status_code: entry.status_code,
    stop_reason: entry.stop_reason,
    error_type: entry.error_type,
    error_message: entry.error_message,
    latency_ms: entry.latency_ms,
    ttfb_ms: entry.ttfb_ms,
    prompt_tokens: entry.prompt_tokens,
    completion_tokens: entry.completion_tokens,
    total_tokens: entry.total_tokens,
    total_cost: entry.total_cost,
    retry_count: entry.retry_count,
    blocked_by_blacklist: entry.blocked_by_blacklist,
    is_truncated: entry.is_truncated,
    is_slow: entry.is_slow,
    prompt_size_warning: entry.prompt_size_warning,
    started_at: entry.started_at,
    completed_at: entry.completed_at,
  };
}
