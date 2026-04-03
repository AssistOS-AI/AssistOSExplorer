/**
 * Hook Adapter — bidirectional conversion between the legacy middleware
 * format (meta + pre/post exports) and the shared hook contract
 * (meta + onRequest/wrapStream/onResponse).
 *
 * These adapters let existing built-in middlewares expose the hook
 * interface without being rewritten, and let new hook-style modules
 * run through the existing middleware engine unchanged.
 *
 * @module hook-adapter
 */

/**
 * Adapt a legacy middleware module to the shared hook contract.
 *
 * Takes a module that exports { meta, pre?, post? } and returns a
 * HookModule-compatible object with { meta, onRequest?, onResponse? }.
 *
 * The original module is not mutated.
 *
 * @param {Object} middlewareModule - A module with meta, optional pre, optional post.
 * @returns {import('./hook-interface.mjs').HookModule}
 */
export function adaptMiddlewareToHook(middlewareModule) {
  if (!middlewareModule || !middlewareModule.meta) {
    throw new Error('adaptMiddlewareToHook: module must export meta');
  }

  const { meta } = middlewareModule;
  const hasPre  = typeof middlewareModule.pre === 'function';
  const hasPost = typeof middlewareModule.post === 'function';

  const phases = [];
  if (hasPre)  phases.push('request');
  if (hasPost) phases.push('response');

  const hookMeta = {
    key:             meta.key,
    name:            meta.name || meta.key,
    description:     meta.description || '',
    version:         meta.version || '1.0.0',
    scope:           'gateway',
    phases,
    defaultSettings: meta.defaultSettings || {},
  };

  const hook = { meta: hookMeta };

  if (hasPre)  hook.onRequest  = middlewareModule.pre;
  if (hasPost) hook.onResponse = middlewareModule.post;
  // Legacy middlewares never have wrapStream.
  hook.wrapStream = null;

  return hook;
}

/**
 * Adapt a hook-style module to the legacy middleware format.
 *
 * Takes a HookModule and returns an object that the existing
 * MiddlewareEngine can consume: { meta, pre?, post? }.
 *
 * The original hook is not mutated.
 *
 * @param {import('./hook-interface.mjs').HookModule} hookModule
 * @returns {{ meta: Object, pre?: Function, post?: Function }}
 */
export function adaptHookToMiddleware(hookModule) {
  if (!hookModule || !hookModule.meta) {
    throw new Error('adaptHookToMiddleware: hook must export meta');
  }

  const { meta } = hookModule;
  const hasOnRequest  = typeof hookModule.onRequest === 'function';
  const hasOnResponse = typeof hookModule.onResponse === 'function';

  // Derive the legacy hooks field from the phases array.
  let hooks;
  if (hasOnRequest && hasOnResponse) {
    hooks = 'both';
  } else if (hasOnRequest) {
    hooks = 'pre';
  } else if (hasOnResponse) {
    hooks = 'post';
  } else {
    hooks = 'both'; // fallback — stream-only hooks have no pre/post
  }

  const middlewareMeta = {
    key:             meta.key,
    name:            meta.name || meta.key,
    description:     meta.description || '',
    version:         meta.version || '1.0.0',
    defaultSettings: meta.defaultSettings || {},
    hooks,
  };

  const mw = { meta: middlewareMeta };

  if (hasOnRequest)  mw.pre  = hookModule.onRequest;
  if (hasOnResponse) mw.post = hookModule.onResponse;

  return mw;
}
