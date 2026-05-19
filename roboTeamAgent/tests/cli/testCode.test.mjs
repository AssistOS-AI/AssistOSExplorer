/**
 * Test Code Tests
 * Tests the test-code action for loading and validating generated code
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';

import {
    createMockAgent,
    createTempDir,
    cleanupTempDir,
} from './helpers/testHelpers.mjs';

describe('test-code Action Tests', () => {
    let tempDir;
    let skillsDir;
    let testCodeAction;

    before(async () => {
        const testModule = await import('../achilles-cli/src/skills/test-code/src/index.mjs');
        testCodeAction = testModule.action;

        // Setup temp directory with pre-generated code
        const dirs = createTempDir('temp_testcode');
        tempDir = dirs.tempDir;
        skillsDir = dirs.skillsDir;
    });

    after(() => {
        cleanupTempDir(tempDir);
    });

    describe('Error Handling', () => {
        it('should return error when skillName not provided', async () => {
            const mockAgent = createMockAgent({ startDir: tempDir });
            const result = await testCodeAction({ mainAgent: mockAgent, promptText: '' });
            assert.ok(result.includes('Error'), 'Should return error');
            assert.ok(result.includes('skillName'), 'Should mention skillName');
        });

        it('should return error when skill directory not found', async () => {
            const mockAgent = createMockAgent({ startDir: tempDir });
            const result = await testCodeAction({ mainAgent: mockAgent, promptText: 'NonExistentSkill' });
            assert.ok(result.includes('Error') || result.includes('not found'), 'Should return error');
        });

        it('should return error when no generated code exists', async () => {
            // Create skill dir without generated code
            const emptySkillDir = path.join(skillsDir, 'EmptySkill');
            fs.mkdirSync(emptySkillDir);
            fs.writeFileSync(path.join(emptySkillDir, 'cskill.md'), '# Empty\n## Summary\nTest');

            const mockAgent = createMockAgent({
                startDir: tempDir,
                skillCatalog: new Map([
                    ['EmptySkill', { name: 'EmptySkill', skillDir: emptySkillDir, type: 'cskill' }],
                ]),
            });
            const result = await testCodeAction({ mainAgent: mockAgent, promptText: 'EmptySkill' });
            assert.ok(result.includes('Error') || result.includes('No generated code'), 'Should return error');
        });
    });

    describe('tskill Code Testing', () => {
        it('should load and test tskill generated code', async () => {
            const skillDir = path.join(skillsDir, 'TskillTest');
            fs.mkdirSync(path.join(skillDir, 'src'), { recursive: true });

            // Create a valid generated module
            fs.writeFileSync(
                path.join(skillDir, 'src', 'tskill.generated.mjs'),
                `export function validator_name(value) {
    if (!value) return 'Name is required';
    return null;
}

export function presenter_name(value) {
    return value ? value.toUpperCase() : '';
}

export function validateRecord(record) {
    const errors = [];
    const nameErr = validator_name(record.name);
    if (nameErr) errors.push({ field: 'name', error: nameErr });
    return { valid: errors.length === 0, errors };
}

export default { validator_name, presenter_name, validateRecord };`
            );

            const mockAgent = createMockAgent({
                startDir: tempDir,
                skillCatalog: new Map([
                    ['TskillTest', { name: 'TskillTest', skillDir, type: 'tskill' }],
                ]),
            });
            const result = await testCodeAction({ mainAgent: mockAgent, promptText: 'TskillTest' });

            assert.ok(result.includes('Module loaded'), 'Should load module');
            assert.ok(result.includes('validator_name'), 'Should list validator function');
            assert.ok(result.includes('presenter_name'), 'Should list presenter function');
            assert.ok(result.includes('validateRecord'), 'Should list validateRecord function');
        });

        it('should execute tskill functions with test input', async () => {
            const mockAgent = createMockAgent({
                startDir: tempDir,
                skillCatalog: new Map([
                    ['TskillTest', { name: 'TskillTest', skillDir: path.join(skillsDir, 'TskillTest'), type: 'tskill' }],
                ]),
            });
            const result = await testCodeAction({ mainAgent: mockAgent, promptText: JSON.stringify({ skillName: 'TskillTest', testInput: { name: 'test' } }) });

            assert.ok(result.includes('Module loaded'), 'Should load module');
        });
    });

    describe('cskill Code Testing', () => {
        it('should load and test cskill generated code', async () => {
            const skillDir = path.join(skillsDir, 'CskillTest');
            fs.mkdirSync(path.join(skillDir, 'src'), { recursive: true });

            fs.writeFileSync(
                path.join(skillDir, 'src', 'index.mjs'),
                `export const specs = {
    name: 'CskillTest',
    description: 'Test code skill',
};

export async function action(invocation = {}) {
    return \`Processed: \${invocation.promptText || ''}\`;
}

export default { specs, action };`
            );

            const mockAgent = createMockAgent({
                startDir: tempDir,
                skillCatalog: new Map([
                    ['CskillTest', { name: 'CskillTest', skillDir, type: 'cskill' }],
                ]),
            });
            const result = await testCodeAction({ mainAgent: mockAgent, promptText: 'CskillTest' });

            assert.ok(result.includes('Module loaded'), 'Should load module');
            assert.ok(result.includes('specs'), 'Should list specs export');
            assert.ok(result.includes('action'), 'Should list action function');
        });
    });

    describe('Syntax Error Handling', () => {
        it('should handle syntax errors in generated code gracefully', async () => {
            const skillDir = path.join(skillsDir, 'SyntaxErrorSkill');
            fs.mkdirSync(path.join(skillDir, 'src'), { recursive: true });

            fs.writeFileSync(
                path.join(skillDir, 'src', 'index.mjs'),
                `export const specs = {
    name: 'BrokenSkill'
    // Missing comma - syntax error
    description: 'This will fail'
};`
            );

            const mockAgent = createMockAgent({
                startDir: tempDir,
                skillCatalog: new Map([
                    ['SyntaxErrorSkill', { name: 'SyntaxErrorSkill', skillDir, type: 'cskill' }],
                ]),
            });
            const result = await testCodeAction({ mainAgent: mockAgent, promptText: 'SyntaxErrorSkill' });

            assert.ok(result.includes('Failed to load') || result.includes('Error'), 'Should indicate load failure');
        });
    });
});
