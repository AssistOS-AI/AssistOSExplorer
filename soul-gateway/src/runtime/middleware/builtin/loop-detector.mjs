/**
 * Built-in middleware: Loop Detector
 *
 * Pre-hook:  check session state for loop signals, intervene/block/log.
 * Post-hook: record response fingerprint for future loop detection.
 *
 * Detects agent loops by tracking response fingerprints within a sliding
 * window and checking for:
 *   - High similarity ratio (many near-identical responses)
 *   - Token growth exceeding threshold (unbounded expansion)
 */

import { createHash } from 'node:crypto';

export const meta = {
  key: 'loop-detector',
  name: 'Loop Detector',
  description: 'Detects agent loops via response fingerprinting and token growth analysis.',
  version: '1.0.0',
  defaultSettings: {
    mode: 'log',             // 'log' | 'intervene' | 'block'
    similarityThreshold: 5,  // edit distance threshold for "similar" fingerprints
    window: 7,               // number of recent responses to analyze
    growthThreshold: 50_000, // token growth threshold
    minResponses: 3,         // minimum responses before detection kicks in
    repetitiveRatio: 0.60,   // ratio of similar responses to trigger detection
  },
  hooks: 'both',
};

/**
 * In-memory session state for loop detection.
 * sessionId -> { fingerprints: string[], totalTokens: number[] }
 */
const _sessions = new Map();

function getSession(sessionId) {
  let session = _sessions.get(sessionId);
  if (!session) {
    session = { fingerprints: [], totalTokens: [] };
    _sessions.set(sessionId, session);
  }
  return session;
}

/**
 * Compute a short fingerprint of response content.
 */
function fingerprint(text) {
  if (!text) return '';
  return createHash('md5').update(text).digest('hex').slice(0, 16);
}

/**
 * Simple edit-distance check: count differing characters
 * in the hex fingerprints (Hamming distance on hex strings).
 */
function fingerprintDistance(a, b) {
  if (a.length !== b.length) return Math.max(a.length, b.length);
  let dist = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) dist++;
  }
  return dist;
}

/**
 * Check whether a loop is detected in the recent window.
 */
function detectLoop(session, settings) {
  const minResponses = settings.minResponses || 3;
  const windowSize = settings.window || 7;
  const threshold = settings.similarityThreshold ?? 5;
  const repetitiveRatio = settings.repetitiveRatio ?? 0.60;
  const growthThreshold = settings.growthThreshold ?? 50_000;

  const fps = session.fingerprints;
  if (fps.length < minResponses) return { looped: false, reason: null };

  const recent = fps.slice(-windowSize);
  if (recent.length < minResponses) return { looped: false, reason: null };

  // Check similarity: compare each pair in the window
  const latest = recent[recent.length - 1];
  let similarCount = 0;
  for (let i = 0; i < recent.length - 1; i++) {
    if (fingerprintDistance(recent[i], latest) <= threshold) {
      similarCount++;
    }
  }

  const ratio = similarCount / (recent.length - 1);
  if (ratio >= repetitiveRatio) {
    return { looped: true, reason: `Repetitive responses: ${(ratio * 100).toFixed(0)}% similar` };
  }

  // Check token growth
  const tokens = session.totalTokens;
  if (tokens.length >= minResponses) {
    const recentTokens = tokens.slice(-windowSize);
    const growth = recentTokens[recentTokens.length - 1] - recentTokens[0];
    if (growth > growthThreshold) {
      return { looped: true, reason: `Token growth exceeded threshold: ${growth} > ${growthThreshold}` };
    }
  }

  return { looped: false, reason: null };
}

/**
 * Pre-hook: check session for loop signals.
 */
export async function pre(ctx, settings) {
  const sessionId = ctx.session?.key || 'default';
  const session = getSession(sessionId);
  const { looped, reason } = detectLoop(session, settings);

  if (!looped) return;

  const mode = settings.mode || 'log';

  if (mode === 'log') {
    ctx.log.warn('Loop detected (log mode)', { sessionId, reason });
    return;
  }

  if (mode === 'intervene') {
    ctx.log.warn('Loop detected (intervene mode)', { sessionId, reason });
    // Inject a system message telling the model to break the loop
    if (!ctx.request.messages) ctx.request.messages = [];
    ctx.request.messages.push({
      role: 'system',
      content: '[LOOP DETECTED] You appear to be repeating yourself. Please provide a different approach or indicate you are stuck.',
    });
    return;
  }

  if (mode === 'block') {
    ctx.log.warn('Loop detected (block mode)', { sessionId, reason });
    ctx.abort.error(429, `Agent loop detected: ${reason}`);
    return;
  }
}

/**
 * Post-hook: record response fingerprint and token usage.
 */
export async function post(ctx, settings) {
  const sessionId = ctx.session?.key || 'default';
  const session = getSession(sessionId);
  const windowSize = settings.window || 7;

  // Extract text from response
  const responseText = extractResponseText(ctx.response);
  const fp = fingerprint(responseText);
  session.fingerprints.push(fp);

  // Track token growth
  const tokens = ctx.usage?.total_tokens ?? ctx.usage?.totalTokens ?? 0;
  const prev = session.totalTokens.length > 0 ? session.totalTokens[session.totalTokens.length - 1] : 0;
  session.totalTokens.push(prev + tokens);

  // Trim to window + some buffer
  const maxKeep = windowSize * 2;
  if (session.fingerprints.length > maxKeep) {
    session.fingerprints = session.fingerprints.slice(-windowSize);
  }
  if (session.totalTokens.length > maxKeep) {
    session.totalTokens = session.totalTokens.slice(-windowSize);
  }
}

function extractResponseText(response) {
  if (!response) return '';
  if (typeof response === 'string') return response;
  // OpenAI chat completion shape
  const choices = response.choices || [];
  if (choices.length > 0) {
    const msg = choices[0].message || choices[0].delta || {};
    return typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content || '');
  }
  return JSON.stringify(response);
}

/** Exposed for testing. */
export function _resetSessions() {
  _sessions.clear();
}

export function _getSession(sessionId) {
  return _sessions.get(sessionId) || null;
}

export function _setSession(sessionId, data) {
  _sessions.set(sessionId, data);
}
