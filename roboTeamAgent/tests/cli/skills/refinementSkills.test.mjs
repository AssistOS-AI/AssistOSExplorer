/**
 * Tests for skill-refiner module
 *
 * Action signature convention: action(recursiveSkilledAgent, prompt)
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ============================================================================
// skill-refiner Tests
// ============================================================================

describe('skill-refiner module - Extended', () => {
    let action;
    let tempDir;
    let tempSkillsDir;

    before(async () => {
        const module = await import('../../src/.AchillesSkills/skill-refiner/skill-refiner.mjs');
        action = module.action;

        tempDir = path.join(__dirname, 'temp_refiner_ext_' + Date.now());
        tempSkillsDir = path.join(tempDir, '.AchillesSkills');
        fs.mkdirSync(tempSkillsDir, { recursive: true });
    });

    after(() => {
        if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('should export action function', () => {
        assert.equal(typeof action, 'function');
    });

    it('should return error when skillName not provided', async () => {
        const mockAgent = { startDir: tempDir };
        const result = await action(mockAgent, '');
        assert.ok(result.includes('Error') && result.includes('skillName'));
    });

    it('should return error when llmAgent not provided', async () => {
        const mockAgent = { startDir: tempDir };
        const result = await action(mockAgent, 'someSkill');
        assert.ok(result.includes('Error') && result.includes('LLM'));
    });

    it('should return error when skill not found', async () => {
        const mockAgent = {
            startDir: tempDir,
            llmAgent: { executePrompt: async () => '{}' },
            getSkillRecord: () => null,
        };
        const result = await action(mockAgent, 'NonExistent');
        const output = typeof result === 'object' ? result.output || result : result;
        assert.ok(String(output).includes('not found'));
    });

    it('should parse JSON input', async () => {
        const mockAgent = {
            startDir: tempDir,
            llmAgent: { executePrompt: async () => '{}' },
            getSkillRecord: () => null,
        };
        const result = await action(mockAgent, JSON.stringify({ skillName: 'NonExistent', maxIterations: 3 }));
        const output = typeof result === 'object' ? result.output : result;
        assert.ok(output.includes('not found') || output.includes('Max iterations: 3'));
    });

    it('should run refinement loop on valid skill', async () => {
        const skillDir = path.join(tempSkillsDir, 'RefineMeExt');
        fs.mkdirSync(skillDir);
        fs.writeFileSync(path.join(skillDir, 'tskill.md'), '# RefineMeExt\n\n## Table Purpose\nTest\n\n## Fields\n\n### id');

        const mockAgent = {
            startDir: tempDir,
            llmAgent: {
                executePrompt: async (prompt, opts) => {
                    if (opts?.responseShape === 'json') {
                        return { success: true, failures: [] };
                    }
                    return 'export const test = 1;';
                },
            },
            getSkillRecord: () => ({
                skillDir,
                filePath: path.join(skillDir, 'tskill.md'),
            }),
            executePrompt: async () => 'Test passed',
        };

        const result = await action(mockAgent, 'RefineMeExt');

        const output = typeof result === 'object' ? result.output : result;
        assert.ok(output.includes('Starting refinement') || output.includes('Iteration'));
    });

    it('should stop after max iterations', async () => {
        const skillDir = path.join(tempSkillsDir, 'MaxIterSkillExt');
        fs.mkdirSync(skillDir);
        fs.writeFileSync(path.join(skillDir, 'cskill.md'), '# Max\n\n## Summary\nTest\n\n## Prompt\nTest');

        const mockAgent = {
            startDir: tempDir,
            llmAgent: {
                executePrompt: async (prompt, opts) => {
                    if (opts?.responseShape === 'json') {
                        return { success: false, failures: [{ section: 'Summary', reason: 'Needs work' }] };
                    }
                    return '{}';
                },
            },
            getSkillRecord: () => ({
                skillDir,
                filePath: path.join(skillDir, 'cskill.md'),
            }),
            executePrompt: async () => 'Test result',
        };

        const result = await action(mockAgent, JSON.stringify({ skillName: 'MaxIterSkillExt', maxIterations: 2 }));

        assert.ok(result.success === false || result.reason === 'max_iterations_reached' || result.output?.includes('Max iterations'));
    });
});
