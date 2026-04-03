/**
 * Request context factory.
 *
 * Creates the mutable context object that flows through the entire
 * request pipeline. Each stage populates additional fields as they
 * become available (identity, session, normalized request, etc.).
 */

import { createRequestId } from '../core/request-id.mjs';

/**
 * Create a new request context for an incoming HTTP request.
 *
 * The context starts with only the raw HTTP primitives and the
 * application context reference. Pipeline stages populate the
 * remaining fields progressively.
 *
 * @param {object} rawReq - { req, res } from the HTTP handler
 * @param {object} appCtx - application context
 * @returns {object} mutable request context
 */
export function createRequestContext(rawReq, appCtx) {
  const requestId = createRequestId(appCtx.config.defaults.requestIdPrefix);

  return {
    // Core identifiers
    requestId,
    startedAt: Date.now(),

    // HTTP primitives
    req: rawReq.req,
    res: rawReq.res,

    // Application context reference
    appCtx,

    // Route metadata — set by the public-api router before entering the pipeline
    routeKind: null,        // 'openai_chat' | 'anthropic_messages' | 'openai_responses'
    responseFormat: null,   // same as routeKind — the format to serialize responses into

    // Populated by pipeline stages
    body: null,             // raw parsed JSON body
    identity: null,         // { soulId, agentName, explicitSessionId }
    apiKey: null,           // authenticated API key record from DB
    session: null,          // resolved session record
    request: null,          // alias for normalizedRequest used by middleware hooks
    normalizedRequest: null, // { messages, model, stream, ...params }
    resolvedModel: null,    // { model: ModelRecord, resolvedVia, kind }
    snapshot: null,         // runtime snapshot bound at ingress

    // Execution results — populated by dispatch
    completion: null,       // final completion object
    streamController: null, // SSE stream controller (if streaming)

    // Observability
    timings: {},            // { parseMs, authMs, normalizeMs, dispatchMs, totalMs }
    metadata: {},           // extensible metadata bag for middlewares

    // Middleware state
    middlewareState: new Map(),
  };
}
