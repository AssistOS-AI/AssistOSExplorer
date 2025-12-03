/**
 * Code Generation Integration Tests
 * Tests the full generate → test flow for all skill types
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
} from './helpers/testHelpers.mjs';

describe('Code Generation Integration Tests', () => {
    let tempDir;
    let skillsDir;
    let generateCodeAction;
    let testCodeAction;

    before(async () => {
        const generateModule = await import('../src/.AchillesSkills/generate-code/generate-code.mjs');
        generateCodeAction = generateModule.action;

        const testModule = await import('../src/.AchillesSkills/test-code/test-code.mjs');
        testCodeAction = testModule.action;

        const dirs = createTempDir('temp_integration');
        tempDir = dirs.tempDir;
        skillsDir = dirs.skillsDir;
    });

    after(() => {
        cleanupTempDir(tempDir);
    });

    it('should generate and test code in sequence for tskill', async () => {
        // Create skill definition
        const skillDir = path.join(skillsDir, 'IntegrationTskill');
        fs.mkdirSync(skillDir);
        fs.writeFileSync(
            path.join(skillDir, 'tskill.md'),
            SKILL_DEFINITIONS.tskill
        );

        // Mock LLM that generates valid code
        const mockLlmAgent = {
            executePrompt: async () => {
                return `export function validator_product_id(value) {
    return value ? null : 'Required';
}
export function validateRecord(record) {
    return { valid: true, errors: [] };
}
export default { validator_product_id, validateRecord };`;
            },
        };

        const mockAgent = createMockAgent({
            startDir: tempDir,
            llmAgent: mockLlmAgent,
            skillCatalog: new Map([
                ['IntegrationTskill', {
                    name: 'IntegrationTskill',
                    skillDir,
                    filePath: path.join(skillDir, 'tskill.md'),
                    type: 'tskill',
                }],
            ]),
        });

        // Generate
        const genResult = await generateCodeAction(mockAgent, 'IntegrationTskill');
        assert.ok(genResult.includes('Generated'), 'Should generate code');

        // Test
        const testResult = await testCodeAction(mockAgent, 'IntegrationTskill');
        assert.ok(testResult.includes('Module loaded'), 'Should load generated module');
        assert.ok(testResult.includes('validator_product_id'), 'Should have validator');
    });

    it('should generate and test code in sequence for iskill', async () => {
        const skillDir = path.join(skillsDir, 'IntegrationIskill');
        fs.mkdirSync(skillDir);
        fs.writeFileSync(
            path.join(skillDir, 'iskill.md'),
            SKILL_DEFINITIONS.iskill
        );

        const mockLlmAgent = {
            executePrompt: async () => {
                return `export const specs = {
    name: 'IntegrationIskill',
    description: 'Test',
    arguments: { name: { type: 'string', required: true } },
};
export async function action(args) {
    return 'Hello ' + (args.name || 'World');
}
export default { specs, action };`;
            },
        };

        const mockAgent = createMockAgent({
            startDir: tempDir,
            llmAgent: mockLlmAgent,
            skillCatalog: new Map([
                ['IntegrationIskill', {
                    name: 'IntegrationIskill',
                    skillDir,
                    filePath: path.join(skillDir, 'iskill.md'),
                    type: 'iskill',
                }],
            ]),
        });

        const genResult = await generateCodeAction(mockAgent, 'IntegrationIskill');
        assert.ok(genResult.includes('Generated'), 'Should generate code');

        const testResult = await testCodeAction(mockAgent, 'IntegrationIskill');
        assert.ok(testResult.includes('Module loaded'), 'Should load generated module');
        assert.ok(testResult.includes('specs'), 'Should have specs');
        assert.ok(testResult.includes('action'), 'Should have action');
    });

    it('should generate and test code in sequence for oskill', async () => {
        const skillDir = path.join(skillsDir, 'IntegrationOskill');
        fs.mkdirSync(skillDir);
        fs.writeFileSync(
            path.join(skillDir, 'oskill.md'),
            SKILL_DEFINITIONS.oskill
        );

        const mockLlmAgent = {
            executePrompt: async () => {
                return `export const specs = {
    name: 'IntegrationOskill',
    type: 'orchestrator',
    allowedSkills: ['greeter'],
    intents: { greet: 'Greet user' },
};
export async function action(input) {
    return 'Routed: ' + input;
}
export default { specs, action };`;
            },
        };

        const mockAgent = createMockAgent({
            startDir: tempDir,
            llmAgent: mockLlmAgent,
            skillCatalog: new Map([
                ['IntegrationOskill', {
                    name: 'IntegrationOskill',
                    skillDir,
                    filePath: path.join(skillDir, 'oskill.md'),
                    type: 'oskill',
                }],
            ]),
        });

        const genResult = await generateCodeAction(mockAgent, 'IntegrationOskill');
        assert.ok(genResult.includes('Generated'), 'Should generate code');

        const testResult = await testCodeAction(mockAgent, 'IntegrationOskill');
        assert.ok(testResult.includes('Module loaded'), 'Should load generated module');
    });

    it('should generate and test code in sequence for cskill', async () => {
        const skillDir = path.join(skillsDir, 'IntegrationCskill');
        fs.mkdirSync(skillDir);
        fs.writeFileSync(
            path.join(skillDir, 'cskill.md'),
            SKILL_DEFINITIONS.cskill
        );

        const mockLlmAgent = {
            executePrompt: async () => {
                return `export const specs = {
    name: 'IntegrationCskill',
    type: 'code',
    llmMode: 'fast',
    arguments: { text: { type: 'string', required: true } },
};
export async function action(input) {
    return 'Summarized: ' + input;
}
export default { specs, action };`;
            },
        };

        const mockAgent = createMockAgent({
            startDir: tempDir,
            llmAgent: mockLlmAgent,
            skillCatalog: new Map([
                ['IntegrationCskill', {
                    name: 'IntegrationCskill',
                    skillDir,
                    filePath: path.join(skillDir, 'cskill.md'),
                    type: 'cskill',
                }],
            ]),
        });

        const genResult = await generateCodeAction(mockAgent, 'IntegrationCskill');
        assert.ok(genResult.includes('Generated'), 'Should generate code');

        const testResult = await testCodeAction(mockAgent, 'IntegrationCskill');
        assert.ok(testResult.includes('Module loaded'), 'Should load generated module');
    });
});
