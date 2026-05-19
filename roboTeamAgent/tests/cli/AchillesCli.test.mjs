import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MainAgent, discoverSkillsFromRoot } from '../achilles-cli/node_modules/achillesAgentLib/MainAgent/index.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const builtInSkillsDir = path.join(__dirname, '..', 'achilles-cli', 'src', 'skills');

function createSilentLogger() {
    return {
        debug() {},
        info() {},
        log() {},
        warn() {},
        error() {},
    };
}

function registerSkillRoot(agent, skillRoot, isInternal = false) {
    const discovered = discoverSkillsFromRoot(skillRoot, { logger: createSilentLogger() });
    for (const skillRecord of discovered) {
        skillRecord.isInternal = isInternal;
        agent._registerSkill(skillRecord);
    }
}

describe('MainAgent - Initialization', () => {
    let tempDir;

    before(() => {
        tempDir = path.join(__dirname, `temp_init_${Date.now()}`);
        fs.mkdirSync(path.join(tempDir, 'skills'), { recursive: true });
    });

    after(() => {
        if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('should initialize with default options', () => {
        const agent = new MainAgent({
            startDir: tempDir,
            logger: createSilentLogger(),
        });

        assert.equal(agent.startDir, tempDir);
        assert.ok(agent.llmAgent);
        assert.equal(typeof agent.executePrompt, 'function');
        assert.equal(typeof agent.executeSkill, 'function');
        assert.equal(typeof agent.buildSkills, 'function');
    });

    it('should accept a custom logger', () => {
        const logs = [];
        const logger = {
            debug: (msg) => logs.push(`debug:${msg}`),
            info: (msg) => logs.push(`info:${msg}`),
            log: (msg) => logs.push(`log:${msg}`),
            warn: (msg) => logs.push(`warn:${msg}`),
            error: (msg) => logs.push(`error:${msg}`),
        };

        const agent = new MainAgent({ startDir: tempDir, logger });
        assert.strictEqual(agent.logger, logger);
    });
});

describe('MainAgent - Skill Discovery', () => {
    let tempDir;

    before(() => {
        tempDir = path.join(__dirname, `temp_discovery_${Date.now()}`);
        fs.mkdirSync(path.join(tempDir, 'skills'), { recursive: true });
    });

    after(() => {
        if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('should register built-in CLI skills from the bundled skills root', () => {
        const agent = new MainAgent({ startDir: tempDir, logger: createSilentLogger() });
        registerSkillRoot(agent, builtInSkillsDir, true);

        assert.ok(agent.getSkillRecord('skill-refiner-orchestrator'));
        assert.ok(agent.getSkillRecord('skills-orchestrator'));
    });

    it('should discover user code skills from working directory', () => {
        const skillDir = path.join(tempDir, 'skills', 'UserCodeSkill');
        fs.mkdirSync(skillDir, { recursive: true });
        fs.writeFileSync(path.join(skillDir, 'cskill.md'), '# User Code Skill\n\n## Summary\nA user code skill.\n');

        const agent = new MainAgent({ startDir: tempDir, logger: createSilentLogger() });
        const record = agent.getSkillRecord('user-code-skill') || agent.getSkillRecord('UserCodeSkill');

        assert.ok(record);
        assert.equal(record.type, 'cskill');
        assert.equal(record.isInternal, false);
    });

    it('should discover user orchestrator skills from working directory', () => {
        const skillDir = path.join(tempDir, 'skills', 'UserOrchSkill');
        fs.mkdirSync(skillDir, { recursive: true });
        fs.writeFileSync(
            path.join(skillDir, 'oskill.md'),
            '# User Orchestrator\n\n## Summary\nA user orchestrator.\n\n## Instructions\nRoute requests.\n\n## Allowed-Skills\n- list-skills\n'
        );

        const agent = new MainAgent({ startDir: tempDir, logger: createSilentLogger() });
        const record = agent.getSkillRecord('user-orch-skill') || agent.getSkillRecord('UserOrchSkill');

        assert.ok(record);
        assert.equal(record.type, 'orchestrator');
        assert.equal(record.isInternal, false);
    });
});

describe('MainAgent - Runtime APIs', () => {
    let tempDir;
    let agent;

    before(() => {
        tempDir = path.join(__dirname, `temp_runtime_${Date.now()}`);
        fs.mkdirSync(path.join(tempDir, 'skills'), { recursive: true });
        agent = new MainAgent({ startDir: tempDir, logger: createSilentLogger() });
    });

    after(() => {
        if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('should return an array from getSkills()', () => {
        const skills = agent.getSkills();
        assert.ok(Array.isArray(skills));
    });

    it('should support buildSkills() without throwing', async () => {
        await assert.doesNotReject(async () => {
            await agent.buildSkills();
        });
    });

    it('should handle malformed skill files gracefully', () => {
        const badSkillDir = path.join(tempDir, 'skills', 'BadSkill');
        fs.mkdirSync(badSkillDir, { recursive: true });
        fs.writeFileSync(path.join(badSkillDir, 'cskill.md'), 'This is not a structured skill file');

        assert.doesNotThrow(() => {
            new MainAgent({ startDir: tempDir, logger: createSilentLogger() });
        });
    });
});
