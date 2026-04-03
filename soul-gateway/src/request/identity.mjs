/**
 * Identity resolution.
 *
 * Extracts client identity from request headers and User-Agent,
 * producing a stable identity object used for session grouping
 * and observability.
 */

/**
 * Resolve the caller's identity from request headers and User-Agent.
 *
 * @param {object} headers - req.headers object (lowercased keys)
 * @param {string} [userAgent] - raw User-Agent header value
 * @returns {{ soulId: string|null, agentName: string, explicitSessionId: string|null }}
 */
export function resolveIdentity(headers, userAgent) {
  const soulId = getHeader(headers, 'x-soul-id') || null;
  let agentName = getHeader(headers, 'x-agent-name') || getHeader(headers, 'x-soul-agent') || null;
  const explicitSessionId = getHeader(headers, 'x-session-id') || null;

  // If no explicit agent name, infer from User-Agent
  if (!agentName && userAgent) {
    agentName = inferAgentFromUserAgent(userAgent);
  }

  // Fallback to 'unknown' if we still have nothing
  if (!agentName) {
    agentName = 'unknown';
  }

  return { soulId, agentName, explicitSessionId };
}

// ── User-Agent inference ────────────────────────────────────────────

/**
 * Known agent signatures in User-Agent strings.
 * Ordered from most specific to least specific.
 */
const UA_PATTERNS = [
  { pattern: /claude[\s_-]?code/i,          name: 'claude-code' },
  { pattern: /cursor\//i,                    name: 'cursor' },
  { pattern: /cursor-client/i,              name: 'cursor' },
  { pattern: /github[\s_-]?copilot/i,       name: 'copilot' },
  { pattern: /copilot/i,                    name: 'copilot' },
  { pattern: /aider\//i,                    name: 'aider' },
  { pattern: /aider/i,                      name: 'aider' },
  { pattern: /cline\//i,                    name: 'cline' },
  { pattern: /cline/i,                      name: 'cline' },
  { pattern: /windsurf/i,                   name: 'windsurf' },
  { pattern: /continue[\s_-]?dev/i,         name: 'continue' },
  { pattern: /continue\//i,                 name: 'continue' },
  { pattern: /roo[\s_-]?code/i,            name: 'roo-code' },
  { pattern: /kilo[\s_-]?code/i,           name: 'kilo-code' },
  { pattern: /void[\s_-]?editor/i,         name: 'void' },
  { pattern: /zed[\s._-]?editor/i,         name: 'zed' },
  { pattern: /zed\//i,                      name: 'zed' },
  { pattern: /open[\s_-]?interpreter/i,     name: 'open-interpreter' },
  { pattern: /bolt[\s._-]?new/i,           name: 'bolt' },
  { pattern: /vscode/i,                     name: 'vscode' },
  { pattern: /visual[\s_-]?studio[\s_-]?code/i, name: 'vscode' },
  { pattern: /intellij/i,                   name: 'intellij' },
  { pattern: /jetbrains/i,                  name: 'jetbrains' },
  { pattern: /neovim/i,                     name: 'neovim' },
  { pattern: /vim/i,                        name: 'vim' },
  { pattern: /emacs/i,                      name: 'emacs' },
  { pattern: /node[\s_-]?fetch/i,           name: 'node-fetch' },
  { pattern: /python[\s_-]?requests/i,      name: 'python-requests' },
  { pattern: /python-httpx/i,               name: 'python-httpx' },
  { pattern: /axios\//i,                    name: 'axios' },
  { pattern: /openai[\s/_-]?python/i,       name: 'openai-python' },
  { pattern: /openai[\s/_-]?node/i,         name: 'openai-node' },
  { pattern: /anthropic[\s/_-]?python/i,    name: 'anthropic-python' },
  { pattern: /anthropic[\s/_-]?typescript/i, name: 'anthropic-ts' },
];

/**
 * Attempt to infer the calling agent/tool from a User-Agent string.
 *
 * @param {string} ua
 * @returns {string|null} inferred agent name, or null
 */
function inferAgentFromUserAgent(ua) {
  if (!ua) return null;

  for (const { pattern, name } of UA_PATTERNS) {
    if (pattern.test(ua)) return name;
  }

  return null;
}

// ── Helpers ─────────────────────────────────────────────────────────

function getHeader(headers, name) {
  if (!headers) return null;
  const val = headers[name];
  if (val === undefined || val === null || val === '') return null;
  return String(val).trim();
}
