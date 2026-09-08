import { SchemaValidationError } from './errors/ValidationError.mjs';

const REPOSITORY_TYPES = new Set(['local', 'git', 'github']);

export const skillManagerConfigSchema = {
    type: 'object',
    properties: {
        version: { type: 'number' },
        repositories: { type: 'array' },
    },
};

function pushError(errors, path, message) {
    errors.push(`${path}: ${message}`);
}

export function validateRepositoryEntry(entry, path = 'repository') {
    const errors = [];

    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        pushError(errors, path, 'must be an object');
        return { valid: false, errors };
    }

    if (typeof entry.name !== 'string' || entry.name.trim() === '') {
        pushError(errors, `${path}.name`, 'must be a non-empty string');
    }

    if (typeof entry.source !== 'string' || entry.source.trim() === '') {
        pushError(errors, `${path}.source`, 'must be a non-empty string');
    }

    if (entry.type !== undefined && !REPOSITORY_TYPES.has(entry.type)) {
        pushError(errors, `${path}.type`, `must be one of: ${Array.from(REPOSITORY_TYPES).join(', ')}`);
    }

    if (entry.enabled !== undefined && typeof entry.enabled !== 'boolean') {
        pushError(errors, `${path}.enabled`, 'must be a boolean');
    }

    return { valid: errors.length === 0, errors };
}

export function validateAchillesCliConfig(config) {
    const errors = [];

    if (!config || typeof config !== 'object' || Array.isArray(config)) {
        return { valid: false, errors: ['config: must be an object'] };
    }

    if (config.version !== undefined && typeof config.version !== 'number') {
        pushError(errors, 'version', 'must be a number');
    }

    if (config.repositories !== undefined) {
        if (!Array.isArray(config.repositories)) {
            pushError(errors, 'repositories', 'must be an array');
        } else {
            config.repositories.forEach((entry, index) => {
                const result = validateRepositoryEntry(entry, `repositories[${index}]`);
                errors.push(...result.errors);
            });
        }
    }

    return { valid: errors.length === 0, errors };
}

export function assertValidConfig(config) {
    const result = validateAchillesCliConfig(config);
    if (!result.valid) {
        throw new SchemaValidationError('achilles-cli-config', result.errors);
    }
    return config;
}

export default {
    skillManagerConfigSchema,
    validateAchillesCliConfig,
    validateRepositoryEntry,
    assertValidConfig,
};
