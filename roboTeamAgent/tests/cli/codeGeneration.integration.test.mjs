/**
 * Code Generation Integration Tests
 * Tests the full generate -> test flow for generated runtime skill types
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
        const generateModule = await import('../achilles-cli/src/skills/generate-code/src/index.mjs');
        generateCodeAction = generateModule.action;

        const testModule = await import('../achilles-cli/src/skills/test-code/src/index.mjs');
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
        const genResult = await generateCodeAction({ mainAgent: mockAgent, promptText: 'IntegrationTskill' });
        assert.ok(genResult.includes('Generated'), 'Should generate code');

        const testResult = await testCodeAction({ mainAgent: mockAgent, promptText: 'IntegrationTskill' });
        assert.ok(testResult.includes('Module loaded'), 'Should load generated module');
        assert.ok(testResult.includes('validator_product_id'), 'Should have validator');
    });

    it('should reject code generation for oskill descriptors', async () => {
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

        const genResult = await generateCodeAction({ mainAgent: mockAgent, promptText: 'IntegrationOskill' });
        assert.ok(genResult.includes('Error'), 'Should reject unsupported type');
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
    description: 'Test cskill',
};
export async function action(invocation = {}) {
    return 'Summarized: ' + (invocation.promptText || '');
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

        const genResult = await generateCodeAction({ mainAgent: mockAgent, promptText: 'IntegrationCskill' });
        assert.ok(genResult.includes('Generated'), 'Should generate code');

        const testResult = await testCodeAction({ mainAgent: mockAgent, promptText: 'IntegrationCskill' });
        assert.ok(testResult.includes('Module loaded'), 'Should load generated module');
    });
});
