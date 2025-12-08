/**
 * Tests for QuickCommands module.
 *
 * Tests the built-in quick commands that don't need LLM processing.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';

// ============================================================================
// QuickCommands Tests
// ============================================================================

describe('QuickCommands', () => {
    let QuickCommands;

    beforeEach(async () => {
        const module = await import('../src/repl/QuickCommands.mjs');
        QuickCommands = module.QuickCommands;
    });

    describe('Constructor', () => {
        it('should create instance with required options', () => {
            const commands = new QuickCommands({
                getUserSkills: () => [],
                getAllSkills: () => [],
                reloadSkills: () => 0,
                historyManager: { getAll: () => [], search: () => [], clear: () => {} },
            });

            assert.ok(commands, 'QuickCommands should be created');
        });

        it('should store builtInSkillsDir when provided', () => {
            const builtInDir = '/path/to/builtin';
            const commands = new QuickCommands({
                getUserSkills: () => [],
                getAllSkills: () => [],
                reloadSkills: () => 0,
                historyManager: { getAll: () => [], search: () => [], clear: () => {} },
                builtInSkillsDir: builtInDir,
            });

            assert.strictEqual(commands.builtInSkillsDir, builtInDir);
        });

        it('should default builtInSkillsDir to null', () => {
            const commands = new QuickCommands({
                getUserSkills: () => [],
                getAllSkills: () => [],
                reloadSkills: () => 0,
                historyManager: { getAll: () => [], search: () => [], clear: () => {} },
            });

            assert.strictEqual(commands.builtInSkillsDir, null);
        });
    });

    describe('isQuickCommand', () => {
        let commands;

        beforeEach(() => {
            commands = new QuickCommands({
                getUserSkills: () => [],
                getAllSkills: () => [],
                reloadSkills: () => 0,
                historyManager: { getAll: () => [], search: () => [], clear: () => {} },
            });
        });

        it('should recognize "help" as quick command', () => {
            assert.strictEqual(commands.isQuickCommand('help'), true);
            assert.strictEqual(commands.isQuickCommand('HELP'), true);
            assert.strictEqual(commands.isQuickCommand('Help'), true);
        });

        it('should recognize "reload" as quick command', () => {
            assert.strictEqual(commands.isQuickCommand('reload'), true);
            assert.strictEqual(commands.isQuickCommand('RELOAD'), true);
        });

        it('should recognize "list" and "ls" as quick commands', () => {
            assert.strictEqual(commands.isQuickCommand('list'), true);
            assert.strictEqual(commands.isQuickCommand('ls'), true);
            assert.strictEqual(commands.isQuickCommand('LIST'), true);
            assert.strictEqual(commands.isQuickCommand('LS'), true);
        });

        it('should recognize "list all" and "ls -a" as quick commands', () => {
            assert.strictEqual(commands.isQuickCommand('list all'), true);
            assert.strictEqual(commands.isQuickCommand('ls -a'), true);
            assert.strictEqual(commands.isQuickCommand('LIST ALL'), true);
            assert.strictEqual(commands.isQuickCommand('LS -A'), true);
        });

        it('should recognize "history" and "hist" as quick commands', () => {
            assert.strictEqual(commands.isQuickCommand('history'), true);
            assert.strictEqual(commands.isQuickCommand('hist'), true);
            assert.strictEqual(commands.isQuickCommand('HISTORY'), true);
        });

        it('should recognize history with arguments', () => {
            assert.strictEqual(commands.isQuickCommand('history 10'), true);
            assert.strictEqual(commands.isQuickCommand('history clear'), true);
            assert.strictEqual(commands.isQuickCommand('hist search'), true);
            assert.strictEqual(commands.isQuickCommand('history test query'), true);
        });

        it('should not recognize non-quick commands', () => {
            assert.strictEqual(commands.isQuickCommand('read skill'), false);
            assert.strictEqual(commands.isQuickCommand('/read'), false);
            assert.strictEqual(commands.isQuickCommand('create new skill'), false);
            assert.strictEqual(commands.isQuickCommand(''), false);
            assert.strictEqual(commands.isQuickCommand('helpme'), false);
        });
    });

    describe('execute - help command', () => {
        it('should handle help command', () => {
            const commands = new QuickCommands({
                getUserSkills: () => [],
                getAllSkills: () => [],
                reloadSkills: () => 0,
                historyManager: { getAll: () => [], search: () => [], clear: () => {} },
            });

            // Mock console.log to prevent output
            const originalLog = console.log;
            console.log = () => {};

            try {
                const result = commands.execute('help');
                assert.deepStrictEqual(result, { handled: true });
            } finally {
                console.log = originalLog;
            }
        });
    });

    describe('execute - reload command', () => {
        it('should call reloadSkills and return count', () => {
            let reloadCalled = false;
            const commands = new QuickCommands({
                getUserSkills: () => [],
                getAllSkills: () => [],
                reloadSkills: () => {
                    reloadCalled = true;
                    return 5;
                },
                historyManager: { getAll: () => [], search: () => [], clear: () => {} },
            });

            const result = commands.execute('reload');
            assert.strictEqual(reloadCalled, true);
            assert.deepStrictEqual(result, { handled: true });
        });
    });

    describe('execute - list command', () => {
        it('should list user skills only with "list"', () => {
            const userSkills = [
                { name: 'my-skill', shortName: 'my-skill', type: 'code' },
                { name: 'another-skill', shortName: 'another-skill', type: 'interactive' },
            ];

            let getUserSkillsCalled = false;
            const commands = new QuickCommands({
                getUserSkills: () => {
                    getUserSkillsCalled = true;
                    return userSkills;
                },
                getAllSkills: () => [],
                reloadSkills: () => 0,
                historyManager: { getAll: () => [], search: () => [], clear: () => {} },
            });

            // Mock console.log
            const originalLog = console.log;
            console.log = () => {};

            try {
                const result = commands.execute('list');
                assert.strictEqual(getUserSkillsCalled, true);
                assert.deepStrictEqual(result, { handled: true });
            } finally {
                console.log = originalLog;
            }
        });

        it('should list all skills with "list all"', () => {
            const allSkills = [
                { name: 'user-skill', shortName: 'user-skill', type: 'code', skillDir: '/user/skills' },
                { name: 'builtin-skill', shortName: 'builtin-skill', type: 'code', skillDir: '/builtin/.AchillesSkills' },
            ];

            let getAllSkillsCalled = false;
            const commands = new QuickCommands({
                getUserSkills: () => [],
                getAllSkills: () => {
                    getAllSkillsCalled = true;
                    return allSkills;
                },
                reloadSkills: () => 0,
                historyManager: { getAll: () => [], search: () => [], clear: () => {} },
                builtInSkillsDir: '/builtin/.AchillesSkills',
            });

            // Mock console.log
            const originalLog = console.log;
            console.log = () => {};

            try {
                const result = commands.execute('list all');
                assert.strictEqual(getAllSkillsCalled, true);
                assert.deepStrictEqual(result, { handled: true });
            } finally {
                console.log = originalLog;
            }
        });

        it('should display message when no user skills found', () => {
            let loggedMessage = '';
            const commands = new QuickCommands({
                getUserSkills: () => [],
                getAllSkills: () => [],
                reloadSkills: () => 0,
                historyManager: { getAll: () => [], search: () => [], clear: () => {} },
            });

            // Mock console.log
            const originalLog = console.log;
            console.log = (msg) => { loggedMessage += msg; };

            try {
                commands.execute('list');
                assert.ok(loggedMessage.includes('No user skills found'), 'Should show no skills message');
            } finally {
                console.log = originalLog;
            }
        });
    });

    describe('execute - history command', () => {
        it('should show history without args', () => {
            const historyManager = {
                getAll: () => ['cmd1', 'cmd2', 'cmd3'],
                search: () => [],
                clear: () => {},
                length: 3,
                getRecent: () => [
                    { index: 0, command: 'cmd1' },
                    { index: 1, command: 'cmd2' },
                    { index: 2, command: 'cmd3' },
                ],
                getHistoryPath: () => '/tmp/test-history',
            };

            const commands = new QuickCommands({
                getUserSkills: () => [],
                getAllSkills: () => [],
                reloadSkills: () => 0,
                historyManager,
            });

            // Mock console.log
            const originalLog = console.log;
            console.log = () => {};

            try {
                const result = commands.execute('history');
                assert.deepStrictEqual(result, { handled: true });
            } finally {
                console.log = originalLog;
            }
        });

        it('should clear history with "history clear"', () => {
            let clearCalled = false;
            const historyManager = {
                getAll: () => [],
                search: () => [],
                clear: () => { clearCalled = true; },
            };

            const commands = new QuickCommands({
                getUserSkills: () => [],
                getAllSkills: () => [],
                reloadSkills: () => 0,
                historyManager,
            });

            // Mock console.log
            const originalLog = console.log;
            console.log = () => {};

            try {
                commands.execute('history clear');
                assert.strictEqual(clearCalled, true);
            } finally {
                console.log = originalLog;
            }
        });

        it('should show limited history with number arg', () => {
            const historyManager = {
                getAll: () => ['cmd1', 'cmd2', 'cmd3'],
                search: () => [],
                clear: () => {},
                length: 3,
                getRecent: (n) => {
                    const all = ['cmd1', 'cmd2', 'cmd3'];
                    return all.slice(-n).map((cmd, i) => ({ index: i, command: cmd }));
                },
                getHistoryPath: () => '/tmp/test-history',
            };

            const commands = new QuickCommands({
                getUserSkills: () => [],
                getAllSkills: () => [],
                reloadSkills: () => 0,
                historyManager,
            });

            // Mock console.log
            const originalLog = console.log;
            console.log = () => {};

            try {
                const result = commands.execute('history 2');
                assert.deepStrictEqual(result, { handled: true });
            } finally {
                console.log = originalLog;
            }
        });

        it('should search history with text arg', () => {
            let searchQuery = null;
            const historyManager = {
                getAll: () => [],
                search: (query) => {
                    searchQuery = query;
                    return [{ index: 0, command: 'test command' }];
                },
                clear: () => {},
            };

            const commands = new QuickCommands({
                getUserSkills: () => [],
                getAllSkills: () => [],
                reloadSkills: () => 0,
                historyManager,
            });

            // Mock console.log
            const originalLog = console.log;
            console.log = () => {};

            try {
                commands.execute('history test');
                assert.strictEqual(searchQuery, 'test');
            } finally {
                console.log = originalLog;
            }
        });
    });

    describe('execute - unhandled commands', () => {
        it('should return handled: false for unknown commands', () => {
            const commands = new QuickCommands({
                getUserSkills: () => [],
                getAllSkills: () => [],
                reloadSkills: () => 0,
                historyManager: { getAll: () => [], search: () => [], clear: () => {} },
            });

            const result = commands.execute('unknown command');
            assert.deepStrictEqual(result, { handled: false });
        });
    });
});

// ============================================================================
// Skill filtering logic tests
// ============================================================================

describe('QuickCommands - Skill Filtering Logic', () => {
    it('should filter built-in skills by skillDir prefix', () => {
        const builtInSkillsDir = '/app/.AchillesSkills';
        const allSkills = [
            { name: 'user-skill', skillDir: '/home/user/project/.AchillesSkills/user-skill' },
            { name: 'list-skills', skillDir: '/app/.AchillesSkills/list-skills' },
            { name: 'read-skill', skillDir: '/app/.AchillesSkills/read-skill' },
        ];

        const builtIn = allSkills.filter(s => s.skillDir?.startsWith(builtInSkillsDir));
        const user = allSkills.filter(s => !s.skillDir?.startsWith(builtInSkillsDir));

        assert.strictEqual(builtIn.length, 2);
        assert.strictEqual(user.length, 1);
        assert.strictEqual(user[0].name, 'user-skill');
    });

    it('should handle skills without skillDir', () => {
        const builtInSkillsDir = '/app/.AchillesSkills';
        const allSkills = [
            { name: 'skill-without-dir' },
            { name: 'builtin', skillDir: '/app/.AchillesSkills/builtin' },
        ];

        const builtIn = allSkills.filter(s => s.skillDir?.startsWith(builtInSkillsDir));
        const user = allSkills.filter(s => !s.skillDir?.startsWith(builtInSkillsDir));

        assert.strictEqual(builtIn.length, 1);
        assert.strictEqual(user.length, 1);
        assert.strictEqual(user[0].name, 'skill-without-dir');
    });

    it('should treat all skills as user when builtInSkillsDir is null', () => {
        const builtInSkillsDir = null;
        const allSkills = [
            { name: 'skill1', skillDir: '/some/path' },
            { name: 'skill2', skillDir: '/another/path' },
        ];

        // When builtInSkillsDir is null, all skills are considered user skills
        const builtIn = builtInSkillsDir
            ? allSkills.filter(s => s.skillDir?.startsWith(builtInSkillsDir))
            : [];
        const user = builtInSkillsDir
            ? allSkills.filter(s => !s.skillDir?.startsWith(builtInSkillsDir))
            : allSkills;

        assert.strictEqual(builtIn.length, 0);
        assert.strictEqual(user.length, 2);
    });
});

// ============================================================================
// History argument parsing tests
// ============================================================================

describe('QuickCommands - History Argument Parsing', () => {
    it('should parse "clear" as clear command', () => {
        const input = 'history clear';
        const arg = input.split(/\s+/).slice(1).join(' ');

        assert.strictEqual(arg, 'clear');
    });

    it('should parse numeric arguments', () => {
        const testCases = [
            { input: 'history 10', expected: '10', isNumeric: true },
            { input: 'history 5', expected: '5', isNumeric: true },
            { input: 'history 100', expected: '100', isNumeric: true },
        ];

        for (const { input, expected, isNumeric } of testCases) {
            const arg = input.split(/\s+/).slice(1).join(' ');
            assert.strictEqual(arg, expected);
            assert.strictEqual(arg.match(/^\d+$/) !== null, isNumeric);
        }
    });

    it('should parse search queries (non-numeric args)', () => {
        const testCases = [
            { input: 'history list', expected: 'list' },
            { input: 'history read skill', expected: 'read skill' },
            { input: 'hist test query', expected: 'test query' },
        ];

        for (const { input, expected } of testCases) {
            const arg = input.split(/\s+/).slice(1).join(' ');
            assert.strictEqual(arg, expected);
            assert.strictEqual(arg.match(/^\d+$/) === null, true);
        }
    });

    it('should handle multiple whitespace', () => {
        const input = 'history   multiple   spaces';
        const arg = input.split(/\s+/).slice(1).join(' ');
        assert.strictEqual(arg, 'multiple spaces');
    });
});
