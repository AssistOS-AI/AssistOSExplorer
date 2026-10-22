/**
 * BaseError - Base class for all custom errors in achilles-cli.
 *
 * Provides structured error information including:
 * - Error code for programmatic handling
 * - Details object for additional context
 * - Recovery hints for user-friendly guidance
 * - Timestamp for debugging
 * - Cause for error chaining
 */

import { ERROR_CODES } from '../constants.mjs';

/**
 * Base error class with structured metadata.
 */
export class BaseError extends Error {
    /**
     * Create a new BaseError.
     *
     * @param {string} message - Human-readable error message
     * @param {Object} [options] - Error options
     * @param {string} [options.code] - Error code from ERROR_CODES
     * @param {Error} [options.cause] - Original error that caused this one
     * @param {Object} [options.details] - Additional structured details
     * @param {string} [options.recoveryHint] - Suggestion for how to fix the error
     */
    constructor(message, { code, cause, details, recoveryHint } = {}) {
        super(message);

        // Maintain proper prototype chain
        Object.setPrototypeOf(this, new.target.prototype);

        this.name = this.constructor.name;
        this.code = code || ERROR_CODES.OPERATION_ERROR;
        this.cause = cause;
        this.details = details || {};
        this.recoveryHint = recoveryHint;
        this.timestamp = new Date().toISOString();

        // Capture stack trace (V8 only)
        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, this.constructor);
        }
    }

    /**
     * Serialize error to JSON for logging/transmission.
     * @returns {Object}
     */
    toJSON() {
        return {
            name: this.name,
            code: this.code,
            message: this.message,
            details: this.details,
            recoveryHint: this.recoveryHint,
            timestamp: this.timestamp,
            stack: this.stack,
            cause: this.cause?.message,
        };
    }

    /**
     * Format error for user-friendly display.
     * @returns {string}
     */
    toUserString() {
        let result = `Error: ${this.message}`;
        if (this.recoveryHint) {
            result += `\nHint: ${this.recoveryHint}`;
        }
        return result;
    }

    /**
     * Check if an error is a BaseError or subclass.
     * @param {Error} error
     * @returns {boolean}
     */
    static isBaseError(error) {
        return error instanceof BaseError;
    }

    /**
     * Wrap a generic error in a BaseError.
     * @param {Error} error - Error to wrap
     * @param {Object} [options] - Additional options
     * @returns {BaseError}
     */
    static wrap(error, options = {}) {
        if (error instanceof BaseError) {
            return error;
        }
        return new BaseError(error.message, {
            cause: error,
            ...options,
        });
    }
}

export default BaseError;
