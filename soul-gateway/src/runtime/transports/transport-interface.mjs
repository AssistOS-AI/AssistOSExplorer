/**
 * Transport plugin contract — JSDoc typedefs only.
 *
 * A transport is the terminal component that fulfills a request.
 * Every transport (built-in or extension) must conform to the
 * TransportPlugin shape.
 *
 * Transports are the only execution model: there is no separate
 * "wrapper" concept.  Wrapping behavior belongs in provider middleware.
 *
 * @module transport-interface
 */

import { ConfigurationError } from '../../core/errors.mjs';

// ── Plugin contract ─────────────────────────────────────────────────

/**
 * @typedef {Object} TransportManifest
 * @property {string}  key               Unique transport key (e.g. 'openai-api')
 * @property {string}  name              Human-readable display name
 * @property {string}  transportType     'external_api' | 'search' | 'local_model' | 'custom'
 * @property {boolean} supportsStreaming Whether the transport can produce streaming responses
 * @property {boolean} supportsTools     Whether the transport supports tool/function calling
 */

/**
 * @typedef {Object} TransportPlugin
 * @property {TransportManifest} manifest
 * @property {(ctx: object) => Promise<object>}   execute         Fulfill a request, returns ExecutionHandle
 * @property {(error: unknown) => object}          classifyError   Classify an error into gateway taxonomy
 * @property {(ctx?: object) => Promise<object[]>} [discoverModels] Discover available models
 * @property {(ctx?: object) => Promise<{ok: boolean, detail: string}>} [testConnection] Test upstream connectivity
 * @property {() => Promise<void>}                 [init]          Lifecycle: initialize
 * @property {() => Promise<void>}                 [shutdown]      Lifecycle: shutdown
 */

// ── Manifest validation ─────────────────────────────────────────────

const VALID_TRANSPORT_TYPES = new Set([
    'external_api',
    'search',
    'local_model',
    'custom',
]);

/**
 * Validate a transport manifest object. Throws on invalid.
 *
 * @param {object} manifest
 * @throws {ConfigurationError}
 */
export function validateTransportManifest(manifest) {
    if (!manifest || typeof manifest !== 'object') {
        throw new ConfigurationError(
            'Transport manifest must be a non-null object'
        );
    }
    if (typeof manifest.key !== 'string' || manifest.key.length === 0) {
        throw new ConfigurationError(
            'Transport manifest.key must be a non-empty string'
        );
    }
    if (typeof manifest.name !== 'string' || manifest.name.length === 0) {
        throw new ConfigurationError(
            'Transport manifest.name must be a non-empty string'
        );
    }
    if (!VALID_TRANSPORT_TYPES.has(manifest.transportType)) {
        throw new ConfigurationError(
            `Transport manifest.transportType must be one of: ${[...VALID_TRANSPORT_TYPES].join(', ')}`
        );
    }
    if (typeof manifest.supportsStreaming !== 'boolean') {
        throw new ConfigurationError(
            'Transport manifest.supportsStreaming must be a boolean'
        );
    }
    if (typeof manifest.supportsTools !== 'boolean') {
        throw new ConfigurationError(
            'Transport manifest.supportsTools must be a boolean'
        );
    }
}
