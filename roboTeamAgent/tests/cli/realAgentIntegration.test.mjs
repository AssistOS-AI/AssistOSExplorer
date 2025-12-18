/**
 * Integration tests using real RecursiveSkilledAgent.
 *
 * These tests verify that external repository features work correctly
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
    let RepoManager;
    let SlashCommandHandler;
    let tempDir;
    let workingDir;
    let externalRepoDir;
    let globalReposDir;

    beforeEach(async () => {
        // Import real modules
        const agentModule = await import('../skill-manager/node_modules/achillesAgentLib/RecursiveSkilledAgents/index.mjs');
        RecursiveSkilledAgent = agentModule.RecursiveSkilledAgent;

        const repoModule = await import('../skill-manager/src/lib/RepoManager.mjs');
        RepoManager = repoModule.RepoManager;

        const slashModule = await import('../skill-manager/src/repl/SlashCommandHandler.mjs');
        SlashCommandHandler = slashModule.SlashCommandHandler;

        // Create temp directories
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'real-agent-test-'));
        workingDir = path.join(tempDir, 'project');
        externalRepoDir = path.join(tempDir, 'external-repo');
        globalReposDir = path.join(tempDir, 'global-repos');

        fs.mkdirSync(workingDir, { recursive: true });
        fs.mkdirSync(globalReposDir, { recursive: true });

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

    it('should discover external skills after /add-repo and _syncAgentSkillRoots', async () => {
        // Initialize agent WITHOUT external repo
        const agent = new RecursiveSkilledAgent({
            startDir: workingDir,
            additionalSkillRoots: [],
        });

        // Verify external skill is NOT present initially
        let skills = agent.getSkills();
        let skillNames = skills.map(s => s.shortName || s.name);
        assert.ok(skillNames.includes('local-skill'), 'Should have local-skill');
        assert.ok(!skillNames.includes('external-skill'), 'Should NOT have external-skill yet');

        // Set up RepoManager and SlashCommandHandler
        const repoManager = new RepoManager({
            workingDir,
            globalReposDir,
        });

        const handler = new SlashCommandHandler({
            executeSkill: async () => {},
            getUserSkills: () => agent.getSkills().filter(s => !s.skillDir?.includes('node_modules')),
            getSkills: () => agent.getSkills(),
            getRepositories: () => repoManager.listRepositories(),
        });

        // Add external repo using slash command
        const result = await handler.executeSlashCommand('add-repo', externalRepoDir, {
            context: { repoManager, skilledAgent: agent },
        });

        assert.strictEqual(result.handled, true);
        assert.ok(result.result?.includes('added') || result.result?.includes('success'),
            `Expected success message, got: ${result.result || result.error}`);

        // Verify external skill IS now present
        skills = agent.getSkills();
        skillNames = skills.map(s => s.shortName || s.name);

        assert.ok(skillNames.includes('local-skill'), 'Should still have local-skill');
        assert.ok(skillNames.includes('external-skill'), 'Should NOW have external-skill after add-repo');
    });

    it('should remove external skills after /remove-repo and _syncAgentSkillRoots', async () => {
        const externalSkillsPath = path.join(externalRepoDir, '.AchillesSkills');

        // Initialize agent WITH external repo
        const agent = new RecursiveSkilledAgent({
            startDir: workingDir,
            additionalSkillRoots: [externalSkillsPath],
        });

        // Verify both skills are present
        let skills = agent.getSkills();
        let skillNames = skills.map(s => s.shortName || s.name);
        assert.ok(skillNames.includes('local-skill'), 'Should have local-skill');
        assert.ok(skillNames.includes('external-skill'), 'Should have external-skill');

        // Set up RepoManager with the external repo already configured
        const configPath = path.join(workingDir, '.skill-manager.json');
        const config = {
            version: 1,
            repositories: [{
                name: 'external-repo',
                source: externalRepoDir,
                type: 'local',
                localPath: externalRepoDir,
                skillsPath: externalSkillsPath,
                enabled: true,
            }],
        };
        fs.writeFileSync(configPath, JSON.stringify(config), 'utf8');

        const repoManager = new RepoManager({
            workingDir,
            globalReposDir,
        });

        const handler = new SlashCommandHandler({
            executeSkill: async () => {},
            getUserSkills: () => agent.getSkills().filter(s => !s.skillDir?.includes('node_modules')),
            getSkills: () => agent.getSkills(),
            getRepositories: () => repoManager.listRepositories(),
        });

        // Remove external repo using slash command
        const result = await handler.executeSlashCommand('remove-repo', 'external-repo', {
            context: { repoManager, skilledAgent: agent },
        });

        assert.strictEqual(result.handled, true);
        assert.ok(result.result?.includes('removed'), `Expected removed message, got: ${result.result || result.error}`);

        // Verify external skill is gone
        skills = agent.getSkills();
        skillNames = skills.map(s => s.shortName || s.name);

        assert.ok(skillNames.includes('local-skill'), 'Should still have local-skill');
        assert.ok(!skillNames.includes('external-skill'), 'Should NOT have external-skill after remove-repo');
    });

    it('should hide skills after /disable-repo and show after /enable-repo', async () => {
        const externalSkillsPath = path.join(externalRepoDir, '.AchillesSkills');

        // Initialize agent WITH external repo
        const agent = new RecursiveSkilledAgent({
            startDir: workingDir,
            additionalSkillRoots: [externalSkillsPath],
        });

        // Set up RepoManager with the external repo configured
        const configPath = path.join(workingDir, '.skill-manager.json');
        const config = {
            version: 1,
            repositories: [{
                name: 'external-repo',
                source: externalRepoDir,
                type: 'local',
                localPath: externalRepoDir,
                skillsPath: externalSkillsPath,
                enabled: true,
            }],
        };
        fs.writeFileSync(configPath, JSON.stringify(config), 'utf8');

        const repoManager = new RepoManager({
            workingDir,
            globalReposDir,
        });

        const handler = new SlashCommandHandler({
            executeSkill: async () => {},
            getUserSkills: () => agent.getSkills().filter(s => !s.skillDir?.includes('node_modules')),
            getSkills: () => agent.getSkills(),
            getRepositories: () => repoManager.listRepositories(),
        });

        // Verify both skills are present initially
        let skills = agent.getSkills();
        let skillNames = skills.map(s => s.shortName || s.name);
        assert.ok(skillNames.includes('external-skill'), 'Should have external-skill initially');

        // Disable the repo
        const disableResult = await handler.executeSlashCommand('disable-repo', 'external-repo', {
            context: { repoManager, skilledAgent: agent },
        });
        assert.ok(disableResult.result?.includes('disabled'), 'Should confirm disabled');

        // Verify external skill is gone
        skills = agent.getSkills();
        skillNames = skills.map(s => s.shortName || s.name);
        assert.ok(!skillNames.includes('external-skill'), 'Should NOT have external-skill after disable');

        // Re-enable the repo
        const enableResult = await handler.executeSlashCommand('enable-repo', 'external-repo', {
            context: { repoManager, skilledAgent: agent },
        });
        assert.ok(enableResult.result?.includes('enabled'), 'Should confirm enabled');

        // Verify external skill is back
        skills = agent.getSkills();
        skillNames = skills.map(s => s.shortName || s.name);
        assert.ok(skillNames.includes('external-skill'), 'Should have external-skill after re-enable');
    });

    it('should filter skills correctly with /ls --repo using real agent', async () => {
        const externalSkillsPath = path.join(externalRepoDir, '.AchillesSkills');

        // Initialize agent WITH external repo
        const agent = new RecursiveSkilledAgent({
            startDir: workingDir,
            additionalSkillRoots: [externalSkillsPath],
        });

        // Set up RepoManager with the external repo configured
        const configPath = path.join(workingDir, '.skill-manager.json');
        const config = {
            version: 1,
            repositories: [{
                name: 'external-repo',
                source: externalRepoDir,
                type: 'local',
                localPath: externalRepoDir,
                skillsPath: externalSkillsPath,
                enabled: true,
            }],
        };
        fs.writeFileSync(configPath, JSON.stringify(config), 'utf8');

        const repoManager = new RepoManager({
            workingDir,
            globalReposDir,
        });

        const handler = new SlashCommandHandler({
            executeSkill: async () => {},
            getUserSkills: () => agent.getSkills().filter(s => !s.skillDir?.includes('node_modules')),
            getSkills: () => agent.getSkills(),
            getRepositories: () => repoManager.listRepositories(),
        });

        // Use /ls --repo to filter
        const result = await handler.executeSlashCommand('ls', '--repo external-repo', {
            context: { repoManager },
        });

        assert.strictEqual(result.handled, true);
        assert.ok(result.result?.includes('external-skill'), 'Should show external-skill');
        assert.ok(!result.result?.includes('local-skill'), 'Should NOT show local-skill');
    });
});
