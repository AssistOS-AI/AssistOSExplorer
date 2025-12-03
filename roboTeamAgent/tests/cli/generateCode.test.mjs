/**
 * Generate Code Tests
 * Tests the generate-code action for all skill types: tskill, iskill, oskill, cskill
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';

import {
    createMockAgent,
    createTempDir,
    cleanupTempDir,
    SKILL_DEFINITIONS,
    MOCK_GENERATED_CODE,
} from './helpers/testHelpers.mjs';

describe('generate-code Action Tests', () => {
    let tempDir;
    let skillsDir;
    let generateCodeAction;

    before(async () => {
        // Import action function
        const generateModule = await import('../src/.AchillesSkills/generate-code/generate-code.mjs');
        generateCodeAction = generateModule.action;

        // Setup temp directory
        const dirs = createTempDir('temp_generatecode');
        tempDir = dirs.tempDir;
        skillsDir = dirs.skillsDir;

        // Create skill directories and definition files for each type
        for (const [type, content] of Object.entries(SKILL_DEFINITIONS)) {
            const skillName = `Test${type.charAt(0).toUpperCase() + type.slice(1)}Skill`;
            const skillDir = path.join(skillsDir, skillName);
            fs.mkdirSync(skillDir);
            fs.writeFileSync(path.join(skillDir, `${type}.md`), content);
        }
    });

    after(() => {
        cleanupTempDir(tempDir);
    });

    describe('Error Handling', () => {
        it('should return error when skillName not provided', async () => {
            const mockAgent = createMockAgent({ startDir: tempDir });
            const result = await generateCodeAction(mockAgent, '');
            assert.ok(result.includes('Error'), 'Should return error');
            assert.ok(result.includes('skillName'), 'Should mention skillName');
        });

        it('should return error when skill not found', async () => {
            const mockAgent = createMockAgent({ startDir: tempDir });
            const result = await generateCodeAction(mockAgent, 'NonExistentSkill');
            assert.ok(result.includes('Error') || result.includes('not found'), 'Should return error');
        });

        it('should return error when llmAgent not provided', async () => {
            const mockAgent = createMockAgent({ startDir: tempDir });
            const result = await generateCodeAction(mockAgent, 'TestTskillSkill');
            assert.ok(result.includes('Error'), 'Should return error');
            assert.ok(result.includes('LLM') || result.includes('not found'), 'Should mention LLM or not found');
        });
    });

    describe('tskill Code Generation', () => {
        it('should generate code for tskill', async () => {
            const skillDir = path.join(skillsDir, 'TestTskillSkill');
            const mockLlmAgent = {
                executePrompt: async () => MOCK_GENERATED_CODE.tskill,
            };

            const mockAgent = createMockAgent({
                startDir: tempDir,
                llmAgent: mockLlmAgent,
                skillCatalog: new Map([
                    ['TestTskillSkill', {
                        name: 'TestTskillSkill',
                        skillDir,
                        filePath: path.join(skillDir, 'tskill.md'),
                        type: 'tskill',
                    }],
                ]),
            });

            const result = await generateCodeAction(mockAgent, 'TestTskillSkill');

            assert.ok(result.includes('Generated'), 'Should indicate generation');
            assert.ok(result.includes('tskill.generated.mjs'), 'Should use tskill.generated.mjs filename');

            // Verify file was created
            const generatedPath = path.join(skillsDir, 'TestTskillSkill', 'tskill.generated.mjs');
            assert.ok(fs.existsSync(generatedPath), 'Generated file should exist');
        });
    });

    describe('iskill Code Generation', () => {
        it('should generate code for iskill', async () => {
            const skillDir = path.join(skillsDir, 'TestIskillSkill');
            const mockLlmAgent = {
                executePrompt: async () => MOCK_GENERATED_CODE.iskill,
            };

            const mockAgent = createMockAgent({
                startDir: tempDir,
                llmAgent: mockLlmAgent,
                skillCatalog: new Map([
                    ['TestIskillSkill', {
                        name: 'TestIskillSkill',
                        skillDir,
                        filePath: path.join(skillDir, 'iskill.md'),
                        type: 'iskill',
                    }],
                ]),
            });

            const result = await generateCodeAction(mockAgent, 'TestIskillSkill');

            assert.ok(result.includes('Generated'), 'Should indicate generation');
            assert.ok(result.includes('TestIskillSkill.generated.mjs'), 'Should use skillName.generated.mjs filename');

            const generatedPath = path.join(skillsDir, 'TestIskillSkill', 'TestIskillSkill.generated.mjs');
            assert.ok(fs.existsSync(generatedPath), 'Generated file should exist');
        });
    });

    describe('oskill Code Generation', () => {
        it('should generate code for oskill', async () => {
            const skillDir = path.join(skillsDir, 'TestOskillSkill');
            const mockLlmAgent = {
                executePrompt: async () => MOCK_GENERATED_CODE.oskill,
            };

            const mockAgent = createMockAgent({
                startDir: tempDir,
                llmAgent: mockLlmAgent,
                skillCatalog: new Map([
                    ['TestOskillSkill', {
                        name: 'TestOskillSkill',
                        skillDir,
                        filePath: path.join(skillDir, 'oskill.md'),
                        type: 'oskill',
                    }],
                ]),
            });

            const result = await generateCodeAction(mockAgent, 'TestOskillSkill');

            assert.ok(result.includes('Generated'), 'Should indicate generation');
            assert.ok(result.includes('TestOskillSkill.generated.mjs'), 'Should use skillName.generated.mjs filename');

            const generatedPath = path.join(skillsDir, 'TestOskillSkill', 'TestOskillSkill.generated.mjs');
            assert.ok(fs.existsSync(generatedPath), 'Generated file should exist');
        });
    });

    describe('cskill Code Generation', () => {
        it('should generate code for cskill', async () => {
            const skillDir = path.join(skillsDir, 'TestCskillSkill');
            const mockLlmAgent = {
                executePrompt: async () => MOCK_GENERATED_CODE.cskill,
            };

            const mockAgent = createMockAgent({
                startDir: tempDir,
                llmAgent: mockLlmAgent,
                skillCatalog: new Map([
                    ['TestCskillSkill', {
                        name: 'TestCskillSkill',
                        skillDir,
                        filePath: path.join(skillDir, 'cskill.md'),
                        type: 'cskill',
                    }],
                ]),
            });

            const result = await generateCodeAction(mockAgent, 'TestCskillSkill');

            assert.ok(result.includes('Generated'), 'Should indicate generation');
            assert.ok(result.includes('TestCskillSkill.generated.mjs'), 'Should use skillName.generated.mjs filename');

            const generatedPath = path.join(skillsDir, 'TestCskillSkill', 'TestCskillSkill.generated.mjs');
            assert.ok(fs.existsSync(generatedPath), 'Generated file should exist');
        });
    });
});
