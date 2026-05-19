/**
 * Tests for orchestrator skill definitions: achilles-cli, skill-refiner
 *
 * These tests verify the skill definition files are valid and contain expected content.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILLS_BASE = path.join(__dirname, '../../achilles-cli/src/skills');
const PROMPTS_BASE = path.join(__dirname, '../../achilles-cli/src/prompts');

// ============================================================================
// Main orchestrator prompt tests
// ============================================================================

describe('main orchestrator prompt', () => {
    it('should have orchestrator prompt module', async () => {
        const promptPath = path.join(PROMPTS_BASE, 'orchestrator-prompt.mjs');
        assert.ok(fs.existsSync(promptPath), 'orchestrator-prompt.mjs should exist');

        const content = fs.readFileSync(promptPath, 'utf8');
        assert.ok(content.includes('buildOrchestratorSystemPrompt'), 'Should export prompt builder');
    });

    it('should include concise communication and skill ambiguity guidance', async () => {
        const promptPath = path.join(PROMPTS_BASE, 'orchestrator-prompt.mjs');
        const content = fs.readFileSync(promptPath, 'utf8');

        assert.ok(content.includes('concise'), 'Should include concise communication guidance');
        assert.ok(content.includes('skill type'), 'Should mention skill type ambiguity');
        assert.ok(!content.includes('list-skills, read-skill, write-skill'), 'Should not hard-code hidden skill-management tool lists');
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
