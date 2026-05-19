/**
 * Tests for execution skill modules: execute-skill, generate-code, test-code
 *
 * Action signature convention: action({ mainAgent, promptText })
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
        const module = await import('../../achilles-cli/src/skills/execute-skill/src/index.mjs');
        action = module.action;

        tempDir = path.join(__dirname, 'temp_execute_ext_' + Date.now());
        tempSkillsDir = path.join(tempDir, 'skills');
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
        const result = await action({ mainAgent: null, promptText: 'test' });
        assert.ok(result.includes('Error'));
    });

    it('should return error when skillName not provided', async () => {
        const mockAgent = { skillCatalog: new Map() };
        const result = await action({ mainAgent: mockAgent, promptText: '' });
        assert.ok(result.includes('Error') && result.includes('skillName'));
    });

    it('should parse "skillName with input" format', async () => {
        const mockAgent = {
            skillCatalog: new Map(),
            getSkillRecord: () => null,
        };

        const result = await action({ mainAgent: mockAgent, promptText: 'nonexistent with some input' });
        assert.ok(result.includes('not found'));
    });

    it('should accept object input', async () => {
        const mockAgent = {
            skillCatalog: new Map(),
            getSkillRecord: () => null,
        };

        const result = await action({ mainAgent: mockAgent, promptText: { skillName: 'test', input: 'data' } });
        assert.ok(result.includes('not found'));
    });

    it('should reject built-in skills', async () => {
        const mockAgent = {
            skillCatalog: new Map(),
            getSkillRecord: () => ({
                name: 'list-skills',
                skillDir: '/builtin/skills/list-skills',
                isInternal: true,
            }),
        };

        const result = await action({ mainAgent: mockAgent, promptText: 'list-skills' });
        assert.ok(result.includes('built-in') || result.includes('management skill'));
    });

    it('should list available user skills when skill not found', async () => {
        const userSkills = [
            { name: 'user-skill', shortName: 'UserSkill', skillDir: '/user' },
        ];
        const mockAgent = {
            skillCatalog: new Map([['user-skill', userSkills[0]]]),
            getSkillRecord: () => null,
            getSkills: () => userSkills,
        };

        const result = await action({ mainAgent: mockAgent, promptText: 'nonexistent' });
        assert.ok(result.includes('UserSkill') || result.includes('user-skill'));
    });

    it('should execute skill and return output', async () => {
        const mockAgent = {
            skillCatalog: new Map(),
            getSkillRecord: (name) => ({
                name: 'test-skill',
                skillDir: '/user/test-skill',
            }),
            executeSkill: async () => ({
                result: 'Execution result',
            }),
        };

        const result = await action({ mainAgent: mockAgent, promptText: 'test-skill' });
        assert.ok(result.includes('Execution result') || result.includes('Output'));
    });

    it('should handle execution errors', async () => {
        const mockAgent = {
            skillCatalog: new Map(),
            getSkillRecord: () => ({
                name: 'error-skill',
                skillDir: '/user/error-skill',
            }),
            executeSkill: async () => {
                throw new Error('Execution failed');
            },
        };

        const result = await action({ mainAgent: mockAgent, promptText: 'error-skill' });
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
        const module = await import('../../achilles-cli/src/skills/generate-code/src/index.mjs');
        action = module.action;

        tempDir = path.join(__dirname, 'temp_gencode_ext_' + Date.now());
        tempSkillsDir = path.join(tempDir, 'skills');
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
        fs.writeFileSync(path.join(skillDir, 'mskill.md'), '# MCP\n\n## Summary\nTest\n\n## Allowed-Tools\n- tool1');

        const mockAgent = {
            startDir: tempDir,
            llmAgent: {},
            getSkillRecord: () => null,
        };
        const result = await action({ mainAgent: mockAgent, promptText: 'MskillGen' });
        assert.ok(result.includes('only supported for') || result.includes('not found'));
    });

    it('should accept object input', async () => {
        const mockAgent = { startDir: tempDir };
        const result = await action({ mainAgent: mockAgent, promptText: { skillName: 'TestSkill' } });
        assert.ok(result.includes('Error'));
    });

    it('should clean markdown code fences from LLM response', async () => {
        const skillDir = path.join(tempSkillsDir, 'FenceSkill');
        fs.mkdirSync(path.join(skillDir, 'src'), { recursive: true });
        const filePath = path.join(skillDir, 'tskill.md');
        fs.writeFileSync(filePath, '# Fence\n\n## Table Purpose\nTest\n\n## Fields\n\n### id');

        const mockAgent = {
            startDir: tempDir,
            llmAgent: {
                executePrompt: async () => '```javascript\nexport const x = 1;\n```',
            },
            getSkillRecord: (name) => name === 'FenceSkill'
                ? { name: 'FenceSkill', skillDir, filePath }
                : null,
        };

        const result = await action({ mainAgent: mockAgent, promptText: 'FenceSkill' });
        assert.ok(result.includes('Generated'));

        const content = fs.readFileSync(path.join(skillDir, 'src', 'tskill.generated.mjs'), 'utf8');
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
        const module = await import('../../achilles-cli/src/skills/test-code/src/index.mjs');
        action = module.action;

        tempDir = path.join(__dirname, 'temp_testcode_ext_' + Date.now());
        tempSkillsDir = path.join(tempDir, 'skills');
        fs.mkdirSync(tempSkillsDir, { recursive: true });
    });

    after(() => {
        if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('should find src/index.js files', async () => {
        const skillDir = path.join(tempSkillsDir, 'JsGenSkillExt');
        fs.mkdirSync(path.join(skillDir, 'src'), { recursive: true });
        fs.writeFileSync(path.join(skillDir, 'src', 'index.js'), 'export const test = 1;');

        const mockAgent = {
            startDir: tempDir,
            getSkillRecord: () => ({ skillDir }),
        };
        const result = await action({ mainAgent: mockAgent, promptText: 'JsGenSkillExt' });
        assert.ok(result.includes('Module loaded') || result.includes('Failed to load'));
    });

    it('should list non-function exports', async () => {
        const skillDir = path.join(tempSkillsDir, 'ConstExportSkillExt');
        fs.mkdirSync(path.join(skillDir, 'src'), { recursive: true });
        fs.writeFileSync(path.join(skillDir, 'src', 'index.mjs'), `
export const CONFIG = { key: 'value' };
export const VERSION = '1.0.0';
export function action() { return 'test'; }
export default { CONFIG, VERSION, action };
`);

        const mockAgent = {
            startDir: tempDir,
            getSkillRecord: () => ({ skillDir }),
        };
        const result = await action({ mainAgent: mockAgent, promptText: 'ConstExportSkillExt' });
        assert.ok(result.includes('CONFIG'));
        assert.ok(result.includes('VERSION'));
        assert.ok(result.includes('object') || result.includes('string'));
    });

    it('should execute functions with testInput', async () => {
        const skillDir = path.join(tempSkillsDir, 'TestInputSkillExt');
        fs.mkdirSync(path.join(skillDir, 'src'), { recursive: true });
        fs.writeFileSync(path.join(skillDir, 'src', 'index.mjs'), `
export function greet(name) { return 'Hello ' + name; }
export default { greet };
`);

        const mockAgent = {
            startDir: tempDir,
            getSkillRecord: () => ({ skillDir }),
        };
        const result = await action({ mainAgent: mockAgent, promptText: JSON.stringify({ skillName: 'TestInputSkillExt', testInput: 'World' }) });
        assert.ok(result.includes('Test Results') || result.includes('Hello World'));
    });
});
