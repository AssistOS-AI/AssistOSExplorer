/**
 * Centralized configuration management for achilles-cli.
 *
 * Provides:
 * - Environment variable access with defaults
 * - Configuration validation
 * - Type coercion for env vars
 *
 * Usage:
 *   import { config } from './lib/Config.mjs';
 *   const uiStyle = config.get('UI_STYLE');
 *   const debug = config.get('DEBUG');
 */

import { ConfigurationError, EnvironmentConfigurationError } from './errors/index.mjs';

/**
 * Environment variable definitions.
 * Maps config keys to their environment variable names and defaults.
 */
const ENV_VARS = {
    UI_STYLE: {
        name: 'ACHILLES_CLI_UI',
        default: 'claude-code',
        description: 'UI style for output formatting',
    },
    ORCHESTRATOR_MODE: {
        name: 'ACHILLES_ORCHESTRATOR_MODE',
        default: 'fast',
        description: 'Orchestrator execution mode (fast/deep)',
    },
    DEBUG: {
        names: ['ACHILLES_DEBUG', 'ACHILES_DEBUG', 'ACHILESS_DEBUG'],
        default: false,
        type: 'boolean',
        description: 'Enable debug logging',
    },
    LOG_LEVEL: {
        name: 'LOG_LEVEL',
        default: 'info',
        description: 'Logging level (debug/info/warn/error)',
    },
    MAX_REFINEMENT_ITERATIONS: {
        name: 'SKILL_MAX_REFINEMENT_ITERATIONS',
        default: 5,
        type: 'number',
        description: 'Maximum skill refinement iterations',
    },
    HISTORY_MAX_ENTRIES: {
        name: 'ACHILLES_CLI_HISTORY_MAX',
        default: 1000,
        type: 'number',
        description: 'Maximum command history entries',
    },
    SPINNER_STYLE: {
        name: 'ACHILLES_CLI_SPINNER',
        default: 'dots',
        description: 'Spinner animation style',
    },
    COLOR_OUTPUT: {
        name: 'ACHILLES_CLI_COLOR',
        default: true,
        type: 'boolean',
        description: 'Enable colored output',
    },
};

/**
 * Configuration manager class.
 * Provides type-safe access to configuration values.
 */
class Config {
    #cache = new Map();
    #validated = false;

    /**
     * Get a configuration value.
     *
     * @param {string} key - Configuration key (from ENV_VARS)
     * @returns {*} Configuration value (type depends on definition)
     * @throws {ConfigurationError} If key is unknown
     */
    get(key) {
        // Return cached value if available
        if (this.#cache.has(key)) {
            return this.#cache.get(key);
        }

        const def = ENV_VARS[key];
        if (!def) {
            throw new ConfigurationError(`Unknown config key: ${key}`, {
                details: { key, availableKeys: Object.keys(ENV_VARS) },
                recoveryHint: `Use one of: ${Object.keys(ENV_VARS).join(', ')}`,
            });
        }

        const value = this.#resolveValue(def);
        this.#cache.set(key, value);
        return value;
    }

    /**
     * Check if a configuration key exists.
     *
     * @param {string} key - Configuration key
     * @returns {boolean}
     */
    has(key) {
        return key in ENV_VARS;
    }

    /**
     * Get all configuration values.
     *
     * @returns {Object} All configuration key-value pairs
     */
    getAll() {
        const result = {};
        for (const key of Object.keys(ENV_VARS)) {
            result[key] = this.get(key);
        }
        return result;
    }

    /**
     * Get configuration metadata.
     *
     * @param {string} key - Configuration key
     * @returns {Object|null} Configuration definition or null if not found
     */
    getDefinition(key) {
        return ENV_VARS[key] || null;
    }

    /**
     * List all available configuration keys.
     *
     * @returns {string[]} Array of configuration keys
     */
    keys() {
        return Object.keys(ENV_VARS);
    }

    /**
     * Clear the configuration cache.
     * Useful for testing or when env vars change.
     */
    clearCache() {
        this.#cache.clear();
        this.#validated = false;
    }

    /**
     * Validate all required configuration.
     *
     * @returns {Config} This instance for chaining
     * @throws {EnvironmentConfigurationError} If required config is missing
     */
    validate() {
        if (this.#validated) return this;

        // Currently no required vars, but this is where we'd check them
        // For example:
        // const required = ['API_KEY'];
        // for (const key of required) {
        //     const value = this.get(key);
        //     if (value === undefined || value === '') {
        //         throw new EnvironmentConfigurationError(
        //             ENV_VARS[key].name,
        //             'Required configuration is missing'
        //         );
        //     }
        // }

        this.#validated = true;
        return this;
    }

    /**
     * Check if configuration has been validated.
     *
     * @returns {boolean}
     */
    isValidated() {
        return this.#validated;
    }

    /**
     * Resolve a configuration value from environment.
     *
     * @param {Object} def - Configuration definition
     * @returns {*} Resolved value
     * @private
     */
    #resolveValue(def) {
        const names = def.names || [def.name];

        for (const name of names) {
            const value = process.env[name];
            if (value !== undefined && value !== '') {
                return this.#parseValue(value, def.type);
            }
        }

        return def.default;
    }

    /**
     * Parse a string value to the appropriate type.
     *
     * @param {string} value - String value from environment
     * @param {string} [type] - Expected type
     * @returns {*} Parsed value
     * @private
     */
    #parseValue(value, type) {
        if (type === 'boolean') {
            return value === 'true' || value === '1' || value === 'yes';
        }
        if (type === 'number') {
            const num = parseInt(value, 10);
            return isNaN(num) ? undefined : num;
        }
        if (type === 'array') {
            return value.split(',').map((s) => s.trim()).filter(Boolean);
        }
        return value;
    }
}

/**
 * Singleton configuration instance.
 */
export const config = new Config();

/**
 * Export the Config class for testing.
 */
export { Config, ENV_VARS };

export default config;
