/**
 * Known agent patterns in User-Agent strings.
 * Order matters — first match wins.
 */
const AGENT_PATTERNS = [
  { pattern: /claude[- ]?code/i, name: 'claude-code' },
  { pattern: /codex[- ]?cli/i, name: 'codex-cli' },
  { pattern: /opencode/i, name: 'opencode' },
  { pattern: /gemini[- ]?cli/i, name: 'gemini-cli' },
  { pattern: /aider/i, name: 'aider' },
  { pattern: /continue/i, name: 'continue' },
  { pattern: /cursor/i, name: 'cursor' },
  { pattern: /copilot/i, name: 'copilot' },
  { pattern: /cline/i, name: 'cline' },
  { pattern: /roo[- ]?code/i, name: 'roo-code' },
  { pattern: /windsurf/i, name: 'windsurf' },
  { pattern: /amp/i, name: 'amp' },
];

/**
 * Parse the User-Agent header to detect which AI agent is making the request.
 *
 * @param {string} userAgent - User-Agent header value
 * @returns {string} Agent name or "unknown"
 */
export function parseAgentName(userAgent) {
  if (!userAgent) return 'unknown';

  // Try known patterns
  for (const { pattern, name } of AGENT_PATTERNS) {
    if (pattern.test(userAgent)) return name;
  }

  // Try to extract the first product token (e.g. "my-agent/1.2.3" → "my-agent")
  const productMatch = userAgent.match(/^([a-zA-Z][a-zA-Z0-9_-]*)/);
  if (productMatch) {
    const token = productMatch[1].toLowerCase();
    // Skip generic browser/runtime tokens
    if (!['mozilla', 'node', 'python', 'go', 'curl', 'wget', 'fetch', 'undici'].includes(token)) {
      return token;
    }
  }

  return 'unknown';
}
