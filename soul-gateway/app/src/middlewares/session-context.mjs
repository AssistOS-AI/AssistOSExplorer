// In-memory session store (keyed by sessionId)
const sessionStore = new Map();

// Cleanup sessions older than TTL
function cleanupSessions(ttlMs) {
  const now = Date.now();
  for (const [key, session] of sessionStore) {
    if (now - session.lastAccess > ttlMs) {
      sessionStore.delete(key);
    }
  }
}

export default {
  name: 'session-context',
  description: 'Maintains rolling session context and injects it as a system message for continuity (MemStack-inspired)',
  version: '1.0.0',
  type: 'both',
  supportsStreaming: false,
  defaultSettings: {
    maxSummaryTokens: 500,  // Max tokens for injected context summary
    sessionTTL: 3600,       // Session TTL in seconds
    extractEntities: true,  // Extract key entities from responses
  },

  async before(ctx, settings) {
    if (!ctx.sessionId) return;

    const ttlMs = (settings.sessionTTL || 3600) * 1000;
    cleanupSessions(ttlMs);

    const session = sessionStore.get(ctx.sessionId);
    if (!session || session.facts.length === 0) return;

    // Build context summary from accumulated facts
    const maxChars = (settings.maxSummaryTokens || 500) * 4;
    let summary = 'Session context from prior exchanges:\n';
    let charCount = summary.length;

    for (const fact of session.facts) {
      const line = `- ${fact}\n`;
      if (charCount + line.length > maxChars) break;
      summary += line;
      charCount += line.length;
    }

    // Inject as system message at the beginning
    ctx.messages = [
      { role: 'system', content: summary },
      ...ctx.messages,
    ];

    ctx.metadata.sessionContextInjected = true;
    ctx.metadata.sessionFactCount = session.facts.length;

    session.lastAccess = Date.now();
  },

  async after(ctx, settings) {
    if (!ctx.sessionId || !ctx.response) return;
    if (!settings.extractEntities) return;

    const ttlMs = (settings.sessionTTL || 3600) * 1000;

    let session = sessionStore.get(ctx.sessionId);
    if (!session) {
      session = { facts: [], lastAccess: Date.now() };
      sessionStore.set(ctx.sessionId, session);
    }

    // Extract key facts from the response (simple heuristic approach)
    const facts = extractFacts(ctx.response);
    for (const fact of facts) {
      // Avoid duplicates
      if (!session.facts.includes(fact)) {
        session.facts.push(fact);
      }
    }

    // Cap total facts to prevent unbounded growth
    const maxFacts = Math.ceil((settings.maxSummaryTokens || 500) / 10);
    if (session.facts.length > maxFacts) {
      session.facts = session.facts.slice(-maxFacts);
    }

    session.lastAccess = Date.now();

    // Schedule cleanup
    cleanupSessions(ttlMs);
  },
};

/**
 * Simple fact extraction from response text.
 * Looks for: decisions, names, file paths, URLs, numbers with context.
 */
function extractFacts(text) {
  if (!text || typeof text !== 'string') return [];
  const facts = [];

  // Extract sentences with decision-like language
  const sentences = text.split(/[.!?\n]+/).map(s => s.trim()).filter(s => s.length > 20 && s.length < 300);

  const decisionPatterns = [
    /\b(?:decided|chose|selected|using|switched to|changed to|set .+ to)\b/i,
    /\b(?:the (?:solution|fix|answer|result) (?:is|was))\b/i,
    /\b(?:created|updated|deleted|added|removed|installed)\b/i,
  ];

  for (const sentence of sentences) {
    if (decisionPatterns.some(p => p.test(sentence))) {
      facts.push(sentence);
      if (facts.length >= 5) break;
    }
  }

  return facts;
}
