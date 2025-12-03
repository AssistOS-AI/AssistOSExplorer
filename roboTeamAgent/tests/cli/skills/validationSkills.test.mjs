/**
 * Tests for validation skill modules: validate-skill, get-template
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
// validate-skill Tests
// ============================================================================

describe('validate-skill module - Extended Tests', () => {
    let action;
    let tempDir;
    let tempSkillsDir;

    before(async () => {
        const module = await import('../../src/.AchillesSkills/validate-skill/validate-skill.mjs');
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
            startDir: tempDir,
            getSkillRecord: () => ({
                skillDir,
                filePath: path.join(skillDir, 'tskill.md'),
            }),
        };

        const result = await action(mockAgent, 'TypeDetectSkill');
        assert.ok(result.includes('Detected Type: tskill'));
    });

    it('should show errors and warnings separately', async () => {
        const skillDir = path.join(tempSkillsDir, 'ErrorWarnSkill');
        fs.mkdirSync(skillDir);
        fs.writeFileSync(path.join(skillDir, 'cskill.md'), '# Code\n\n## Summary\nTest\n\n## Prompt\nTest');

        const mockAgent = {
            startDir: tempDir,
            getSkillRecord: () => ({
                skillDir,
                filePath: path.join(skillDir, 'cskill.md'),
            }),
        };

        const result = await action(mockAgent, 'ErrorWarnSkill');
        assert.ok(result.includes('Warnings:') || result.includes('No issues found'));
    });

    it('should accept object input', async () => {
        const skillDir = path.join(tempSkillsDir, 'ObjValidateSkill');
        fs.mkdirSync(skillDir);
        fs.writeFileSync(path.join(skillDir, 'cskill.md'), '# Obj\n\n## Summary\nTest\n\n## Prompt\nTest');

        const mockAgent = {
            startDir: tempDir,
            getSkillRecord: () => null,
        };

        const result = await action(mockAgent, { skillName: 'ObjValidateSkill' });
        assert.ok(result.includes('Validation') || result.includes('VALID'));
    });
});

// ============================================================================
// get-template Tests
// ============================================================================

describe('get-template module - Extended Tests', () => {
    let action;

    before(async () => {
        const module = await import('../../src/.AchillesSkills/get-template/get-template.mjs');
        action = module.action;
    });

    it('should return template for iskill', async () => {
        const mockAgent = { startDir: '/tmp' };
        const result = await action(mockAgent, 'iskill');
        assert.ok(result.includes('Commands') || result.includes('iskill') || result.includes('Template'));
    });

    it('should return template for mskill', async () => {
        const mockAgent = { startDir: '/tmp' };
        const result = await action(mockAgent, 'mskill');
        assert.ok(result.includes('MCP') || result.includes('mskill') || result.includes('Template'));
    });

    it('should accept object input', async () => {
        const mockAgent = { startDir: '/tmp' };
        const result = await action(mockAgent, { skillType: 'tskill' });
        assert.ok(result.includes('Table Purpose') || result.includes('Fields') || result.includes('Template'));
    });

    it('should show required and optional sections', async () => {
        const mockAgent = { startDir: '/tmp' };
        const result = await action(mockAgent, 'tskill');
        assert.ok(result.includes('Required sections'));
        assert.ok(result.includes('Optional sections'));
    });

    it('should include template markers', async () => {
        const mockAgent = { startDir: '/tmp' };
        const result = await action(mockAgent, 'cskill');
        assert.ok(result.includes('TEMPLATE START'));
        assert.ok(result.includes('TEMPLATE END'));
    });
});
