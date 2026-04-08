import { ConfigurationError } from '../../core/errors.mjs';

const VALID_KINDS = [
    'middlewares',
    'providerMiddlewares',
    'transports',
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
        throw new ConfigurationError(
            'Extension manifest must have a string "key"'
        );
    }

    if (!/^[a-z0-9][a-z0-9-]*$/.test(manifest.key)) {
        throw new ConfigurationError(
            `Extension key "${manifest.key}" must be lowercase alphanumeric with hyphens`
        );
    }

    if (manifest.version && typeof manifest.version !== 'string') {
        throw new ConfigurationError('Extension version must be a string');
    }

    if (
        manifest.kind &&
        !VALID_KINDS.includes(manifest.kind) &&
        manifest.kind !== expectedKind
    ) {
        throw new ConfigurationError(
            `Extension kind "${manifest.kind}" is not valid (expected ${expectedKind})`
        );
    }

}
