/**
 * Built-in middleware: Session Context
 *
 * Pre-hook:  inject a rolling summary of previous interactions.
 * Post-hook: extract key facts from the response to update the summary.
 *
 * Maintains an in-memory per-session summary string that grows with
 * each interaction but is bounded by maxSummaryTokens.
 */

export const meta = {
  key: 'session-context',
  name: 'Session Context',
  description: 'Maintains and injects a rolling session summary across requests.',
  version: '1.0.0',
  defaultSettings: {
    maxSummaryTokens: 1000,
    charsPerToken: 4,
    summaryRole: 'system',
    summaryPrefix: '[Session summary] ',
  },
  hooks: 'both',
};

/**
 * In-memory session summaries.
 * sessionId -> string
 */
const _summaries = new Map();

/**
 * Pre-hook: inject session summary as a system message if one exists.
 */
export async function pre(ctx, settings) {
  const sessionId = ctx.session?.key || 'default';
  const summary = _summaries.get(sessionId);
  if (!summary) return;

  const prefix = settings.summaryPrefix || '[Session summary] ';
  if (!ctx.request.messages) ctx.request.messages = [];

  ctx.request.messages.unshift({
    role: settings.summaryRole || 'system',
    content: `${prefix}${summary}`,
  });

  ctx.log.debug('Session context injected', { sessionId, summaryLength: summary.length });
}

/**
 * Post-hook: extract key facts and update the rolling summary.
 */
export async function post(ctx, settings) {
  const sessionId = ctx.session?.key || 'default';
  const maxChars = (settings.maxSummaryTokens || 1000) * (settings.charsPerToken || 4);

  const responseText = extractResponseText(ctx.response);
  if (!responseText) return;

  // Extract a brief excerpt from the response
  const excerpt = responseText.length > 500
    ? responseText.slice(0, 500)
    : responseText;

  // Append to existing summary
  const existing = _summaries.get(sessionId) || '';
  let updated = existing
    ? `${existing}\n- ${excerpt}`
    : excerpt;

  // Trim if exceeds max
  if (updated.length > maxChars) {
    updated = updated.slice(-maxChars);
    // Clean up — start from the first complete line
    const nl = updated.indexOf('\n');
    if (nl > 0 && nl < 200) {
      updated = updated.slice(nl + 1);
    }
  }

  _summaries.set(sessionId, updated);
  ctx.log.debug('Session context updated', { sessionId, summaryLength: updated.length });
}

function extractResponseText(response) {
  if (!response) return '';
  if (typeof response === 'string') return response;
  const choices = response.choices || [];
  if (choices.length > 0) {
    const msg = choices[0].message || choices[0].delta || {};
    return typeof msg.content === 'string' ? msg.content : '';
  }
  return '';
}

/** Exposed for testing. */
export function _resetSummaries() {
  _summaries.clear();
}

export function _getSummary(sessionId) {
  return _summaries.get(sessionId) || null;
}

export function _setSummary(sessionId, text) {
  _summaries.set(sessionId, text);
}
