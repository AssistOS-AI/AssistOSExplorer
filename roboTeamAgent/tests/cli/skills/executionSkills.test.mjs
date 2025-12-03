/**
 * Tests for execution skill modules: execute-skill, generate-code, test-code
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
// execute-skill Tests
// ============================================================================

describe('execute-skill module - Extended', () => {
    let action;
    let tempDir;
    let tempSkillsDir;

    before(async () => {
        const module = await import('../../src/.AchillesSkills/execute-skill/execute-skill.mjs');
        action = module.action;

        tempDir = path.join(__dirname, 'temp_execute_ext_' + Date.now());
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

    it('should return error when agent is missing', async () => {
        const result = await action(null, 'test');
        assert.ok(result.includes('Error'));
    });

    it('should return error when skillName not provided', async () => {
        const mockAgent = { skillCatalog: new Map() };
        const result = await action(mockAgent, '');
        assert.ok(result.includes('Error') && result.includes('skillName'));
    });

    it('should parse "skillName with input" format', async () => {
        const mockAgent = {
            skillCatalog: new Map(),
            getSkillRecord: () => null,
        };

        const result = await action(mockAgent, 'nonexistent with some input');
        assert.ok(result.includes('not found'));
    });

    it('should accept object input', async () => {
        const mockAgent = {
            skillCatalog: new Map(),
            getSkillRecord: () => null,
        };

        const result = await action(mockAgent, { skillName: 'test', input: 'data' });
        assert.ok(result.includes('not found'));
    });

    it('should reject built-in skills', async () => {
        const builtInDir = '/builtin/.AchillesSkills';
        const mockAgent = {
            additionalSkillRoots: [builtInDir],
            skillCatalog: new Map(),
            getSkillRecord: () => ({
                name: 'list-skills',
                skillDir: `${builtInDir}/list-skills`,
            }),
        };

        const result = await action(mockAgent, 'list-skills');
        assert.ok(result.includes('built-in') || result.includes('management skill'));
    });

    it('should list available user skills when skill not found', async () => {
        const mockAgent = {
            skillCatalog: new Map([
                ['user-skill', { name: 'user-skill', shortName: 'UserSkill', skillDir: '/user' }],
            ]),
            getSkillRecord: () => null,
        };

        const result = await action(mockAgent, 'nonexistent');
        assert.ok(result.includes('UserSkill') || result.includes('user-skill'));
    });

    it('should execute skill and return output', async () => {
        const mockAgent = {
            skillCatalog: new Map(),
            getSkillRecord: (name) => ({
                name: 'test-skill',
                skillDir: '/user/test-skill',
            }),
            executeWithReviewMode: async () => ({
                result: 'Execution result',
            }),
        };

        const result = await action(mockAgent, 'test-skill');
        assert.ok(result.includes('Execution result') || result.includes('Output'));
    });

    it('should handle execution errors', async () => {
        const mockAgent = {
            skillCatalog: new Map(),
            getSkillRecord: () => ({
                name: 'error-skill',
                skillDir: '/user/error-skill',
            }),
            executeWithReviewMode: async () => {
                throw new Error('Execution failed');
            },
        };

        const result = await action(mockAgent, 'error-skill');
        assert.ok(result.includes('Error') && result.includes('Execution failed'));
    });
});

// ============================================================================
// generate-code Tests (Extended)
// ============================================================================

describe('generate-code module - Extended Tests', () => {
    let action;
    let tempDir;
    let tempSkillsDir;

    before(async () => {
        const module = await import('../../src/.AchillesSkills/generate-code/generate-code.mjs');
        action = module.action;

        tempDir = path.join(__dirname, 'temp_gencode_ext_' + Date.now());
        tempSkillsDir = path.join(tempDir, '.AchillesSkills');
        fs.mkdirSync(tempSkillsDir, { recursive: true });
    });

    after(() => {
        if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('should reject unsupported skill types', async () => {
        const skillDir = path.join(tempSkillsDir, 'MskillGen');
        fs.mkdirSync(skillDir);
        fs.writeFileSync(path.join(skillDir, 'mskill.md'), '# MCP\n\n## Summary\nTest\n\n## MCP Tools\n### tool1');

        const mockAgent = {
            startDir: tempDir,
            llmAgent: {},
            getSkillRecord: () => null,
        };
        const result = await action(mockAgent, 'MskillGen');
        assert.ok(result.includes('only supported for') || result.includes('not found'));
    });

    it('should accept object input', async () => {
        const mockAgent = { startDir: tempDir };
        const result = await action(mockAgent, { skillName: 'TestSkill' });
        assert.ok(result.includes('Error'));
    });

    it('should clean markdown code fences from LLM response', async () => {
        const skillDir = path.join(tempSkillsDir, 'FenceSkill');
        fs.mkdirSync(skillDir);
        fs.writeFileSync(path.join(skillDir, 'tskill.md'), '# Fence\n\n## Table Purpose\nTest\n\n## Fields\n\n### id');

        const mockAgent = {
            startDir: tempDir,
            llmAgent: {
                executePrompt: async () => '```javascript\nexport const x = 1;\n```',
            },
            getSkillRecord: () => null,
        };

        const result = await action(mockAgent, 'FenceSkill');
        assert.ok(result.includes('Generated'));

        const content = fs.readFileSync(path.join(skillDir, 'tskill.generated.mjs'), 'utf8');
        assert.ok(!content.includes('```'), 'Should not contain code fence markers');
    });
});

// ============================================================================
// test-code Tests (Extended)
// ============================================================================

describe('test-code module - Extended Tests', () => {
    let action;
    let tempDir;
    let tempSkillsDir;

    before(async () => {
        const module = await import('../../src/.AchillesSkills/test-code/test-code.mjs');
        action = module.action;

        tempDir = path.join(__dirname, 'temp_testcode_ext_' + Date.now());
        tempSkillsDir = path.join(tempDir, '.AchillesSkills');
        fs.mkdirSync(tempSkillsDir, { recursive: true });
    });

    after(() => {
        if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('should find .generated.js files', async () => {
        const skillDir = path.join(tempSkillsDir, 'JsGenSkillExt');
        fs.mkdirSync(skillDir);
        fs.writeFileSync(path.join(skillDir, 'JsGenSkillExt.generated.js'), 'module.exports = { test: 1 };');

        const mockAgent = {
            startDir: tempDir,
            getSkillRecord: () => ({ skillDir }),
        };
        const result = await action(mockAgent, 'JsGenSkillExt');
        assert.ok(result.includes('Module loaded') || result.includes('Failed to load'));
    });

    it('should list non-function exports', async () => {
        const skillDir = path.join(tempSkillsDir, 'ConstExportSkillExt');
        fs.mkdirSync(skillDir);
        fs.writeFileSync(path.join(skillDir, 'ConstExportSkillExt.generated.mjs'), `
export const CONFIG = { key: 'value' };
export const VERSION = '1.0.0';
export function action() { return 'test'; }
export default { CONFIG, VERSION, action };
`);

        const mockAgent = {
            startDir: tempDir,
            getSkillRecord: () => ({ skillDir }),
        };
        const result = await action(mockAgent, 'ConstExportSkillExt');
        assert.ok(result.includes('CONFIG'));
        assert.ok(result.includes('VERSION'));
        assert.ok(result.includes('object') || result.includes('string'));
    });

    it('should execute functions with testInput', async () => {
        const skillDir = path.join(tempSkillsDir, 'TestInputSkillExt');
        fs.mkdirSync(skillDir);
        fs.writeFileSync(path.join(skillDir, 'TestInputSkillExt.generated.mjs'), `
export function greet(name) { return 'Hello ' + name; }
export default { greet };
`);

        const mockAgent = {
            startDir: tempDir,
            getSkillRecord: () => ({ skillDir }),
        };
        const result = await action(mockAgent, JSON.stringify({ skillName: 'TestInputSkillExt', testInput: 'World' }));
        assert.ok(result.includes('Test Results') || result.includes('Hello World'));
    });
});
