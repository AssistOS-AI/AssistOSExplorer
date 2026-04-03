/**
 * Built-in middleware: Request Logger
 *
 * Pre-hook:  log request start (model, message count, key).
 * Post-hook: log response metadata (status, token usage, latency).
 */

export const meta = {
  key: 'request-logger',
  name: 'Request Logger',
  description: 'Logs request start and response metadata for observability.',
  version: '1.0.0',
  defaultSettings: {
    logRequestBody: false,    // if true, include message content (expensive)
    logResponseBody: false,   // if true, include response content
    excerptChars: 200,        // max chars for body excerpts
  },
  hooks: 'both',
};

/**
 * Pre-hook: log request start.
 */
export async function pre(ctx, settings) {
  const req = ctx.request;

  // Stash start time for latency measurement in post-hook
  ctx.state?.set?.('request-logger:startMs', Date.now());

  const entry = {
    model: req.model,
    messageCount: req.messages?.length ?? 0,
    keyId: ctx.auth?.keyId || 'anonymous',
    stream: !!req.stream,
  };

  if (settings.logRequestBody && req.messages?.length > 0) {
    const last = req.messages[req.messages.length - 1];
    const text = typeof last.content === 'string' ? last.content : JSON.stringify(last.content || '');
    const maxChars = settings.excerptChars || 200;
    entry.lastMessageExcerpt = text.length > maxChars
      ? text.slice(0, maxChars) + '...'
      : text;
  }

  ctx.log.info('Request start', entry);
}

/**
 * Post-hook: log response metadata.
 */
export async function post(ctx, settings) {
  const req = ctx.request;
  const startMs = ctx.state?.get?.('request-logger:startMs') || Date.now();
  const latencyMs = Date.now() - startMs;

  const entry = {
    model: req.model,
    keyId: ctx.auth?.keyId || 'anonymous',
    latencyMs,
  };

  if (ctx.usage) {
    entry.promptTokens = ctx.usage.prompt_tokens ?? ctx.usage.promptTokens ?? 0;
    entry.completionTokens = ctx.usage.completion_tokens ?? ctx.usage.completionTokens ?? 0;
    entry.totalTokens = ctx.usage.total_tokens ?? ctx.usage.totalTokens ?? 0;
  }

  if (settings.logResponseBody && ctx.response) {
    const text = extractResponseText(ctx.response);
    const maxChars = settings.excerptChars || 200;
    entry.responseExcerpt = text.length > maxChars
      ? text.slice(0, maxChars) + '...'
      : text;
  }

  ctx.log.info('Request complete', entry);
}

function extractResponseText(response) {
  if (!response) return '';
  if (typeof response === 'string') return response;
  const choices = response.choices || [];
  if (choices.length > 0) {
    const msg = choices[0].message || {};
    return typeof msg.content === 'string' ? msg.content : '';
  }
  return '';
}
