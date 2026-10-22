/**
 * Backend module contract.
 *
 * A "backend" is the only execution concept below routing for talking
 * to an external system.  A backend module exposes a single
 * `execute(executionCtx)` method that the catalog wraps once into a
 * kernel terminal middleware via `createBackendTerminal`.  The runtime
 * then dispatches every external call through that terminal.
 *
 * There is no separate provider-execution or transport-execution
 * subsystem — those concepts collapsed into this one shape during the
 * middleware-first cleanup pass.
 *
 * Optional lifecycle methods (`init`, `shutdown`, `discoverModels`,
 * `testConnection`, `validateProviderRecord`, `validateModelRecord`) are
 * NOT request-time middleware concerns.  They live on the backend
 * module so admin/management code does not need a parallel execution
 * architecture to call them.
 *
 * @module runtime/backends/backend-interface
 */

import { ConfigurationError } from '../../core/errors.mjs';

// ── Manifest ────────────────────────────────────────────────────────

/**
 * Canonical backend kinds.  Same enumeration the snapshot/management
 * APIs report and the dashboard renders.
 */
const VALID_KINDS = new Set([
    'external_api',
    'local_model',
    'custom',
]);

const VALID_AUTH = new Set(['none', 'api_key', 'oauth', 'hybrid', 'custom']);

/**
 * @typedef {Object} BackendManifest
 * @property {string} key                 Unique backend module key (e.g. 'openai-api')
 * @property {'external_api'|'local_model'|'custom'} kind
 * @property {'none'|'api_key'|'oauth'|'hybrid'|'custom'} authStrategy
 * @property {boolean} supportsStreaming
 * @property {boolean} supportsTools
 * @property {string[]} supportedFormats  e.g. ['openai_chat', 'anthropic_messages']
 * @property {string} [displayName]
 * @property {string} [defaultBaseUrl]
 * @property {string} [oauthAdapterKey]
 * @property {boolean} [hidden]           If true, the backend is hidden from
 *                                        the dashboard "Add Provider" picker
 *                                        (used for protocol-family dispatchers
 *                                        whose vendors are configured via
 *                                        presets).
 */

/**
 * @typedef {Object} BackendModule
 * @property {BackendManifest} manifest
 * @property {(executionCtx: BackendExecutionContext) => Promise<BackendExecutionHandle>} execute
 * @property {(error: unknown, executionCtx?: object) => ClassifiedError} classifyError
 * @property {() => Promise<void>} [init]
 * @property {() => Promise<void>} [shutdown]
 * @property {(providerRecord: object) => void} [validateProviderRecord]
 * @property {(modelRecord: object) => void} [validateModelRecord]
 * @property {(lifecycleCtx: object) => Promise<ModelDescriptor[]>} [discoverModels]
 * @property {(lifecycleCtx: object) => Promise<{ok: boolean, detail: any}>} [testConnection]
 * @property {object} [formatConverter]   Optional protocol converter (ISP)
 * @property {object} [oauthAdapter]      Optional OAuth adapter (ISP)
 */

// ── Execution & lifecycle context types (JSDoc) ─────────────────────

/**
 * @typedef {Object} BackendExecutionContext
 * @property {string} requestId
 * @property {object} request            Normalized request (canonical OpenAI chat shape)
 * @property {object} resolvedModel      Frozen model record
 * @property {object} providerRecord     Frozen provider record
 * @property {object|null} credentialLease
 * @property {{ index: number, previousErrors: Array }} attempt
 * @property {AbortSignal} signal
 * @property {object} logger
 * @property {object} services           Frozen extension services bag
 */

/**
 * @typedef {Object} BackendExecutionHandle
 * @property {string|null} accountId
 * @property {AsyncGenerator<NormalizedChunk, BackendCompletion, void>|null} stream
 * @property {(reason?: Error) => Promise<void>} [abort]
 */

/**
 * @typedef {Object} BackendCompletion
 * @property {object|null} usage
 * @property {object|null} rawResponse
 * @property {object|null} responseMeta
 */

/**
 * @typedef {Object} NormalizedChunk
 * @property {'message_start'|'text_delta'|'tool_call_delta'|'usage'|'done'|'error'} type
 * @property {object} [data]  Shape depends on type — see canonical-stream docs.
 */

/**
 * @typedef {Object} ClassifiedError
 * @property {number} httpStatus
 * @property {string} errorType
 * @property {boolean} retryable
 * @property {boolean} cooldown
 * @property {boolean} cascade
 * @property {number|null} retryAfterSeconds
 */

/**
 * @typedef {Object} ModelDescriptor
 * @property {string} modelId
 * @property {string} displayName
 * @property {number|null} contextWindow
 * @property {number|null} maxOutputTokens
 * @property {boolean} supportsTools
 * @property {boolean} supportsStreaming
 * @property {boolean} supportsVision
 * @property {object} [pricing]
 */

// ── Manifest validation ─────────────────────────────────────────────

/**
 * Validate a backend manifest object.  Throws `ConfigurationError` on
 * any failure.  Used by `BackendCatalog.register`, the loader, the
 * extension adapter, and tests.
 *
 * @param {object} manifest
 */
export function validateBackendManifest(manifest) {
    if (!manifest || typeof manifest !== 'object') {
        throw new ConfigurationError(
            'Backend manifest must be a non-null object'
        );
    }
    if (typeof manifest.key !== 'string' || manifest.key.length === 0) {
        throw new ConfigurationError(
            'Backend manifest.key must be a non-empty string'
        );
    }
    if (!VALID_KINDS.has(manifest.kind)) {
        throw new ConfigurationError(
            `Backend manifest.kind must be one of: ${[...VALID_KINDS].join(', ')}`
        );
    }
    if (!VALID_AUTH.has(manifest.authStrategy)) {
        throw new ConfigurationError(
            `Backend manifest.authStrategy must be one of: ${[...VALID_AUTH].join(', ')}`
        );
    }
    if (typeof manifest.supportsStreaming !== 'boolean') {
        throw new ConfigurationError(
            'Backend manifest.supportsStreaming must be a boolean'
        );
    }
    if (typeof manifest.supportsTools !== 'boolean') {
        throw new ConfigurationError(
            'Backend manifest.supportsTools must be a boolean'
        );
    }
    if (!Array.isArray(manifest.supportedFormats)) {
        throw new ConfigurationError(
            'Backend manifest.supportedFormats must be an array'
        );
    }
}

/**
 * Whether a value is one of the canonical backend kinds.
 * @param {string} kind
 * @returns {boolean}
 */
export function isBackendKind(kind) {
    return VALID_KINDS.has(kind);
}
