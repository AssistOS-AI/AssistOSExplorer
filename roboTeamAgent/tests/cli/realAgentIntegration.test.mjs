/**
 * Integration tests using real RecursiveSkilledAgent.
 *
 * These tests verify that skill discovery works correctly
 * with the actual agent, not mocks.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ============================================================================
// Real Agent Integration Tests
// ============================================================================

describe('Real RecursiveSkilledAgent Integration', () => {
    let RecursiveSkilledAgent;
    let tempDir;
    let workingDir;
    let externalRepoDir;

    beforeEach(async () => {
        // Import real modules
        const agentModule = await import('../skill-manager/node_modules/achillesAgentLib/RecursiveSkilledAgents/index.mjs');
        RecursiveSkilledAgent = agentModule.RecursiveSkilledAgent;

        // Create temp directories
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'real-agent-test-'));
        workingDir = path.join(tempDir, 'project');
        externalRepoDir = path.join(tempDir, 'external-repo');

        fs.mkdirSync(workingDir, { recursive: true });

        // Create local skill in working directory
        const localSkillDir = path.join(workingDir, '.AchillesSkills', 'local-skill');
        fs.mkdirSync(localSkillDir, { recursive: true });
        fs.writeFileSync(path.join(localSkillDir, 'cskill.md'), `# local-skill

A local skill in the project.

## Summary

This is a local skill for testing.

## Instructions

Return a greeting.

## Examples

Input: "hello"
Output: "Hello from local skill!"
`);

        // Create external repo with a skill
        const externalSkillDir = path.join(externalRepoDir, '.AchillesSkills', 'external-skill');
        fs.mkdirSync(externalSkillDir, { recursive: true });
        fs.writeFileSync(path.join(externalSkillDir, 'cskill.md'), `# external-skill

An external skill from a repository.

## Summary

This is an external skill for testing repository features.

## Instructions

Return a farewell.

## Examples

Input: "bye"
Output: "Goodbye from external skill!"
`);
    });

    afterEach(() => {
        if (tempDir && fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('should discover local skills on agent initialization', async () => {
        const agent = new RecursiveSkilledAgent({
            startDir: workingDir,
            additionalSkillRoots: [],
        });

        const skills = agent.getSkills();
        const skillNames = skills.map(s => s.shortName || s.name);

        assert.ok(skillNames.includes('local-skill'), 'Should discover local-skill');
    });

    it('should discover external skills when added to additionalSkillRoots at init', async () => {
        const externalSkillsPath = path.join(externalRepoDir, '.AchillesSkills');

        const agent = new RecursiveSkilledAgent({
            startDir: workingDir,
            additionalSkillRoots: [externalSkillsPath],
        });

        const skills = agent.getSkills();
        const skillNames = skills.map(s => s.shortName || s.name);

        assert.ok(skillNames.includes('local-skill'), 'Should discover local-skill');
        assert.ok(skillNames.includes('external-skill'), 'Should discover external-skill');
    });

});

// ============================================================================
// Wildcard Allowed-Skills Integration Tests
// ============================================================================

describe('Orchestrator Wildcard Allowed-Skills Integration', () => {
    let RecursiveSkilledAgent;
    let OrchestratorSkillsSubsystem;
    let tempDir;
    let workingDir;
    let externalRepoDir;

    beforeEach(async () => {
        // Import real modules
        const agentModule = await import('../skill-manager/node_modules/achillesAgentLib/RecursiveSkilledAgents/index.mjs');
        RecursiveSkilledAgent = agentModule.RecursiveSkilledAgent;

        const orchestratorModule = await import('../skill-manager/node_modules/achillesAgentLib/OrchestratorSkillsSubsystem/OrchestratorSkillsSubsystem.mjs');
        OrchestratorSkillsSubsystem = orchestratorModule.OrchestratorSkillsSubsystem;

        // Create temp directories
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wildcard-test-'));
        workingDir = path.join(tempDir, 'project');
        externalRepoDir = path.join(tempDir, 'external-repo');

        fs.mkdirSync(workingDir, { recursive: true });

        // Create a local cgskill (simple skill)
        const localSkillDir = path.join(workingDir, '.AchillesSkills', 'greeter');
        fs.mkdirSync(localSkillDir, { recursive: true });
        fs.writeFileSync(path.join(localSkillDir, 'cgskill.md'), `# Greeter

## Summary
A simple greeting skill.

## Prompt
Say hello to the user.

## LLM-Mode
fast
`);

        // Create an orchestrator WITH wildcard in Allowed-Skills
        const orchestratorDir = path.join(workingDir, '.AchillesSkills', 'test-orchestrator');
        fs.mkdirSync(orchestratorDir, { recursive: true });
        fs.writeFileSync(path.join(orchestratorDir, 'oskill.md'), `# Test Orchestrator

## Summary
An orchestrator that can use all skills via wildcard.

## Instructions
Route user requests to appropriate skills.

## Allowed-Skills
- greeter
- *

## Intents
- greet: Say hello
`);

        // Create external repo with a skill
        const externalSkillDir = path.join(externalRepoDir, '.AchillesSkills', 'calculator');
        fs.mkdirSync(externalSkillDir, { recursive: true });
        fs.writeFileSync(path.join(externalSkillDir, 'cgskill.md'), `# Calculator

## Summary
Performs math calculations.

## Prompt
Perform the requested calculation.

## LLM-Mode
fast
`);
    });

    afterEach(() => {
        if (tempDir && fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('should preserve * wildcard in orchestrator allowedSkills metadata', async () => {
        const agent = new RecursiveSkilledAgent({
            startDir: workingDir,
            additionalSkillRoots: [],
        });

        const skills = agent.getSkills();
        const orchestrator = skills.find(s => s.shortName === 'test-orchestrator' || s.name?.includes('test-orchestrator'));

        assert.ok(orchestrator, 'Should find test-orchestrator skill');
        assert.ok(orchestrator.metadata, 'Orchestrator should have metadata');
        assert.ok(Array.isArray(orchestrator.metadata.allowedSkills), 'Should have allowedSkills array');
        assert.ok(orchestrator.metadata.allowedSkills.includes('*'), 'Should include * wildcard in allowedSkills');
    });

    it('should resolve all skills when * wildcard is present', async () => {
        const externalSkillsPath = path.join(externalRepoDir, '.AchillesSkills');

        const agent = new RecursiveSkilledAgent({
            startDir: workingDir,
            additionalSkillRoots: [externalSkillsPath],
        });

        const skills = agent.getSkills();
        const orchestrator = skills.find(s => s.shortName === 'test-orchestrator' || s.name?.includes('test-orchestrator'));

        assert.ok(orchestrator, 'Should find test-orchestrator skill');

        // Create subsystem and resolve allowed skills
        const subsystem = new OrchestratorSkillsSubsystem({ llmAgent: null });
        const resolvedSkills = subsystem.resolveAllowedSkills(orchestrator, agent);

        const resolvedNames = resolvedSkills.map(s => s.shortName || s.name);

        // Should include the local greeter skill
        assert.ok(resolvedNames.some(n => n.includes('greeter')), 'Should include greeter skill');

        // Should include the external calculator skill
        assert.ok(resolvedNames.some(n => n.includes('calculator')), 'Should include external calculator skill');

        // Should NOT include self (the orchestrator)
        assert.ok(!resolvedNames.some(n => n.includes('test-orchestrator')), 'Should NOT include self');
    });

    it('should include external skills when * wildcard is present after adding repo', async () => {
        // Start WITHOUT external repo
        const agent = new RecursiveSkilledAgent({
            startDir: workingDir,
            additionalSkillRoots: [],
        });

        const skills = agent.getSkills();
        const orchestrator = skills.find(s => s.shortName === 'test-orchestrator' || s.name?.includes('test-orchestrator'));

        // Initially resolve - should NOT include calculator
        const subsystem = new OrchestratorSkillsSubsystem({ llmAgent: null });
        let resolvedSkills = subsystem.resolveAllowedSkills(orchestrator, agent);
        let resolvedNames = resolvedSkills.map(s => s.shortName || s.name);

        assert.ok(!resolvedNames.some(n => n.includes('calculator')), 'Should NOT include calculator initially');

        // Now add external repo to agent's skill roots
        const externalSkillsPath = path.join(externalRepoDir, '.AchillesSkills');
        const agentRoots = agent.getAdditionalSkillRoots();
        agentRoots.push(externalSkillsPath);
        agent.reloadSkills();

        // Re-fetch orchestrator after reload
        const reloadedSkills = agent.getSkills();
        const reloadedOrchestrator = reloadedSkills.find(s => s.shortName === 'test-orchestrator' || s.name?.includes('test-orchestrator'));

        // Now resolve - should include calculator
        resolvedSkills = subsystem.resolveAllowedSkills(reloadedOrchestrator, agent);
        resolvedNames = resolvedSkills.map(s => s.shortName || s.name);

        assert.ok(resolvedNames.some(n => n.includes('calculator')), 'Should include calculator after adding repo');
    });

    it('should still respect explicit allowed skills alongside wildcard', async () => {
        // Create an orchestrator with explicit skill + wildcard
        const orchestratorDir = path.join(workingDir, '.AchillesSkills', 'mixed-orchestrator');
        fs.mkdirSync(orchestratorDir, { recursive: true });
        fs.writeFileSync(path.join(orchestratorDir, 'oskill.md'), `# Mixed Orchestrator

## Summary
Orchestrator with explicit + wildcard skills.

## Instructions
Route requests.

## Allowed-Skills
- greeter
- *
`);

        const externalSkillsPath = path.join(externalRepoDir, '.AchillesSkills');

        const agent = new RecursiveSkilledAgent({
            startDir: workingDir,
            additionalSkillRoots: [externalSkillsPath],
        });

        const skills = agent.getSkills();
        const orchestrator = skills.find(s => s.shortName === 'mixed-orchestrator' || s.name?.includes('mixed-orchestrator'));

        assert.ok(orchestrator, 'Should find mixed-orchestrator');

        // Should have both explicit 'greeter' and '*' in allowedSkills
        assert.ok(orchestrator.metadata.allowedSkills.includes('greeter'), 'Should have explicit greeter');
        assert.ok(orchestrator.metadata.allowedSkills.includes('*'), 'Should have wildcard');

        // Resolve should include all skills
        const subsystem = new OrchestratorSkillsSubsystem({ llmAgent: null });
        const resolvedSkills = subsystem.resolveAllowedSkills(orchestrator, agent);
        const resolvedNames = resolvedSkills.map(s => s.shortName || s.name);

        assert.ok(resolvedNames.some(n => n.includes('greeter')), 'Should include greeter');
        assert.ok(resolvedNames.some(n => n.includes('calculator')), 'Should include calculator via wildcard');
    });

    it('should NOT use wildcard when not present in allowed skills', async () => {
        // Create an orchestrator WITHOUT wildcard
        const restrictedDir = path.join(workingDir, '.AchillesSkills', 'restricted-orchestrator');
        fs.mkdirSync(restrictedDir, { recursive: true });
        fs.writeFileSync(path.join(restrictedDir, 'oskill.md'), `# Restricted Orchestrator

## Summary
Orchestrator with only explicit skills, no wildcard.

## Instructions
Route requests.

## Allowed-Skills
- greeter
`);

        const externalSkillsPath = path.join(externalRepoDir, '.AchillesSkills');

        const agent = new RecursiveSkilledAgent({
            startDir: workingDir,
            additionalSkillRoots: [externalSkillsPath],
        });

        const skills = agent.getSkills();
        const orchestrator = skills.find(s => s.shortName === 'restricted-orchestrator' || s.name?.includes('restricted-orchestrator'));

        assert.ok(orchestrator, 'Should find restricted-orchestrator');

        // Should NOT have wildcard
        assert.ok(!orchestrator.metadata.allowedSkills.includes('*'), 'Should NOT have wildcard');

        // Resolve should only include greeter, not calculator
        const subsystem = new OrchestratorSkillsSubsystem({ llmAgent: null });
        const resolvedSkills = subsystem.resolveAllowedSkills(orchestrator, agent);
        const resolvedNames = resolvedSkills.map(s => s.shortName || s.name);

        assert.ok(resolvedNames.some(n => n.includes('greeter')), 'Should include greeter');
        assert.ok(!resolvedNames.some(n => n.includes('calculator')), 'Should NOT include calculator (no wildcard)');
    });
});
