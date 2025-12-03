/**
 * Tests for CRUD skill modules: list-skills, read-skill, write-skill, delete-skill
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
// list-skills Tests
// ============================================================================

describe('list-skills module - Extended Tests', () => {
    let action;

    before(async () => {
        const module = await import('../../src/.AchillesSkills/list-skills/list-skills.mjs');
        action = module.action;
    });

    it('should filter skills by type', async () => {
        const mockAgent = {
            startDir: '/tmp',
            skillCatalog: new Map([
                ['code-skill', { name: 'code-skill', type: 'code', shortName: 'CodeSkill', descriptor: { summary: 'Code' }, skillDir: '/test' }],
                ['orch-skill', { name: 'orch-skill', type: 'orchestrator', shortName: 'OrchSkill', descriptor: { summary: 'Orch' }, skillDir: '/test' }],
                ['db-skill', { name: 'db-skill', type: 'dbtable', shortName: 'DbSkill', descriptor: { summary: 'DB' }, skillDir: '/test' }],
            ]),
        };

        const result = await action(mockAgent, 'code');
        assert.ok(result.includes('code-skill') || result.includes('CodeSkill'), 'Should include code skill');
        assert.ok(!result.includes('orch-skill'), 'Should not include orchestrator skill');
    });

    it('should handle filter with no matches', async () => {
        const mockAgent = {
            startDir: '/tmp',
            skillCatalog: new Map([
                ['code-skill', { name: 'code-skill', type: 'code', shortName: 'CodeSkill', descriptor: { summary: 'Code' }, skillDir: '/test' }],
            ]),
        };

        const result = await action(mockAgent, 'nonexistent');
        assert.ok(result.includes('No skills found matching'));
    });

    it('should accept object input with filter', async () => {
        const mockAgent = {
            startDir: '/tmp',
            skillCatalog: new Map([
                ['skill1', { name: 'skill1', type: 'code', shortName: 'Skill1', descriptor: { summary: 'S1' }, skillDir: '/test' }],
            ]),
        };

        const result = await action(mockAgent, { filter: 'code' });
        assert.ok(result.includes('skill1') || result.includes('Skill1'));
    });

    it('should include skill paths in output', async () => {
        const mockAgent = {
            startDir: '/tmp',
            skillCatalog: new Map([
                ['skill1', { name: 'skill1', type: 'code', shortName: 'Skill1', descriptor: { summary: 'S1' }, skillDir: '/path/to/skill' }],
            ]),
        };

        const result = await action(mockAgent, '');
        assert.ok(result.includes('Path:'), 'Should show path');
    });
});

// ============================================================================
// read-skill Tests
// ============================================================================

describe('read-skill module - Extended Tests', () => {
    let action;
    let tempDir;
    let tempSkillsDir;

    before(async () => {
        const module = await import('../../src/.AchillesSkills/read-skill/read-skill.mjs');
        action = module.action;

        tempDir = path.join(__dirname, 'temp_read_ext_' + Date.now());
        tempSkillsDir = path.join(tempDir, '.AchillesSkills');
        fs.mkdirSync(tempSkillsDir, { recursive: true });
    });

    after(() => {
        if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('should accept object input', async () => {
        const skillDir = path.join(tempSkillsDir, 'ObjectInputSkill');
        fs.mkdirSync(skillDir);
        fs.writeFileSync(path.join(skillDir, 'cskill.md'), '# Object Input\n\n## Summary\nTest');

        const mockAgent = {
            startDir: tempDir,
            getSkillRecord: () => ({
                skillDir,
                filePath: path.join(skillDir, 'cskill.md'),
                type: 'code',
            }),
        };

        const result = await action(mockAgent, { skillName: 'ObjectInputSkill' });
        assert.ok(result.includes('Object Input'));
    });

    it('should list available skills when skill not found', async () => {
        const skillDir = path.join(tempSkillsDir, 'ExistingSkill');
        fs.mkdirSync(skillDir, { recursive: true });
        fs.writeFileSync(path.join(skillDir, 'cskill.md'), '# Existing');

        const mockAgent = {
            startDir: tempDir,
            getSkillRecord: () => null,
        };

        const result = await action(mockAgent, 'NotFound');
        assert.ok(result.includes('Available skills') || result.includes('not found'));
    });

    it('should handle all skill file types', async () => {
        const TYPES = ['skill.md', 'cskill.md', 'iskill.md', 'oskill.md', 'mskill.md', 'tskill.md'];

        for (const fileName of TYPES) {
            const skillName = `Test${fileName.replace('.md', '')}Ext`;
            const skillDir = path.join(tempSkillsDir, skillName);
            fs.mkdirSync(skillDir, { recursive: true });
            fs.writeFileSync(path.join(skillDir, fileName), `# ${skillName}\n\nContent`);

            const mockAgent = {
                startDir: tempDir,
                getSkillRecord: () => null,
            };
            const result = await action(mockAgent, skillName);
            assert.ok(result.includes(skillName), `Should read ${fileName}`);
        }
    });
});

// ============================================================================
// write-skill Tests
// ============================================================================

describe('write-skill module - Extended Tests', () => {
    let action;
    let tempDir;
    let tempSkillsDir;

    before(async () => {
        const module = await import('../../src/.AchillesSkills/write-skill/write-skill.mjs');
        action = module.action;

        tempDir = path.join(__dirname, 'temp_write_ext_' + Date.now());
        tempSkillsDir = path.join(tempDir, '.AchillesSkills');
        fs.mkdirSync(tempSkillsDir, { recursive: true });
    });

    after(() => {
        if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('should handle skillsDir not configured', async () => {
        const mockAgent = { startDir: null };
        const result = await action(mockAgent, '{}');
        assert.ok(result.includes('Error'));
    });

    it('should warn for non-standard file names', async () => {
        const mockAgent = { startDir: tempDir };
        const input = JSON.stringify({
            skillName: 'WarnSkill',
            fileName: 'random.txt',
            content: 'content',
        });

        const result = await action(mockAgent, input);
        assert.ok(result.includes('Warning') || result.includes('not a standard'));
    });

    it('should allow .mjs files', async () => {
        const mockAgent = { startDir: tempDir };
        const input = JSON.stringify({
            skillName: 'MjsSkill',
            fileName: 'MjsSkill.mjs',
            content: 'export const test = 1;',
        });

        const result = await action(mockAgent, input);
        assert.ok(!result.includes('Warning'), 'Should not warn for .mjs files');
        assert.ok(fs.existsSync(path.join(tempSkillsDir, 'MjsSkill', 'MjsSkill.mjs')));
    });

    it('should update existing file', async () => {
        const skillDir = path.join(tempSkillsDir, 'UpdateSkillExt');
        fs.mkdirSync(skillDir, { recursive: true });
        fs.writeFileSync(path.join(skillDir, 'cskill.md'), 'Original');

        const mockAgent = { startDir: tempDir };
        const input = JSON.stringify({
            skillName: 'UpdateSkillExt',
            fileName: 'cskill.md',
            content: 'Updated',
        });

        const result = await action(mockAgent, input);
        assert.ok(result.includes('Updated'), 'Should indicate update');

        const content = fs.readFileSync(path.join(skillDir, 'cskill.md'), 'utf8');
        assert.equal(content, 'Updated');
    });

    it('should accept object input directly', async () => {
        const mockAgent = { startDir: tempDir };
        const result = await action(mockAgent, {
            skillName: 'DirectObjSkill',
            fileName: 'cskill.md',
            content: '# Direct Object',
        });

        assert.ok(result.includes('Created') || result.includes('Written'));
    });
});

// ============================================================================
// delete-skill Tests
// ============================================================================

describe('delete-skill module - Extended Tests', () => {
    let action;
    let tempDir;
    let tempSkillsDir;

    before(async () => {
        const module = await import('../../src/.AchillesSkills/delete-skill/delete-skill.mjs');
        action = module.action;

        tempDir = path.join(__dirname, 'temp_delete_ext_' + Date.now());
        tempSkillsDir = path.join(tempDir, '.AchillesSkills');
        fs.mkdirSync(tempSkillsDir, { recursive: true });
    });

    after(() => {
        if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('should handle skillsDir not configured', async () => {
        const mockAgent = { startDir: null };
        const result = await action(mockAgent, 'SomeSkill');
        assert.ok(result.includes('Error'));
    });

    it('should accept object input', async () => {
        const skillDir = path.join(tempSkillsDir, 'ObjDeleteSkill');
        fs.mkdirSync(skillDir);
        fs.writeFileSync(path.join(skillDir, 'cskill.md'), '# Delete Me');

        const mockAgent = { startDir: tempDir };
        const result = await action(mockAgent, { skillName: 'ObjDeleteSkill' });
        assert.ok(result.includes('Deleted'));
        assert.ok(!fs.existsSync(skillDir));
    });

    it('should list deleted files', async () => {
        const skillDir = path.join(tempSkillsDir, 'MultiFileSkill');
        fs.mkdirSync(skillDir);
        fs.writeFileSync(path.join(skillDir, 'cskill.md'), '# Skill');
        fs.writeFileSync(path.join(skillDir, 'helper.mjs'), 'export const x = 1;');

        const mockAgent = { startDir: tempDir };
        const result = await action(mockAgent, 'MultiFileSkill');
        assert.ok(result.includes('2 file(s)'));
    });
});
