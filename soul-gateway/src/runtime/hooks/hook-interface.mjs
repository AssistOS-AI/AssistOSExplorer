/**
 * Shared Hook Contract — the generic interface used by both gateway hooks
 * and provider hooks.
 *
 * This file defines the canonical shape via JSDoc typedefs. No runtime
 * enforcement — it is a documentation-only contract that adapters and
 * future hook modules conform to.
 *
 * @module hook-interface
 */

/**
 * Allowed scope values for a hook module.
 * @typedef {'gateway' | 'provider'} HookScope
 */

/**
 * Allowed phase values for a hook module.
 * @typedef {'request' | 'stream' | 'response'} HookPhase
 */

/**
 * Metadata block that every hook module must export.
 *
 * @typedef {Object} HookMeta
 * @property {string}       key             - Unique identifier (e.g. 'rate-limiter').
 * @property {string}       name            - Human-readable display name.
 * @property {string}       [description]   - Short description of what the hook does.
 * @property {string}       [version]       - SemVer version string.
 * @property {HookScope}    scope           - 'gateway' or 'provider'.
 * @property {HookPhase[]}  phases          - Which phases the hook implements.
 * @property {Object}       [defaultSettings] - Default configuration merged with assignment overrides.
 */

/**
 * A hook module — the generic unit of processing in both the gateway
 * middleware pipeline and the provider wrapper pipeline.
 *
 * A hook must export `meta` and at least one phase function.
 *
 * @typedef {Object} HookModule
 * @property {HookMeta}    meta         - Metadata describing the hook.
 * @property {Function}    [onRequest]  - async (ctx, settings) => void — runs before dispatch.
 * @property {Function}    [wrapStream] - (stream, ctx, settings) => AsyncGenerator — wraps the response stream.
 * @property {Function}    [onResponse] - async (ctx, settings) => void — runs after dispatch.
 */

/**
 * Validate that a value looks like a well-formed HookModule.
 *
 * Does not throw — returns an object with `valid` and `errors`.
 *
 * @param {*} hookModule
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateHookModule(hookModule) {
  const errors = [];

  if (!hookModule || typeof hookModule !== 'object') {
    return { valid: false, errors: ['hookModule must be a non-null object'] };
  }

  // meta
  if (!hookModule.meta || typeof hookModule.meta !== 'object') {
    errors.push('meta must be a non-null object');
  } else {
    if (typeof hookModule.meta.key !== 'string' || !hookModule.meta.key) {
      errors.push('meta.key must be a non-empty string');
    }
    if (typeof hookModule.meta.name !== 'string' || !hookModule.meta.name) {
      errors.push('meta.name must be a non-empty string');
    }
    if (!['gateway', 'provider'].includes(hookModule.meta.scope)) {
      errors.push("meta.scope must be 'gateway' or 'provider'");
    }
    if (!Array.isArray(hookModule.meta.phases) || hookModule.meta.phases.length === 0) {
      errors.push('meta.phases must be a non-empty array');
    } else {
      const allowed = new Set(['request', 'stream', 'response']);
      for (const p of hookModule.meta.phases) {
        if (!allowed.has(p)) {
          errors.push(`meta.phases contains invalid phase '${p}'`);
        }
      }
    }
  }

  // At least one phase function
  const hasOnRequest  = typeof hookModule.onRequest === 'function';
  const hasWrapStream = typeof hookModule.wrapStream === 'function';
  const hasOnResponse = typeof hookModule.onResponse === 'function';

  if (!hasOnRequest && !hasWrapStream && !hasOnResponse) {
    errors.push('hook must implement at least one of: onRequest, wrapStream, onResponse');
  }

  return { valid: errors.length === 0, errors };
}
