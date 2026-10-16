/**
 * UIContext - Global UI Provider Context
 *
 * Singleton that holds the current UI provider, allowing components
 * to access UI capabilities without prop drilling.
 *
 * @module UIContext
 *
 * @example
 * // Set provider at app startup
 * import { UIContext } from './ui/UIContext.mjs';
 * import { ClaudeCodeUIProvider } from './ui/providers/ClaudeCodeUIProvider.mjs';
 *
 * UIContext.setProvider(new ClaudeCodeUIProvider());
 *
 * // Access anywhere in the app
 * const ui = UIContext.getProvider();
 * ui.banner.showStartup({ ... });
 * const input = await ui.input.prompt();
 */

import baseTheme from './themes/base.mjs';

/**
 * Current UI provider instance
 * @type {Object|null}
 */
let currentProvider = null;

/**
 * Default theme to use when no provider is set
 * @type {Object}
 */
let defaultTheme = baseTheme;

/**
 * UIContext singleton for managing UI provider globally
 */
export const UIContext = {
    /**
     * Set the current UI provider
     *
     * @param {Object} provider - UIProvider implementation
     * @throws {Error} If provider is null/undefined
     */
    setProvider(provider) {
        if (!provider) {
            throw new Error('UIContext: Provider cannot be null or undefined');
        }

        // Dispose previous provider if it exists
        if (currentProvider && typeof currentProvider.dispose === 'function') {
            currentProvider.dispose();
        }

        currentProvider = provider;
    },

    /**
     * Get the current UI provider
     *
     * @returns {Object} - Current UIProvider
     * @throws {Error} If no provider has been set
     */
    getProvider() {
        if (!currentProvider) {
            throw new Error(
                'UIContext: No UI provider has been set. ' +
                'Call UIContext.setProvider() first, or use UIContext.hasProvider() to check.'
            );
        }
        return currentProvider;
    },

    /**
     * Get the current theme
     *
     * If a provider is set, returns the provider's theme.
     * Otherwise, returns the default theme.
     *
     * @returns {Object} - Theme object
     */
    getTheme() {
        if (currentProvider) {
            return currentProvider.theme;
        }
        return defaultTheme;
    },

    /**
     * Set the default theme (used when no provider is set)
     *
     * @param {Object} theme - Theme object
     */
    setDefaultTheme(theme) {
        defaultTheme = theme;
    },

    /**
     * Check if a provider is currently set
     *
     * @returns {boolean}
     */
    hasProvider() {
        return currentProvider !== null;
    },

    /**
     * Get provider if available, otherwise return null (no error)
     *
     * Useful for optional UI operations.
     *
     * @returns {Object|null} - Current UIProvider or null
     */
    getProviderIfAvailable() {
        return currentProvider;
    },

    /**
     * Clear the current provider
     *
     * Disposes the current provider and sets it to null.
     */
    clear() {
        if (currentProvider && typeof currentProvider.dispose === 'function') {
            currentProvider.dispose();
        }
        currentProvider = null;
    },

    /**
     * Execute a function with a temporary provider
     *
     * Useful for testing or one-off UI operations with a different provider.
     *
     * @param {Object} tempProvider - Temporary provider to use
     * @param {Function} fn - Function to execute
     * @returns {*} - Result of fn()
     */
    withProvider(tempProvider, fn) {
        const previous = currentProvider;
        currentProvider = tempProvider;
        try {
            return fn();
        } finally {
            currentProvider = previous;
        }
    },

    /**
     * Execute an async function with a temporary provider
     *
     * @param {Object} tempProvider - Temporary provider to use
     * @param {Function} fn - Async function to execute
     * @returns {Promise<*>} - Result of fn()
     */
    async withProviderAsync(tempProvider, fn) {
        const previous = currentProvider;
        currentProvider = tempProvider;
        try {
            return await fn();
        } finally {
            currentProvider = previous;
        }
    },
};

export default UIContext;
