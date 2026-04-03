/**
 * Provider plugin contract — JSDoc typedefs only.
 *
 * Every provider module (built-in or extension) must export
 * `providerPlugin` conforming to the ProviderPlugin shape.
 *
 * The `formatConverter` and `oauthAdapter` properties are OPTIONAL
 * (Interface Segregation: providers that don't convert or handle
 * OAuth simply omit them).
 */
import { ConfigurationError } from '../../core/errors.mjs';

// ── Plugin contract ─────────────────────────────────────────────────

/**
 * @typedef {Object} ProviderManifest
 * @property {string} key              Unique provider adapter key (e.g. 'openai-api')
 * @property {'external_api'|'search'|'local_model'|'custom'|'wrapper'} kind
 *           Canonical executor kinds: external_api, search, local_model, custom.
 *           DEPRECATED: 'wrapper' — still accepted for backward compatibility,
 *           but wrappers should be implemented as provider hooks going forward.
 * @property {'none'|'api_key'|'oauth'|'hybrid'|'custom'} authStrategy
 * @property {boolean} supportsStreaming
 * @property {boolean} supportsTools
 * @property {string[]} supportedFormats  e.g. ['openai_chat', 'anthropic_messages']
 */

/**
 * @typedef {Object} ProviderPlugin
 * @property {ProviderManifest} manifest
 * @property {(deps?: object) => Promise<void>} init
 * @property {() => Promise<void>} shutdown
 * @property {(providerRecord: object) => void} validateProviderRecord
 * @property {(modelRecord: object) => void} validateModelRecord
 * @property {(ctx?: object) => Promise<ModelDescriptor[]>} discoverModels
 * @property {(ctx: object) => Promise<{ok: boolean, detail: string}>} testConnection
 * @property {(ctx: ExecuteContext) => Promise<ExecutionHandle>} execute
 * @property {(error: unknown, ctx?: object) => ClassifiedError} classifyError
 * @property {object} [formatConverter]  Optional format converter (ISP)
 * @property {object} [oauthAdapter]     Optional OAuth adapter (ISP)
 */

// ── Execution types ─────────────────────────────────────────────────

/**
 * @typedef {Object} ExecuteContext
 * @property {string} requestId
 * @property {object} request            Normalized request (internal OpenAI chat shape)
 * @property {object} resolvedModel      Model registry record
 * @property {object} providerRecord     Provider registry record
 * @property {object|null} credentialLease
 * @property {object} attempt            { index, previousErrors }
 * @property {AbortSignal} signal
 * @property {object} logger
 * @property {object} services
 */

/**
 * @typedef {Object} ExecutionHandle
 * @property {string|null} accountId
 * @property {AsyncGenerator<NormalizedChunk, ProviderCompletion, void>} stream
 * @property {(reason?: Error) => Promise<void>} abort
 */

/**
 * @typedef {Object} ProviderCompletion
 * @property {object|null} usage
 * @property {object|null} rawResponse
 * @property {object|null} responseMeta
 */

// ── Normalized chunk types ──────────────────────────────────────────

/**
 * @typedef {Object} NormalizedChunk
 * @property {'message_start'|'text_delta'|'tool_call_delta'|'usage'|'done'|'error'} type
 * @property {object} [data]  Shape depends on type — see below.
 *
 * message_start  → { id, model, role }
 * text_delta     → { text }
 * tool_call_delta→ { index, id?, name?, arguments? }
 * usage          → { input_tokens, output_tokens, total_tokens }
 * done           → { finish_reason, model }
 * error          → { message, type? }
 */

// ── Error classification ────────────────────────────────────────────

/**
 * @typedef {Object} ClassifiedError
 * @property {number} httpStatus
 * @property {string} errorType       Machine-readable string from the gateway taxonomy
 * @property {boolean} retryable
 * @property {boolean} cooldown       Whether to trigger model cooldown
 * @property {boolean} cascade        Whether to cascade to next model
 * @property {number|null} retryAfterSeconds
 */

// ── Model discovery ─────────────────────────────────────────────────

/**
 * @typedef {Object} ModelDescriptor
 * @property {string} modelId         Provider-native model identifier
 * @property {string} displayName
 * @property {number|null} contextWindow
 * @property {number|null} maxOutputTokens
 * @property {boolean} supportsTools
 * @property {boolean} supportsStreaming
 * @property {boolean} supportsVision
 * @property {object} [pricing]       { inputPricePerMillion, outputPricePerMillion }
 */

// ── Manifest validation helper ──────────────────────────────────────

/**
 * Canonical executor kinds going forward.
 * 'wrapper' is DEPRECATED — kept for backward compatibility only.
 * Wrappers should be implemented as provider hooks, not as provider plugins.
 */
const EXECUTOR_KINDS = new Set(['external_api', 'search', 'local_model', 'custom']);
const DEPRECATED_KINDS = new Set(['wrapper']);
const VALID_KINDS = new Set([...EXECUTOR_KINDS, ...DEPRECATED_KINDS]);
const VALID_AUTH = new Set(['none', 'api_key', 'oauth', 'hybrid', 'custom']);

/** @type {Array<{kind: string, message: string}>} */
const _deprecationLog = [];

/**
 * Return and clear accumulated deprecation warnings (for testing).
 * @returns {Array<{kind: string, message: string}>}
 */
export function drainDeprecationWarnings() {
  return _deprecationLog.splice(0);
}

/**
 * Validate a provider manifest object.  Throws on invalid.
 *
 * @param {object} manifest
 * @param {object} [options]
 * @param {object} [options.log]  Logger instance; receives deprecation warnings
 */
export function validateManifest(manifest, options = {}) {
  if (!manifest || typeof manifest !== 'object') {
    throw new ConfigurationError('Provider manifest must be a non-null object');
  }
  if (typeof manifest.key !== 'string' || manifest.key.length === 0) {
    throw new ConfigurationError('Provider manifest.key must be a non-empty string');
  }
  if (!VALID_KINDS.has(manifest.kind)) {
    throw new ConfigurationError(`Provider manifest.kind must be one of: ${[...VALID_KINDS].join(', ')}`);
  }

  // Deprecation: kind='wrapper' is accepted but discouraged.
  // Wrappers are now provider hooks; only executors are terminal backends.
  if (DEPRECATED_KINDS.has(manifest.kind)) {
    const msg = `Provider manifest kind '${manifest.kind}' is deprecated. ` +
      `Use provider hooks (onRequest/onResponse/wrapStream) for wrapping behavior, ` +
      `or an executor kind (${[...EXECUTOR_KINDS].join(', ')}) for terminal backends.`;
    _deprecationLog.push({ kind: manifest.kind, message: msg });
    if (options.log && typeof options.log.warn === 'function') {
      options.log.warn('provider_manifest_deprecated_kind', {
        key: manifest.key,
        kind: manifest.kind,
        message: msg,
      });
    }
  }

  if (!VALID_AUTH.has(manifest.authStrategy)) {
    throw new ConfigurationError(`Provider manifest.authStrategy must be one of: ${[...VALID_AUTH].join(', ')}`);
  }
  if (typeof manifest.supportsStreaming !== 'boolean') {
    throw new ConfigurationError('Provider manifest.supportsStreaming must be a boolean');
  }
  if (typeof manifest.supportsTools !== 'boolean') {
    throw new ConfigurationError('Provider manifest.supportsTools must be a boolean');
  }
  if (!Array.isArray(manifest.supportedFormats)) {
    throw new ConfigurationError('Provider manifest.supportedFormats must be an array');
  }
}

/**
 * Check whether a provider manifest kind is a canonical executor kind.
 * @param {string} kind
 * @returns {boolean}
 */
export function isExecutorKind(kind) {
  return EXECUTOR_KINDS.has(kind);
}

/**
 * Check whether a provider manifest kind is deprecated.
 * @param {string} kind
 * @returns {boolean}
 */
export function isDeprecatedKind(kind) {
  return DEPRECATED_KINDS.has(kind);
}
