/**
 * UI Providers - Provider Registry and Factory
 *
 * @module providers
 */

import { BaseUIProvider } from './BaseUIProvider.mjs';
import { ClaudeCodeUIProvider } from './ClaudeCodeUIProvider.mjs';
import { MinimalUIProvider } from './MinimalUIProvider.mjs';

/**
 * Registry of available UI providers
 */
const providerRegistry = new Map();

// Register built-in providers
providerRegistry.set('base', BaseUIProvider);
providerRegistry.set('claude-code', ClaudeCodeUIProvider);
providerRegistry.set('minimal', MinimalUIProvider);

/**
 * Register a custom UI provider
 *
 * @param {string} name - Provider name
 * @param {typeof BaseUIProvider} ProviderClass - Provider class
 */
export function registerProvider(name, ProviderClass) {
    providerRegistry.set(name, ProviderClass);
}

/**
 * Get a provider class by name
 *
 * @param {string} name - Provider name
 * @returns {typeof BaseUIProvider} Provider class
 * @throws {Error} If provider not found
 */
export function getProviderClass(name) {
    const ProviderClass = providerRegistry.get(name);
    if (!ProviderClass) {
        const available = [...providerRegistry.keys()].join(', ');
        throw new Error(`UI provider '${name}' not found. Available: ${available}`);
    }
    return ProviderClass;
}

/**
 * Create a provider instance by name
 *
 * @param {string} name - Provider name (default: 'claude-code')
 * @param {Object} options - Provider options
 * @returns {BaseUIProvider} Provider instance
 */
export function createProvider(name = 'claude-code', options = {}) {
    const ProviderClass = getProviderClass(name);
    return new ProviderClass(options);
}

/**
 * Get all registered provider names
 *
 * @returns {string[]} Array of provider names
 */
export function getProviderNames() {
    return [...providerRegistry.keys()];
}

/**
 * Check if a provider exists
 *
 * @param {string} name - Provider name
 * @returns {boolean}
 */
export function hasProvider(name) {
    return providerRegistry.has(name);
}

// Re-export provider classes
export { BaseUIProvider, ClaudeCodeUIProvider, MinimalUIProvider };

export default {
    registerProvider,
    getProviderClass,
    createProvider,
    getProviderNames,
    hasProvider,
    BaseUIProvider,
    ClaudeCodeUIProvider,
    MinimalUIProvider,
};
