/**
 * Tests for skills directory structure
 *
 * Verifies all expected skill directories exist and contain proper definition files.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILLS_BASE = path.join(__dirname, '../../src/.AchillesSkills');

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
        'skills-orchestrator',
        'execute-skill',
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
