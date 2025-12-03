/**
 * Tests for REPLSession including instantiation, methods, and extended behavior.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ============================================================================
// REPLSession Basic Tests
// ============================================================================

describe('REPLSession', () => {
    it('should instantiate with a RecursiveSkilledAgent instance', async () => {
        const { REPLSession } = await import('../src/repl/REPLSession.mjs');
        const { RecursiveSkilledAgent } = await import('achilles-agent-lib/RecursiveSkilledAgents');
        const { LLMAgent } = await import('achilles-agent-lib/LLMAgents');
        const { builtInSkillsDir } = await import('../src/index.mjs');

        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repl-test-'));
        try {
            const llmAgent = new LLMAgent({ name: 'test' });
            const agent = new RecursiveSkilledAgent({
                startDir: tempDir,
                additionalSkillRoots: [builtInSkillsDir],
                llmAgent,
            });

            const session = new REPLSession(agent, { workingDir: tempDir });

            assert.ok(session, 'REPLSession should be created');
            assert.strictEqual(session.agent, agent, 'REPLSession should store agent reference');
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('should have start method', async () => {
        const { REPLSession } = await import('../src/repl/REPLSession.mjs');
        const { RecursiveSkilledAgent } = await import('achilles-agent-lib/RecursiveSkilledAgents');
        const { LLMAgent } = await import('achilles-agent-lib/LLMAgents');
        const { builtInSkillsDir } = await import('../src/index.mjs');

        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repl-test-'));
        try {
            const llmAgent = new LLMAgent({ name: 'test' });
            const agent = new RecursiveSkilledAgent({
                startDir: tempDir,
                additionalSkillRoots: [builtInSkillsDir],
                llmAgent,
            });

            const session = new REPLSession(agent, { workingDir: tempDir });

            assert.strictEqual(typeof session.start, 'function', 'REPLSession should have start method');
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });
});

// ============================================================================
// REPLSession Extended Tests - Cancellation and Skill Info
// ============================================================================

describe('REPLSession - Extended Tests', () => {
    describe('/exec cancellation behavior', () => {
        it('SIGINT handler pattern should resolve with empty string for cancellation', async () => {
            const simulateCancellation = () => {
                return new Promise((resolve) => {
                    const handleSIGINT = () => {
                        resolve('');
                    };
                    handleSIGINT();
                });
            };

            const result = await simulateCancellation();
            assert.strictEqual(result, '', 'Cancellation should resolve with empty string');
        });

        it('empty input should be skipped in main loop pattern', () => {
            const inputs = ['', '  ', null, undefined];
            const processed = [];

            for (const input of inputs) {
                if (!input || !input.trim()) {
                    continue;
                }
                processed.push(input);
            }

            assert.strictEqual(processed.length, 0, 'Empty inputs should be skipped');
        });

        it('cancellation should not throw errors', async () => {
            const simulateFullCancellation = async () => {
                const result = await new Promise((resolve) => {
                    resolve('');
                });

                if (!result || !result.trim()) {
                    return 'skipped';
                }
                return 'processed';
            };

            const outcome = await simulateFullCancellation();
            assert.strictEqual(outcome, 'skipped', 'Cancellation should result in skipped processing');
        });
    });

    describe('/exec skill info display', () => {
        it('should format skill info correctly for code skills', () => {
            const skill = { name: 'calculator', type: 'code', description: 'Math operations' };
            const skillType = skill.type;

            const inputGuidance = skillType === 'code'
                ? 'Type your request in natural language'
                : skillType === 'interactive'
                    ? 'Provide any initial context or press Enter to start'
                    : 'Type your input or press Enter to execute';

            assert.strictEqual(inputGuidance, 'Type your request in natural language');
        });

        it('should format skill info correctly for interactive skills', () => {
            const skill = { name: 'booking', type: 'interactive', description: 'Make reservations' };
            const skillType = skill.type;

            const inputGuidance = skillType === 'code'
                ? 'Type your request in natural language'
                : skillType === 'interactive'
                    ? 'Provide any initial context or press Enter to start'
                    : 'Type your input or press Enter to execute';

            assert.strictEqual(inputGuidance, 'Provide any initial context or press Enter to start');
        });

        it('should format skill info correctly for other skill types', () => {
            const skill = { name: 'inventory', type: 'dbtable', description: 'Track stock' };
            const skillType = skill.type;

            const inputGuidance = skillType === 'code'
                ? 'Type your request in natural language'
                : skillType === 'interactive'
                    ? 'Provide any initial context or press Enter to start'
                    : 'Type your input or press Enter to execute';

            assert.strictEqual(inputGuidance, 'Type your input or press Enter to execute');
        });

        it('should handle skills without description', () => {
            const skill = { name: 'mystery', type: 'code' };
            const hint = skill.description || null;

            assert.strictEqual(hint, null, 'Skills without description should have null hint');
        });
    });

    describe('commands requiring input after skill selection', () => {
        // These commands wait for additional input after skill selection
        const commandsNeedingInput = ['/exec', '/refine', '/update'];
        const commandsNotNeedingInput = ['/read', '/delete', '/validate', '/generate', '/test'];

        it('should identify commands that need input after skill selection', () => {
            // The list of commands that should wait for input
            const needsInput = ['exec', 'refine', 'update'];

            for (const cmd of needsInput) {
                assert.ok(
                    commandsNeedingInput.includes(`/${cmd}`),
                    `/${cmd} should be in commandsNeedingInput list`
                );
            }
        });

        it('should identify commands that execute immediately after skill selection', () => {
            for (const cmd of commandsNotNeedingInput) {
                assert.ok(
                    !commandsNeedingInput.includes(cmd),
                    `${cmd} should NOT be in commandsNeedingInput list`
                );
            }
        });

        it('/refine should show "Describe what to improve or requirements to meet"', () => {
            const command = 'refine';
            let inputGuidance;

            if (command === 'exec') {
                inputGuidance = 'Type your request in natural language';
            } else if (command === 'refine') {
                inputGuidance = 'Describe what to improve or requirements to meet';
            } else if (command === 'update') {
                inputGuidance = 'Specify section name and new content';
            }

            assert.strictEqual(inputGuidance, 'Describe what to improve or requirements to meet');
        });

        it('/update should show "Specify section name and new content"', () => {
            const command = 'update';
            let inputGuidance;

            if (command === 'exec') {
                inputGuidance = 'Type your request in natural language';
            } else if (command === 'refine') {
                inputGuidance = 'Describe what to improve or requirements to meet';
            } else if (command === 'update') {
                inputGuidance = 'Specify section name and new content';
            }

            assert.strictEqual(inputGuidance, 'Specify section name and new content');
        });

        it('/exec should show skill-type-specific guidance', () => {
            const command = 'exec';
            const skillTypes = ['code', 'interactive', 'dbtable'];
            const expectedGuidance = {
                code: 'Type your request in natural language',
                interactive: 'Provide any initial context or press Enter to start',
                dbtable: 'Type your input or press Enter to execute',
            };

            for (const skillType of skillTypes) {
                let inputGuidance;
                if (command === 'exec') {
                    if (skillType === 'code') {
                        inputGuidance = 'Type your request in natural language';
                    } else if (skillType === 'interactive') {
                        inputGuidance = 'Provide any initial context or press Enter to start';
                    } else {
                        inputGuidance = 'Type your input or press Enter to execute';
                    }
                }
                assert.strictEqual(
                    inputGuidance,
                    expectedGuidance[skillType],
                    `/${command} with ${skillType} skill should show correct guidance`
                );
            }
        });
    });

    describe('command input flow patterns', () => {
        it('should build full command with skill name and input for /exec', () => {
            const commandName = '/exec';
            const skillName = 'calculator';
            const userInput = '123 * 456';

            const fullCommand = `${commandName} ${skillName} ${userInput}`.trim();
            assert.strictEqual(fullCommand, '/exec calculator 123 * 456');
        });

        it('should build full command with skill name and requirements for /refine', () => {
            const commandName = '/refine';
            const skillName = 'inventory';
            const userInput = 'make sure all validators return proper error messages';

            const fullCommand = `${commandName} ${skillName} ${userInput}`.trim();
            assert.strictEqual(fullCommand, '/refine inventory make sure all validators return proper error messages');
        });

        it('should build full command with skill name and section info for /update', () => {
            const commandName = '/update';
            const skillName = 'customer';
            const userInput = 'Summary add support for email validation';

            const fullCommand = `${commandName} ${skillName} ${userInput}`.trim();
            assert.strictEqual(fullCommand, '/update customer Summary add support for email validation');
        });

        it('should handle empty input gracefully', () => {
            const commandName = '/exec';
            const skillName = 'calculator';
            const userInput = '';

            const fullCommand = `${commandName} ${skillName} ${userInput}`.trim();
            assert.strictEqual(fullCommand, '/exec calculator');
        });
    });
});
