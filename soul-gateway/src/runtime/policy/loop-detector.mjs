/**
 * Agent loop detection.
 *
 * Detects repetitive agent behavior by fingerprinting responses and checking
 * for two signals:
 *   - Similarity: too many identical fingerprints in the recent window
 *   - Growth:     token volume is high AND responses are repetitive
 */

import { createHash } from 'node:crypto';

/**
 * Evaluate whether the current response indicates a loop.
 *
 * Mutates `sessionState.recent_fingerprints` (rolling window of hashes).
 *
 * @param {object} sessionState  Mutable session state, must have `recent_fingerprints: string[]`
 * @param {object} response      The provider response
 * @param {string} [response.content]        Response text
 * @param {Array}  [response.tool_calls]     Tool calls array
 * @param {object} settings
 * @param {number} settings.minResponses            Minimum responses before checking (default 3)
 * @param {number} settings.windowSize               Rolling window size (default 7)
 * @param {number} settings.similarityThreshold      How many identical fingerprints trigger a loop (default 5)
 * @param {number} settings.growthThresholdTokens    Token volume threshold (default 50000)
 * @param {number} settings.repetitiveRatioThreshold Ratio of identical fingerprints (default 0.6)
 * @param {string} settings.mode                     Action mode: 'intervene' | 'block' | 'log' (default 'log')
 * @returns {{ loopDetected: boolean, signal: 'similarity'|'growth'|null, mode: 'intervene'|'block'|'log' }}
 */
export function evaluateLoopSignal(sessionState, response, settings) {
  const {
    minResponses = 3,
    windowSize = 7,
    similarityThreshold = 5,
    growthThresholdTokens = 50_000,
    repetitiveRatioThreshold = 0.60,
    mode = 'log',
  } = settings || {};

  // Ensure the fingerprint array exists
  if (!Array.isArray(sessionState.recent_fingerprints)) {
    sessionState.recent_fingerprints = [];
  }

  // Compute fingerprint for this response
  const fingerprint = hashResponse(response);

  // Add to rolling window
  sessionState.recent_fingerprints.push(fingerprint);

  // Trim to window size
  while (sessionState.recent_fingerprints.length > windowSize) {
    sessionState.recent_fingerprints.shift();
  }

  const fps = sessionState.recent_fingerprints;

  // Not enough data yet
  if (fps.length < minResponses) {
    return { loopDetected: false, signal: null, mode };
  }

  // ── Similarity check ──────────────────────────────────────────────
  // Count how many of the recent fingerprints are identical to the current one
  let identicalCount = 0;
  for (const fp of fps) {
    if (fp === fingerprint) identicalCount++;
  }

  if (identicalCount >= similarityThreshold) {
    return { loopDetected: true, signal: 'similarity', mode };
  }

  // ── Growth check ──────────────────────────────────────────────────
  // Estimate total token volume in the window
  const totalTokens = estimateResponseTokens(response) * fps.length;

  if (totalTokens > growthThresholdTokens) {
    const repetitiveRatio = identicalCount / fps.length;
    if (repetitiveRatio >= repetitiveRatioThreshold) {
      return { loopDetected: true, signal: 'growth', mode };
    }
  }

  return { loopDetected: false, signal: null, mode };
}

// ── internals ─────────────────────────────────────────────────────────

/**
 * Create a SHA-256 fingerprint from response content + tool calls.
 */
function hashResponse(response) {
  const hash = createHash('sha256');

  // Include text content
  if (response && typeof response.content === 'string') {
    hash.update(response.content);
  }

  // Include tool calls (name + arguments)
  if (response && Array.isArray(response.tool_calls)) {
    for (const tc of response.tool_calls) {
      if (tc.function) {
        hash.update(tc.function.name || '');
        hash.update(tc.function.arguments || '');
      }
    }
  }

  return hash.digest('hex');
}

/**
 * Rough token estimate for a response (for growth check).
 */
function estimateResponseTokens(response) {
  let chars = 0;
  if (response && typeof response.content === 'string') {
    chars += response.content.length;
  }
  if (response && Array.isArray(response.tool_calls)) {
    for (const tc of response.tool_calls) {
      if (tc.function) {
        chars += (tc.function.name || '').length;
        chars += (tc.function.arguments || '').length;
      }
    }
  }
  return Math.ceil(chars / 4);
}
