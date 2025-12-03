/**
 * Skill Specifications (.specs.md) Tests
 * Tests for loading and using .specs.md files in skill operations
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';

import { loadSpecsContent, buildSpecsContext } from '../src/schemas/skillSchemas.mjs';
import {
    createMockAgent,
    createTempDir,
    cleanupTempDir,
    SKILL_DEFINITIONS,
} from './helpers/testHelpers.mjs';

describe('Skill Specifications (.specs.md) Support', () => {
    let tempDir;
    let skillsDir;

    before(() => {
        const dirs = createTempDir('temp_specs');
        tempDir = dirs.tempDir;
        skillsDir = dirs.skillsDir;
    });

    after(() => {
        cleanupTempDir(tempDir);
    });

    describe('loadSpecsContent Utility', () => {
        it('should return null for non-existent skill directory', () => {
            const result = loadSpecsContent('/non/existent/path');
            assert.strictEqual(result, null);
        });

        it('should return null for skill directory without specs file', () => {
            const skillDir = path.join(skillsDir, 'NoSpecsSkill');
            fs.mkdirSync(skillDir);
            fs.writeFileSync(path.join(skillDir, 'cskill.md'), '# Test\n## Summary\nTest skill');

            const result = loadSpecsContent(skillDir);
            assert.strictEqual(result, null);
        });

        it('should load specs content when .specs.md exists', () => {
            const skillDir = path.join(skillsDir, 'WithSpecsSkill');
            fs.mkdirSync(skillDir);
            fs.writeFileSync(path.join(skillDir, 'cskill.md'), '# Test\n## Summary\nTest skill');
            fs.writeFileSync(path.join(skillDir, '.specs.md'), '# Specifications\n\n- Must return JSON\n- Max 100 chars');

            const result = loadSpecsContent(skillDir);
            assert.ok(result !== null, 'Should return specs content');
            assert.ok(result.includes('Specifications'), 'Should contain specs content');
            assert.ok(result.includes('Must return JSON'), 'Should contain requirements');
        });

        it('should return null for null skillDir', () => {
            const result = loadSpecsContent(null);
            assert.strictEqual(result, null);
        });

        it('should return null for undefined skillDir', () => {
            const result = loadSpecsContent(undefined);
            assert.strictEqual(result, null);
        });
    });

    describe('buildSpecsContext Utility', () => {
        it('should return empty string for null specs', () => {
            const result = buildSpecsContext(null);
            assert.strictEqual(result, '');
        });

        it('should return empty string for undefined specs', () => {
            const result = buildSpecsContext(undefined);
            assert.strictEqual(result, '');
        });

        it('should return empty string for empty string specs', () => {
            const result = buildSpecsContext('');
            assert.strictEqual(result, '');
        });

        it('should format specs content for LLM prompt', () => {
            const specsContent = '- Must validate email format\n- Return error messages in JSON';
            const result = buildSpecsContext(specsContent);

            assert.ok(result.includes('Skill Specifications'), 'Should include header');
            assert.ok(result.includes('Must validate email format'), 'Should include specs content');
            assert.ok(result.includes('IMPORTANT'), 'Should include importance note');
        });
    });

    describe('Code Generation with Specs', () => {
        it('should include specs content in LLM prompt when .specs.md exists', async () => {
            const generateModule = await import('../src/.AchillesSkills/generate-code/generate-code.mjs');
            const generateCodeAction = generateModule.action;

            const skillDir = path.join(skillsDir, 'SpecsCodeGenSkill');
            fs.mkdirSync(skillDir);
            fs.writeFileSync(path.join(skillDir, 'cskill.md'), SKILL_DEFINITIONS.cskill);
            fs.writeFileSync(path.join(skillDir, '.specs.md'), '# Code Generation Specs\n\n- Generated code must use arrow functions\n- All exports must be named exports');

            let capturedPrompt = null;
            const mockLlmAgent = {
                executePrompt: async (prompt) => {
                    capturedPrompt = prompt;
                    return `export const specs = { name: 'test' };
export const action = async (input) => 'result';
export default { specs, action };`;
                },
            };

            const mockAgent = createMockAgent({
                startDir: tempDir,
                llmAgent: mockLlmAgent,
                skillCatalog: new Map([
                    ['SpecsCodeGenSkill', {
                        name: 'SpecsCodeGenSkill',
                        skillDir,
                        filePath: path.join(skillDir, 'cskill.md'),
                        type: 'cskill',
                    }],
                ]),
            });

            await generateCodeAction(mockAgent, 'SpecsCodeGenSkill');

            assert.ok(capturedPrompt !== null, 'LLM should have been called');
            assert.ok(capturedPrompt.includes('Skill Specifications'), 'Prompt should include specs section');
            assert.ok(capturedPrompt.includes('arrow functions'), 'Prompt should include specs requirements');
            assert.ok(capturedPrompt.includes('named exports'), 'Prompt should include all specs');
        });

        it('should work normally when no .specs.md exists', async () => {
            const generateModule = await import('../src/.AchillesSkills/generate-code/generate-code.mjs');
            const generateCodeAction = generateModule.action;

            const skillDir = path.join(skillsDir, 'NoSpecsCodeGenSkill');
            fs.mkdirSync(skillDir);
            fs.writeFileSync(path.join(skillDir, 'cskill.md'), SKILL_DEFINITIONS.cskill);

            let capturedPrompt = null;
            const mockLlmAgent = {
                executePrompt: async (prompt) => {
                    capturedPrompt = prompt;
                    return `export const specs = { name: 'test' };
export const action = async (input) => 'result';
export default { specs, action };`;
                },
            };

            const mockAgent = createMockAgent({
                startDir: tempDir,
                llmAgent: mockLlmAgent,
                skillCatalog: new Map([
                    ['NoSpecsCodeGenSkill', {
                        name: 'NoSpecsCodeGenSkill',
                        skillDir,
                        filePath: path.join(skillDir, 'cskill.md'),
                        type: 'cskill',
                    }],
                ]),
            });

            const result = await generateCodeAction(mockAgent, 'NoSpecsCodeGenSkill');

            assert.ok(result.includes('Generated'), 'Should generate code successfully');
            assert.ok(capturedPrompt !== null, 'LLM should have been called');
            assert.ok(!capturedPrompt.includes('Skill Specifications'), 'Prompt should not include specs section');
        });
    });

    describe('read-skill with Specs', () => {
        it('should display .specs.md content when reading a skill', async () => {
            const readModule = await import('../src/.AchillesSkills/read-skill/read-skill.mjs');
            const readSkillAction = readModule.action;

            const skillDir = path.join(skillsDir, 'ReadableSpecsSkill');
            fs.mkdirSync(skillDir);
            fs.writeFileSync(path.join(skillDir, 'cskill.md'), '# Readable Skill\n\n## Summary\nA test skill');
            fs.writeFileSync(path.join(skillDir, '.specs.md'), '# Specs for Readable Skill\n\n- Must handle errors gracefully');

            const mockAgent = createMockAgent({
                startDir: tempDir,
                skillCatalog: new Map([
                    ['ReadableSpecsSkill', {
                        name: 'ReadableSpecsSkill',
                        skillDir,
                        filePath: path.join(skillDir, 'cskill.md'),
                        type: 'cskill',
                    }],
                ]),
            });

            const result = await readSkillAction(mockAgent, 'ReadableSpecsSkill');

            assert.ok(result.includes('Readable Skill'), 'Should include skill content');
            assert.ok(result.includes('.specs.md'), 'Should indicate specs file');
            assert.ok(result.includes('Must handle errors gracefully'), 'Should include specs content');
        });

        it('should work normally when no .specs.md exists for read-skill', async () => {
            const readModule = await import('../src/.AchillesSkills/read-skill/read-skill.mjs');
            const readSkillAction = readModule.action;

            const skillDir = path.join(skillsDir, 'NoSpecsReadableSkill');
            fs.mkdirSync(skillDir);
            fs.writeFileSync(path.join(skillDir, 'cskill.md'), '# No Specs Skill\n\n## Summary\nA skill without specs');

            const mockAgent = createMockAgent({
                startDir: tempDir,
                skillCatalog: new Map([
                    ['NoSpecsReadableSkill', {
                        name: 'NoSpecsReadableSkill',
                        skillDir,
                        filePath: path.join(skillDir, 'cskill.md'),
                        type: 'cskill',
                    }],
                ]),
            });

            const result = await readSkillAction(mockAgent, 'NoSpecsReadableSkill');

            assert.ok(result.includes('No Specs Skill'), 'Should include skill content');
            assert.ok(!result.includes('.specs.md'), 'Should not mention specs file');
        });
    });
});
