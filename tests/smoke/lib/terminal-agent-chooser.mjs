import { createRedactor, findSecretLeaks } from './security.mjs';
import { redactTraceText, findTraceCredentialResidue } from './redacted-trace.mjs';

export function gitAgentTarget(page, chooser) {
  return chooser.locator('.terminal-target-button').filter({
    has: page.locator('.terminal-target-detail', { hasText: /^AchillesIDE\/gitAgent$/ }),
  });
}

export function matchesProfileDiscovery(response, profileId) {
  const request = response.request();
  if (request.method() !== 'POST' || new URL(response.url()).pathname !== '/webtty/target-discoveries') return false;
  try {
    const profile = request.postDataJSON()?.profile;
    return profile?.provider === 'roboWorkAgent' && profile.id === profileId && profile.mode === 'live-agent';
  } catch { return false; }
}

export function safePrimaryFailure(error, phase) {
  const redact = createRedactor();
  const text = redactTraceText(redact(String(error?.message || error || 'Unknown failure')))
    .replace(/[A-Za-z0-9_-]{24,}/g, '[REDACTED:OPAQUE]').slice(0, 2048);
  return { phase, message: findSecretLeaks(text).length || findTraceCredentialResidue(text).length ? '[REDACTED:RESIDUE]' : text };
}
