import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MainAgent, discoverSkillsFromRoot } from '../achilles-cli/node_modules/achillesAgentLib/MainAgent/index.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const builtInSkillsDir = path.join(__dirname, '..', 'achilles-cli', 'src', 'skills');

function silentLogger() {
    return {
        debug() {},
        info() {},
        log() {},
        warn() {},
        error() {},
    };
}

function registerSkillRoot(agent, skillRoot, isInternal = false) {
    const discovered = discoverSkillsFromRoot(skillRoot, { logger: silentLogger() });
    for (const skillRecord of discovered) {
        skillRecord.isInternal = isInternal;
        agent._registerSkill(skillRecord);
    }
}

describe('MainAgent Integration Tests', () => {
    let tempDir;
    let skillsDir;
    let agent;

    before(() => {
        tempDir = path.join('/tmp', `achilles_integration_${Date.now()}`);
        fs.mkdirSync(tempDir, { recursive: true });
        skillsDir = path.join(tempDir, 'skills');
        fs.mkdirSync(skillsDir);

        const mathSkillDir = path.join(skillsDir, 'SimpleMath');
        fs.mkdirSync(mathSkillDir);
        fs.writeFileSync(
            path.join(mathSkillDir, 'cskill.md'),
            '# Simple Math\n\n## Summary\nA skill for simple calculations.\n\n## Prompt\nSolve math expressions.\n\n## LLM Mode\nfast\n'
        );

        const greeterSkillDir = path.join(skillsDir, 'Greeter');
        fs.mkdirSync(greeterSkillDir);
        fs.writeFileSync(
            path.join(greeterSkillDir, 'cskill.md'),
            '# Greeter\n\n## Summary\nA skill for greetings.\n\n## Prompt\nGenerate a short greeting.\n\n## LLM Mode\nfast\n'
        );

        agent = new MainAgent({
            startDir: tempDir,
            logger: silentLogger(),
        });
        registerSkillRoot(agent, builtInSkillsDir, true);
    });

    after(() => {
        if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('should have built-in and user skills registered', () => {
        const skills = agent.getSkills();
        const names = skills.map((s) => s.name || s.shortName);

        assert.ok(names.some((n) => n.includes('skill-refiner')));
        assert.ok(names.some((n) => n.toLowerCase().includes('simplemath') || n.includes('simple-math')));
        assert.ok(names.some((n) => n.toLowerCase().includes('greeter')));
    });

    it('should execute list-skills action directly', async () => {
        const { action } = await import('../achilles-cli/src/skills/list-skills/list-skills.mjs');
        const result = await action(agent, '');

        assert.ok(result);
        assert.equal(typeof result, 'string');
        assert.ok(result.includes('skill') || result.includes('Found'));
    });

    it('should execute get-template action directly', async () => {
        const { action } = await import('../achilles-cli/src/skills/get-template/get-template.mjs');
        const result = await action(agent, 'cskill');

        assert.ok(result);
        assert.equal(typeof result, 'string');
        assert.ok(result.includes('#') || result.includes('Summary'));
    });

    it('should expose core MainAgent properties', () => {
        assert.ok(agent.startDir);
        assert.ok(agent.llmAgent);
        assert.equal(typeof agent.getSkills, 'function');
        assert.equal(typeof agent.getSkillRecord, 'function');
        assert.equal(typeof agent.executePrompt, 'function');
    });
});

describe('MainAgent + LLMAgent Live Call (optional)', () => {
    const hasKey = Boolean(
        process.env.OPENAI_API_KEY
        || process.env.ANTHROPIC_API_KEY
        || process.env.GEMINI_API_KEY
        || process.env.OPENROUTER_API_KEY
    );

    const testIt = hasKey ? it : it.skip;

    testIt('should get a direct LLM response', async () => {
        const agent = new MainAgent({
            startDir: process.cwd(),
            logger: silentLogger(),
        });
        const response = await agent.llmAgent.executePrompt('Return only the number 4.');
        assert.ok(typeof response === 'string');
        assert.ok(response.includes('4'));
    });
});
