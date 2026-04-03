/**
 * Executor plugin contract — JSDoc typedefs only.
 *
 * An executor is the terminal component that fulfills a request.
 * Every executor (built-in or extension) must conform to the
 * ExecutorPlugin shape.
 *
 * This is the new abstraction layer that separates the "thing that
 * calls an upstream API" from provider hooks (wrappers) that
 * decorate the call.
 *
 * @module executor-interface
 */

import { ConfigurationError } from '../../core/errors.mjs';

// ── Plugin contract ─────────────────────────────────────────────────

/**
 * @typedef {Object} ExecutorManifest
 * @property {string}  key               Unique executor key (e.g. 'openai-api')
 * @property {string}  name              Human-readable display name
 * @property {string}  executorType      'external_api' | 'search' | 'local_model' | 'custom' | 'wrapper'
 *           Canonical types: external_api, search, local_model, custom.
 *           DEPRECATED: 'wrapper' — still accepted for backward compatibility,
 *           but wrapping behavior should be implemented as provider hooks.
 * @property {boolean} supportsStreaming  Whether the executor can produce streaming responses
 * @property {boolean} supportsTools     Whether the executor supports tool/function calling
 */

/**
 * @typedef {Object} ExecutorPlugin
 * @property {ExecutorManifest} manifest
 * @property {(ctx: object) => Promise<object>}   execute         Fulfill a request, returns ExecutionHandle
 * @property {(error: unknown) => object}          classifyError   Classify an error into gateway taxonomy
 * @property {(ctx?: object) => Promise<object[]>} [discoverModels] Discover available models
 * @property {(ctx?: object) => Promise<{ok: boolean, detail: string}>} [testConnection] Test upstream connectivity
 * @property {() => Promise<void>}                 [init]          Lifecycle: initialize
 * @property {() => Promise<void>}                 [shutdown]      Lifecycle: shutdown
 */

// ── Manifest validation ─────────────────────────────────────────────

const VALID_EXECUTOR_TYPES = new Set(['external_api', 'search', 'local_model', 'wrapper', 'custom']);

/**
 * Validate an executor manifest object. Throws on invalid.
 *
 * @param {object} manifest
 * @throws {ConfigurationError}
 */
export function validateExecutorManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') {
    throw new ConfigurationError('Executor manifest must be a non-null object');
  }
  if (typeof manifest.key !== 'string' || manifest.key.length === 0) {
    throw new ConfigurationError('Executor manifest.key must be a non-empty string');
  }
  if (typeof manifest.name !== 'string' || manifest.name.length === 0) {
    throw new ConfigurationError('Executor manifest.name must be a non-empty string');
  }
  if (!VALID_EXECUTOR_TYPES.has(manifest.executorType)) {
    throw new ConfigurationError(
      `Executor manifest.executorType must be one of: ${[...VALID_EXECUTOR_TYPES].join(', ')}`,
    );
  }
  if (typeof manifest.supportsStreaming !== 'boolean') {
    throw new ConfigurationError('Executor manifest.supportsStreaming must be a boolean');
  }
  if (typeof manifest.supportsTools !== 'boolean') {
    throw new ConfigurationError('Executor manifest.supportsTools must be a boolean');
  }
}
