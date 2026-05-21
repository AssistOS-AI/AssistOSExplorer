/**
 * Tests for editor skill modules: update-section, preview-changes
 *
 * Action signature convention: action({ mainAgent, promptText })
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function contentArg(content, token = 'content') {
    return `--begin-${token}--\n${content}\n--end-${token}--`;
}

function updateSectionInput(skillName, section, content) {
    return `${skillName} "${section}" ${contentArg(content)}`;
}

function previewChangesInput(skillName, fileName, content) {
    return `${skillName} ${fileName} ${contentArg(content)}`;
}

// ============================================================================
// update-section Tests
// ============================================================================

describe('update-section module - Extended Tests', () => {
    let action;
    let tempDir;
    let tempSkillsDir;

    before(async () => {
        const module = await import('../../achilles-cli/src/skills/update-section/src/index.mjs');
        action = module.action;

        tempDir = path.join(__dirname, 'temp_updatesec_ext_' + Date.now());
        tempSkillsDir = path.join(tempDir, 'skills');
        fs.mkdirSync(tempSkillsDir, { recursive: true });
    });

    after(() => {
        if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('should return error when section is missing', async () => {
        const mockAgent = { startDir: tempDir };
        const input = `Test ${contentArg('New content')}`;
        const result = await action({ mainAgent: mockAgent, promptText: input });
        assert.ok(result.includes('Error'));
    });

    it('should return error when content is missing', async () => {
        const mockAgent = { startDir: tempDir };
        const input = 'Test Summary';
        const result = await action({ mainAgent: mockAgent, promptText: input });
        assert.ok(result.includes('Error') && result.includes('content'));
    });

    it('should update multiple sections sequentially', async () => {
        const skillDir = path.join(tempSkillsDir, 'MultiUpdateSkillExt');
        fs.mkdirSync(skillDir);
        fs.writeFileSync(path.join(skillDir, 'cskill.md'), '# Multi\n\n## Summary\nOld1\n\n## Input Format\nOld2');

        const mockAgent = {
            startDir: tempDir,
            getSkillRecord: () => ({
                skillDir,
                filePath: path.join(skillDir, 'cskill.md'),
                type: 'cskill',
            }),
        };

        // Update Summary
        await action({ mainAgent: mockAgent, promptText: updateSectionInput('MultiUpdateSkillExt', 'Summary', 'New1') });

        // Update Input Format
        await action({ mainAgent: mockAgent, promptText: updateSectionInput('MultiUpdateSkillExt', 'Input Format', 'New2') });

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
                type: 'cskill',
            }),
        };

        await action({ mainAgent: mockAgent, promptText: updateSectionInput('AddSectionSkillExt', 'NewSection', 'Brand new content') });

        const content = fs.readFileSync(path.join(skillDir, 'cskill.md'), 'utf8');
        assert.ok(content.includes('## NewSection'));
        assert.ok(content.includes('Brand new content'));
    });

    it('should trigger code regeneration when runtime code exists', async () => {
        const skillDir = path.join(tempSkillsDir, 'RegenSkillExt');
        fs.mkdirSync(path.join(skillDir, 'src'), { recursive: true });
        fs.writeFileSync(path.join(skillDir, 'cskill.md'), '# Regen\n\n## Summary\nOriginal summary\n\n## Input Format\nText input\n\n## Output Format\nText output');
        fs.writeFileSync(path.join(skillDir, 'src', 'index.mjs'), 'export const specs = {};');

        const mockAgent = {
            startDir: tempDir,
            llmAgent: {
                executePrompt: async () => 'export const specs = { name: "regen" };\nexport async function action() { return "test"; }',
            },
            getSkillRecord: () => ({
                skillDir,
                filePath: path.join(skillDir, 'cskill.md'),
                type: 'cskill',
            }),
        };

        const result = await action({ mainAgent: mockAgent, promptText: updateSectionInput('RegenSkillExt', 'Summary', 'Updated summary') });

        const content = fs.readFileSync(path.join(skillDir, 'cskill.md'), 'utf8');
        assert.ok(content.includes('Updated summary'));

        assert.ok(
            result.includes('regeneration') || result.includes('Detected existing generated code'),
            `Should mention regeneration. Got: ${result}`
        );
    });

    it('should not trigger regeneration when no runtime code exists', async () => {
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

        const result = await action({ mainAgent: mockAgent, promptText: updateSectionInput('NoRegenSkillExt', 'Summary', 'Updated') });

        assert.ok(
            !result.includes('regeneration') && !result.includes('Detected existing generated code'),
            `Should not mention regeneration when no runtime code exists. Got: ${result}`
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
        const module = await import('../../achilles-cli/src/skills/preview-changes/src/index.mjs');
        action = module.action;

        tempDir = path.join(__dirname, 'temp_preview_ext_' + Date.now());
        tempSkillsDir = path.join(tempDir, 'skills');
        fs.mkdirSync(tempSkillsDir, { recursive: true });
    });

    after(() => {
        if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('should return error when skillName is missing', async () => {
        const mockAgent = { startDir: tempDir };
        const input = `test.md ${contentArg('test')}`;
        const result = await action({ mainAgent: mockAgent, promptText: input });
        assert.ok(result.includes('Error'));
    });

    it('should return error when fileName is missing', async () => {
        const mockAgent = { startDir: tempDir };
        const input = `test ${contentArg('test')}`;
        const result = await action({ mainAgent: mockAgent, promptText: input });
        assert.ok(result.includes('Error'));
    });

    it('should return error when newContent is missing', async () => {
        const mockAgent = { startDir: tempDir };
        const input = 'test test.md';
        const result = await action({ mainAgent: mockAgent, promptText: input });
        assert.ok(result.includes('Error') && result.includes('content'));
    });

    it('should show no changes when content is identical', async () => {
        const skillDir = path.join(tempSkillsDir, 'NoChangeSkillExt');
        fs.mkdirSync(skillDir);
        fs.writeFileSync(path.join(skillDir, 'cskill.md'), 'Same content');

        const mockAgent = { startDir: tempDir };
        const input = previewChangesInput('NoChangeSkillExt', 'cskill.md', 'Same content');

        const result = await action({ mainAgent: mockAgent, promptText: input });
        assert.ok(result.includes('No changes'));
    });

    it('should show additions in diff', async () => {
        const skillDir = path.join(tempSkillsDir, 'AdditionSkillExt');
        fs.mkdirSync(skillDir);
        fs.writeFileSync(path.join(skillDir, 'cskill.md'), 'Line 1');

        const mockAgent = { startDir: tempDir };
        const input = previewChangesInput('AdditionSkillExt', 'cskill.md', 'Line 1\nLine 2');

        const result = await action({ mainAgent: mockAgent, promptText: input });
        assert.ok(result.includes('+'), 'Should show addition marker');
    });

    it('should show removals in diff', async () => {
        const skillDir = path.join(tempSkillsDir, 'RemovalSkillExt');
        fs.mkdirSync(skillDir);
        fs.writeFileSync(path.join(skillDir, 'cskill.md'), 'Line 1\nLine 2');

        const mockAgent = { startDir: tempDir };
        const input = previewChangesInput('RemovalSkillExt', 'cskill.md', 'Line 1');

        const result = await action({ mainAgent: mockAgent, promptText: input });
        assert.ok(result.includes('-'), 'Should show removal marker');
    });
});
