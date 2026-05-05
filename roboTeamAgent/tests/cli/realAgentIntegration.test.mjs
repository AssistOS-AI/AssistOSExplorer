/**
 * Integration tests using real MainAgent.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { MainAgent, discoverSkillsFromRoot } from '../achilles-cli/node_modules/achillesAgentLib/MainAgent/index.mjs';
import { OrchestratorSkillsSubsystem } from '../achilles-cli/node_modules/achillesAgentLib/OrchestratorSkillsSubsystem/index.mjs';

function logger() {
    return {
        debug() {},
        info() {},
        log() {},
        warn() {},
        error() {},
    };
}

function registerSkillRoot(agent, skillRoot, isInternal = false) {
    const discovered = discoverSkillsFromRoot(skillRoot, { logger: logger() });
    for (const skillRecord of discovered) {
        skillRecord.isInternal = isInternal;
        agent._registerSkill(skillRecord);
    }
}

describe('Real MainAgent Integration', () => {
    let tempDir;
    let workingDir;
    let externalRepoDir;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'real-agent-test-'));
        workingDir = path.join(tempDir, 'project');
        externalRepoDir = path.join(tempDir, 'external-repo');

        fs.mkdirSync(workingDir, { recursive: true });

        const localSkillDir = path.join(workingDir, 'skills', 'local-skill');
        fs.mkdirSync(localSkillDir, { recursive: true });
        fs.writeFileSync(path.join(localSkillDir, 'cskill.md'), `# local-skill

## Summary
Local skill.

## Prompt
Return a greeting.
`);

        const externalSkillDir = path.join(externalRepoDir, 'skills', 'external-skill');
        fs.mkdirSync(externalSkillDir, { recursive: true });
        fs.writeFileSync(path.join(externalSkillDir, 'cskill.md'), `# external-skill

## Summary
External skill.

## Prompt
Return a farewell.
`);
    });

    afterEach(() => {
        if (tempDir && fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('should discover local skills on initialization', () => {
        const agent = new MainAgent({
            startDir: workingDir,
            logger: logger(),
        });

        const names = agent.getSkills().map((s) => s.shortName || s.name);
        assert.ok(names.includes('local-skill'));
    });

    it('should discover external skills when external root is registered', () => {
        const externalSkillsPath = path.join(externalRepoDir, 'skills');
        const agent = new MainAgent({
            startDir: workingDir,
            logger: logger(),
        });

        registerSkillRoot(agent, externalSkillsPath, false);

        const names = agent.getSkills().map((s) => s.shortName || s.name);
        assert.ok(names.includes('local-skill'));
        assert.ok(names.includes('external-skill'));
    });
});

describe('Orchestrator allowlist resolution', () => {
    let tempDir;
    let workingDir;
    let externalRepoDir;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestrator-test-'));
        workingDir = path.join(tempDir, 'project');
        externalRepoDir = path.join(tempDir, 'external-repo');

        fs.mkdirSync(workingDir, { recursive: true });

        const localSkillDir = path.join(workingDir, 'skills', 'greeter');
        fs.mkdirSync(localSkillDir, { recursive: true });
        fs.writeFileSync(path.join(localSkillDir, 'cskill.md'), `# Greeter

## Summary
Greeting skill.

## Prompt
Say hello.
`);

        const orchestratorDir = path.join(workingDir, 'skills', 'test-orchestrator');
        fs.mkdirSync(orchestratorDir, { recursive: true });
        fs.writeFileSync(path.join(orchestratorDir, 'oskill.md'), `# Test Orchestrator

## Summary
Routes requests.

## Instructions
Route user requests.

## Allowed-Skills
- greeter
- calculator
`);

        const restrictedDir = path.join(workingDir, 'skills', 'restricted-orchestrator');
        fs.mkdirSync(restrictedDir, { recursive: true });
        fs.writeFileSync(path.join(restrictedDir, 'oskill.md'), `# Restricted Orchestrator

## Summary
Restricted routing.

## Instructions
Route requests.

## Allowed-Skills
- greeter
`);

        const externalSkillDir = path.join(externalRepoDir, 'skills', 'calculator');
        fs.mkdirSync(externalSkillDir, { recursive: true });
        fs.writeFileSync(path.join(externalSkillDir, 'cskill.md'), `# Calculator

## Summary
Math skill.

## Prompt
Calculate expressions.
`);
    });

    afterEach(() => {
        if (tempDir && fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('should resolve explicit allowlisted local and external skills', () => {
        const externalSkillsPath = path.join(externalRepoDir, 'skills');
        const agent = new MainAgent({
            startDir: workingDir,
            logger: logger(),
        });
        registerSkillRoot(agent, externalSkillsPath, false);

        const orchestrator = agent.getSkillRecord('test-orchestrator');
        assert.ok(orchestrator);
        assert.ok(Array.isArray(orchestrator.preparedConfig?.allowedSkills));
        assert.ok(orchestrator.preparedConfig.allowedSkills.includes('greeter'));
        assert.ok(orchestrator.preparedConfig.allowedSkills.includes('calculator'));

        const subsystem = new OrchestratorSkillsSubsystem({ mainAgent: agent });
        const resolved = subsystem.resolveAllowedSkills(orchestrator, agent);
        const names = resolved.map((s) => s.shortName || s.name);

        assert.ok(names.some((n) => n.includes('greeter')));
        assert.ok(names.some((n) => n.includes('calculator')));
        assert.ok(!names.some((n) => n.includes('test-orchestrator')));
    });

    it('should not include non-allowlisted external skills', () => {
        const externalSkillsPath = path.join(externalRepoDir, 'skills');
        const agent = new MainAgent({
            startDir: workingDir,
            logger: logger(),
        });
        registerSkillRoot(agent, externalSkillsPath, false);

        const orchestrator = agent.getSkillRecord('restricted-orchestrator');
        assert.ok(orchestrator);

        const subsystem = new OrchestratorSkillsSubsystem({ mainAgent: agent });
        const resolved = subsystem.resolveAllowedSkills(orchestrator, agent);
        const names = resolved.map((s) => s.shortName || s.name);

        assert.ok(names.some((n) => n.includes('greeter')));
        assert.ok(!names.some((n) => n.includes('calculator')));
    });
});
