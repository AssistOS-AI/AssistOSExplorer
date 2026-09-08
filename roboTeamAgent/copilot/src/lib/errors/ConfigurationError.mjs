/**
 * Configuration-related errors.
 *
 * Used for errors related to:
 * - Invalid configuration files
 * - Missing or invalid environment variables
 * - Repository configuration issues
 */

import { BaseError } from './BaseError.mjs';
import { ERROR_CODES } from '../constants.mjs';

/**
 * Base configuration error.
 */
export class ConfigurationError extends BaseError {
    /**
     * Create a ConfigurationError.
     * @param {string} message - Error message
     * @param {Object} [options] - Error options
     */
    constructor(message, options = {}) {
        super(message, {
            code: ERROR_CODES.CONFIG_ERROR,
            ...options,
        });
    }
}

/**
 * Repository configuration error.
 */
export class RepositoryConfigurationError extends ConfigurationError {
    /**
     * Create a RepositoryConfigurationError.
     * @param {string} repoName - Name of the repository
     * @param {string} message - Error message
     * @param {Object} [options] - Error options
     */
    constructor(repoName, message, options = {}) {
        super(`Repository "${repoName}": ${message}`, {
            code: ERROR_CODES.REPO_CONFIG_ERROR,
            details: { repository: repoName, ...options.details },
            ...options,
        });
        this.repoName = repoName;
    }
}

/**
 * Environment variable configuration error.
 */
export class EnvironmentConfigurationError extends ConfigurationError {
    /**
     * Create an EnvironmentConfigurationError.
     * @param {string} varName - Name of the environment variable
     * @param {string} message - Error message
     * @param {Object} [options] - Error options
     */
    constructor(varName, message, options = {}) {
        super(`Environment variable "${varName}": ${message}`, {
            code: ERROR_CODES.CONFIG_ERROR,
            details: { variable: varName, ...options.details },
            recoveryHint: options.recoveryHint || `Set the ${varName} environment variable`,
            ...options,
        });
        this.varName = varName;
    }
}

/**
 * Config file error.
 */
export class ConfigFileError extends ConfigurationError {
    /**
     * Create a ConfigFileError.
     * @param {string} filePath - Path to the config file
     * @param {string} message - Error message
     * @param {Object} [options] - Error options
     */
    constructor(filePath, message, options = {}) {
        super(`Config file "${filePath}": ${message}`, {
            code: ERROR_CODES.CONFIG_ERROR,
            details: { file: filePath, ...options.details },
            ...options,
        });
        this.filePath = filePath;
    }
}

export default ConfigurationError;
