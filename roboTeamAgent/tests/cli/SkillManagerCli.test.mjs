import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { RecursiveSkilledAgent } from 'achillesAgentLib/RecursiveSkilledAgents';
import { LLMAgent } from 'achillesAgentLib/LLMAgents';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const builtInSkillsDir = path.join(__dirname, '..', 'src', '.AchillesSkills');

/**
 * Unit tests for RecursiveSkilledAgent with additionalSkillRoots.
 * Tests the structural and file-system aspects without requiring actual LLM API calls.
 */

describe('RecursiveSkilledAgent - Initialization', () => {
    let tempDir;
    let skillsDir;
    let agent;
    let realLLMAgent;

    before(() => {
        tempDir = path.join(__dirname, 'temp_init_' + Date.now());
        fs.mkdirSync(tempDir, { recursive: true });
        skillsDir = path.join(tempDir, '.AchillesSkills');
        fs.mkdirSync(skillsDir);
        realLLMAgent = new LLMAgent({ name: 'test-agent' });
    });

    after(() => {
        if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('should initialize with default options', () => {
        agent = new RecursiveSkilledAgent({
            startDir: tempDir,
            additionalSkillRoots: [builtInSkillsDir],
            llmAgent: realLLMAgent,
        });

        assert.ok(agent.startDir, 'Should have startDir set');
        assert.equal(agent.startDir, tempDir, 'startDir should match');
        assert.ok(agent.llmAgent, 'Should have llmAgent set');
        assert.ok(agent.skillCatalog, 'Should have skillCatalog');
    });

    it('should store additionalSkillRoots', () => {
        agent = new RecursiveSkilledAgent({
            startDir: tempDir,
            additionalSkillRoots: [builtInSkillsDir],
            llmAgent: realLLMAgent,
        });

        assert.ok(agent.additionalSkillRoots, 'Should have additionalSkillRoots');
        assert.ok(agent.additionalSkillRoots.includes(builtInSkillsDir), 'additionalSkillRoots should include built-in skills');
    });

    it('should use console as default logger', () => {
        agent = new RecursiveSkilledAgent({
            startDir: tempDir,
            additionalSkillRoots: [builtInSkillsDir],
            llmAgent: realLLMAgent,
        });

        assert.strictEqual(agent.logger, console, 'Default logger should be console');
    });

    it('should accept custom logger', () => {
        const logs = [];
        const customLogger = {
            log: (msg) => logs.push({ level: 'log', msg }),
            warn: (msg) => logs.push({ level: 'warn', msg }),
            error: (msg) => logs.push({ level: 'error', msg }),
        };

        agent = new RecursiveSkilledAgent({
            startDir: tempDir,
            additionalSkillRoots: [builtInSkillsDir],
            llmAgent: realLLMAgent,
            logger: customLogger,
        });

        assert.strictEqual(agent.logger, customLogger, 'Should use provided logger');
    });
});

describe('RecursiveSkilledAgent - Built-in Skills Discovery', () => {
    let tempDir;
    let agent;
    let realLLMAgent;

    before(() => {
        tempDir = path.join(__dirname, 'temp_builtin_' + Date.now());
        fs.mkdirSync(tempDir, { recursive: true });
        realLLMAgent = new LLMAgent({ name: 'builtin-test-agent' });

        agent = new RecursiveSkilledAgent({
            startDir: tempDir,
            additionalSkillRoots: [builtInSkillsDir],
            llmAgent: realLLMAgent,
        });
    });

    after(() => {
        if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('should discover built-in skills', () => {
        const skills = agent.getSkills();
        assert.ok(skills.length > 0, 'Should discover built-in skills');
    });

    it('should have list-skills skill', () => {
        const skill = agent.getSkillRecord('list-skills');
        assert.ok(skill, 'list-skills skill should exist');
    });

    it('should have read-skill skill', () => {
        const skill = agent.getSkillRecord('read-skill');
        assert.ok(skill, 'read-skill skill should exist');
    });

    it('should have write-skill skill', () => {
        const skill = agent.getSkillRecord('write-skill');
        assert.ok(skill, 'write-skill skill should exist');
    });

    it('should have delete-skill skill', () => {
        const skill = agent.getSkillRecord('delete-skill');
        assert.ok(skill, 'delete-skill skill should exist');
    });

    it('should have validate-skill skill', () => {
        const skill = agent.getSkillRecord('validate-skill');
        assert.ok(skill, 'validate-skill skill should exist');
    });

    it('should have get-template skill', () => {
        const skill = agent.getSkillRecord('get-template');
        assert.ok(skill, 'get-template skill should exist');
    });

    it('should have update-section skill', () => {
        const skill = agent.getSkillRecord('update-section');
        assert.ok(skill, 'update-section skill should exist');
    });

    it('should have preview-changes skill', () => {
        const skill = agent.getSkillRecord('preview-changes');
        assert.ok(skill, 'preview-changes skill should exist');
    });

    it('should have generate-code skill', () => {
        const skill = agent.getSkillRecord('generate-code');
        assert.ok(skill, 'generate-code skill should exist');
    });

    it('should have test-code skill', () => {
        const skill = agent.getSkillRecord('test-code');
        assert.ok(skill, 'test-code skill should exist');
    });

    it('should have skills-orchestrator', () => {
        const skill = agent.getSkillRecord('skills-orchestrator');
        assert.ok(skill, 'skills-orchestrator skill should exist');
    });

    it('should have skill-refiner orchestrator', () => {
        const skill = agent.getSkillRecord('skill-refiner');
        assert.ok(skill, 'skill-refiner skill should exist');
    });
});

describe('RecursiveSkilledAgent - getSkills method', () => {
    let tempDir;
    let agent;
    let realLLMAgent;

    before(() => {
        tempDir = path.join(__dirname, 'temp_getskills_' + Date.now());
        fs.mkdirSync(tempDir, { recursive: true });
        realLLMAgent = new LLMAgent({ name: 'getskills-test-agent' });

        agent = new RecursiveSkilledAgent({
            startDir: tempDir,
            additionalSkillRoots: [builtInSkillsDir],
            llmAgent: realLLMAgent,
        });
    });

    after(() => {
        if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('should return an array', () => {
        const skills = agent.getSkills();
        assert.ok(Array.isArray(skills), 'getSkills should return an array');
    });

    it('should return skills with expected properties', () => {
        const skills = agent.getSkills();
        assert.ok(skills.length > 0, 'Should have skills');

        const skill = skills[0];
        assert.ok(skill.name, 'Skill should have name');
        assert.ok(skill.type, 'Skill should have type');
    });
});

describe('RecursiveSkilledAgent - reloadSkills method', () => {
    let tempDir;
    let skillsDir;
    let agent;
    let realLLMAgent;

    before(() => {
        tempDir = path.join(__dirname, 'temp_reload_' + Date.now());
        fs.mkdirSync(tempDir, { recursive: true });
        skillsDir = path.join(tempDir, '.AchillesSkills');
        fs.mkdirSync(skillsDir);
        realLLMAgent = new LLMAgent({ name: 'reload-test-agent' });

        agent = new RecursiveSkilledAgent({
            startDir: tempDir,
            additionalSkillRoots: [builtInSkillsDir],
            llmAgent: realLLMAgent,
        });
    });

    after(() => {
        if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('should return skill count', () => {
        const count = agent.reloadSkills();
        assert.ok(typeof count === 'number', 'reloadSkills should return a number');
        assert.ok(count > 0, 'Should have skills after reload');
    });

    it('should discover newly added skills', () => {
        const initialCount = agent.getSkills().length;

        // Add a new skill
        const newSkillDir = path.join(skillsDir, 'NewTestSkill');
        fs.mkdirSync(newSkillDir);
        fs.writeFileSync(
            path.join(newSkillDir, 'cskill.md'),
            '# New Test Skill\n\n## Summary\nA dynamically added skill.'
        );

        agent.reloadSkills();
        const newCount = agent.getSkills().length;

        assert.ok(newCount > initialCount, 'Should have more skills after adding one');
    });

    it('should not create duplicate skills on multiple reloads', () => {
        agent.reloadSkills();
        const countAfterFirst = agent.getSkills().length;

        agent.reloadSkills();
        const countAfterSecond = agent.getSkills().length;

        assert.equal(countAfterFirst, countAfterSecond, 'Skill count should not change on second reload');
    });
});

describe('RecursiveSkilledAgent - executePrompt method', () => {
    let tempDir;
    let agent;
    let realLLMAgent;

    before(() => {
        tempDir = path.join(__dirname, 'temp_execute_' + Date.now());
        fs.mkdirSync(tempDir, { recursive: true });
        realLLMAgent = new LLMAgent({ name: 'execute-test-agent' });

        agent = new RecursiveSkilledAgent({
            startDir: tempDir,
            additionalSkillRoots: [builtInSkillsDir],
            llmAgent: realLLMAgent,
        });
    });

    after(() => {
        if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('should have executePrompt method', () => {
        assert.equal(typeof agent.executePrompt, 'function', 'Should have executePrompt method');
    });

    it('should have getSkills method', () => {
        assert.equal(typeof agent.getSkills, 'function', 'Should have getSkills method');
    });

    it('should have reloadSkills method', () => {
        assert.equal(typeof agent.reloadSkills, 'function', 'Should have reloadSkills method');
    });
});

describe('RecursiveSkilledAgent - User Skills Discovery', () => {
    let tempDir;
    let skillsDir;
    let realLLMAgent;

    before(() => {
        tempDir = path.join(__dirname, 'temp_userskills_' + Date.now());
        fs.mkdirSync(tempDir, { recursive: true });
        skillsDir = path.join(tempDir, '.AchillesSkills');
        fs.mkdirSync(skillsDir);
        realLLMAgent = new LLMAgent({ name: 'userskills-test-agent' });
    });

    after(() => {
        if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('should discover user code skills (cskill.md)', () => {
        const codeSkillDir = path.join(skillsDir, 'UserCodeSkill');
        fs.mkdirSync(codeSkillDir);
        fs.writeFileSync(
            path.join(codeSkillDir, 'cskill.md'),
            '# User Code Skill\n\n## Summary\nA user-defined code skill.'
        );

        const agent = new RecursiveSkilledAgent({
            startDir: tempDir,
            additionalSkillRoots: [builtInSkillsDir],
            llmAgent: realLLMAgent,
        });

        const skill = agent.getSkillRecord('UserCodeSkill');
        assert.ok(skill, 'Should discover user code skill');
        assert.equal(skill.type, 'code', 'Should be of type code');
    });

    it('should discover user orchestrator skills (oskill.md)', () => {
        const orchSkillDir = path.join(skillsDir, 'UserOrchSkill');
        fs.mkdirSync(orchSkillDir);
        fs.writeFileSync(
            path.join(orchSkillDir, 'oskill.md'),
            '# User Orchestrator\n\n## Summary\nA user-defined orchestrator skill.\n\n## Instructions\nRoute requests.\n\n## Allowed-Skills\n- list-skills'
        );

        const agent = new RecursiveSkilledAgent({
            startDir: tempDir,
            additionalSkillRoots: [builtInSkillsDir],
            llmAgent: realLLMAgent,
        });

        const skill = agent.getSkillRecord('UserOrchSkill');
        assert.ok(skill, 'Should discover user orchestrator skill');
        assert.equal(skill.type, 'orchestrator', 'Should be of type orchestrator');
    });
});

describe('RecursiveSkilledAgent - Error Handling', () => {
    let realLLMAgent;

    before(() => {
        realLLMAgent = new LLMAgent({ name: 'error-test-agent' });
    });

    it('should handle empty skills directory', () => {
        const tempDir = path.join('/tmp', 'achilles_empty_' + Date.now());
        fs.mkdirSync(tempDir, { recursive: true });
        fs.mkdirSync(path.join(tempDir, '.AchillesSkills'));

        const agent = new RecursiveSkilledAgent({
            startDir: tempDir,
            additionalSkillRoots: [builtInSkillsDir],
            llmAgent: realLLMAgent,
        });

        assert.ok(agent, 'Agent should be created with empty skills directory');
        // Should still have built-in skills
        assert.ok(agent.getSkills().length > 0, 'Should have built-in skills');

        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('should handle malformed skill files gracefully', () => {
        const tempDir = path.join(__dirname, 'temp_malformed_' + Date.now());
        fs.mkdirSync(tempDir, { recursive: true });
        const skillsDir = path.join(tempDir, '.AchillesSkills');
        fs.mkdirSync(skillsDir);

        const badSkillDir = path.join(skillsDir, 'BadSkill');
        fs.mkdirSync(badSkillDir);
        fs.writeFileSync(
            path.join(badSkillDir, 'cskill.md'),
            'This is not valid markdown skill format'
        );

        assert.doesNotThrow(() => {
            new RecursiveSkilledAgent({
                startDir: tempDir,
                additionalSkillRoots: [builtInSkillsDir],
                llmAgent: realLLMAgent,
            });
        });

        fs.rmSync(tempDir, { recursive: true, force: true });
    });
});
