import { createHash } from 'node:crypto';
import { LoopDetectedError } from '../utils/errors.mjs';
import { createLogger } from '../utils/logger.mjs';

const log = createLogger('loop-detector');

// --- Default thresholds ---
const DEFAULT_MAX_REQUESTS_PER_WINDOW = 50;
const WINDOW_MS = 60_000;
const DEFAULT_MAX_IDENTICAL_REQUESTS = 3;
const TOKEN_EXPLOSION_STREAK = 5;
const HISTORY_SIZE = 20;
const EVICTION_INTERVAL_MS = 5 * 60_000;
const EVICTION_MAX_AGE_MS = 30 * 60_000;

// --- In-memory state ---
// Rapid-fire: tracked per session+model so different models don't interfere
const rapidFire = new Map();     // key: "sessionId:model" -> { timestamps, lastAccess }
// Content/token patterns: tracked per session (content hash already includes model)
const contentState = new Map();  // key: sessionId -> { contentHashes, promptSizes, lastAccess }

/**
 * Check for loop patterns and throw LoopDetectedError if detected.
 * Call this synchronously in the pipeline after body parsing.
 *
 * @param {string} sessionId
 * @param {Array} messages - request body messages array
 * @param {number} requestSizeBytes - byte size of the messages payload
 * @param {string} [model] - requested model name (included in content hash so same message to different models isn't flagged)
 * @param {object} [opts]
 * @param {number} [opts.maxRpm] - per-key RPM limit (overrides default 50)
 */
export function checkLoopDetection(sessionId, messages, requestSizeBytes, model, { maxRpm } = {}) {
  const effectiveMaxRpm = maxRpm || DEFAULT_MAX_REQUESTS_PER_WINDOW;
  const maxIdentical = DEFAULT_MAX_IDENTICAL_REQUESTS;
  const now = Date.now();
  const windowStart = now - WINDOW_MS;

  // --- 1. Rapid-fire detection (per session+model) ---
  const rapidKey = model ? `${sessionId}:${model}` : sessionId;
  let rf = rapidFire.get(rapidKey);
  if (!rf) {
    rf = { timestamps: [], lastAccess: now };
    rapidFire.set(rapidKey, rf);
  }
  rf.lastAccess = now;
  rf.timestamps = rf.timestamps.filter(t => t >= windowStart);

  if (rf.timestamps.length >= effectiveMaxRpm) {
    log.warn('Rapid-fire loop detected', { sessionId, model, count: rf.timestamps.length + 1, limit: effectiveMaxRpm });
    throw new LoopDetectedError('rapid_fire',
      `Loop detected: ${rf.timestamps.length + 1} requests for ${model || 'unknown'} in ${WINDOW_MS / 1000}s window`);
  }

  // --- 2. Repeated content detection (per session) ---
  //    Hash includes model so same message to different models isn't flagged
  let cs = contentState.get(sessionId);
  if (!cs) {
    cs = { contentHashes: [], promptSizes: [], lastAccess: now };
    contentState.set(sessionId, cs);
  }
  cs.lastAccess = now;

  const contentHash = messages?.length
    ? createHash('sha256').update(JSON.stringify(messages) + '||' + (model || '')).digest('hex').slice(0, 16)
    : null;

  if (contentHash) {
    // Count consecutive identical requests from the tail of the history.
    // Interleaved different requests (A, B, A, B, A) are NOT a loop.
    let consecutiveCount = 0;
    for (let i = cs.contentHashes.length - 1; i >= 0; i--) {
      if (cs.contentHashes[i] === contentHash) consecutiveCount++;
      else break;
    }
    if (consecutiveCount >= maxIdentical) {
      log.warn('Repeated content loop detected', { sessionId, hash: contentHash, count: consecutiveCount + 1 });
      throw new LoopDetectedError('repeated_content',
        `Loop detected: identical message sent ${consecutiveCount + 1} times`);
    }
  }

  // --- 3. Token explosion detection (per session) ---
  if (cs.promptSizes.length >= TOKEN_EXPLOSION_STREAK - 1) {
    const recentSizes = cs.promptSizes.slice(-(TOKEN_EXPLOSION_STREAK - 1));
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
  rf.timestamps.push(now);

  cs.contentHashes.push(contentHash);
  if (cs.contentHashes.length > HISTORY_SIZE) {
    cs.contentHashes = cs.contentHashes.slice(-HISTORY_SIZE);
  }

  cs.promptSizes.push(requestSizeBytes);
  if (cs.promptSizes.length > HISTORY_SIZE) {
    cs.promptSizes = cs.promptSizes.slice(-HISTORY_SIZE);
  }
}

export function getLoopDetectorStats() {
  return { trackedRapidFire: rapidFire.size, trackedContent: contentState.size };
}

// --- Eviction: clean up stale entries every 5 minutes ---
const evictionTimer = setInterval(() => {
  const cutoff = Date.now() - EVICTION_MAX_AGE_MS;
  let evicted = 0;
  for (const [id, entry] of rapidFire) {
    if (entry.lastAccess < cutoff) { rapidFire.delete(id); evicted++; }
  }
  for (const [id, entry] of contentState) {
    if (entry.lastAccess < cutoff) { contentState.delete(id); evicted++; }
  }
  if (evicted > 0) {
    log.debug('Evicted stale loop-detector entries', { evicted, rapidFire: rapidFire.size, content: contentState.size });
  }
}, EVICTION_INTERVAL_MS);

evictionTimer.unref();
