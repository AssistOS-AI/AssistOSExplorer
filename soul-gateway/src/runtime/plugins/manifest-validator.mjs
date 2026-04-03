import { ConfigurationError } from '../../core/errors.mjs';

const VALID_KINDS = [
  // legacy extension kinds (still supported for backward compatibility)
  'middlewares', 'search', 'models',
  // DEPRECATED: 'wrappers' — kept for backward compat only.
  // Wrapping behavior should use providerHooks; terminal execution should use executors.
  'wrappers',
  // canonical hook kinds
  'gatewayHooks', 'providerHooks',
  // canonical executor kind
  'executors',
  // canonical executor subtypes (used by provider manifest kind, not extension kind)
  // 'external_api', 'search', 'local_model', 'custom'
];

/**
 * Validate an extension manifest object.
 * Throws ConfigurationError on invalid manifests.
 */
export function validateExtensionManifest(manifest, expectedKind) {
  if (!manifest || typeof manifest !== 'object') {
    throw new ConfigurationError('Extension manifest must be an object');
  }

  if (!manifest.key || typeof manifest.key !== 'string') {
    throw new ConfigurationError('Extension manifest must have a string "key"');
  }

  if (!/^[a-z0-9][a-z0-9-]*$/.test(manifest.key)) {
    throw new ConfigurationError(
      `Extension key "${manifest.key}" must be lowercase alphanumeric with hyphens`
    );
  }

  if (manifest.version && typeof manifest.version !== 'string') {
    throw new ConfigurationError('Extension version must be a string');
  }

  if (manifest.kind && !VALID_KINDS.includes(manifest.kind) && manifest.kind !== expectedKind) {
    throw new ConfigurationError(
      `Extension kind "${manifest.kind}" is not valid (expected ${expectedKind})`
    );
  }

  // For provider-type extensions (search, models, wrappers), validate providerPlugin shape
  if (['search', 'models', 'wrappers'].includes(expectedKind)) {
    // These are validated when the plugin is loaded, not at manifest level
  }

  // For middleware extensions, validate meta shape
  if (expectedKind === 'middlewares') {
    if (manifest.hooks && !['pre', 'post', 'both'].includes(manifest.hooks)) {
      throw new ConfigurationError(
        `Middleware hooks must be "pre", "post", or "both", got "${manifest.hooks}"`
      );
    }
  }

  // For gateway/provider hook extensions, validate phases if present
  if (expectedKind === 'gatewayHooks' || expectedKind === 'providerHooks') {
    if (manifest.phases) {
      const validPhases = ['request', 'stream', 'response'];
      const phases = Array.isArray(manifest.phases) ? manifest.phases : [manifest.phases];
      for (const p of phases) {
        if (!validPhases.includes(p)) {
          throw new ConfigurationError(
            `Hook phase "${p}" is not valid (expected one of: ${validPhases.join(', ')})`
          );
        }
      }
    }
  }
}
