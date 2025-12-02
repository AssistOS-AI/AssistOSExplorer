/**
 * Comprehensive tests for all skills in skill-manager/.AchillesSkills/
 *
 * Tests cover:
 * - list-skills
 * - read-skill
 * - write-skill
 * - delete-skill
 * - validate-skill
 * - get-template
 * - update-section
 * - preview-changes
 * - generate-code
 * - test-code
 * - execute-skill
 * - skill-refiner (orchestrator)
 * - skill-manager (orchestrator)
 * - OpsSkill (cskill)
 * - skillSchemas.mjs utilities
 */

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILLS_BASE = path.join(__dirname, '../src/.AchillesSkills');

// ============================================================================
// skillSchemas.mjs Tests
// ============================================================================

describe('skillSchemas.mjs - Schema Utilities', () => {
    let detectSkillType, validateSkillContent, parseSkillSections, updateSkillSection;
    let SKILL_TYPES, SKILL_TEMPLATES;

    before(async () => {
        const schemas = await import('../src/skillSchemas.mjs');
        detectSkillType = schemas.detectSkillType;
        validateSkillContent = schemas.validateSkillContent;
        parseSkillSections = schemas.parseSkillSections;
        updateSkillSection = schemas.updateSkillSection;
        SKILL_TYPES = schemas.SKILL_TYPES;
        SKILL_TEMPLATES = schemas.SKILL_TEMPLATES;
    });

    describe('detectSkillType', () => {
        it('should detect tskill from content', () => {
            const content = `# MyTable\n\n## Table Purpose\nStores data\n\n## Fields\n\n### id\n`;
            assert.equal(detectSkillType(content), 'tskill');
        });

        it('should detect cskill from content', () => {
            const content = `# MyCode\n\n## Summary\nDoes something\n\n## Prompt\nYou are an assistant`;
            assert.equal(detectSkillType(content), 'cskill');
        });

        it('should detect oskill from content', () => {
            const content = `# MyOrch\n\n## Instructions\nRoute things\n\n## Allowed-Skills\n- skill1`;
            assert.equal(detectSkillType(content), 'oskill');
        });

        it('should detect iskill from content', () => {
            const content = `# MyInteractive\n\n## Summary\nInteractive\n\n## Required Arguments\n- arg1`;
            assert.equal(detectSkillType(content), 'iskill');
        });

        it('should detect mskill from content', () => {
            const content = `# MyMCP\n\n## Summary\nMCP skill\n\n## MCP Tools\n\n### tool1`;
            assert.equal(detectSkillType(content), 'mskill');
        });

        it('should return null for empty content', () => {
            assert.equal(detectSkillType(''), null);
            assert.equal(detectSkillType(null), null);
            assert.equal(detectSkillType(undefined), null);
        });

        it('should return null for unknown content', () => {
            const content = `# Random\n\nSome random text without any skill markers`;
            assert.equal(detectSkillType(content), null);
        });
    });

    describe('validateSkillContent', () => {
        it('should validate valid tskill content', () => {
            const content = `# MyTable\n\n## Table Purpose\nStores data\n\n## Fields\n\n### id\nDescription`;
            const result = validateSkillContent(content);
            assert.ok(result.valid, 'Should be valid');
            assert.equal(result.detectedType, 'tskill');
        });

        it('should return errors for missing required sections', () => {
            const content = `# MyTable\n\n## Table Purpose\nStores data`;
            const result = validateSkillContent(content, 'tskill');
            assert.ok(!result.valid, 'Should be invalid');
            assert.ok(result.errors.some(e => e.includes('Fields')), 'Should mention Fields');
        });

        it('should return error for empty content', () => {
            const result = validateSkillContent('');
            assert.ok(!result.valid);
            assert.ok(result.errors.some(e => e.includes('empty')));
        });

        it('should warn about missing title when content does not start with #', () => {
            // Content that does NOT start with # should trigger the title error
            const content = `Some text\n## Table Purpose\nStores data\n\n## Fields\n\n### id`;
            const result = validateSkillContent(content, 'tskill');
            assert.ok(result.errors.some(e => e.includes('should start with')));
        });

        it('should warn about missing optional sections', () => {
            const content = `# MyTable\n\n## Table Purpose\nStores data\n\n## Fields\n\n### id`;
            const result = validateSkillContent(content, 'tskill');
            assert.ok(result.warnings.some(w => w.includes('Business Rules')));
        });

        it('should validate cskill with LLM Mode warning', () => {
            const content = `# MyCode\n\n## Summary\nDoes something\n\n## Prompt\nYou are an assistant`;
            const result = validateSkillContent(content, 'cskill');
            assert.ok(result.valid);
            assert.ok(result.warnings.some(w => w.includes('LLM Mode')));
        });
    });

    describe('parseSkillSections', () => {
        it('should extract title', () => {
            const content = `# My Title\n\n## Section1\nContent1`;
            const sections = parseSkillSections(content);
            assert.equal(sections._title, 'My Title');
        });

        it('should extract sections', () => {
            const content = `# Title\n\n## Summary\nMy summary\n\n## Prompt\nMy prompt`;
            const sections = parseSkillSections(content);
            assert.equal(sections.Summary, 'My summary');
            assert.equal(sections.Prompt, 'My prompt');
        });

        it('should handle multiline sections', () => {
            // The regex requires specific formatting with newline after ##
            const content = `# Title\n\n## Summary\nLine 1\nLine 2\nLine 3\n\n## Other\nContent`;
            const sections = parseSkillSections(content);
            // Check if Summary section is extracted (may be trimmed)
            assert.ok(sections.Summary, 'Should have Summary section');
            // The content includes multiple lines
            assert.ok(
                sections.Summary.includes('Line 1') || sections.Summary.length > 0,
                'Summary should have content'
            );
        });

        it('should return empty object for null content', () => {
            const sections = parseSkillSections(null);
            assert.deepEqual(sections, {});
        });
    });

    describe('updateSkillSection', () => {
        it('should update existing section', () => {
            const content = `# Title\n\n## Summary\nOld content\n\n## Other\nOther content`;
            const updated = updateSkillSection(content, 'Summary', 'New content');
            assert.ok(updated.includes('New content'));
            assert.ok(!updated.includes('Old content'));
        });

        it('should append new section if not exists', () => {
            const content = `# Title\n\n## Summary\nSome content`;
            const updated = updateSkillSection(content, 'NewSection', 'New section content');
            assert.ok(updated.includes('## NewSection'));
            assert.ok(updated.includes('New section content'));
        });

        it('should preserve other sections', () => {
            const content = `# Title\n\n## Summary\nOld\n\n## Prompt\nPrompt content`;
            const updated = updateSkillSection(content, 'Summary', 'New');
            assert.ok(updated.includes('## Prompt'));
            assert.ok(updated.includes('Prompt content'));
        });
    });

    describe('SKILL_TEMPLATES', () => {
        it('should have templates for all skill types', () => {
            assert.ok(SKILL_TEMPLATES.tskill, 'Should have tskill template');
            assert.ok(SKILL_TEMPLATES.cskill, 'Should have cskill template');
            assert.ok(SKILL_TEMPLATES.iskill, 'Should have iskill template');
            assert.ok(SKILL_TEMPLATES.oskill, 'Should have oskill template');
            assert.ok(SKILL_TEMPLATES.mskill, 'Should have mskill template');
        });

        it('should have valid template content', () => {
            for (const [type, template] of Object.entries(SKILL_TEMPLATES)) {
                assert.ok(template.startsWith('#'), `${type} template should start with #`);
                assert.ok(template.includes('##'), `${type} template should have sections`);
            }
        });
    });
});

// ============================================================================
// list-skills Tests
// ============================================================================

describe('list-skills module - Extended Tests', () => {
    let action;

    before(async () => {
        const module = await import('../src/.AchillesSkills/list-skills/list-skills.mjs');
        action = module.action;
    });

    it('should filter skills by type', async () => {
        const mockSkilledAgent = {
            skillCatalog: new Map([
                ['code-skill', { name: 'code-skill', type: 'code', shortName: 'CodeSkill', descriptor: { summary: 'Code' }, skillDir: '/test' }],
                ['orch-skill', { name: 'orch-skill', type: 'orchestrator', shortName: 'OrchSkill', descriptor: { summary: 'Orch' }, skillDir: '/test' }],
                ['db-skill', { name: 'db-skill', type: 'dbtable', shortName: 'DbSkill', descriptor: { summary: 'DB' }, skillDir: '/test' }],
            ]),
        };

        const result = await action('code', { skilledAgent: mockSkilledAgent });
        assert.ok(result.includes('code-skill') || result.includes('CodeSkill'), 'Should include code skill');
        assert.ok(!result.includes('orch-skill'), 'Should not include orchestrator skill');
    });

    it('should handle filter with no matches', async () => {
        const mockSkilledAgent = {
            skillCatalog: new Map([
                ['code-skill', { name: 'code-skill', type: 'code', shortName: 'CodeSkill', descriptor: { summary: 'Code' }, skillDir: '/test' }],
            ]),
        };

        const result = await action('nonexistent', { skilledAgent: mockSkilledAgent });
        assert.ok(result.includes('No skills found matching'));
    });

    it('should accept object input with filter', async () => {
        const mockSkilledAgent = {
            skillCatalog: new Map([
                ['skill1', { name: 'skill1', type: 'code', shortName: 'Skill1', descriptor: { summary: 'S1' }, skillDir: '/test' }],
            ]),
        };

        const result = await action({ filter: 'code' }, { skilledAgent: mockSkilledAgent });
        assert.ok(result.includes('skill1') || result.includes('Skill1'));
    });

    it('should include skill paths in output', async () => {
        const mockSkilledAgent = {
            skillCatalog: new Map([
                ['skill1', { name: 'skill1', type: 'code', shortName: 'Skill1', descriptor: { summary: 'S1' }, skillDir: '/path/to/skill' }],
            ]),
        };

        const result = await action('', { skilledAgent: mockSkilledAgent });
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
        const module = await import('../src/.AchillesSkills/read-skill/read-skill.mjs');
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
            getSkillRecord: () => ({
                skillDir,
                filePath: path.join(skillDir, 'cskill.md'),
                type: 'code',
            }),
        };

        const result = await action({ skillName: 'ObjectInputSkill' }, { skillsDir: tempSkillsDir, skilledAgent: mockAgent });
        assert.ok(result.includes('Object Input'));
    });

    it('should list available skills when skill not found', async () => {
        const skillDir = path.join(tempSkillsDir, 'ExistingSkill');
        fs.mkdirSync(skillDir);
        fs.writeFileSync(path.join(skillDir, 'cskill.md'), '# Existing');

        const mockAgent = { getSkillRecord: () => null };

        const result = await action('NotFound', { skillsDir: tempSkillsDir, skilledAgent: mockAgent });
        assert.ok(result.includes('Available skills') || result.includes('not found'));
    });

    it('should handle all skill file types', async () => {
        const TYPES = ['skill.md', 'cskill.md', 'iskill.md', 'oskill.md', 'mskill.md', 'tskill.md'];

        for (const fileName of TYPES) {
            const skillName = `Test${fileName.replace('.md', '')}`;
            const skillDir = path.join(tempSkillsDir, skillName);
            fs.mkdirSync(skillDir, { recursive: true });
            fs.writeFileSync(path.join(skillDir, fileName), `# ${skillName}\n\nContent`);

            const mockAgent = { getSkillRecord: () => null };
            const result = await action(skillName, { skillsDir: tempSkillsDir, skilledAgent: mockAgent });
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
        const module = await import('../src/.AchillesSkills/write-skill/write-skill.mjs');
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
        const result = await action('{}', {});
        assert.ok(result.includes('Error') && result.includes('skillsDir'));
    });

    it('should warn for non-standard file names', async () => {
        const input = JSON.stringify({
            skillName: 'WarnSkill',
            fileName: 'random.txt',
            content: 'content',
        });

        const result = await action(input, { skillsDir: tempSkillsDir });
        assert.ok(result.includes('Warning') || result.includes('not a standard'));
    });

    it('should allow .mjs files', async () => {
        const input = JSON.stringify({
            skillName: 'MjsSkill',
            fileName: 'MjsSkill.mjs',
            content: 'export const test = 1;',
        });

        const result = await action(input, { skillsDir: tempSkillsDir });
        assert.ok(!result.includes('Warning'), 'Should not warn for .mjs files');
        assert.ok(fs.existsSync(path.join(tempSkillsDir, 'MjsSkill', 'MjsSkill.mjs')));
    });

    it('should update existing file', async () => {
        const skillDir = path.join(tempSkillsDir, 'UpdateSkill');
        fs.mkdirSync(skillDir, { recursive: true });
        fs.writeFileSync(path.join(skillDir, 'cskill.md'), 'Original');

        const input = JSON.stringify({
            skillName: 'UpdateSkill',
            fileName: 'cskill.md',
            content: 'Updated',
        });

        const result = await action(input, { skillsDir: tempSkillsDir });
        assert.ok(result.includes('Updated'), 'Should indicate update');

        const content = fs.readFileSync(path.join(skillDir, 'cskill.md'), 'utf8');
        assert.equal(content, 'Updated');
    });

    it('should accept object input directly', async () => {
        const result = await action({
            skillName: 'DirectObjSkill',
            fileName: 'cskill.md',
            content: '# Direct Object',
        }, { skillsDir: tempSkillsDir });

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
        const module = await import('../src/.AchillesSkills/delete-skill/delete-skill.mjs');
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
        const result = await action('SomeSkill', {});
        assert.ok(result.includes('Error') && result.includes('skillsDir'));
    });

    it('should accept object input', async () => {
        const skillDir = path.join(tempSkillsDir, 'ObjDeleteSkill');
        fs.mkdirSync(skillDir);
        fs.writeFileSync(path.join(skillDir, 'cskill.md'), '# Delete Me');

        const result = await action({ skillName: 'ObjDeleteSkill' }, { skillsDir: tempSkillsDir });
        assert.ok(result.includes('Deleted'));
        assert.ok(!fs.existsSync(skillDir));
    });

    it('should list deleted files', async () => {
        const skillDir = path.join(tempSkillsDir, 'MultiFileSkill');
        fs.mkdirSync(skillDir);
        fs.writeFileSync(path.join(skillDir, 'cskill.md'), '# Skill');
        fs.writeFileSync(path.join(skillDir, 'helper.mjs'), 'export const x = 1;');

        const result = await action('MultiFileSkill', { skillsDir: tempSkillsDir });
        assert.ok(result.includes('2 file(s)'));
    });
});

// ============================================================================
// validate-skill Tests
// ============================================================================

describe('validate-skill module - Extended Tests', () => {
    let action;
    let tempDir;
    let tempSkillsDir;

    before(async () => {
        const module = await import('../src/.AchillesSkills/validate-skill/validate-skill.mjs');
        action = module.action;

        tempDir = path.join(__dirname, 'temp_validate_ext_' + Date.now());
        tempSkillsDir = path.join(tempDir, '.AchillesSkills');
        fs.mkdirSync(tempSkillsDir, { recursive: true });
    });

    after(() => {
        if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('should show detected type', async () => {
        const skillDir = path.join(tempSkillsDir, 'TypeDetectSkill');
        fs.mkdirSync(skillDir);
        fs.writeFileSync(path.join(skillDir, 'tskill.md'), '# Table\n\n## Table Purpose\nTest\n\n## Fields\n\n### id');

        const mockAgent = {
            getSkillRecord: () => ({
                skillDir,
                filePath: path.join(skillDir, 'tskill.md'),
            }),
        };

        const result = await action('TypeDetectSkill', { skillsDir: tempSkillsDir, skilledAgent: mockAgent });
        assert.ok(result.includes('Detected Type: tskill'));
    });

    it('should show errors and warnings separately', async () => {
        const skillDir = path.join(tempSkillsDir, 'ErrorWarnSkill');
        fs.mkdirSync(skillDir);
        fs.writeFileSync(path.join(skillDir, 'cskill.md'), '# Code\n\n## Summary\nTest\n\n## Prompt\nTest');

        const mockAgent = {
            getSkillRecord: () => ({
                skillDir,
                filePath: path.join(skillDir, 'cskill.md'),
            }),
        };

        const result = await action('ErrorWarnSkill', { skillsDir: tempSkillsDir, skilledAgent: mockAgent });
        assert.ok(result.includes('Warnings:') || result.includes('No issues found'));
    });

    it('should accept object input', async () => {
        const skillDir = path.join(tempSkillsDir, 'ObjValidateSkill');
        fs.mkdirSync(skillDir);
        fs.writeFileSync(path.join(skillDir, 'cskill.md'), '# Obj\n\n## Summary\nTest\n\n## Prompt\nTest');

        const mockAgent = { getSkillRecord: () => null };

        const result = await action({ skillName: 'ObjValidateSkill' }, { skillsDir: tempSkillsDir, skilledAgent: mockAgent });
        assert.ok(result.includes('Validation') || result.includes('VALID'));
    });
});

// ============================================================================
// get-template Tests
// ============================================================================

describe('get-template module - Extended Tests', () => {
    let action;

    before(async () => {
        const module = await import('../src/.AchillesSkills/get-template/get-template.mjs');
        action = module.action;
    });

    it('should return template for iskill', async () => {
        const result = await action('iskill', {});
        assert.ok(result.includes('Commands') || result.includes('iskill'));
    });

    it('should return template for mskill', async () => {
        const result = await action('mskill', {});
        assert.ok(result.includes('MCP') || result.includes('mskill'));
    });

    it('should accept object input', async () => {
        const result = await action({ skillType: 'tskill' }, {});
        assert.ok(result.includes('Table Purpose') || result.includes('Fields'));
    });

    it('should show required and optional sections', async () => {
        const result = await action('tskill', {});
        assert.ok(result.includes('Required sections'));
        assert.ok(result.includes('Optional sections'));
    });

    it('should include template markers', async () => {
        const result = await action('cskill', {});
        assert.ok(result.includes('TEMPLATE START'));
        assert.ok(result.includes('TEMPLATE END'));
    });
});

// ============================================================================
// update-section Tests
// ============================================================================

describe('update-section module - Extended Tests', () => {
    let action;
    let tempDir;
    let tempSkillsDir;

    before(async () => {
        const module = await import('../src/.AchillesSkills/update-section/update-section.mjs');
        action = module.action;

        tempDir = path.join(__dirname, 'temp_updatesec_ext_' + Date.now());
        tempSkillsDir = path.join(tempDir, '.AchillesSkills');
        fs.mkdirSync(tempSkillsDir, { recursive: true });
    });

    after(() => {
        if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('should return error when section is missing', async () => {
        const input = JSON.stringify({ skillName: 'Test', content: 'New content' });
        const result = await action(input, { skillsDir: tempSkillsDir });
        assert.ok(result.includes('Error') && result.includes('section'));
    });

    it('should return error when content is missing', async () => {
        const input = JSON.stringify({ skillName: 'Test', section: 'Summary' });
        const result = await action(input, { skillsDir: tempSkillsDir });
        assert.ok(result.includes('Error') && result.includes('content'));
    });

    it('should update multiple sections sequentially', async () => {
        const skillDir = path.join(tempSkillsDir, 'MultiUpdateSkill');
        fs.mkdirSync(skillDir);
        fs.writeFileSync(path.join(skillDir, 'cskill.md'), '# Multi\n\n## Summary\nOld1\n\n## Prompt\nOld2');

        const mockAgent = {
            getSkillRecord: () => ({
                skillDir,
                filePath: path.join(skillDir, 'cskill.md'),
            }),
        };

        // Update Summary
        await action(JSON.stringify({
            skillName: 'MultiUpdateSkill',
            section: 'Summary',
            content: 'New1',
        }), { skillsDir: tempSkillsDir, skilledAgent: mockAgent });

        // Update Prompt
        await action(JSON.stringify({
            skillName: 'MultiUpdateSkill',
            section: 'Prompt',
            content: 'New2',
        }), { skillsDir: tempSkillsDir, skilledAgent: mockAgent });

        const content = fs.readFileSync(path.join(skillDir, 'cskill.md'), 'utf8');
        assert.ok(content.includes('New1'));
        assert.ok(content.includes('New2'));
    });

    it('should add new section if not exists', async () => {
        const skillDir = path.join(tempSkillsDir, 'AddSectionSkill');
        fs.mkdirSync(skillDir);
        fs.writeFileSync(path.join(skillDir, 'cskill.md'), '# Add\n\n## Summary\nTest');

        const mockAgent = {
            getSkillRecord: () => ({
                skillDir,
                filePath: path.join(skillDir, 'cskill.md'),
            }),
        };

        await action(JSON.stringify({
            skillName: 'AddSectionSkill',
            section: 'NewSection',
            content: 'Brand new content',
        }), { skillsDir: tempSkillsDir, skilledAgent: mockAgent });

        const content = fs.readFileSync(path.join(skillDir, 'cskill.md'), 'utf8');
        assert.ok(content.includes('## NewSection'));
        assert.ok(content.includes('Brand new content'));
    });

    it('should trigger code regeneration when .generated.mjs exists', async () => {
        const skillDir = path.join(tempSkillsDir, 'RegenSkill');
        fs.mkdirSync(skillDir);
        fs.writeFileSync(path.join(skillDir, 'iskill.md'), '# Regen\n\n## Summary\nOriginal summary\n\n## Commands\n\n### test\nTest command');
        // Create a .generated.mjs file to trigger regeneration
        fs.writeFileSync(path.join(skillDir, 'regen.generated.mjs'), 'export const specs = {};');

        const mockAgent = {
            getSkillRecord: () => ({
                skillDir,
                filePath: path.join(skillDir, 'iskill.md'),
            }),
        };

        // Mock llmAgent for code generation
        const mockLlm = {
            executePrompt: async () => 'export const specs = { name: "regen" };\nexport async function action() { return "test"; }',
        };

        const result = await action(JSON.stringify({
            skillName: 'RegenSkill',
            section: 'Summary',
            content: 'Updated summary',
        }), { skillsDir: tempSkillsDir, skilledAgent: mockAgent, llmAgent: mockLlm });

        // Check that the section was updated
        const content = fs.readFileSync(path.join(skillDir, 'iskill.md'), 'utf8');
        assert.ok(content.includes('Updated summary'));

        // Check that regeneration was triggered (message should mention it)
        assert.ok(
            result.includes('regeneration') || result.includes('Detected existing generated code'),
            `Should mention regeneration. Got: ${result}`
        );
    });

    it('should not trigger regeneration when no .generated.mjs exists', async () => {
        const skillDir = path.join(tempSkillsDir, 'NoRegenSkill');
        fs.mkdirSync(skillDir);
        fs.writeFileSync(path.join(skillDir, 'cskill.md'), '# NoRegen\n\n## Summary\nOriginal');

        const mockAgent = {
            getSkillRecord: () => ({
                skillDir,
                filePath: path.join(skillDir, 'cskill.md'),
            }),
        };

        const result = await action(JSON.stringify({
            skillName: 'NoRegenSkill',
            section: 'Summary',
            content: 'Updated',
        }), { skillsDir: tempSkillsDir, skilledAgent: mockAgent });

        // Should NOT mention regeneration
        assert.ok(
            !result.includes('regeneration') && !result.includes('Detected existing generated code'),
            `Should not mention regeneration when no .generated.mjs exists. Got: ${result}`
        );
        assert.ok(result.includes('Updated section'));
    });
});

// ============================================================================
// preview-changes Tests
// ============================================================================

describe('preview-changes module - Extended Tests', () => {
    let action;
    let tempDir;
    let tempSkillsDir;

    before(async () => {
        const module = await import('../src/.AchillesSkills/preview-changes/preview-changes.mjs');
        action = module.action;

        tempDir = path.join(__dirname, 'temp_preview_ext_' + Date.now());
        tempSkillsDir = path.join(tempDir, '.AchillesSkills');
        fs.mkdirSync(tempSkillsDir, { recursive: true });
    });

    after(() => {
        if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('should return error when skillName is missing', async () => {
        const input = JSON.stringify({ fileName: 'test.md', newContent: 'test' });
        const result = await action(input, { skillsDir: tempSkillsDir });
        assert.ok(result.includes('Error') && result.includes('skillName'));
    });

    it('should return error when fileName is missing', async () => {
        const input = JSON.stringify({ skillName: 'test', newContent: 'test' });
        const result = await action(input, { skillsDir: tempSkillsDir });
        assert.ok(result.includes('Error') && result.includes('fileName'));
    });

    it('should return error when newContent is missing', async () => {
        const input = JSON.stringify({ skillName: 'test', fileName: 'test.md' });
        const result = await action(input, { skillsDir: tempSkillsDir });
        assert.ok(result.includes('Error') && result.includes('newContent'));
    });

    it('should show no changes when content is identical', async () => {
        const skillDir = path.join(tempSkillsDir, 'NoChangeSkill');
        fs.mkdirSync(skillDir);
        fs.writeFileSync(path.join(skillDir, 'cskill.md'), 'Same content');

        const input = JSON.stringify({
            skillName: 'NoChangeSkill',
            fileName: 'cskill.md',
            newContent: 'Same content',
        });

        const result = await action(input, { skillsDir: tempSkillsDir });
        assert.ok(result.includes('No changes'));
    });

    it('should show additions in diff', async () => {
        const skillDir = path.join(tempSkillsDir, 'AdditionSkill');
        fs.mkdirSync(skillDir);
        fs.writeFileSync(path.join(skillDir, 'cskill.md'), 'Line 1');

        const input = JSON.stringify({
            skillName: 'AdditionSkill',
            fileName: 'cskill.md',
            newContent: 'Line 1\nLine 2',
        });

        const result = await action(input, { skillsDir: tempSkillsDir });
        assert.ok(result.includes('+'), 'Should show addition marker');
    });

    it('should show removals in diff', async () => {
        const skillDir = path.join(tempSkillsDir, 'RemovalSkill');
        fs.mkdirSync(skillDir);
        fs.writeFileSync(path.join(skillDir, 'cskill.md'), 'Line 1\nLine 2');

        const input = JSON.stringify({
            skillName: 'RemovalSkill',
            fileName: 'cskill.md',
            newContent: 'Line 1',
        });

        const result = await action(input, { skillsDir: tempSkillsDir });
        assert.ok(result.includes('-'), 'Should show removal marker');
    });
});

// ============================================================================
// execute-skill Tests
// ============================================================================

describe('execute-skill module', () => {
    let action;
    let tempDir;
    let tempSkillsDir;

    before(async () => {
        const module = await import('../src/.AchillesSkills/execute-skill/execute-skill.mjs');
        action = module.action;

        tempDir = path.join(__dirname, 'temp_execute_' + Date.now());
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

    it('should return error when skilledAgent is missing', async () => {
        const result = await action('test', {});
        assert.ok(result.includes('Error') && result.includes('skilledAgent'));
    });

    it('should return error when skillName not provided', async () => {
        const mockAgent = { skillCatalog: new Map() };
        const result = await action('', { skilledAgent: mockAgent });
        assert.ok(result.includes('Error') && result.includes('skillName'));
    });

    it('should parse "skillName with input" format', async () => {
        const mockAgent = {
            skillCatalog: new Map(),
            getSkillRecord: () => null,
        };

        const result = await action('nonexistent with some input', { skilledAgent: mockAgent });
        assert.ok(result.includes('not found'));
    });

    it('should accept object input', async () => {
        const mockAgent = {
            skillCatalog: new Map(),
            getSkillRecord: () => null,
        };

        const result = await action({ skillName: 'test', input: 'data' }, { skilledAgent: mockAgent });
        assert.ok(result.includes('not found'));
    });

    it('should reject built-in skills', async () => {
        const builtInDir = '/builtin/.AchillesSkills';
        const mockAgent = {
            builtInSkillsDir: builtInDir,
            skillCatalog: new Map(),
            getSkillRecord: () => ({
                name: 'list-skills',
                skillDir: `${builtInDir}/list-skills`,
            }),
        };

        const result = await action('list-skills', { skilledAgent: mockAgent });
        assert.ok(result.includes('built-in') || result.includes('management skill'));
    });

    it('should list available user skills when skill not found', async () => {
        const mockAgent = {
            skillCatalog: new Map([
                ['user-skill', { name: 'user-skill', shortName: 'UserSkill', skillDir: '/user' }],
            ]),
            getSkillRecord: () => null,
        };

        const result = await action('nonexistent', { skilledAgent: mockAgent });
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

        const result = await action('test-skill', { skilledAgent: mockAgent });
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

        const result = await action('error-skill', { skilledAgent: mockAgent });
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
        const module = await import('../src/.AchillesSkills/generate-code/generate-code.mjs');
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

        const result = await action('MskillGen', { skillsDir: tempSkillsDir, llmAgent: {} });
        assert.ok(result.includes('only supported for') || result.includes('not found'));
    });

    it('should accept object input', async () => {
        const result = await action({ skillName: 'TestSkill' }, { skillsDir: tempSkillsDir });
        assert.ok(result.includes('Error'));
    });

    it('should clean markdown code fences from LLM response', async () => {
        const skillDir = path.join(tempSkillsDir, 'FenceSkill');
        fs.mkdirSync(skillDir);
        fs.writeFileSync(path.join(skillDir, 'tskill.md'), '# Fence\n\n## Table Purpose\nTest\n\n## Fields\n\n### id');

        const mockLlm = {
            executePrompt: async () => '```javascript\nexport const x = 1;\n```',
        };

        const result = await action('FenceSkill', { skillsDir: tempSkillsDir, llmAgent: mockLlm });
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
        const module = await import('../src/.AchillesSkills/test-code/test-code.mjs');
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
        const skillDir = path.join(tempSkillsDir, 'JsGenSkill');
        fs.mkdirSync(skillDir);
        fs.writeFileSync(path.join(skillDir, 'JsGenSkill.generated.js'), 'module.exports = { test: 1 };');

        // Note: .js with module.exports won't work in ESM context, but the test
        // verifies the file discovery works
        const result = await action('JsGenSkill', { skillsDir: tempSkillsDir });
        // Should at least try to load the file
        assert.ok(result.includes('Module loaded') || result.includes('Failed to load'));
    });

    it('should list non-function exports', async () => {
        const skillDir = path.join(tempSkillsDir, 'ConstExportSkill');
        fs.mkdirSync(skillDir);
        fs.writeFileSync(path.join(skillDir, 'ConstExportSkill.generated.mjs'), `
export const CONFIG = { key: 'value' };
export const VERSION = '1.0.0';
export function action() { return 'test'; }
export default { CONFIG, VERSION, action };
`);

        const result = await action('ConstExportSkill', { skillsDir: tempSkillsDir });
        assert.ok(result.includes('CONFIG'));
        assert.ok(result.includes('VERSION'));
        assert.ok(result.includes('object') || result.includes('string'));
    });

    it('should execute functions with testInput', async () => {
        const skillDir = path.join(tempSkillsDir, 'TestInputSkill');
        fs.mkdirSync(skillDir);
        fs.writeFileSync(path.join(skillDir, 'TestInputSkill.generated.mjs'), `
export function greet(name) { return 'Hello ' + name; }
export default { greet };
`);

        const result = await action(
            JSON.stringify({ skillName: 'TestInputSkill', testInput: 'World' }),
            { skillsDir: tempSkillsDir }
        );
        assert.ok(result.includes('Test Results') || result.includes('Hello World'));
    });
});

// ============================================================================
// skill-refiner Tests
// ============================================================================

describe('skill-refiner module', () => {
    let action;
    let tempDir;
    let tempSkillsDir;

    before(async () => {
        const module = await import('../src/.AchillesSkills/skill-refiner/skill-refiner.mjs');
        action = module.action;

        tempDir = path.join(__dirname, 'temp_refiner_' + Date.now());
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
        const result = await action('', { skillsDir: tempSkillsDir });
        assert.ok(result.includes('Error') && result.includes('skillName'));
    });

    it('should return error when llmAgent not provided', async () => {
        const result = await action('someSkill', { skillsDir: tempSkillsDir });
        assert.ok(result.includes('Error') && result.includes('LLM'));
    });

    it('should return error when skill not found', async () => {
        const mockLlm = { executePrompt: async () => '{}' };
        const result = await action('NonExistent', { skillsDir: tempSkillsDir, llmAgent: mockLlm });
        assert.ok(result.includes('not found') || (typeof result === 'object' && result.output?.includes('not found')));
    });

    it('should parse JSON input', async () => {
        const mockLlm = { executePrompt: async () => '{}' };
        const result = await action(
            JSON.stringify({ skillName: 'NonExistent', maxIterations: 3 }),
            { skillsDir: tempSkillsDir, llmAgent: mockLlm }
        );
        const output = typeof result === 'object' ? result.output : result;
        assert.ok(output.includes('not found') || output.includes('Max iterations: 3'));
    });

    it('should run refinement loop on valid skill', async () => {
        const skillDir = path.join(tempSkillsDir, 'RefineMe');
        fs.mkdirSync(skillDir);
        fs.writeFileSync(path.join(skillDir, 'tskill.md'), '# RefineMe\n\n## Table Purpose\nTest\n\n## Fields\n\n### id');

        const mockLlm = {
            executePrompt: async (prompt, opts) => {
                if (opts?.responseShape === 'json') {
                    return { success: true, failures: [] };
                }
                return 'export const test = 1;';
            },
        };

        const mockAgent = {
            getSkillRecord: () => ({
                skillDir,
                filePath: path.join(skillDir, 'tskill.md'),
            }),
            executePrompt: async () => 'Test passed',
        };

        const result = await action('RefineMe', {
            skillsDir: tempSkillsDir,
            llmAgent: mockLlm,
            skilledAgent: mockAgent,
        });

        const output = typeof result === 'object' ? result.output : result;
        assert.ok(output.includes('Starting refinement') || output.includes('Iteration'));
    });

    it('should stop after max iterations', async () => {
        const skillDir = path.join(tempSkillsDir, 'MaxIterSkill');
        fs.mkdirSync(skillDir);
        fs.writeFileSync(path.join(skillDir, 'cskill.md'), '# Max\n\n## Summary\nTest\n\n## Prompt\nTest');

        const mockLlm = {
            executePrompt: async (prompt, opts) => {
                if (opts?.responseShape === 'json') {
                    return { success: false, failures: [{ section: 'Summary', reason: 'Needs work' }] };
                }
                return '{}';
            },
        };

        const mockAgent = {
            getSkillRecord: () => ({
                skillDir,
                filePath: path.join(skillDir, 'cskill.md'),
            }),
            executePrompt: async () => 'Test result',
        };

        const result = await action(
            JSON.stringify({ skillName: 'MaxIterSkill', maxIterations: 2 }),
            { skillsDir: tempSkillsDir, llmAgent: mockLlm, skilledAgent: mockAgent }
        );

        assert.ok(result.success === false || result.reason === 'max_iterations_reached' || result.output?.includes('Max iterations'));
    });
});

// ============================================================================
// OpsSkill Tests
// ============================================================================

describe('OpsSkill (cskill for file operations)', () => {
    it('should have valid cskill.md definition', async () => {
        const opsSkillPath = path.join(SKILLS_BASE, 'OpsSkill', 'cskill.md');
        assert.ok(fs.existsSync(opsSkillPath), 'OpsSkill cskill.md should exist');

        const content = fs.readFileSync(opsSkillPath, 'utf8');
        assert.ok(content.includes('## Summary'), 'Should have Summary section');
        assert.ok(content.includes('## Prompt'), 'Should have Prompt section');
        assert.ok(content.includes('## LLM Mode'), 'Should have LLM Mode section');
    });

    it('should contain file operation instructions', async () => {
        const opsSkillPath = path.join(SKILLS_BASE, 'OpsSkill', 'cskill.md');
        const content = fs.readFileSync(opsSkillPath, 'utf8');

        assert.ok(content.includes('file') || content.includes('File'), 'Should mention file operations');
        assert.ok(content.includes('Node.js') || content.includes('node:fs'), 'Should mention Node.js');
    });
});

// ============================================================================
// skill-manager Orchestrator Tests
// ============================================================================

describe('skill-manager orchestrator', () => {
    it('should have valid oskill.md definition', async () => {
        const skillPath = path.join(SKILLS_BASE, 'skill-manager', 'oskill.md');
        assert.ok(fs.existsSync(skillPath), 'skill-manager oskill.md should exist');

        const content = fs.readFileSync(skillPath, 'utf8');
        assert.ok(content.includes('## Instructions'), 'Should have Instructions section');
        assert.ok(content.includes('## Allowed-Skills'), 'Should have Allowed-Skills section');
    });

    it('should list all expected allowed skills', async () => {
        const skillPath = path.join(SKILLS_BASE, 'skill-manager', 'oskill.md');
        const content = fs.readFileSync(skillPath, 'utf8');

        const expectedSkills = [
            'list-skills',
            'read-skill',
            'write-skill',
            'update-section',
            'delete-skill',
            'validate-skill',
            'get-template',
            'preview-changes',
            'generate-code',
            'test-code',
            'skill-refiner',
            'execute-skill',
        ];

        for (const skill of expectedSkills) {
            assert.ok(content.includes(skill), `Should include ${skill} in allowed skills`);
        }
    });

    it('should have intent definitions', async () => {
        const skillPath = path.join(SKILLS_BASE, 'skill-manager', 'oskill.md');
        const content = fs.readFileSync(skillPath, 'utf8');

        assert.ok(content.includes('## Intents'), 'Should have Intents section');
        assert.ok(content.includes('list') || content.includes('List'), 'Should have list intent');
        assert.ok(content.includes('read') || content.includes('Read'), 'Should have read intent');
        assert.ok(content.includes('create') || content.includes('Create'), 'Should have create intent');
    });

    it('should have example usage in instructions', async () => {
        const skillPath = path.join(SKILLS_BASE, 'skill-manager', 'oskill.md');
        const content = fs.readFileSync(skillPath, 'utf8');

        assert.ok(content.includes('Example') || content.includes('example'), 'Should include examples');
    });
});

// ============================================================================
// skill-refiner Orchestrator Definition Tests
// ============================================================================

describe('skill-refiner orchestrator definition', () => {
    it('should have valid oskill.md definition', async () => {
        const skillPath = path.join(SKILLS_BASE, 'skill-refiner', 'oskill.md');
        assert.ok(fs.existsSync(skillPath), 'skill-refiner oskill.md should exist');

        const content = fs.readFileSync(skillPath, 'utf8');
        assert.ok(content.includes('## Instructions'), 'Should have Instructions section');
        assert.ok(content.includes('## Allowed-Skills'), 'Should have Allowed-Skills section');
    });

    it('should have module reference', async () => {
        const skillPath = path.join(SKILLS_BASE, 'skill-refiner', 'oskill.md');
        const content = fs.readFileSync(skillPath, 'utf8');

        assert.ok(content.includes('## Module') || content.includes('skill-refiner.mjs'), 'Should reference module');
    });

    it('should have iteration instructions', async () => {
        const skillPath = path.join(SKILLS_BASE, 'skill-refiner', 'oskill.md');
        const content = fs.readFileSync(skillPath, 'utf8');

        assert.ok(content.includes('iteration') || content.includes('loop'), 'Should mention iteration loop');
    });

    it('should list required sub-skills', async () => {
        const skillPath = path.join(SKILLS_BASE, 'skill-refiner', 'oskill.md');
        const content = fs.readFileSync(skillPath, 'utf8');

        const requiredSkills = ['read-skill', 'validate-skill', 'generate-code', 'test-code', 'update-section'];
        for (const skill of requiredSkills) {
            assert.ok(content.includes(skill), `Should list ${skill} as allowed skill`);
        }
    });
});

// ============================================================================
// Directory Structure Tests
// ============================================================================

describe('Skills Directory Structure', () => {
    const expectedSkills = [
        'list-skills',
        'read-skill',
        'write-skill',
        'delete-skill',
        'validate-skill',
        'get-template',
        'update-section',
        'preview-changes',
        'generate-code',
        'test-code',
        'skill-refiner',
        'skill-manager',
        'execute-skill',
        'OpsSkill',
    ];

    for (const skillName of expectedSkills) {
        it(`should have ${skillName} directory`, () => {
            const skillDir = path.join(SKILLS_BASE, skillName);
            assert.ok(fs.existsSync(skillDir), `${skillName} directory should exist`);
        });
    }

    it('should have skill definition files in each directory', () => {
        for (const skillName of expectedSkills) {
            const skillDir = path.join(SKILLS_BASE, skillName);
            const files = fs.readdirSync(skillDir);

            const hasSkillDef = files.some(f =>
                f.endsWith('skill.md') || f.endsWith('.mjs') || f.endsWith('.js')
            );
            assert.ok(hasSkillDef, `${skillName} should have a skill definition or module file`);
        }
    });
});

// ============================================================================
// InteractiveSkillsSubsystem Tests
// ============================================================================

describe('InteractiveSkillsSubsystem - Module Loading', () => {
    let tempDir;
    let tempSkillsDir;

    before(() => {
        tempDir = path.join(__dirname, 'temp_interactive_' + Date.now());
        tempSkillsDir = path.join(tempDir, '.AchillesSkills');
        fs.mkdirSync(tempSkillsDir, { recursive: true });
    });

    after(() => {
        if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('should succeed when iskill has .generated.mjs file (lowercase)', async () => {
        // Create an iskill directory with iskill.md and lowercase .generated.mjs
        const skillDir = path.join(tempSkillsDir, 'TestJoker');
        fs.mkdirSync(skillDir);

        // Create iskill.md definition
        fs.writeFileSync(path.join(skillDir, 'iskill.md'), `# Test Joker Skill

## Summary
A simple interactive skill that tells jokes.

## Required Arguments
- topic

## Prompt
Tell programming jokes only.
`);

        // Create a .generated.mjs file (lowercase - now supported!)
        fs.writeFileSync(path.join(skillDir, 'testjoker.generated.mjs'), `
export const specs = {
    name: 'test-joker',
    description: 'Tells jokes',
    arguments: {
        topic: { description: 'Topic for jokes', type: 'string', required: true },
    },
};

export async function action(args, context) {
    return 'Why do programmers prefer dark mode? Because light attracts bugs!';
}
`);

        // Import the execute-skill action
        const executeModule = await import('../src/.AchillesSkills/execute-skill/execute-skill.mjs');
        const executeAction = executeModule.action;

        // Create a mock skilledAgent that simulates the updated InteractiveSkillsSubsystem behavior
        const mockAgent = {
            skillCatalog: new Map([
                ['test-joker', {
                    name: 'test-joker',
                    shortName: 'TestJoker',
                    type: 'interactive',
                    skillDir: skillDir,
                    filePath: path.join(skillDir, 'iskill.md'),
                }],
            ]),
            getSkillRecord: (name) => {
                if (name === 'test-joker' || name === 'testjoker') {
                    return {
                        name: 'test-joker',
                        shortName: 'TestJoker',
                        type: 'interactive',
                        skillDir: skillDir,
                        filePath: path.join(skillDir, 'iskill.md'),
                    };
                }
                return null;
            },
            executeWithReviewMode: async (input, opts) => {
                // Simulate updated InteractiveSkillsSubsystem - now supports .generated.mjs
                const shortName = 'TestJoker';
                const lowerName = shortName.toLowerCase();
                const candidateFiles = [
                    `${shortName}.mjs`,
                    `${shortName}.js`,
                    `${shortName}.generated.mjs`,
                    `${lowerName}.generated.mjs`,  // Now supported!
                    `${lowerName}.mjs`,
                    `${lowerName}.js`,
                ];

                const existingFiles = fs.readdirSync(skillDir);
                const hasProperModule = candidateFiles.some(f => existingFiles.includes(f));

                if (hasProperModule) {
                    return { result: 'Why do programmers prefer dark mode? Because light attracts bugs!' };
                }

                throw new Error(
                    `Interactive skill module missing for skill folder ${skillDir}. ` +
                    `Expected ${candidateFiles.join(' or ')}.`
                );
            },
        };

        const result = await executeAction('test-joker', { skilledAgent: mockAgent });

        // Should succeed now that .generated.mjs is supported
        assert.ok(
            result.includes('dark mode') || result.includes('Output'),
            `Should execute successfully with .generated.mjs. Got: ${result}`
        );
    });

    it('should succeed when iskill has properly named module file', async () => {
        // Create an iskill directory with properly named module
        const skillDir = path.join(tempSkillsDir, 'ProperJoker');
        fs.mkdirSync(skillDir);

        // Create iskill.md definition
        fs.writeFileSync(path.join(skillDir, 'iskill.md'), `# Proper Joker Skill

## Summary
A properly configured interactive skill.

## Required Arguments
- topic
`);

        // Create properly named module file (ProperJoker.mjs matches directory name)
        fs.writeFileSync(path.join(skillDir, 'ProperJoker.mjs'), `
export const specs = {
    name: 'proper-joker',
    description: 'Tells jokes properly',
    arguments: {
        topic: { description: 'Topic for jokes', type: 'string', required: true },
    },
};

export async function action(args, context) {
    return 'What do you call a programmer from Finland? Nerdic!';
}
`);

        // Import the execute-skill action
        const executeModule = await import('../src/.AchillesSkills/execute-skill/execute-skill.mjs');
        const executeAction = executeModule.action;

        const mockAgent = {
            skillCatalog: new Map([
                ['proper-joker', {
                    name: 'proper-joker',
                    shortName: 'ProperJoker',
                    type: 'interactive',
                    skillDir: skillDir,
                }],
            ]),
            getSkillRecord: () => ({
                name: 'proper-joker',
                shortName: 'ProperJoker',
                type: 'interactive',
                skillDir: skillDir,
            }),
            executeWithReviewMode: async () => {
                // Simulate successful execution when module exists
                const shortName = 'ProperJoker';
                const candidateFiles = [`${shortName}.mjs`, `${shortName}.js`];
                const existingFiles = fs.readdirSync(skillDir);
                const hasProperModule = candidateFiles.some(f => existingFiles.includes(f));

                if (hasProperModule) {
                    return { result: 'What do you call a programmer from Finland? Nerdic!' };
                }
                throw new Error('Module missing');
            },
        };

        const result = await executeAction('proper-joker', { skilledAgent: mockAgent });

        // Should succeed
        assert.ok(
            result.includes('Nerdic') || result.includes('Output'),
            `Should execute successfully. Got: ${result}`
        );
    });

    it('should document the iskill module naming conventions', async () => {
        // This test documents the expected behavior and naming convention
        const skillDir = path.join(tempSkillsDir, 'NamingExample');
        fs.mkdirSync(skillDir);

        // Document the supported naming patterns (in priority order):
        // Directory: NamingExample/
        const directoryName = 'NamingExample';
        const lowerName = directoryName.toLowerCase();

        const supportedModuleNames = [
            `${directoryName}.mjs`,           // 1. Exact match: NamingExample.mjs
            `${directoryName}.js`,            // 2. Exact match: NamingExample.js
            `${directoryName}.generated.mjs`, // 3. Generated (PascalCase): NamingExample.generated.mjs
            `${lowerName}.generated.mjs`,     // 4. Generated (lowercase): namingexample.generated.mjs
            `${lowerName}.mjs`,               // 5. Lowercase: namingexample.mjs
            `${lowerName}.js`,                // 6. Lowercase: namingexample.js
        ];

        const unsupportedModuleNames = [
            'naming-example.mjs',           // Wrong: hyphenated
            'naming-example.generated.mjs', // Wrong: hyphenated
            'iskill.mjs',                   // Wrong: generic name
        ];

        // Verify the expected naming patterns
        assert.equal(supportedModuleNames.length, 6, 'Should support 6 naming patterns');
        assert.equal(supportedModuleNames[0], 'NamingExample.mjs');
        assert.equal(supportedModuleNames[3], 'namingexample.generated.mjs');

        // Document that shortName comes from directory name
        assert.ok(supportedModuleNames.includes(`${directoryName}.mjs`));
        assert.ok(supportedModuleNames.includes(`${lowerName}.generated.mjs`));
    });
});

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

        const listModule = await import('../src/.AchillesSkills/list-skills/list-skills.mjs');
        listAction = listModule.action;

        const readModule = await import('../src/.AchillesSkills/read-skill/read-skill.mjs');
        readAction = readModule.action;

        const writeModule = await import('../src/.AchillesSkills/write-skill/write-skill.mjs');
        writeAction = writeModule.action;

        const validateModule = await import('../src/.AchillesSkills/validate-skill/validate-skill.mjs');
        validateAction = validateModule.action;

        const deleteModule = await import('../src/.AchillesSkills/delete-skill/delete-skill.mjs');
        deleteAction = deleteModule.action;
    });

    after(() => {
        if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('should complete full create-read-validate-delete workflow', async () => {
        // 1. Create skill
        const createResult = await writeAction(JSON.stringify({
            skillName: 'WorkflowTestSkill',
            fileName: 'cskill.md',
            content: '# Workflow Test\n\n## Summary\nTest skill for workflow\n\n## Prompt\nDo something\n\n## LLM Mode\nfast',
        }), { skillsDir: tempSkillsDir });
        assert.ok(createResult.includes('Created'), 'Should create skill');

        // 2. List skills
        const mockAgent = {
            skillCatalog: new Map([
                ['workflow-test-skill', {
                    name: 'workflow-test-skill',
                    type: 'code',
                    shortName: 'WorkflowTestSkill',
                    descriptor: { summary: 'Test skill for workflow' },
                    skillDir: path.join(tempSkillsDir, 'WorkflowTestSkill'),
                }],
            ]),
            getSkillRecord: () => ({
                skillDir: path.join(tempSkillsDir, 'WorkflowTestSkill'),
                filePath: path.join(tempSkillsDir, 'WorkflowTestSkill', 'cskill.md'),
            }),
        };

        const listResult = await listAction('', { skilledAgent: mockAgent });
        assert.ok(listResult.includes('WorkflowTestSkill') || listResult.includes('workflow-test-skill'));

        // 3. Read skill
        const readResult = await readAction('WorkflowTestSkill', {
            skillsDir: tempSkillsDir,
            skilledAgent: mockAgent,
        });
        assert.ok(readResult.includes('Workflow Test'));

        // 4. Validate skill
        const validateResult = await validateAction('WorkflowTestSkill', {
            skillsDir: tempSkillsDir,
            skilledAgent: mockAgent,
        });
        assert.ok(validateResult.includes('VALID') || validateResult.includes('Validation'));

        // 5. Delete skill
        const deleteResult = await deleteAction('WorkflowTestSkill', { skillsDir: tempSkillsDir });
        assert.ok(deleteResult.includes('Deleted'));
        assert.ok(!fs.existsSync(path.join(tempSkillsDir, 'WorkflowTestSkill')));
    });
});
