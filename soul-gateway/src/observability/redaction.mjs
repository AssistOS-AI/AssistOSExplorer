/**
 * Redaction utilities for log entries.
 */

/**
 * Redact sensitive fields from a log entry for broadcast.
 * Full payloads are only sent on soul-specific streams.
 */
export function redactLogEntry(entry) {
  const { request_payload, response_payload, request_headers, ...safe } = entry;
  if (entry.response_excerpt) {
    safe.response_excerpt = entry.response_excerpt;
  }
  return safe;
}

/**
 * Redact request/response payloads for storage.
 * Keeps first N chars as excerpt.
 */
export function redactPayload(text, maxChars = 2000) {
  if (!text) return { excerpt: null, full: text };
  const excerpt = text.length > maxChars ? text.slice(0, maxChars) + '...' : text;
  return { excerpt, full: text };
}
