import { createHash } from 'node:crypto';
import { LoopDetectedError } from '../utils/errors.mjs';
import { createLogger } from '../utils/logger.mjs';

const log = createLogger('loop-detector');

// --- Thresholds ---
const MAX_REQUESTS_PER_WINDOW = 15;
const WINDOW_MS = 60_000;
const MAX_IDENTICAL_REQUESTS = 3;
const TOKEN_EXPLOSION_STREAK = 5;
const HISTORY_SIZE = 20;
const EVICTION_INTERVAL_MS = 5 * 60_000;
const EVICTION_MAX_AGE_MS = 30 * 60_000;

// --- In-memory state ---
const sessions = new Map();

/**
 * Check for loop patterns and throw LoopDetectedError if detected.
 * Call this synchronously in the pipeline after body parsing.
 *
 * @param {string} sessionId
 * @param {Array} messages - request body messages array
 * @param {number} requestSizeBytes - byte size of the messages payload
 */
export function checkLoopDetection(sessionId, messages, requestSizeBytes) {
  const now = Date.now();
  let history = sessions.get(sessionId);

  if (!history) {
    history = { timestamps: [], contentHashes: [], promptSizes: [], lastAccess: now };
    sessions.set(sessionId, history);
  }

  history.lastAccess = now;

  // Prune timestamps outside the window
  const windowStart = now - WINDOW_MS;
  history.timestamps = history.timestamps.filter(t => t >= windowStart);

  // 1. Rapid-fire detection
  if (history.timestamps.length >= MAX_REQUESTS_PER_WINDOW) {
    log.warn('Rapid-fire loop detected', { sessionId, count: history.timestamps.length + 1 });
    throw new LoopDetectedError('rapid_fire',
      `Loop detected: ${history.timestamps.length + 1} requests in ${WINDOW_MS / 1000}s window`);
  }

  // 2. Repeated content detection — hash the full messages array
  //    so requests with different tool history/context are not flagged as duplicates
  const contentHash = messages?.length
    ? createHash('sha256').update(JSON.stringify(messages)).digest('hex').slice(0, 16)
    : null;

  if (contentHash) {
    // Count consecutive identical requests from the tail of the history.
    // Interleaved different requests (A, B, A, B, A) are NOT a loop.
    let consecutiveCount = 0;
    for (let i = history.contentHashes.length - 1; i >= 0; i--) {
      if (history.contentHashes[i] === contentHash) consecutiveCount++;
      else break;
    }
    if (consecutiveCount >= MAX_IDENTICAL_REQUESTS) {
      log.warn('Repeated content loop detected', { sessionId, hash: contentHash, count: consecutiveCount + 1 });
      throw new LoopDetectedError('repeated_content',
        `Loop detected: identical message sent ${consecutiveCount + 1} times`);
    }
  }

  // 3. Token explosion detection
  if (history.promptSizes.length >= TOKEN_EXPLOSION_STREAK - 1) {
    const recentSizes = history.promptSizes.slice(-(TOKEN_EXPLOSION_STREAK - 1));
    const allIncreasing = recentSizes.every((size, i) =>
      i === 0 || size > recentSizes[i - 1]
    );
    if (allIncreasing && requestSizeBytes > recentSizes[recentSizes.length - 1]) {
      log.warn('Token explosion loop detected', {
        sessionId,
        sizes: [...recentSizes, requestSizeBytes],
      });
      throw new LoopDetectedError('token_explosion',
        'Loop detected: prompt size growing monotonically across consecutive requests');
    }
  }

  // Record current request
  history.timestamps.push(now);

  history.contentHashes.push(contentHash);
  if (history.contentHashes.length > HISTORY_SIZE) {
    history.contentHashes = history.contentHashes.slice(-HISTORY_SIZE);
  }

  history.promptSizes.push(requestSizeBytes);
  if (history.promptSizes.length > HISTORY_SIZE) {
    history.promptSizes = history.promptSizes.slice(-HISTORY_SIZE);
  }
}

// --- Eviction: clean up stale sessions every 5 minutes ---
const evictionTimer = setInterval(() => {
  const cutoff = Date.now() - EVICTION_MAX_AGE_MS;
  let evicted = 0;
  for (const [id, history] of sessions) {
    if (history.lastAccess < cutoff) {
      sessions.delete(id);
      evicted++;
    }
  }
  if (evicted > 0) {
    log.debug('Evicted stale loop-detector sessions', { evicted, remaining: sessions.size });
  }
}, EVICTION_INTERVAL_MS);

evictionTimer.unref();
