import { randomBytes } from 'node:crypto';

/**
 * Generate an OpenAI-compatible request ID.
 * Format: `{prefix}{base36-timestamp}-{random-hex}`
 */
export function createRequestId(prefix = 'chatcmpl-') {
  const ts = Date.now().toString(36);
  const rand = randomBytes(8).toString('hex');
  return `${prefix}${ts}-${rand}`;
}
