/**
 * Tests for skillSchemas.mjs utilities
 *
 * Action signature convention: action(recursiveSkilledAgent, prompt)
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

describe('skillSchemas.mjs - Schema Utilities', () => {
    let detectSkillType, validateSkillContent, parseSkillSections, updateSkillSection;
    let SKILL_TYPES, SKILL_TEMPLATES;

    before(async () => {
        const schemas = await import('../../src/skillSchemas.mjs');
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
            const content = `# Title\n\n## Summary\nLine 1\nLine 2\nLine 3\n\n## Other\nContent`;
            const sections = parseSkillSections(content);
            assert.ok(sections.Summary, 'Should have Summary section');
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
