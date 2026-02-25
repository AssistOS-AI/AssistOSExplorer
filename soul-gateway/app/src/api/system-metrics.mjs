import { sendJson } from '../utils/http-helpers.mjs';
import { getPool } from '../db/init.mjs';
import { getQueueStats } from '../pipeline/model-queue.mjs';
import { getLoopDetectorStats } from '../pipeline/loop-detector.mjs';
import { getStreamStats } from '../ws/log-stream.mjs';

export async function handleSystemMetrics(_req, res) {
  const lagMs = await measureEventLoopLag();

  const mem = process.memoryUsage();
  const pool = getPool();

  sendJson(res, {
    process: {
      rss: mem.rss,
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      external: mem.external,
      uptime: process.uptime(),
      eventLoopLagMs: lagMs,
    },
    db: {
      total: pool.totalCount,
      idle: pool.idleCount,
      waiting: pool.waitingCount,
    },
    modelQueue: getQueueStats(),
    loopDetector: getLoopDetectorStats(),
    streams: getStreamStats(),
  });
}

function measureEventLoopLag() {
  const start = performance.now();
  return new Promise(resolve => {
    setTimeout(() => resolve(Math.round((performance.now() - start) * 100) / 100), 0);
  });
}
