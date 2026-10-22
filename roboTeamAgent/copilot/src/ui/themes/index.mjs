/**
 * Theme Registry - Central theme loading and management
 *
 * @module themes
 */

import baseTheme, {
    colors,
    box,
    icons,
    semantic,
    terminal,
    spinnerConfig,
    promptConfig,
    selectorConfig,
    createStyler,
    getSemanticColor,
    line,
    mergeTheme,
} from './base.mjs';

/**
 * Registry of available themes
 */
const themeRegistry = new Map();

// Register base theme
themeRegistry.set('base', baseTheme);

/**
 * Register a new theme
 *
 * @param {string} name - Theme name
 * @param {Object} theme - Theme object
 */
export function registerTheme(name, theme) {
    themeRegistry.set(name, theme);
}

/**
 * Get a theme by name
 *
 * @param {string} name - Theme name
 * @returns {Object} - Theme object
 * @throws {Error} - If theme not found
 */
export function getTheme(name) {
    const theme = themeRegistry.get(name);
    if (!theme) {
        throw new Error(`Theme '${name}' not found. Available: ${[...themeRegistry.keys()].join(', ')}`);
    }
    return theme;
}

/**
 * Get all registered theme names
 *
 * @returns {string[]} - Array of theme names
 */
export function getThemeNames() {
    return [...themeRegistry.keys()];
}

/**
 * Check if a theme exists
 *
 * @param {string} name - Theme name
 * @returns {boolean}
 */
export function hasTheme(name) {
    return themeRegistry.has(name);
}

// Re-export base theme components for convenience
export {
    baseTheme,
    colors,
    box,
    icons,
    semantic,
    terminal,
    spinnerConfig,
    promptConfig,
    selectorConfig,
    createStyler,
    getSemanticColor,
    line,
    mergeTheme,
};

export default baseTheme;
