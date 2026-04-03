/**
 * Middleware Execution Engine.
 *
 * Runs an ordered middleware plan around a dispatch function.
 * Pre-hooks execute before dispatch, post-hooks after.
 * Abort signals (SyntheticResponseAbort, MiddlewareAbortError) are
 * propagated; all other middleware errors are caught, logged, and
 * swallowed so a misbehaving middleware never crashes a request.
 */

import { SyntheticResponseAbort, MiddlewareAbortError } from '../../core/errors.mjs';
import { abortSuccess, abortError } from './middleware-abort.mjs';

/**
 * Execute the full middleware pipeline.
 *
 * @param {Object}   planCtx
 * @param {Object}   planCtx.reqCtx   - Per-request context (request, appCtx, log, …).
 * @param {Array}    planCtx.plan     - Ordered list from MiddlewareCatalog.resolveAssignmentPlan.
 * @param {Function} planCtx.dispatch - The actual provider call: async () => result.
 * @returns {{ result: Object|null, synthetic: boolean, abortedBy: string|null }}
 */
export async function runMiddlewarePlan(planCtx) {
  const { reqCtx, plan, dispatch } = planCtx;
  const log = reqCtx.log || reqCtx.appCtx?.log || noopLog;

  // ── Pre-dispatch hooks ────────────────────────────────────────────

  for (const entry of plan) {
    if (!entry.hooks.pre) continue;
    if (entry.hookMode === 'post') continue; // hook_mode says post-only

    const hookCtx = buildHookCtx(reqCtx, entry, 'pre', log);

    try {
      await entry.hooks.pre(hookCtx, entry.settings);
    } catch (err) {
      // Abort-success: middleware provided a synthetic response
      if (err instanceof SyntheticResponseAbort) {
        log.info('Middleware aborted with synthetic response', {
          middleware: entry.middlewareKey,
        });
        return {
          result: err.syntheticResponse,
          synthetic: true,
          abortedBy: entry.middlewareKey,
        };
      }
      // Abort-error: middleware wants to block the request
      if (err instanceof MiddlewareAbortError) {
        log.warn('Middleware aborted with error', {
          middleware: entry.middlewareKey,
          status: err.httpStatus,
          message: err.message,
        });
        throw err;
      }
      // Any other error: log and continue — middleware failures are non-fatal
      log.error('Middleware pre-hook error (suppressed)', {
        middleware: entry.middlewareKey,
        error: err.message,
        stack: err.stack,
      });
    }
  }

  // ── Dispatch ──────────────────────────────────────────────────────

  const result = await dispatch();

  // ── Post-dispatch hooks ───────────────────────────────────────────

  for (const entry of plan) {
    if (!entry.hooks.post) continue;
    if (entry.hookMode === 'pre') continue; // hook_mode says pre-only

    const hookCtx = buildHookCtx(reqCtx, entry, 'post', log, result);

    try {
      await entry.hooks.post(hookCtx, entry.settings);
    } catch (err) {
      // Abort signals from post hooks are still respected
      if (err instanceof SyntheticResponseAbort) {
        log.info('Post-hook aborted with synthetic response', {
          middleware: entry.middlewareKey,
        });
        return {
          result: err.syntheticResponse,
          synthetic: true,
          abortedBy: entry.middlewareKey,
        };
      }
      if (err instanceof MiddlewareAbortError) {
        log.warn('Post-hook aborted with error', {
          middleware: entry.middlewareKey,
          status: err.httpStatus,
          message: err.message,
        });
        throw err;
      }
      log.error('Middleware post-hook error (suppressed)', {
        middleware: entry.middlewareKey,
        error: err.message,
        stack: err.stack,
      });
    }
  }

  return { result, synthetic: false, abortedBy: null };
}

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Build the context object passed to each middleware hook.
 *
 * @param {Object}  reqCtx      - The request-level context.
 * @param {Object}  entry       - Plan entry with { middlewareKey, settings, hooks }.
 * @param {string}  phase       - 'pre' or 'post'.
 * @param {Object}  log         - Logger.
 * @param {Object}  [result]    - Dispatch result (post-phase only).
 */
function buildHookCtx(reqCtx, entry, phase, log, result = undefined) {
  const request = reqCtx.normalizedRequest ?? reqCtx.request ?? null;
  const auth = buildAuthContext(reqCtx);
  const session = buildSessionContext(reqCtx, auth);
  const runtime = buildRuntimeContext(reqCtx);

  const ctx = {
    request,
    log,
    auth,
    session,
    runtime,
    // Deprecated compatibility alias. This is a narrowed runtime view,
    // not the mutable application context.
    appCtx: runtime,
    state: reqCtx.middlewareState,
    metadata: reqCtx.metadata,
    abort: {
      success: (response) => abortSuccess(entry.middlewareKey, response),
      error: (httpStatus, message) => abortError(entry.middlewareKey, httpStatus, message),
    },
  };

  if (phase === 'post') {
    ctx.response = result?.response ?? result ?? null;
    ctx.usage = result?.usage ?? null;
  }

  return ctx;
}

function buildAuthContext(reqCtx) {
  const apiKey = reqCtx.apiKey || null;
  const env = reqCtx.appCtx?.config?.env || {};

  return Object.freeze({
    keyId: apiKey?.id || 'anonymous',
    label: apiKey?.label || null,
    rpmLimit: apiKey?.rpm_limit ?? env.DEFAULT_RPM_LIMIT ?? null,
    tpmLimit: apiKey?.tpm_limit ?? env.DEFAULT_TPM_LIMIT ?? null,
    apiKeyRecord: apiKey,
  });
}

function buildSessionContext(reqCtx, auth) {
  const session = reqCtx.session || null;
  const identity = reqCtx.identity || null;
  const explicitId = identity?.explicitSessionId || session?.explicit_session_id || null;
  const key = explicitId
    ? `explicit:${auth.keyId}:${explicitId}`
    : session?.group_key || auth.keyId || 'default';

  return Object.freeze({
    id: session?.id || explicitId || null,
    key,
    explicitId,
    agentName: identity?.agentName || session?.agent_name || null,
    soulId: identity?.soulId || session?.soul_id || null,
  });
}

function buildRuntimeContext(reqCtx) {
  const services = Object.freeze({
    spendCache: reqCtx.appCtx?.services?.spendCache || null,
    systemMetrics: reqCtx.appCtx?.services?.systemMetrics || null,
  });

  return Object.freeze({
    config: reqCtx.appCtx?.config || null,
    pool: reqCtx.appCtx?.pool || null,
    services,
  });
}

const noopLog = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
};
