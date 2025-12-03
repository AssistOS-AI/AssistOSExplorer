/**
 * Integration tests for skills - complete workflow testing
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
// Integration Tests
// ============================================================================

describe('Skills Integration - Complete Workflow', () => {
    let tempDir;
    let tempSkillsDir;
    let listAction, readAction, writeAction, validateAction, deleteAction;

    before(async () => {
        tempDir = path.join(__dirname, 'temp_integration_' + Date.now());
        tempSkillsDir = path.join(tempDir, '.AchillesSkills');
        fs.mkdirSync(tempSkillsDir, { recursive: true });

        const listModule = await import('../../src/.AchillesSkills/list-skills/list-skills.mjs');
        listAction = listModule.action;

        const readModule = await import('../../src/.AchillesSkills/read-skill/read-skill.mjs');
        readAction = readModule.action;

        const writeModule = await import('../../src/.AchillesSkills/write-skill/write-skill.mjs');
        writeAction = writeModule.action;

        const validateModule = await import('../../src/.AchillesSkills/validate-skill/validate-skill.mjs');
        validateAction = validateModule.action;

        const deleteModule = await import('../../src/.AchillesSkills/delete-skill/delete-skill.mjs');
        deleteAction = deleteModule.action;
    });

    after(() => {
        if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('should complete full create-read-validate-delete workflow', async () => {
        const mockAgent = {
            startDir: tempDir,
            skillCatalog: new Map(),
            getSkillRecord: () => ({
                skillDir: path.join(tempSkillsDir, 'WorkflowTestSkill'),
                filePath: path.join(tempSkillsDir, 'WorkflowTestSkill', 'cskill.md'),
            }),
        };

        // 1. Create skill
        const createResult = await writeAction(mockAgent, JSON.stringify({
            skillName: 'WorkflowTestSkill',
            fileName: 'cskill.md',
            content: '# Workflow Test\n\n## Summary\nTest skill for workflow\n\n## Prompt\nDo something\n\n## LLM Mode\nfast',
        }));
        assert.ok(createResult.includes('Created'), 'Should create skill');

        // 2. List skills (update catalog)
        mockAgent.skillCatalog = new Map([
            ['workflow-test-skill', {
                name: 'workflow-test-skill',
                type: 'code',
                shortName: 'WorkflowTestSkill',
                descriptor: { summary: 'Test skill for workflow' },
                skillDir: path.join(tempSkillsDir, 'WorkflowTestSkill'),
            }],
        ]);

        const listResult = await listAction(mockAgent, '');
        assert.ok(listResult.includes('WorkflowTestSkill') || listResult.includes('workflow-test-skill'));

        // 3. Read skill
        const readResult = await readAction(mockAgent, 'WorkflowTestSkill');
        assert.ok(readResult.includes('Workflow Test'));

        // 4. Validate skill
        const validateResult = await validateAction(mockAgent, 'WorkflowTestSkill');
        assert.ok(validateResult.includes('VALID') || validateResult.includes('Validation'));

        // 5. Delete skill
        const deleteResult = await deleteAction(mockAgent, 'WorkflowTestSkill');
        assert.ok(deleteResult.includes('Deleted'));
        assert.ok(!fs.existsSync(path.join(tempSkillsDir, 'WorkflowTestSkill')));
    });
});
