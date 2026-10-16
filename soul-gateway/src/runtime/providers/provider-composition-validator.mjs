import { BadRequestError, ConfigurationError } from '../../core/errors.mjs';
import { normalizeProviderRecord } from './runtime-record-normalizer.mjs';

function badProviderComposition(message, errorFactory) {
    if (typeof errorFactory === 'function') {
        throw errorFactory(message);
    }
    throw new ConfigurationError(message);
}

export function requireBackendModuleForProvider(
    providerRecord,
    backendCatalog,
    { errorFactory = null } = {}
) {
    if (!backendCatalog || typeof backendCatalog.getBackend !== 'function') {
        badProviderComposition(
            'Provider composition validation requires backendCatalog',
            errorFactory
        );
    }

    const normalizedProvider = normalizeProviderRecord(providerRecord);
    const backendKey = normalizedProvider?.backendKey;
    if (!backendKey) {
        badProviderComposition(
            `Provider '${normalizedProvider?.providerKey || normalizedProvider?.displayName || 'unknown'}' is missing backendKey`,
            errorFactory
        );
    }

    const backendModule = backendCatalog.getBackend(backendKey);
    if (!backendModule) {
        badProviderComposition(
            `Unknown provider backend '${backendKey}'`,
            errorFactory
        );
    }

    if (typeof backendModule.validateProviderRecord === 'function') {
        try {
            backendModule.validateProviderRecord(normalizedProvider);
        } catch (err) {
            badProviderComposition(
                `Invalid provider configuration for backend '${backendKey}': ${err.message}`,
                errorFactory
            );
        }
    }

    return { normalizedProvider, backendModule };
}

export function requireProviderMiddlewareModule(
    middlewareKey,
    providerMiddlewareRegistry,
    { errorFactory = null } = {}
) {
    if (
        !providerMiddlewareRegistry ||
        typeof providerMiddlewareRegistry.get !== 'function'
    ) {
        badProviderComposition(
            'Provider composition validation requires providerMiddlewareRegistry',
            errorFactory
        );
    }

    if (!middlewareKey) {
        badProviderComposition(
            'Provider middleware binding is missing middlewareKey',
            errorFactory
        );
    }

    const middlewareModule = providerMiddlewareRegistry.get(middlewareKey);
    if (!middlewareModule) {
        badProviderComposition(
            `Unknown provider middleware '${middlewareKey}'`,
            errorFactory
        );
    }

    return middlewareModule;
}

export function validateProviderCompositionSnapshot({
    providers,
    providerBindingsByProviderId,
    backendCatalog,
    providerMiddlewareRegistry,
}) {
    if (!(providers instanceof Map)) {
        throw new ConfigurationError(
            'Provider composition validation requires a providers map'
        );
    }
    if (!(providerBindingsByProviderId instanceof Map)) {
        throw new ConfigurationError(
            'Provider composition validation requires provider bindings by provider id'
        );
    }

    const providerIds = new Set();
    for (const providerRecord of providers.values()) {
        providerIds.add(providerRecord.id);
        requireBackendModuleForProvider(providerRecord, backendCatalog);
    }

    for (const [providerId, bindings] of providerBindingsByProviderId) {
        if (!providerIds.has(providerId)) {
            throw new ConfigurationError(
                `Provider middleware bindings reference unknown provider '${providerId}'`
            );
        }
        for (const binding of bindings) {
            requireProviderMiddlewareModule(
                binding.middlewareKey,
                providerMiddlewareRegistry
            );
        }
    }
}

export function badRequestFactory(message) {
    return new BadRequestError(message);
}
