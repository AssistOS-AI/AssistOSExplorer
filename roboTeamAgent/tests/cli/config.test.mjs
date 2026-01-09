/**
 * Tests for Config and configSchema modules.
 *
 * Tests configuration management, environment variable handling,
 * and schema validation.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';

describe('Config', () => {
    let originalEnv;

    beforeEach(() => {
        // Save original environment
        originalEnv = { ...process.env };
    });

    afterEach(() => {
        // Restore original environment
        process.env = originalEnv;
    });

    describe('Config class', () => {
        it('should load Config module', async () => {
            const module = await import('../skill-manager/src/lib/Config.mjs');

            assert.ok(module.config, 'Should export config singleton');
            assert.ok(module.Config, 'Should export Config class');
            assert.ok(module.ENV_VARS, 'Should export ENV_VARS definitions');
        });

        it('should get default values', async () => {
            // Clear any env vars that might affect the test
            delete process.env.SKILL_MANAGER_UI;
            delete process.env.ACHILLES_DEBUG;
            delete process.env.LOG_LEVEL;

            const { Config } = await import('../skill-manager/src/lib/Config.mjs');
            const config = new Config();

            assert.strictEqual(config.get('UI_STYLE'), 'claude-code');
            assert.strictEqual(config.get('DEBUG'), false);
            assert.strictEqual(config.get('LOG_LEVEL'), 'info');
        });

        it('should read from environment variables', async () => {
            process.env.SKILL_MANAGER_UI = 'minimal';
            process.env.ACHILLES_DEBUG = 'true';
            process.env.LOG_LEVEL = 'debug';

            const { Config } = await import('../skill-manager/src/lib/Config.mjs');
            const config = new Config();

            assert.strictEqual(config.get('UI_STYLE'), 'minimal');
            assert.strictEqual(config.get('DEBUG'), true);
            assert.strictEqual(config.get('LOG_LEVEL'), 'debug');
        });

        it('should support multiple env var names for same config', async () => {
            // Test that any of the DEBUG var names work
            process.env.ACHILES_DEBUG = 'true'; // Note: intentional typo support

            const { Config } = await import('../skill-manager/src/lib/Config.mjs');
            const config = new Config();

            assert.strictEqual(config.get('DEBUG'), true);
        });

        it('should parse boolean values correctly', async () => {
            const { Config } = await import('../skill-manager/src/lib/Config.mjs');
            const config = new Config();

            // Test various truthy strings
            process.env.ACHILLES_DEBUG = '1';
            config.clearCache();
            assert.strictEqual(config.get('DEBUG'), true);

            process.env.ACHILLES_DEBUG = 'yes';
            config.clearCache();
            assert.strictEqual(config.get('DEBUG'), true);

            process.env.ACHILLES_DEBUG = 'false';
            config.clearCache();
            assert.strictEqual(config.get('DEBUG'), false);
        });

        it('should parse number values', async () => {
            process.env.SKILL_MAX_REFINEMENT_ITERATIONS = '10';

            const { Config } = await import('../skill-manager/src/lib/Config.mjs');
            const config = new Config();

            assert.strictEqual(config.get('MAX_REFINEMENT_ITERATIONS'), 10);
        });

        it('should throw for unknown config key', async () => {
            const { Config, config } = await import('../skill-manager/src/lib/Config.mjs');

            assert.throws(
                () => config.get('UNKNOWN_KEY'),
                /Unknown config key/
            );
        });

        it('should check if key exists', async () => {
            const { config } = await import('../skill-manager/src/lib/Config.mjs');

            assert.strictEqual(config.has('UI_STYLE'), true);
            assert.strictEqual(config.has('UNKNOWN_KEY'), false);
        });

        it('should list all keys', async () => {
            const { config } = await import('../skill-manager/src/lib/Config.mjs');
            const keys = config.keys();

            assert.ok(Array.isArray(keys));
            assert.ok(keys.includes('UI_STYLE'));
            assert.ok(keys.includes('DEBUG'));
            assert.ok(keys.includes('LOG_LEVEL'));
        });

        it('should get all config values', async () => {
            const { Config } = await import('../skill-manager/src/lib/Config.mjs');
            const config = new Config();
            const all = config.getAll();

            assert.ok(typeof all === 'object');
            assert.ok('UI_STYLE' in all);
            assert.ok('DEBUG' in all);
        });

        it('should get config definition', async () => {
            const { config } = await import('../skill-manager/src/lib/Config.mjs');
            const def = config.getDefinition('UI_STYLE');

            assert.ok(def);
            assert.strictEqual(def.name, 'SKILL_MANAGER_UI');
            assert.ok(def.description);
        });

        it('should cache values', async () => {
            const { Config } = await import('../skill-manager/src/lib/Config.mjs');
            const config = new Config();

            // First call
            const value1 = config.get('UI_STYLE');

            // Change env var
            process.env.SKILL_MANAGER_UI = 'changed';

            // Second call should return cached value
            const value2 = config.get('UI_STYLE');

            assert.strictEqual(value1, value2);

            // Clear cache and get updated value
            config.clearCache();
            const value3 = config.get('UI_STYLE');

            assert.strictEqual(value3, 'changed');
        });

        it('should validate configuration', async () => {
            const { Config } = await import('../skill-manager/src/lib/Config.mjs');
            const config = new Config();

            // Should not throw
            config.validate();

            assert.ok(config.isValidated());
        });
    });
});

describe('configSchema', () => {
    describe('validateSkillManagerConfig', () => {
        it('should load configSchema module', async () => {
            const module = await import('../skill-manager/src/lib/configSchema.mjs');

            assert.ok(module.skillManagerConfigSchema, 'Should export schema');
            assert.ok(module.validateSkillManagerConfig, 'Should export validate function');
            assert.ok(module.assertValidConfig, 'Should export assertValidConfig');
        });

        it('should validate valid config', async () => {
            const { validateSkillManagerConfig } = await import('../skill-manager/src/lib/configSchema.mjs');

            const validConfig = {
                version: 1,
                repositories: [
                    { name: 'test-repo', source: '/path/to/repo', type: 'local', enabled: true },
                ],
            };

            const result = validateSkillManagerConfig(validConfig);

            assert.strictEqual(result.valid, true);
            assert.deepStrictEqual(result.errors, []);
        });

        it('should reject invalid version type', async () => {
            const { validateSkillManagerConfig } = await import('../skill-manager/src/lib/configSchema.mjs');

            const invalidConfig = {
                version: 'not-a-number',
            };

            const result = validateSkillManagerConfig(invalidConfig);

            assert.strictEqual(result.valid, false);
            assert.ok(result.errors.some(e => e.includes('version')));
        });

        it('should reject invalid repositories type', async () => {
            const { validateSkillManagerConfig } = await import('../skill-manager/src/lib/configSchema.mjs');

            const invalidConfig = {
                repositories: 'not-an-array',
            };

            const result = validateSkillManagerConfig(invalidConfig);

            assert.strictEqual(result.valid, false);
            assert.ok(result.errors.some(e => e.includes('repositories')));
        });

        it('should validate repository entries', async () => {
            const { validateSkillManagerConfig } = await import('../skill-manager/src/lib/configSchema.mjs');

            const invalidConfig = {
                repositories: [
                    { name: '', source: null }, // Invalid
                ],
            };

            const result = validateSkillManagerConfig(invalidConfig);

            assert.strictEqual(result.valid, false);
            assert.ok(result.errors.length > 0);
        });

        it('should validate repository type enum', async () => {
            const { validateSkillManagerConfig } = await import('../skill-manager/src/lib/configSchema.mjs');

            const invalidConfig = {
                repositories: [
                    { name: 'test', source: '/path', type: 'invalid-type' },
                ],
            };

            const result = validateSkillManagerConfig(invalidConfig);

            assert.strictEqual(result.valid, false);
            assert.ok(result.errors.some(e => e.includes('type')));
        });
    });

    describe('assertValidConfig', () => {
        it('should not throw for valid config', async () => {
            const { assertValidConfig } = await import('../skill-manager/src/lib/configSchema.mjs');

            const validConfig = { version: 1, repositories: [] };

            // Should not throw
            assertValidConfig(validConfig);
        });

        it('should throw SchemaValidationError for invalid config', async () => {
            const { assertValidConfig } = await import('../skill-manager/src/lib/configSchema.mjs');

            const invalidConfig = { version: 'bad' };

            assert.throws(
                () => assertValidConfig(invalidConfig),
                /SchemaValidationError|validation failed/i
            );
        });
    });

    describe('validateRepositoryEntry', () => {
        it('should validate valid repository entry', async () => {
            const { validateRepositoryEntry } = await import('../skill-manager/src/lib/configSchema.mjs');

            const validEntry = { name: 'test', source: '/path/to/repo' };

            const result = validateRepositoryEntry(validEntry);

            assert.strictEqual(result.valid, true);
        });

        it('should reject missing name', async () => {
            const { validateRepositoryEntry } = await import('../skill-manager/src/lib/configSchema.mjs');

            const invalidEntry = { source: '/path' };

            const result = validateRepositoryEntry(invalidEntry);

            assert.strictEqual(result.valid, false);
            assert.ok(result.errors.some(e => e.includes('name')));
        });

        it('should reject missing source', async () => {
            const { validateRepositoryEntry } = await import('../skill-manager/src/lib/configSchema.mjs');

            const invalidEntry = { name: 'test' };

            const result = validateRepositoryEntry(invalidEntry);

            assert.strictEqual(result.valid, false);
            assert.ok(result.errors.some(e => e.includes('source')));
        });
    });
});
