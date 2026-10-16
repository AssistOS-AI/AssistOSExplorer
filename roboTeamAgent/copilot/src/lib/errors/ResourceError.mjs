/**
 * Resource-related errors.
 *
 * Used for errors related to:
 * - Resource not found (skill, repository, file)
 * - Resource access issues
 * - Invalid resources
 */

import { BaseError } from './BaseError.mjs';
import { ERROR_CODES } from '../constants.mjs';

/**
 * Base resource error.
 */
export class ResourceError extends BaseError {
    /**
     * Create a ResourceError.
     * @param {string} message - Error message
     * @param {Object} [options] - Error options
     */
    constructor(message, options = {}) {
        super(message, {
            code: ERROR_CODES.RESOURCE_ERROR,
            ...options,
        });
    }
}

/**
 * Skill not found error.
 */
export class SkillNotFoundError extends ResourceError {
    /**
     * Create a SkillNotFoundError.
     * @param {string} skillName - Name of the skill that was not found
     * @param {string[]} [availableSkills] - List of available skill names for suggestions
     * @param {Object} [options] - Error options
     */
    constructor(skillName, availableSkills = [], options = {}) {
        const hint = availableSkills.length > 0
            ? `Available skills: ${availableSkills.slice(0, 5).join(', ')}${availableSkills.length > 5 ? '...' : ''}`
            : 'Use /ls to list available skills';

        super(`Skill "${skillName}" not found`, {
            code: ERROR_CODES.SKILL_NOT_FOUND,
            details: { skill: skillName, availableSkills: availableSkills.slice(0, 10), ...options.details },
            recoveryHint: options.recoveryHint || hint,
            ...options,
        });
        this.skillName = skillName;
        this.availableSkills = availableSkills;
    }
}

/**
 * Repository not found error.
 */
export class RepositoryNotFoundError extends ResourceError {
    /**
     * Create a RepositoryNotFoundError.
     * @param {string} repoName - Name of the repository that was not found
     * @param {string[]} [availableRepos] - List of available repository names
     * @param {Object} [options] - Error options
     */
    constructor(repoName, availableRepos = [], options = {}) {
        const hint = availableRepos.length > 0
            ? `Available repositories: ${availableRepos.join(', ')}`
            : 'Install the repository package or check your configuration';

        super(`Repository "${repoName}" not found`, {
            code: ERROR_CODES.REPO_NOT_FOUND,
            details: { repository: repoName, availableRepos, ...options.details },
            recoveryHint: options.recoveryHint || hint,
            ...options,
        });
        this.repoName = repoName;
        this.availableRepos = availableRepos;
    }
}

/**
 * File not found error.
 */
export class FileNotFoundError extends ResourceError {
    /**
     * Create a FileNotFoundError.
     * @param {string} filePath - Path to the file that was not found
     * @param {Object} [options] - Error options
     */
    constructor(filePath, options = {}) {
        super(`File not found: "${filePath}"`, {
            code: ERROR_CODES.FILE_NOT_FOUND,
            details: { path: filePath, ...options.details },
            ...options,
        });
        this.filePath = filePath;
    }
}

/**
 * Directory not found error.
 */
export class DirectoryNotFoundError extends ResourceError {
    /**
     * Create a DirectoryNotFoundError.
     * @param {string} dirPath - Path to the directory that was not found
     * @param {Object} [options] - Error options
     */
    constructor(dirPath, options = {}) {
        super(`Directory not found: "${dirPath}"`, {
            code: ERROR_CODES.RESOURCE_ERROR,
            details: { path: dirPath, ...options.details },
            ...options,
        });
        this.dirPath = dirPath;
    }
}

/**
 * Resource access denied error.
 */
export class ResourceAccessError extends ResourceError {
    /**
     * Create a ResourceAccessError.
     * @param {string} resourceType - Type of resource (file, directory, repository)
     * @param {string} resourcePath - Path or identifier of the resource
     * @param {string} [reason] - Reason for access denial
     * @param {Object} [options] - Error options
     */
    constructor(resourceType, resourcePath, reason = 'permission denied', options = {}) {
        super(`Access denied to ${resourceType} "${resourcePath}": ${reason}`, {
            code: ERROR_CODES.RESOURCE_ERROR,
            details: { resourceType, path: resourcePath, reason, ...options.details },
            ...options,
        });
        this.resourceType = resourceType;
        this.resourcePath = resourcePath;
        this.reason = reason;
    }
}

export default ResourceError;
