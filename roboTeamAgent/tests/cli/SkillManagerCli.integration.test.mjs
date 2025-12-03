import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { RecursiveSkilledAgent } from 'achilles-agent-lib/RecursiveSkilledAgents';
import { LLMAgent } from 'achilles-agent-lib/LLMAgents';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const builtInSkillsDir = path.join(__dirname, '..', 'src', '.AchillesSkills');

/**
 * Integration tests that make actual LLM API calls.
 * These tests verify that prompts are sound and the agent behaves correctly.
 *
 * Requirements:
 * - Valid LLM API credentials configured
 * - Network access
 *
 * Run with: node --test tests/skill-manager/SkillManagerAgent.integration.test.mjs
 */

describe('RecursiveSkilledAgent Integration Tests (Real LLM Calls)', () => {
    let tempDir;
    let skillsDir;
    let agent;
    let llmAgent;

    before(() => {
        // Setup temp directory for skills in /tmp to isolate from project
        tempDir = path.join('/tmp', 'achilles_integration_' + Date.now());
        fs.mkdirSync(tempDir, { recursive: true });

        skillsDir = path.join(tempDir, '.AchillesSkills');
        fs.mkdirSync(skillsDir);

        // Create a code skill for testing
        const mathSkillDir = path.join(skillsDir, 'SimpleMath');
        fs.mkdirSync(mathSkillDir);
        fs.writeFileSync(
            path.join(mathSkillDir, 'cskill.md'),
            `# Simple Math

## Summary
A skill that performs simple mathematical calculations.

## Prompt
You are a math helper. When given a math problem, solve it step by step and return the final answer.
Always format your response as: "The answer is: [number]"

## LLM Mode
fast
`
        );

        // Create another code skill
        const greeterSkillDir = path.join(skillsDir, 'Greeter');
        fs.mkdirSync(greeterSkillDir);
        fs.writeFileSync(
            path.join(greeterSkillDir, 'cskill.md'),
            `# Greeter

## Summary
A skill that generates friendly greetings.

## Prompt
You are a friendly greeter. When given a name, generate a warm, personalized greeting.
Keep it brief - one sentence only.

## LLM Mode
fast
`
        );

        // Create real LLMAgent
        llmAgent = new LLMAgent({ name: 'integration-test-agent' });

        // Create RecursiveSkilledAgent with built-in skills
        agent = new RecursiveSkilledAgent({
            startDir: tempDir,
            additionalSkillRoots: [builtInSkillsDir],
            llmAgent: llmAgent,
        });

        // Force skill discovery from the temp directory
        agent.reloadSkills();
    });

    after(() => {
        if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    describe('LLMAgent.executePrompt() - Direct API calls', () => {
        it('should get a valid response from the LLM', async () => {
            const response = await llmAgent.executePrompt('What is 2 + 2? Reply with just the number.');

            assert.ok(response, 'Should receive a response');
            assert.ok(typeof response === 'string', 'Response should be a string');
            assert.ok(response.includes('4'), 'Response should contain the answer 4');
        });

        it('should handle conversation history', async () => {
            const response = await llmAgent.executePrompt('What number did I just ask about?', {
                history: [
                    { role: 'user', message: 'Remember the number 42.' },
                    { role: 'assistant', message: 'I will remember 42.' },
                ],
            });

            assert.ok(response, 'Should receive a response');
            assert.ok(response.includes('42'), 'Response should reference the number from history');
        });
    });

    describe('LLMAgent.interpretMessage() - Intent classification', () => {
        it('should classify acceptance intent correctly', async () => {
            const result = await llmAgent.interpretMessage('yes, that looks good', {
                intents: ['accept', 'cancel', 'update'],
            });

            assert.ok(result, 'Should return a result');
            assert.equal(result.intent, 'accept', 'Should classify as accept');
        });

        it('should classify cancellation intent correctly', async () => {
            const result = await llmAgent.interpretMessage('no, cancel that', {
                intents: ['accept', 'cancel', 'update'],
            });

            assert.ok(result, 'Should return a result');
            assert.equal(result.intent, 'cancel', 'Should classify as cancel');
        });

        it('should handle ambiguous messages', async () => {
            const result = await llmAgent.interpretMessage('maybe later', {
                intents: ['accept', 'cancel', 'update'],
            });

            assert.ok(result, 'Should return a result');
            assert.ok(result.intent, 'Should have an intent');
        });
    });

    describe('RecursiveSkilledAgent skill execution', () => {
        it('should have built-in skills registered', () => {
            const skills = agent.getSkills();
            assert.ok(skills.length > 5, 'Should have built-in skills');

            // Check for built-in skills
            const skillNames = skills.map(s => s.name || s.shortName);
            assert.ok(skillNames.some(n => n && n.includes('list-skills')), 'Should have list-skills');
            assert.ok(skillNames.some(n => n && n.includes('read-skill')), 'Should have read-skill');
            assert.ok(skillNames.some(n => n && n.includes('get-template')), 'Should have get-template');
            assert.ok(skillNames.some(n => n && n.includes('write-skill')), 'Should have write-skill');
        });

        it('should execute list-skills action directly', async () => {
            // Import action directly like other tests do
            // Action signature: action(recursiveSkilledAgent, prompt)
            const { action } = await import('../src/.AchillesSkills/list-skills/list-skills.mjs');

            const result = await action(agent, '');

            assert.ok(result, 'Should return a result');
            assert.ok(typeof result === 'string', 'Result should be a string');
            assert.ok(result.includes('skill') || result.includes('Found'), 'Should list skills');
        });

        it('should execute get-template action directly', async () => {
            // Import action directly like other tests do
            // Action signature: action(recursiveSkilledAgent, prompt)
            const { action } = await import('../src/.AchillesSkills/get-template/get-template.mjs');

            const result = await action(agent, 'cskill');

            assert.ok(result, 'Should return a result');
            assert.ok(typeof result === 'string', 'Result should be a string');
            assert.ok(result.includes('#') || result.includes('Summary'), 'Should return template');
        });
    });

    describe('Skill agent properties', () => {
        it('should have core agent properties', () => {
            // Verify the agent has required properties
            assert.ok(agent.startDir, 'Agent should have startDir');
            assert.ok(agent.llmAgent, 'Agent should have llmAgent');
            assert.ok(agent.skillCatalog, 'Agent should have skillCatalog');
        });

        it('should have getSkills method', () => {
            const skills = agent.getSkills();
            assert.ok(Array.isArray(skills), 'getSkills should return an array');
        });
    });
});

describe('Interactive Skill Integration Tests', () => {
    let tempDir;
    let skillsDir;
    let agent;
    let llmAgent;

    before(() => {
        tempDir = path.join('/tmp', 'achilles_interactive_' + Date.now());
        fs.mkdirSync(tempDir, { recursive: true });

        skillsDir = path.join(tempDir, '.AchillesSkills');
        fs.mkdirSync(skillsDir);

        // Create an interactive skill
        const jokerDir = path.join(skillsDir, 'TestJoker');
        fs.mkdirSync(jokerDir);

        fs.writeFileSync(
            path.join(jokerDir, 'iskill.md'),
            `# Test Joker

## Summary
Tells jokes about a given topic.

## Required Arguments
- topic: The subject of the joke
`
        );

        fs.writeFileSync(
            path.join(jokerDir, 'TestJoker.mjs'),
            `export const specs = {
    description: 'Tells jokes about a given topic',
    arguments: {
        topic: {
            description: 'The subject of the joke',
            type: 'string',
        },
    },
};

export async function action({ topic }, { llmAgent }) {
    if (!llmAgent) {
        throw new Error('llmAgent not provided to action');
    }

    const prompt = \`Tell a short, family-friendly joke about \${topic || 'computers'}. Keep it to 2 sentences max.\`;
    const joke = await llmAgent.executePrompt(prompt, { mode: 'fast' });
    return joke;
}
`
        );

        llmAgent = new LLMAgent({ name: 'interactive-test-agent' });

        agent = new RecursiveSkilledAgent({
            startDir: tempDir,
            additionalSkillRoots: [builtInSkillsDir],
            llmAgent: llmAgent,
        });
    });

    after(() => {
        if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    describe('Interactive skill discovery', () => {
        it('should discover interactive skills', () => {
            const interactiveSkills = agent.listSkillsByType('interactive');
            assert.ok(interactiveSkills.length >= 1, 'Should discover interactive skill');
            assert.ok(
                interactiveSkills.some(s => s.shortName === 'TestJoker'),
                'Should discover TestJoker skill'
            );
        });
    });

    describe('runInteractiveSkill with real LLM', () => {
        it('should execute interactive skill with llmAgent in context', async () => {
            const { runInteractiveSkill } = await import('achilles-agent-lib/InteractiveSkillsSubsystem/executor/runInteractiveSkill.mjs');

            let contextReceived = null;

            const testSkill = {
                name: 'test-joke-skill',
                description: 'Test skill',
                argumentMetadata: {
                    topic: {
                        name: 'topic',
                        description: 'Topic for the joke',
                        type: 'string',
                    },
                },
                argumentOrder: ['topic'],
            };

            const testAction = async (args, context) => {
                contextReceived = context;

                // Verify llmAgent is present and functional
                if (!context.llmAgent) {
                    throw new Error('llmAgent missing from context');
                }

                // Actually use the LLM
                const response = await context.llmAgent.executePrompt(
                    `Tell a one-liner joke about ${args.topic || 'testing'}.`
                );

                return response;
            };

            // Auto-accept prompter
            let promptCount = 0;
            const autoPrompter = async () => {
                promptCount++;
                if (promptCount > 3) throw new Error('Too many prompts');
                return 'accept';
            };

            const result = await runInteractiveSkill({
                skill: testSkill,
                action: testAction,
                providedArgs: { topic: 'programming' },
                llmAgent: llmAgent,
                readUserPrompt: autoPrompter,
                taskDescription: 'Tell a joke',
            });

            assert.ok(result, 'Should return a result');
            assert.ok(typeof result === 'string', 'Result should be a string');
            assert.ok(contextReceived, 'Context should have been passed');
            assert.ok(contextReceived.llmAgent, 'llmAgent should be in context');
        });
    });
});

describe('Error Recovery Integration Tests', () => {
    let tempDir;
    let llmAgent;

    before(() => {
        tempDir = path.join('/tmp', 'achilles_error_' + Date.now());
        fs.mkdirSync(tempDir, { recursive: true });
        fs.mkdirSync(path.join(tempDir, '.AchillesSkills'));

        llmAgent = new LLMAgent({ name: 'error-test-agent' });
    });

    after(() => {
        if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('should handle malformed skill gracefully during execution', async () => {
        const skillsDir = path.join(tempDir, '.AchillesSkills');

        // Create a skill with invalid prompt section
        const badSkillDir = path.join(skillsDir, 'BadPrompt');
        if (!fs.existsSync(badSkillDir)) {
            fs.mkdirSync(badSkillDir);
        }
        fs.writeFileSync(
            path.join(badSkillDir, 'cskill.md'),
            `# Bad Prompt Skill

## Summary
This skill has no prompt section.
`
        );

        const agent = new RecursiveSkilledAgent({
            startDir: tempDir,
            additionalSkillRoots: [builtInSkillsDir],
            llmAgent: llmAgent,
        });

        // Import and call list-skills action directly
        const { action } = await import('../src/.AchillesSkills/list-skills/list-skills.mjs');
        const result = await action('', {
            skilledAgent: agent,
            llmAgent: agent.llmAgent,
        });

        assert.ok(result, 'Should list skills without crashing');
        assert.ok(typeof result === 'string', 'Result should be a string');
    });
});
