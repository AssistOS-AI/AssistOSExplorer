import { createHash } from 'node:crypto';
import { createLogger } from '../utils/logger.mjs';

const log = createLogger('loop-detector');

const EVICTION_INTERVAL_MS = 5 * 60_000;
const EVICTION_MAX_AGE_MS = 30 * 60_000;

// In-memory state keyed by tracking ID (sessionId or apiKeyId:agentName)
const sessions = new Map();

/**
 * Get or create a tracking session.
 */
function getSession(trackingId) {
  let session = sessions.get(trackingId);
  if (!session) {
    session = {
      fingerprints: [],
      requestCount: 0,
      tokenGrowth: 0,
      lastAccess: Date.now(),
      loopDetected: false,
      interventionCount: 0,
    };
    sessions.set(trackingId, session);
  }
  session.lastAccess = Date.now();
  return session;
}

/**
 * Resolve the tracking ID from available context.
 * Prefers sessionId, falls back to apiKeyId:agentName.
 */
export function resolveTrackingId(sessionId, apiKeyId, agentName) {
  if (sessionId) return sessionId;
  return `${apiKeyId || 'unknown'}:${agentName || 'unknown'}`;
}

/**
 * Extract a fingerprint from an assistant response.
 * Captures the action pattern (tool calls + content prefix) not the full text.
 */
export function extractFingerprint(responseContent) {
  if (!responseContent || typeof responseContent !== 'string') return null;

  const toolPattern = [];
  const toolCallRegex = /(?:"name"\s*:\s*"([^"]+)")|(?:tool_use[^}]*"name"\s*:\s*"([^"]+)")/g;
  let match;
  while ((match = toolCallRegex.exec(responseContent)) !== null) {
    toolPattern.push(match[1] || match[2]);
  }

  const prefix = responseContent.slice(0, 200).trim();
  const raw = toolPattern.length > 0
    ? `tools:${toolPattern.sort().join(',')}|${prefix}`
    : prefix;

  return createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

/**
 * Record a response fingerprint for a tracking session.
 * Called from the middleware after() hook.
 */
export function recordResponse(trackingId, responseContent, windowSize = 7) {
  const session = getSession(trackingId);
  const fingerprint = extractFingerprint(responseContent);
  if (fingerprint) {
    session.fingerprints.push(fingerprint);
    if (session.fingerprints.length > windowSize) {
      session.fingerprints = session.fingerprints.slice(-windowSize);
    }
  }
}

/**
 * Record request growth (message count and estimated tokens).
 * Called from the middleware before() hook.
 */
export function recordRequest(trackingId, messages) {
  const session = getSession(trackingId);
  session.requestCount++;

  if (Array.isArray(messages)) {
    const chars = messages.reduce((sum, m) => {
      const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
      return sum + content.length;
    }, 0);
    session.tokenGrowth += Math.ceil(chars / 4);
  }
}

/**
 * Check if the current session is in a detected loop state.
 * Returns { detected, reason, repetitionRate } or { detected: false }.
 */
export function checkLoop(trackingId, { similarityThreshold = 5, similarityWindow = 7, growthTokenThreshold = 50000 } = {}) {
  const session = getSession(trackingId);
  const fps = session.fingerprints;

  if (fps.length < 3) return { detected: false };

  const window = fps.slice(-similarityWindow);
  const counts = new Map();
  for (const fp of window) {
    counts.set(fp, (counts.get(fp) || 0) + 1);
  }
  const maxCount = Math.max(...counts.values());
  const repetitionRate = maxCount / window.length;

  // Signal 1: Pure response similarity
  if (maxCount >= similarityThreshold) {
    session.loopDetected = true;
    log.warn('Agent loop detected: response similarity', {
      trackingId,
      similarFingerprints: maxCount,
      windowSize: window.length,
      repetitionRate: repetitionRate.toFixed(2),
      requestCount: session.requestCount,
    });
    return { detected: true, reason: 'response_similarity', repetitionRate };
  }

  // Signal 2: Growth + moderate repetition
  if (session.tokenGrowth > growthTokenThreshold && repetitionRate > 0.6) {
    session.loopDetected = true;
    log.warn('Agent loop detected: growth + repetition', {
      trackingId,
      tokenGrowth: session.tokenGrowth,
      repetitionRate: repetitionRate.toFixed(2),
      requestCount: session.requestCount,
    });
    return { detected: true, reason: 'growth_and_repetition', repetitionRate };
  }

  return { detected: false, repetitionRate };
}

/**
 * Mark that an intervention was delivered for this session.
 */
export function markIntervention(trackingId) {
  const session = getSession(trackingId);
  session.interventionCount++;
}

/**
 * Get stats for dashboard/debugging.
 */
export function getLoopDetectorStats() {
  let loopsDetected = 0;
  for (const [, session] of sessions) {
    if (session.loopDetected) loopsDetected++;
  }
  return { trackedSessions: sessions.size, loopsDetected };
}

// --- Eviction: clean up stale entries every 5 minutes ---
const evictionTimer = setInterval(() => {
  const cutoff = Date.now() - EVICTION_MAX_AGE_MS;
  let evicted = 0;
  for (const [id, entry] of sessions) {
    if (entry.lastAccess < cutoff) { sessions.delete(id); evicted++; }
  }
  if (evicted > 0) {
    log.debug('Evicted stale loop-detector entries', { evicted, remaining: sessions.size });
  }
}, EVICTION_INTERVAL_MS);

evictionTimer.unref();
