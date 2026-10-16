/**
 * Operation-related errors.
 *
 * Used for errors related to:
 * - Git operations (clone, pull, etc.)
 * - Skill execution failures
 * - File system operations
 */

import { BaseError } from './BaseError.mjs';
import { ERROR_CODES } from '../constants.mjs';

/**
 * Base operation error.
 */
export class OperationError extends BaseError {
    /**
     * Create an OperationError.
     * @param {string} message - Error message
     * @param {Object} [options] - Error options
     */
    constructor(message, options = {}) {
        super(message, {
            code: ERROR_CODES.OPERATION_ERROR,
            ...options,
        });
    }
}

/**
 * Git operation error.
 */
export class GitOperationError extends OperationError {
    /**
     * Create a GitOperationError.
     * @param {string} operation - Git operation that failed (clone, pull, etc.)
     * @param {string} message - Error message
     * @param {Object} [options] - Error options
     */
    constructor(operation, message, options = {}) {
        super(`Git ${operation} failed: ${message}`, {
            code: ERROR_CODES.GIT_ERROR,
            details: { operation, ...options.details },
            recoveryHint: options.recoveryHint || 'Ensure git is installed and the repository is accessible',
            ...options,
        });
        this.operation = operation;
    }
}

/**
 * Skill execution error.
 */
export class SkillExecutionError extends OperationError {
    /**
     * Create a SkillExecutionError.
     * @param {string} skillName - Name of the skill that failed
     * @param {string} message - Error message
     * @param {Object} [options] - Error options
     */
    constructor(skillName, message, options = {}) {
        super(`Skill "${skillName}" failed: ${message}`, {
            code: ERROR_CODES.SKILL_EXEC_ERROR,
            details: { skill: skillName, ...options.details },
            ...options,
        });
        this.skillName = skillName;
    }
}

/**
 * Skill execution cancelled error.
 */
export class SkillExecutionCancelledError extends SkillExecutionError {
    /**
     * Create a SkillExecutionCancelledError.
     * @param {string} skillName - Name of the skill that was cancelled
     */
    constructor(skillName) {
        super(skillName, 'Execution cancelled by user', {
            code: ERROR_CODES.SKILL_CANCELLED,
            recoveryHint: 'Re-run the skill to try again',
        });
    }
}

/**
 * Test execution error.
 */
export class TestExecutionError extends OperationError {
    /**
     * Create a TestExecutionError.
     * @param {string} testName - Name or path of the test that failed
     * @param {string} message - Error message
     * @param {Object} [options] - Error options
     */
    constructor(testName, message, options = {}) {
        super(`Test "${testName}" failed: ${message}`, {
            code: ERROR_CODES.OPERATION_ERROR,
            details: { test: testName, ...options.details },
            ...options,
        });
        this.testName = testName;
    }
}

/**
 * File system operation error.
 */
export class FileSystemError extends OperationError {
    /**
     * Create a FileSystemError.
     * @param {string} operation - File operation (read, write, delete, etc.)
     * @param {string} path - File path
     * @param {string} message - Error message
     * @param {Object} [options] - Error options
     */
    constructor(operation, path, message, options = {}) {
        super(`File ${operation} failed for "${path}": ${message}`, {
            code: ERROR_CODES.OPERATION_ERROR,
            details: { operation, path, ...options.details },
            ...options,
        });
        this.operation = operation;
        this.path = path;
    }
}

export default OperationError;
