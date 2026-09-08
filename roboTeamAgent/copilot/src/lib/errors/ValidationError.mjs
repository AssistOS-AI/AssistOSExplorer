/**
 * Validation-related errors.
 *
 * Used for errors related to:
 * - Schema validation failures
 * - Field validation failures
 * - Input validation failures
 */

import { BaseError } from './BaseError.mjs';
import { ERROR_CODES } from '../constants.mjs';

/**
 * Base validation error.
 */
export class ValidationError extends BaseError {
    /**
     * Create a ValidationError.
     * @param {string} message - Error message
     * @param {Object} [options] - Error options
     */
    constructor(message, options = {}) {
        super(message, {
            code: ERROR_CODES.VALIDATION_ERROR,
            ...options,
        });
    }
}

/**
 * Schema validation error.
 */
export class SchemaValidationError extends ValidationError {
    /**
     * Create a SchemaValidationError.
     * @param {string} skillName - Name of the skill that failed validation
     * @param {string[]} errors - List of validation errors
     * @param {Object} [options] - Error options
     */
    constructor(skillName, errors, options = {}) {
        const errorList = Array.isArray(errors) ? errors : [errors];
        const message = `Schema validation failed for "${skillName}":\n  - ${errorList.join('\n  - ')}`;
        super(message, {
            code: ERROR_CODES.SCHEMA_VALIDATION_ERROR,
            details: { skill: skillName, errors: errorList, ...options.details },
            recoveryHint: options.recoveryHint || 'Check the skill definition file for missing or invalid sections',
            ...options,
        });
        this.skillName = skillName;
        this.validationErrors = errorList;
    }
}

/**
 * Field validation error.
 */
export class FieldValidationError extends ValidationError {
    /**
     * Create a FieldValidationError.
     * @param {string} fieldName - Name of the field that failed validation
     * @param {*} value - The invalid value
     * @param {string} expectedType - Expected type or format
     * @param {Object} [options] - Error options
     */
    constructor(fieldName, value, expectedType, options = {}) {
        const displayValue = typeof value === 'object' ? JSON.stringify(value) : String(value);
        super(`Invalid value for field "${fieldName}": got ${displayValue}, expected ${expectedType}`, {
            code: ERROR_CODES.FIELD_VALIDATION_ERROR,
            details: { field: fieldName, value, expectedType, ...options.details },
            ...options,
        });
        this.fieldName = fieldName;
        this.value = value;
        this.expectedType = expectedType;
    }
}

/**
 * Input validation error.
 */
export class InputValidationError extends ValidationError {
    /**
     * Create an InputValidationError.
     * @param {string} inputName - Name of the input parameter
     * @param {string} message - Error message
     * @param {Object} [options] - Error options
     */
    constructor(inputName, message, options = {}) {
        super(`Invalid input "${inputName}": ${message}`, {
            code: ERROR_CODES.VALIDATION_ERROR,
            details: { input: inputName, ...options.details },
            ...options,
        });
        this.inputName = inputName;
    }
}

/**
 * Required field missing error.
 */
export class RequiredFieldError extends ValidationError {
    /**
     * Create a RequiredFieldError.
     * @param {string} fieldName - Name of the missing required field
     * @param {Object} [options] - Error options
     */
    constructor(fieldName, options = {}) {
        super(`Required field "${fieldName}" is missing`, {
            code: ERROR_CODES.VALIDATION_ERROR,
            details: { field: fieldName, ...options.details },
            recoveryHint: options.recoveryHint || `Provide a value for the "${fieldName}" field`,
            ...options,
        });
        this.fieldName = fieldName;
    }
}

export default ValidationError;
