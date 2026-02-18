import { config } from '../config.mjs';
import { createLogger } from '../utils/logger.mjs';

const log = createLogger('prompt-checker');

/**
 * Check prompt size and return a warning flag if unusually large.
 * Uses a rough token estimate (chars / 4).
 */
export function checkPromptSize(messages) {
  let totalChars = 0;
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      totalChars += msg.content.length;
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === 'text') totalChars += (part.text || '').length;
      }
    }
  }

  const estimatedTokens = Math.ceil(totalChars / 4);
  const requestSizeBytes = totalChars;
  const warning = estimatedTokens > config.largePromptTokens;

  if (warning) {
    log.warn('Large prompt detected', { estimatedTokens, threshold: config.largePromptTokens });
  }

  return { estimatedTokens, requestSizeBytes, promptSizeWarning: warning };
}
