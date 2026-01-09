/**
 * Tests for constants module.
 *
 * Tests BUILT_IN_SKILLS registry, timeouts, and error codes.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

describe('constants', () => {
    let BUILT_IN_SKILLS, TIMEOUTS, CONFIG_VERSION, ERROR_CODES;

    it('should load constants module', async () => {
        const module = await import('../skill-manager/src/lib/constants.mjs');
        BUILT_IN_SKILLS = module.BUILT_IN_SKILLS;
        TIMEOUTS = module.TIMEOUTS;
        CONFIG_VERSION = module.CONFIG_VERSION;
        ERROR_CODES = module.ERROR_CODES;

        assert.ok(BUILT_IN_SKILLS, 'Should export BUILT_IN_SKILLS');
        assert.ok(TIMEOUTS, 'Should export TIMEOUTS');
        assert.ok(CONFIG_VERSION, 'Should export CONFIG_VERSION');
        assert.ok(ERROR_CODES, 'Should export ERROR_CODES');
    });

    describe('BUILT_IN_SKILLS', () => {
        it('should contain all expected skill names', async () => {
            const module = await import('../skill-manager/src/lib/constants.mjs');
            const { BUILT_IN_SKILLS } = module;

            const expectedSkills = [
                'LIST',
                'READ',
                'WRITE',
                'DELETE',
                'VALIDATE',
                'GET_TEMPLATE',
                'GENERATE_CODE',
                'TEST_CODE',
                'RUN_TESTS',
                'SKILL_REFINER',
                'UPDATE_SECTION',
                'PREVIEW',
                'EXECUTE',
                'READ_SPECS',
                'WRITE_SPECS',
                'WRITE_TESTS',
                'ORCHESTRATOR',
            ];

            for (const skill of expectedSkills) {
                assert.ok(skill in BUILT_IN_SKILLS, `Should have ${skill}`);
                assert.strictEqual(
                    typeof BUILT_IN_SKILLS[skill],
                    'string',
                    `${skill} should be a string`
                );
            }
        });

        it('should have valid skill name values', async () => {
            const module = await import('../skill-manager/src/lib/constants.mjs');
            const { BUILT_IN_SKILLS } = module;

            // Check specific values
            assert.strictEqual(BUILT_IN_SKILLS.LIST, 'list-skills');
            assert.strictEqual(BUILT_IN_SKILLS.READ, 'read-skill');
            assert.strictEqual(BUILT_IN_SKILLS.WRITE, 'write-skill');
            assert.strictEqual(BUILT_IN_SKILLS.ORCHESTRATOR, 'skills-orchestrator');
        });

        it('should have unique skill names', async () => {
            const module = await import('../skill-manager/src/lib/constants.mjs');
            const { BUILT_IN_SKILLS } = module;

            const values = Object.values(BUILT_IN_SKILLS);
            const uniqueValues = new Set(values);

            assert.strictEqual(values.length, uniqueValues.size, 'All skill names should be unique');
        });
    });

    describe('TIMEOUTS', () => {
        it('should have reasonable timeout values', async () => {
            const module = await import('../skill-manager/src/lib/constants.mjs');
            const { TIMEOUTS } = module;

            assert.ok(TIMEOUTS.DEFAULT > 0, 'DEFAULT timeout should be positive');
            assert.ok(TIMEOUTS.ORCHESTRATOR > 0, 'ORCHESTRATOR timeout should be positive');
            assert.ok(TIMEOUTS.DBTABLE > 0, 'DBTABLE timeout should be positive');

            // Should be at least 30 seconds
            assert.ok(TIMEOUTS.DEFAULT >= 30000, 'DEFAULT should be at least 30s');
        });

        it('should have orchestrator timeout >= default', async () => {
            const module = await import('../skill-manager/src/lib/constants.mjs');
            const { TIMEOUTS } = module;

            assert.ok(
                TIMEOUTS.ORCHESTRATOR >= TIMEOUTS.DEFAULT,
                'ORCHESTRATOR timeout should be >= DEFAULT'
            );
        });
    });

    describe('CONFIG_VERSION', () => {
        it('should be a positive integer', async () => {
            const module = await import('../skill-manager/src/lib/constants.mjs');
            const { CONFIG_VERSION } = module;

            assert.strictEqual(typeof CONFIG_VERSION, 'number');
            assert.ok(Number.isInteger(CONFIG_VERSION));
            assert.ok(CONFIG_VERSION >= 1);
        });
    });

    describe('ERROR_CODES', () => {
        it('should have all expected error codes', async () => {
            const module = await import('../skill-manager/src/lib/constants.mjs');
            const { ERROR_CODES } = module;

            const expectedCodes = [
                'OPERATION_ERROR',
                'CONFIG_ERROR',
                'REPO_CONFIG_ERROR',
                'GIT_ERROR',
                'VALIDATION_ERROR',
                'SCHEMA_VALIDATION_ERROR',
                'FIELD_VALIDATION_ERROR',
                'RESOURCE_ERROR',
                'SKILL_NOT_FOUND',
                'REPO_NOT_FOUND',
                'FILE_NOT_FOUND',
                'SKILL_EXEC_ERROR',
                'SKILL_CANCELLED',
            ];

            for (const code of expectedCodes) {
                assert.ok(code in ERROR_CODES, `Should have ${code}`);
            }
        });

        it('should have unique error code values', async () => {
            const module = await import('../skill-manager/src/lib/constants.mjs');
            const { ERROR_CODES } = module;

            const values = Object.values(ERROR_CODES);
            const uniqueValues = new Set(values);

            assert.strictEqual(values.length, uniqueValues.size, 'All error codes should be unique');
        });
    });
});
