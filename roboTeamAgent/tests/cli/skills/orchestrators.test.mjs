/**
 * Tests for orchestrator skill definitions: skill-manager, skill-refiner
 *
 * These tests verify the skill definition files are valid and contain expected content.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILLS_BASE = path.join(__dirname, '../../src/.AchillesSkills');

// ============================================================================
// skill-manager Orchestrator Tests
// ============================================================================

describe('skills-orchestrator', () => {
    it('should have valid oskill.md definition', async () => {
        const skillPath = path.join(SKILLS_BASE, 'skills-orchestrator', 'oskill.md');
        assert.ok(fs.existsSync(skillPath), 'skills-orchestrator oskill.md should exist');

        const content = fs.readFileSync(skillPath, 'utf8');
        assert.ok(content.includes('## Instructions'), 'Should have Instructions section');
        assert.ok(content.includes('## Allowed-Skills'), 'Should have Allowed-Skills section');
    });

    it('should list all expected allowed skills', async () => {
        const skillPath = path.join(SKILLS_BASE, 'skills-orchestrator', 'oskill.md');
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
        const skillPath = path.join(SKILLS_BASE, 'skills-orchestrator', 'oskill.md');
        const content = fs.readFileSync(skillPath, 'utf8');

        assert.ok(content.includes('## Intents'), 'Should have Intents section');
        assert.ok(content.includes('list') || content.includes('List'), 'Should have list intent');
        assert.ok(content.includes('read') || content.includes('Read'), 'Should have read intent');
        assert.ok(content.includes('create') || content.includes('Create'), 'Should have create intent');
    });

    it('should have example usage in instructions', async () => {
        const skillPath = path.join(SKILLS_BASE, 'skills-orchestrator', 'oskill.md');
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
