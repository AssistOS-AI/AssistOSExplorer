/**
 * Provider Hook Execution Engine
 *
 * Executes a provider pipeline: request hooks -> executor -> stream hooks -> response hooks.
 *
 * Execution rules (from HOOK-SCOPE-PHASE-REFACTOR.md):
 *   - request hooks:  ascending sort_order
 *   - stream hooks:   stack semantics (last hook wraps outermost)
 *   - response hooks: reverse order (to preserve around-style nesting)
 *
 * The engine returns a handle identical in shape to what the direct executor
 * returns, so the caller (execution-engine) can treat both paths the same way.
 *
 * @module provider-hook-engine
 */

/**
 * Execute a provider pipeline around a terminal executor.
 *
 * @param {object} pipelineCtx
 * @param {Array}    pipelineCtx.requestHooks   - ordered hook entries for request phase
 * @param {Array}    pipelineCtx.streamHooks    - ordered hook entries for stream phase
 * @param {Array}    pipelineCtx.responseHooks  - ordered hook entries for response phase
 * @param {function} pipelineCtx.executor       - the terminal execute function (ctx) => handle
 * @param {object}   pipelineCtx.ctx            - provider execution context
 * @param {object}   [pipelineCtx.log]          - optional logger
 * @returns {Promise<object>} execution handle with .stream, .accountId, ._responseHooks
 */
export async function executeProviderPipeline(pipelineCtx) {
  const { requestHooks, streamHooks, responseHooks, executor, ctx, log } = pipelineCtx;

  // 1. Run request hooks in ascending order
  for (const entry of requestHooks) {
    const hook = entry.hook;
    if (typeof hook.onRequest === 'function') {
      try {
        await hook.onRequest(ctx, entry.settings || {});
      } catch (err) {
        if (log) log.warn('provider request hook error', { hook: hook.meta.key, error: err.message });
      }
    }
  }

  // 2. Execute the terminal executor
  let handle = await executor(ctx);

  // 3. Wrap the stream through stream hooks (stack semantics — last hook wraps outermost)
  if (handle.stream && streamHooks.length > 0) {
    let stream = handle.stream;
    for (const entry of streamHooks) {
      const hook = entry.hook;
      if (typeof hook.wrapStream === 'function') {
        try {
          stream = hook.wrapStream(stream, ctx, entry.settings || {});
        } catch (err) {
          if (log) log.warn('provider stream hook error', { hook: hook.meta.key, error: err.message });
        }
      }
    }
    handle = { ...handle, stream };
  }

  // 4. Attach response hooks to the handle for the caller to invoke after collection.
  //    Response hooks run in REVERSE order to preserve around-style nesting.
  handle._responseHooks = responseHooks;

  return handle;
}

/**
 * Run the response hooks attached to a handle after stream collection.
 *
 * Called by the execution engine after collectNormalizedStream completes.
 *
 * @param {object} handle   - execution handle with _responseHooks
 * @param {object} ctx      - provider context (may be mutated by hooks)
 * @param {object} [log]    - optional logger
 */
export async function runResponseHooks(handle, ctx, log) {
  const hooks = handle._responseHooks;
  if (!hooks || hooks.length === 0) return;

  // Response hooks run in reverse order (last assigned runs first)
  for (let i = hooks.length - 1; i >= 0; i--) {
    const entry = hooks[i];
    const hook = entry.hook;
    if (typeof hook.onResponse === 'function') {
      try {
        await hook.onResponse(ctx, entry.settings || {});
      } catch (err) {
        if (log) log.warn('provider response hook error', { hook: hook.meta.key, error: err.message });
      }
    }
  }
}
