/**
 * Tests for centralized error system.
 *
 * Tests error class hierarchy, error codes, and error handling patterns.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

describe('Error Classes', () => {
    let errors;

    it('should load all error exports', async () => {
        errors = await import('../skill-manager/src/lib/errors/index.mjs');

        // Verify all expected exports exist
        const expectedExports = [
            'BaseError',
            'ConfigurationError',
            'RepositoryConfigurationError',
            'EnvironmentConfigurationError',
            'ConfigFileError',
            'OperationError',
            'GitOperationError',
            'SkillExecutionError',
            'SkillExecutionCancelledError',
            'TestExecutionError',
            'FileSystemError',
            'ValidationError',
            'SchemaValidationError',
            'FieldValidationError',
            'InputValidationError',
            'RequiredFieldError',
            'ResourceError',
            'SkillNotFoundError',
            'RepositoryNotFoundError',
            'FileNotFoundError',
            'DirectoryNotFoundError',
            'ResourceAccessError',
        ];

        for (const name of expectedExports) {
            assert.ok(errors[name], `Should export ${name}`);
            assert.strictEqual(typeof errors[name], 'function', `${name} should be a class`);
        }
    });

    describe('BaseError', () => {
        it('should create error with message', async () => {
            const { BaseError } = await import('../skill-manager/src/lib/errors/BaseError.mjs');
            const error = new BaseError('Test error');

            assert.strictEqual(error.message, 'Test error');
            assert.strictEqual(error.name, 'BaseError');
            assert.ok(error instanceof Error);
        });

        it('should accept error code', async () => {
            const { BaseError } = await import('../skill-manager/src/lib/errors/BaseError.mjs');
            const error = new BaseError('Test error', { code: 'TEST_CODE' });

            assert.strictEqual(error.code, 'TEST_CODE');
        });

        it('should accept cause', async () => {
            const { BaseError } = await import('../skill-manager/src/lib/errors/BaseError.mjs');
            const cause = new Error('Original error');
            const error = new BaseError('Wrapped error', { cause });

            assert.strictEqual(error.cause, cause);
        });

        it('should accept details', async () => {
            const { BaseError } = await import('../skill-manager/src/lib/errors/BaseError.mjs');
            const error = new BaseError('Test error', { details: { foo: 'bar' } });

            assert.deepStrictEqual(error.details, { foo: 'bar' });
        });

        it('should accept recoveryHint', async () => {
            const { BaseError } = await import('../skill-manager/src/lib/errors/BaseError.mjs');
            const error = new BaseError('Test error', { recoveryHint: 'Try again' });

            assert.strictEqual(error.recoveryHint, 'Try again');
        });

        it('should have timestamp', async () => {
            const { BaseError } = await import('../skill-manager/src/lib/errors/BaseError.mjs');
            const error = new BaseError('Test error');

            assert.ok(error.timestamp);
            assert.ok(Date.parse(error.timestamp));
        });

        it('should serialize to JSON', async () => {
            const { BaseError } = await import('../skill-manager/src/lib/errors/BaseError.mjs');
            const error = new BaseError('Test error', {
                code: 'TEST_CODE',
                details: { key: 'value' },
                recoveryHint: 'Try again',
            });

            const json = error.toJSON();

            assert.strictEqual(json.name, 'BaseError');
            assert.strictEqual(json.code, 'TEST_CODE');
            assert.strictEqual(json.message, 'Test error');
            assert.deepStrictEqual(json.details, { key: 'value' });
            assert.strictEqual(json.recoveryHint, 'Try again');
            assert.ok(json.timestamp);
        });

        it('should format user-friendly string', async () => {
            const { BaseError } = await import('../skill-manager/src/lib/errors/BaseError.mjs');
            const error = new BaseError('Test error', {
                recoveryHint: 'Try again',
            });

            const str = error.toUserString();

            assert.ok(str.includes('Test error'));
            assert.ok(str.includes('Try again'));
        });

        it('should wrap existing errors', async () => {
            const { BaseError } = await import('../skill-manager/src/lib/errors/BaseError.mjs');
            const original = new Error('Original error');
            const wrapped = BaseError.wrap(original, { code: 'WRAPPED' });

            assert.ok(wrapped instanceof BaseError);
            assert.strictEqual(wrapped.message, 'Original error');
            assert.strictEqual(wrapped.cause, original);
            assert.strictEqual(wrapped.code, 'WRAPPED');
        });
    });

    describe('ConfigurationError', () => {
        it('should create configuration error', async () => {
            const { ConfigurationError } = await import('../skill-manager/src/lib/errors/ConfigurationError.mjs');
            const error = new ConfigurationError('Config error');

            assert.ok(error instanceof Error);
            assert.strictEqual(error.name, 'ConfigurationError');
            assert.ok(error.code);
        });

        it('should create repository configuration error', async () => {
            const { RepositoryConfigurationError } = await import('../skill-manager/src/lib/errors/ConfigurationError.mjs');
            const error = new RepositoryConfigurationError('my-repo', 'Invalid config');

            assert.ok(error.message.includes('my-repo'));
            assert.ok(error.message.includes('Invalid config'));
            assert.strictEqual(error.repoName, 'my-repo');
        });

        it('should create environment configuration error', async () => {
            const { EnvironmentConfigurationError } = await import('../skill-manager/src/lib/errors/ConfigurationError.mjs');
            const error = new EnvironmentConfigurationError('API_KEY', 'is required');

            assert.ok(error.message.includes('API_KEY'));
            assert.strictEqual(error.varName, 'API_KEY');
            assert.ok(error.recoveryHint);
        });

        it('should create config file error', async () => {
            const { ConfigFileError } = await import('../skill-manager/src/lib/errors/ConfigurationError.mjs');
            const error = new ConfigFileError('/path/to/config.json', 'Invalid JSON');

            assert.ok(error.message.includes('/path/to/config.json'));
            assert.strictEqual(error.filePath, '/path/to/config.json');
        });
    });

    describe('OperationError', () => {
        it('should create git operation error', async () => {
            const { GitOperationError } = await import('../skill-manager/src/lib/errors/OperationError.mjs');
            const error = new GitOperationError('clone', 'Repository not found');

            assert.ok(error.message.includes('clone'));
            assert.ok(error.message.includes('Repository not found'));
            assert.strictEqual(error.operation, 'clone');
        });

        it('should create skill execution error', async () => {
            const { SkillExecutionError } = await import('../skill-manager/src/lib/errors/OperationError.mjs');
            const error = new SkillExecutionError('my-skill', 'Timeout');

            assert.ok(error.message.includes('my-skill'));
            assert.strictEqual(error.skillName, 'my-skill');
        });

        it('should create skill execution cancelled error', async () => {
            const { SkillExecutionCancelledError } = await import('../skill-manager/src/lib/errors/OperationError.mjs');
            const error = new SkillExecutionCancelledError('my-skill');

            assert.ok(error.message.includes('cancelled'));
            assert.strictEqual(error.skillName, 'my-skill');
        });

        it('should create file system error', async () => {
            const { FileSystemError } = await import('../skill-manager/src/lib/errors/OperationError.mjs');
            const error = new FileSystemError('write', '/path/to/file', 'Permission denied');

            assert.ok(error.message.includes('write'));
            assert.ok(error.message.includes('/path/to/file'));
            assert.strictEqual(error.operation, 'write');
            assert.strictEqual(error.path, '/path/to/file');
        });
    });

    describe('ValidationError', () => {
        it('should create schema validation error', async () => {
            const { SchemaValidationError } = await import('../skill-manager/src/lib/errors/ValidationError.mjs');
            const error = new SchemaValidationError('my-skill', ['Missing field: name', 'Invalid type']);

            assert.ok(error.message.includes('my-skill'));
            assert.strictEqual(error.skillName, 'my-skill');
            assert.ok(Array.isArray(error.validationErrors));
            assert.strictEqual(error.validationErrors.length, 2);
        });

        it('should create field validation error', async () => {
            const { FieldValidationError } = await import('../skill-manager/src/lib/errors/ValidationError.mjs');
            const error = new FieldValidationError('age', -5, 'positive number');

            assert.ok(error.message.includes('age'));
            assert.strictEqual(error.fieldName, 'age');
            assert.strictEqual(error.value, -5);
            assert.strictEqual(error.expectedType, 'positive number');
        });

        it('should create required field error', async () => {
            const { RequiredFieldError } = await import('../skill-manager/src/lib/errors/ValidationError.mjs');
            const error = new RequiredFieldError('username');

            assert.ok(error.message.includes('username'));
            assert.strictEqual(error.fieldName, 'username');
            assert.ok(error.recoveryHint);
        });
    });

    describe('ResourceError', () => {
        it('should create skill not found error with suggestions', async () => {
            const { SkillNotFoundError } = await import('../skill-manager/src/lib/errors/ResourceError.mjs');
            const error = new SkillNotFoundError('equipmnt', ['equipment', 'material', 'area']);

            assert.ok(error.message.includes('equipmnt'));
            assert.strictEqual(error.skillName, 'equipmnt');
            assert.ok(error.recoveryHint.includes('equipment'));
        });

        it('should create repository not found error', async () => {
            const { RepositoryNotFoundError } = await import('../skill-manager/src/lib/errors/ResourceError.mjs');
            const error = new RepositoryNotFoundError('my-repo', ['repo-1', 'repo-2']);

            assert.strictEqual(error.repoName, 'my-repo');
            assert.ok(error.recoveryHint.includes('repo-1'));
        });

        it('should create directory not found error', async () => {
            const { DirectoryNotFoundError } = await import('../skill-manager/src/lib/errors/ResourceError.mjs');
            const error = new DirectoryNotFoundError('/path/to/dir');

            assert.ok(error.message.includes('/path/to/dir'));
            assert.strictEqual(error.dirPath, '/path/to/dir');
        });
    });
});
