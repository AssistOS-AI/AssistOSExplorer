/**
 * Tests for editor skill modules: update-section, preview-changes
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
// update-section Tests
// ============================================================================

describe('update-section module - Extended Tests', () => {
    let action;
    let tempDir;
    let tempSkillsDir;

    before(async () => {
        const module = await import('../../src/.AchillesSkills/update-section/update-section.mjs');
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
        const mockAgent = { startDir: tempDir };
        const input = JSON.stringify({ skillName: 'Test', content: 'New content' });
        const result = await action(mockAgent, input);
        assert.ok(result.includes('Error') && result.includes('section'));
    });

    it('should return error when content is missing', async () => {
        const mockAgent = { startDir: tempDir };
        const input = JSON.stringify({ skillName: 'Test', section: 'Summary' });
        const result = await action(mockAgent, input);
        assert.ok(result.includes('Error') && result.includes('content'));
    });

    it('should update multiple sections sequentially', async () => {
        const skillDir = path.join(tempSkillsDir, 'MultiUpdateSkillExt');
        fs.mkdirSync(skillDir);
        fs.writeFileSync(path.join(skillDir, 'cskill.md'), '# Multi\n\n## Summary\nOld1\n\n## Prompt\nOld2');

        const mockAgent = {
            startDir: tempDir,
            getSkillRecord: () => ({
                skillDir,
                filePath: path.join(skillDir, 'cskill.md'),
            }),
        };

        // Update Summary
        await action(mockAgent, JSON.stringify({
            skillName: 'MultiUpdateSkillExt',
            section: 'Summary',
            content: 'New1',
        }));

        // Update Prompt
        await action(mockAgent, JSON.stringify({
            skillName: 'MultiUpdateSkillExt',
            section: 'Prompt',
            content: 'New2',
        }));

        const content = fs.readFileSync(path.join(skillDir, 'cskill.md'), 'utf8');
        assert.ok(content.includes('New1'));
        assert.ok(content.includes('New2'));
    });

    it('should add new section if not exists', async () => {
        const skillDir = path.join(tempSkillsDir, 'AddSectionSkillExt');
        fs.mkdirSync(skillDir);
        fs.writeFileSync(path.join(skillDir, 'cskill.md'), '# Add\n\n## Summary\nTest');

        const mockAgent = {
            startDir: tempDir,
            getSkillRecord: () => ({
                skillDir,
                filePath: path.join(skillDir, 'cskill.md'),
            }),
        };

        await action(mockAgent, JSON.stringify({
            skillName: 'AddSectionSkillExt',
            section: 'NewSection',
            content: 'Brand new content',
        }));

        const content = fs.readFileSync(path.join(skillDir, 'cskill.md'), 'utf8');
        assert.ok(content.includes('## NewSection'));
        assert.ok(content.includes('Brand new content'));
    });

    it('should trigger code regeneration when .generated.mjs exists', async () => {
        const skillDir = path.join(tempSkillsDir, 'RegenSkillExt');
        fs.mkdirSync(skillDir);
        fs.writeFileSync(path.join(skillDir, 'iskill.md'), '# Regen\n\n## Summary\nOriginal summary\n\n## Commands\n\n### test\nTest command');
        fs.writeFileSync(path.join(skillDir, 'regen.generated.mjs'), 'export const specs = {};');

        const mockAgent = {
            startDir: tempDir,
            llmAgent: {
                executePrompt: async () => 'export const specs = { name: "regen" };\nexport async function action() { return "test"; }',
            },
            getSkillRecord: () => ({
                skillDir,
                filePath: path.join(skillDir, 'iskill.md'),
            }),
        };

        const result = await action(mockAgent, JSON.stringify({
            skillName: 'RegenSkillExt',
            section: 'Summary',
            content: 'Updated summary',
        }));

        const content = fs.readFileSync(path.join(skillDir, 'iskill.md'), 'utf8');
        assert.ok(content.includes('Updated summary'));

        assert.ok(
            result.includes('regeneration') || result.includes('Detected existing generated code'),
            `Should mention regeneration. Got: ${result}`
        );
    });

    it('should not trigger regeneration when no .generated.mjs exists', async () => {
        const skillDir = path.join(tempSkillsDir, 'NoRegenSkillExt');
        fs.mkdirSync(skillDir);
        fs.writeFileSync(path.join(skillDir, 'cskill.md'), '# NoRegen\n\n## Summary\nOriginal');

        const mockAgent = {
            startDir: tempDir,
            getSkillRecord: () => ({
                skillDir,
                filePath: path.join(skillDir, 'cskill.md'),
            }),
        };

        const result = await action(mockAgent, JSON.stringify({
            skillName: 'NoRegenSkillExt',
            section: 'Summary',
            content: 'Updated',
        }));

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
        const module = await import('../../src/.AchillesSkills/preview-changes/preview-changes.mjs');
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
        const mockAgent = { startDir: tempDir };
        const input = JSON.stringify({ fileName: 'test.md', newContent: 'test' });
        const result = await action(mockAgent, input);
        assert.ok(result.includes('Error') && result.includes('skillName'));
    });

    it('should return error when fileName is missing', async () => {
        const mockAgent = { startDir: tempDir };
        const input = JSON.stringify({ skillName: 'test', newContent: 'test' });
        const result = await action(mockAgent, input);
        assert.ok(result.includes('Error') && result.includes('fileName'));
    });

    it('should return error when newContent is missing', async () => {
        const mockAgent = { startDir: tempDir };
        const input = JSON.stringify({ skillName: 'test', fileName: 'test.md' });
        const result = await action(mockAgent, input);
        assert.ok(result.includes('Error') && result.includes('newContent'));
    });

    it('should show no changes when content is identical', async () => {
        const skillDir = path.join(tempSkillsDir, 'NoChangeSkillExt');
        fs.mkdirSync(skillDir);
        fs.writeFileSync(path.join(skillDir, 'cskill.md'), 'Same content');

        const mockAgent = { startDir: tempDir };
        const input = JSON.stringify({
            skillName: 'NoChangeSkillExt',
            fileName: 'cskill.md',
            newContent: 'Same content',
        });

        const result = await action(mockAgent, input);
        assert.ok(result.includes('No changes'));
    });

    it('should show additions in diff', async () => {
        const skillDir = path.join(tempSkillsDir, 'AdditionSkillExt');
        fs.mkdirSync(skillDir);
        fs.writeFileSync(path.join(skillDir, 'cskill.md'), 'Line 1');

        const mockAgent = { startDir: tempDir };
        const input = JSON.stringify({
            skillName: 'AdditionSkillExt',
            fileName: 'cskill.md',
            newContent: 'Line 1\nLine 2',
        });

        const result = await action(mockAgent, input);
        assert.ok(result.includes('+'), 'Should show addition marker');
    });

    it('should show removals in diff', async () => {
        const skillDir = path.join(tempSkillsDir, 'RemovalSkillExt');
        fs.mkdirSync(skillDir);
        fs.writeFileSync(path.join(skillDir, 'cskill.md'), 'Line 1\nLine 2');

        const mockAgent = { startDir: tempDir };
        const input = JSON.stringify({
            skillName: 'RemovalSkillExt',
            fileName: 'cskill.md',
            newContent: 'Line 1',
        });

        const result = await action(mockAgent, input);
        assert.ok(result.includes('-'), 'Should show removal marker');
    });
});
