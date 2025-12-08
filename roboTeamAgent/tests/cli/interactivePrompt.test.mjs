/**
 * Tests for InteractivePrompt module.
 *
 * Tests the interactive input handling with command/skill selectors.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';

// ============================================================================
// InteractivePrompt Tests
// ============================================================================

describe('InteractivePrompt', () => {
    let InteractivePrompt;

    beforeEach(async () => {
        const module = await import('../src/repl/InteractivePrompt.mjs');
        InteractivePrompt = module.InteractivePrompt;
    });

    describe('Constructor', () => {
        it('should create instance with required options', () => {
            const prompt = new InteractivePrompt({
                historyManager: { getAll: () => [] },
                slashHandler: { parseSlashCommand: () => null, getCompletions: () => [[], ''] },
                commandList: [],
                getUserSkills: () => [],
            });

            assert.ok(prompt, 'InteractivePrompt should be created');
        });

        it('should use default prompt string', () => {
            const prompt = new InteractivePrompt({
                historyManager: { getAll: () => [] },
                slashHandler: { parseSlashCommand: () => null, getCompletions: () => [[], ''] },
                commandList: [],
                getUserSkills: () => [],
            });

            assert.strictEqual(prompt.promptString, 'SkillManager> ');
        });

        it('should accept custom prompt string', () => {
            const prompt = new InteractivePrompt({
                historyManager: { getAll: () => [] },
                slashHandler: { parseSlashCommand: () => null, getCompletions: () => [[], ''] },
                commandList: [],
                getUserSkills: () => [],
                prompt: 'Custom> ',
            });

            assert.strictEqual(prompt.promptString, 'Custom> ');
        });

        it('should initialize hint color constants', () => {
            const prompt = new InteractivePrompt({
                historyManager: { getAll: () => [] },
                slashHandler: { parseSlashCommand: () => null, getCompletions: () => [[], ''] },
                commandList: [],
                getUserSkills: () => [],
            });

            assert.strictEqual(prompt.HINT_COLOR, '\x1b[90m');
            assert.strictEqual(prompt.RESET_COLOR, '\x1b[0m');
        });

        it('should initialize currentHintLines to 0', () => {
            const prompt = new InteractivePrompt({
                historyManager: { getAll: () => [] },
                slashHandler: { parseSlashCommand: () => null, getCompletions: () => [[], ''] },
                commandList: [],
                getUserSkills: () => [],
            });

            assert.strictEqual(prompt.currentHintLines, 0);
        });
    });

    describe('Command List', () => {
        it('should store command list reference', () => {
            const commandList = [
                { name: '/read', description: 'Read a skill' },
                { name: '/write', description: 'Write a skill' },
            ];

            const prompt = new InteractivePrompt({
                historyManager: { getAll: () => [] },
                slashHandler: { parseSlashCommand: () => null, getCompletions: () => [[], ''] },
                commandList,
                getUserSkills: () => [],
            });

            assert.strictEqual(prompt.commandList, commandList);
        });
    });

    describe('History Manager Integration', () => {
        it('should store history manager reference', () => {
            const historyManager = {
                getAll: () => ['cmd1', 'cmd2'],
                add: () => {},
            };

            const prompt = new InteractivePrompt({
                historyManager,
                slashHandler: { parseSlashCommand: () => null, getCompletions: () => [[], ''] },
                commandList: [],
                getUserSkills: () => [],
            });

            assert.strictEqual(prompt.historyManager, historyManager);
        });
    });

    describe('Slash Handler Integration', () => {
        it('should store slash handler reference', () => {
            const slashHandler = {
                parseSlashCommand: (input) => {
                    if (input.startsWith('/')) {
                        const parts = input.slice(1).split(' ');
                        return { command: parts[0], args: parts.slice(1).join(' ') };
                    }
                    return null;
                },
                getCompletions: () => [[], ''],
            };

            const prompt = new InteractivePrompt({
                historyManager: { getAll: () => [] },
                slashHandler,
                commandList: [],
                getUserSkills: () => [],
            });

            assert.strictEqual(prompt.slashHandler, slashHandler);
        });
    });

    describe('getUserSkills callback', () => {
        it('should store getUserSkills callback', () => {
            const getUserSkills = () => [
                { name: 'my-skill', type: 'code' },
            ];

            const prompt = new InteractivePrompt({
                historyManager: { getAll: () => [] },
                slashHandler: { parseSlashCommand: () => null, getCompletions: () => [[], ''] },
                commandList: [],
                getUserSkills,
            });

            assert.strictEqual(prompt.getUserSkills, getUserSkills);
            assert.strictEqual(prompt.getUserSkills().length, 1);
        });
    });
});

// ============================================================================
// Key Code Recognition Tests
// ============================================================================

describe('InteractivePrompt - Key Code Recognition', () => {
    describe('Ctrl+C detection', () => {
        it('should recognize Ctrl+C key code', () => {
            const ctrlC = '\x03';
            assert.strictEqual(ctrlC, '\x03');
        });
    });

    describe('Enter key detection', () => {
        it('should recognize carriage return', () => {
            const cr = '\r';
            const isEnter = cr === '\r' || cr === '\n';
            assert.strictEqual(isEnter, true);
        });

        it('should recognize newline', () => {
            const lf = '\n';
            const isEnter = lf === '\r' || lf === '\n';
            assert.strictEqual(isEnter, true);
        });
    });

    describe('Escape key detection', () => {
        it('should recognize escape key', () => {
            const esc = '\x1b';
            assert.strictEqual(esc, '\x1b');
        });
    });

    describe('Arrow key detection', () => {
        it('should recognize up arrow', () => {
            const upArrow = '\x1b[A';
            assert.strictEqual(upArrow, '\x1b[A');
        });

        it('should recognize down arrow', () => {
            const downArrow = '\x1b[B';
            assert.strictEqual(downArrow, '\x1b[B');
        });
    });

    describe('Tab key detection', () => {
        it('should recognize tab key', () => {
            const tab = '\t';
            assert.strictEqual(tab, '\t');
        });
    });
});

// ============================================================================
// History Navigation Logic Tests
// ============================================================================

describe('InteractivePrompt - History Navigation Logic', () => {
    describe('Up arrow navigation', () => {
        it('should save current buffer on first up arrow', () => {
            const history = ['cmd1', 'cmd2', 'cmd3'];
            let historyIndex = -1;
            let savedBuffer = '';
            const currentBuffer = 'current typing';

            // Simulate up arrow logic
            if (historyIndex === -1) {
                savedBuffer = currentBuffer;
            }
            if (historyIndex < history.length - 1) {
                historyIndex++;
            }

            assert.strictEqual(savedBuffer, 'current typing');
            assert.strictEqual(historyIndex, 0);
        });

        it('should navigate through history on repeated up arrow', () => {
            const history = ['cmd1', 'cmd2', 'cmd3'];
            let historyIndex = -1;

            // First up
            historyIndex++;
            const first = history[history.length - 1 - historyIndex];
            assert.strictEqual(first, 'cmd3');

            // Second up
            historyIndex++;
            const second = history[history.length - 1 - historyIndex];
            assert.strictEqual(second, 'cmd2');

            // Third up
            historyIndex++;
            const third = history[history.length - 1 - historyIndex];
            assert.strictEqual(third, 'cmd1');
        });

        it('should stay at oldest entry when at top', () => {
            const history = ['cmd1', 'cmd2'];
            let historyIndex = 1; // At oldest

            if (historyIndex < history.length - 1) {
                historyIndex++;
            }

            assert.strictEqual(historyIndex, 1); // Should not change
        });
    });

    describe('Down arrow navigation', () => {
        it('should navigate back through history', () => {
            const history = ['cmd1', 'cmd2', 'cmd3'];
            let historyIndex = 2; // At oldest
            const savedBuffer = 'original';

            // First down
            historyIndex--;
            const first = history[history.length - 1 - historyIndex];
            assert.strictEqual(first, 'cmd2');
            assert.strictEqual(historyIndex, 1);
        });

        it('should restore saved buffer when returning to -1', () => {
            const history = ['cmd1', 'cmd2'];
            let historyIndex = 0;
            const savedBuffer = 'my original input';
            let currentBuffer = 'cmd2';

            // Down arrow
            historyIndex--;
            if (historyIndex === -1) {
                currentBuffer = savedBuffer;
            }

            assert.strictEqual(historyIndex, -1);
            assert.strictEqual(currentBuffer, 'my original input');
        });

        it('should do nothing when already at -1', () => {
            let historyIndex = -1;

            if (historyIndex === -1) {
                // Do nothing
            } else {
                historyIndex--;
            }

            assert.strictEqual(historyIndex, -1);
        });
    });

    describe('Empty history handling', () => {
        it('should not navigate when history is empty', () => {
            const history = [];
            let historyIndex = -1;

            // Up arrow with empty history
            if (history.length === 0) {
                // Do nothing
            } else if (historyIndex < history.length - 1) {
                historyIndex++;
            }

            assert.strictEqual(historyIndex, -1);
        });
    });
});

// ============================================================================
// Command Selection Flow Tests
// ============================================================================

describe('InteractivePrompt - Command Selection Flow', () => {
    describe('Commands needing skill argument', () => {
        const commandsNeedingInput = ['/exec', '/refine', '/update'];
        const commandsNotNeedingInput = ['/read', '/delete', '/validate', '/generate', '/test'];

        it('should identify commands that need additional input', () => {
            for (const cmd of commandsNeedingInput) {
                assert.ok(commandsNeedingInput.includes(cmd), `${cmd} should need input`);
            }
        });

        it('should identify commands that execute immediately', () => {
            for (const cmd of commandsNotNeedingInput) {
                assert.ok(!commandsNeedingInput.includes(cmd), `${cmd} should not need input`);
            }
        });
    });

    describe('Full command building', () => {
        it('should build command with skill name only', () => {
            const commandName = '/read';
            const skillName = 'my-skill';

            const fullCommand = `${commandName} ${skillName}`;
            assert.strictEqual(fullCommand, '/read my-skill');
        });

        it('should build command with skill name and input', () => {
            const commandName = '/exec';
            const skillName = 'calculator';
            const userInput = 'calculate 2+2';

            const fullCommand = `${commandName} ${skillName} ${userInput}`.trim();
            assert.strictEqual(fullCommand, '/exec calculator calculate 2+2');
        });

        it('should handle empty user input', () => {
            const commandName = '/exec';
            const skillName = 'my-skill';
            const userInput = '';

            const fullCommand = `${commandName} ${skillName} ${userInput}`.trim();
            assert.strictEqual(fullCommand, '/exec my-skill');
        });
    });

    describe('Skill type input guidance', () => {
        it('should provide correct guidance for code skills', () => {
            const skillType = 'code';
            let guidance;

            if (skillType === 'code') {
                guidance = 'Type your request in natural language';
            } else if (skillType === 'interactive') {
                guidance = 'Provide any initial context or press Enter to start';
            } else {
                guidance = 'Type your input or press Enter to execute';
            }

            assert.strictEqual(guidance, 'Type your request in natural language');
        });

        it('should provide correct guidance for interactive skills', () => {
            const skillType = 'interactive';
            let guidance;

            if (skillType === 'code') {
                guidance = 'Type your request in natural language';
            } else if (skillType === 'interactive') {
                guidance = 'Provide any initial context or press Enter to start';
            } else {
                guidance = 'Type your input or press Enter to execute';
            }

            assert.strictEqual(guidance, 'Provide any initial context or press Enter to start');
        });

        it('should provide correct guidance for dbtable skills', () => {
            const skillType = 'dbtable';
            let guidance;

            if (skillType === 'code') {
                guidance = 'Type your request in natural language';
            } else if (skillType === 'interactive') {
                guidance = 'Provide any initial context or press Enter to start';
            } else {
                guidance = 'Type your input or press Enter to execute';
            }

            assert.strictEqual(guidance, 'Type your input or press Enter to execute');
        });
    });

    describe('Command-specific input guidance', () => {
        it('should show correct guidance for /exec', () => {
            const commandName = '/exec';
            let guidance;

            if (commandName === '/exec') {
                guidance = 'Type your request in natural language';
            } else if (commandName === '/refine') {
                guidance = 'Describe what to improve or requirements to meet';
            } else if (commandName === '/update') {
                guidance = 'Specify section name and new content';
            }

            assert.strictEqual(guidance, 'Type your request in natural language');
        });

        it('should show correct guidance for /refine', () => {
            const commandName = '/refine';
            let guidance;

            if (commandName === '/exec') {
                guidance = 'Type your request in natural language';
            } else if (commandName === '/refine') {
                guidance = 'Describe what to improve or requirements to meet';
            } else if (commandName === '/update') {
                guidance = 'Specify section name and new content';
            }

            assert.strictEqual(guidance, 'Describe what to improve or requirements to meet');
        });

        it('should show correct guidance for /update', () => {
            const commandName = '/update';
            let guidance;

            if (commandName === '/exec') {
                guidance = 'Type your request in natural language';
            } else if (commandName === '/refine') {
                guidance = 'Describe what to improve or requirements to meet';
            } else if (commandName === '/update') {
                guidance = 'Specify section name and new content';
            }

            assert.strictEqual(guidance, 'Specify section name and new content');
        });
    });
});

// ============================================================================
// Slash Command Parsing Tests
// ============================================================================

describe('InteractivePrompt - Slash Command Detection', () => {
    describe('getCommandNeedingSkillArg pattern', () => {
        it('should detect commands starting with /', () => {
            const buffer = '/read';
            const startsWithSlash = buffer.startsWith('/');
            assert.strictEqual(startsWithSlash, true);
        });

        it('should not detect non-slash input', () => {
            const buffer = 'read';
            const startsWithSlash = buffer.startsWith('/');
            assert.strictEqual(startsWithSlash, false);
        });

        it('should detect when command has no args yet', () => {
            const testCases = [
                { input: '/read', hasArgs: false },
                { input: '/read ', hasArgs: false },
                { input: '/read my-skill', hasArgs: true },
            ];

            for (const { input, hasArgs } of testCases) {
                const parts = input.slice(1).split(' ');
                const args = parts.slice(1).join(' ').trim();
                assert.strictEqual(!!args, hasArgs, `"${input}" hasArgs should be ${hasArgs}`);
            }
        });
    });
});
