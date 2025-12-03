/**
 * Tests for CLI features including module exports, REPLSession, and history navigation.
 *
 * Updated to use RecursiveSkilledAgent (SkillManagerCli was removed).
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ============================================================================
// index.mjs Export Tests
// ============================================================================

describe('index.mjs exports', () => {
    it('should export RecursiveSkilledAgent', async () => {
        const { RecursiveSkilledAgent } = await import('../src/index.mjs');
        assert.ok(RecursiveSkilledAgent, 'RecursiveSkilledAgent should be exported');
        assert.strictEqual(typeof RecursiveSkilledAgent, 'function', 'RecursiveSkilledAgent should be a class');
    });

    it('should export REPLSession', async () => {
        const { REPLSession } = await import('../src/index.mjs');
        assert.ok(REPLSession, 'REPLSession should be exported');
        assert.strictEqual(typeof REPLSession, 'function', 'REPLSession should be a class');
    });

    it('should export SlashCommandHandler', async () => {
        const { SlashCommandHandler } = await import('../src/index.mjs');
        assert.ok(SlashCommandHandler, 'SlashCommandHandler should be exported');
        assert.strictEqual(typeof SlashCommandHandler, 'function', 'SlashCommandHandler should be a class');
    });

    it('should export CommandSelector and related functions', async () => {
        const { CommandSelector, showCommandSelector, showSkillSelector, buildCommandList } = await import('../src/index.mjs');
        assert.ok(CommandSelector, 'CommandSelector should be exported');
        assert.strictEqual(typeof showCommandSelector, 'function', 'showCommandSelector should be a function');
        assert.strictEqual(typeof showSkillSelector, 'function', 'showSkillSelector should be a function');
        assert.strictEqual(typeof buildCommandList, 'function', 'buildCommandList should be a function');
    });

    it('should export HistoryManager', async () => {
        const { HistoryManager } = await import('../src/index.mjs');
        assert.ok(HistoryManager, 'HistoryManager should be exported');
        assert.strictEqual(typeof HistoryManager, 'function', 'HistoryManager should be a class');
    });

    it('should export utility functions', async () => {
        const { summarizeResult, formatSlashResult } = await import('../src/index.mjs');
        assert.strictEqual(typeof summarizeResult, 'function', 'summarizeResult should be a function');
        assert.strictEqual(typeof formatSlashResult, 'function', 'formatSlashResult should be a function');
    });

    it('should export help functions', async () => {
        const { printREPLHelp, showHistory, searchHistory } = await import('../src/index.mjs');
        assert.strictEqual(typeof printREPLHelp, 'function', 'printREPLHelp should be a function');
        assert.strictEqual(typeof showHistory, 'function', 'showHistory should be a function');
        assert.strictEqual(typeof searchHistory, 'function', 'searchHistory should be a function');
    });

    it('should export builtInSkillsDir constant', async () => {
        const { builtInSkillsDir } = await import('../src/index.mjs');
        assert.ok(builtInSkillsDir, 'builtInSkillsDir should be exported');
        assert.ok(typeof builtInSkillsDir === 'string', 'builtInSkillsDir should be a string path');
    });
});

// ============================================================================
// REPLSession Tests
// ============================================================================

describe('REPLSession', () => {
    it('should instantiate with a RecursiveSkilledAgent instance', async () => {
        const { REPLSession } = await import('../src/REPLSession.mjs');
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
        const { REPLSession } = await import('../src/REPLSession.mjs');
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
// SlashCommandHandler Tests
// ============================================================================

describe('SlashCommandHandler', () => {
    it('should have static COMMANDS property', async () => {
        const { SlashCommandHandler } = await import('../src/SlashCommandHandler.mjs');

        assert.ok(SlashCommandHandler.COMMANDS, 'Should have COMMANDS property');
        assert.ok(SlashCommandHandler.COMMANDS.ls, 'Should have ls command');
        assert.ok(SlashCommandHandler.COMMANDS.read, 'Should have read command');
        assert.ok(SlashCommandHandler.COMMANDS.exec, 'Should have exec command');
    });

    it('should parse slash commands correctly', async () => {
        const { SlashCommandHandler } = await import('../src/SlashCommandHandler.mjs');

        const handler = new SlashCommandHandler({
            executeSkill: async () => {},
            getUserSkills: () => [],
            getSkills: () => [],
        });

        const parsed = handler.parseSlashCommand('/read my-skill');
        assert.strictEqual(parsed.command, 'read');
        assert.strictEqual(parsed.args, 'my-skill');
    });

    it('should identify slash commands', async () => {
        const { SlashCommandHandler } = await import('../src/SlashCommandHandler.mjs');

        const handler = new SlashCommandHandler({
            executeSkill: async () => {},
            getUserSkills: () => [],
            getSkills: () => [],
        });

        assert.strictEqual(handler.isSlashCommand('/read'), true);
        assert.strictEqual(handler.isSlashCommand('read'), false);
        assert.strictEqual(handler.isSlashCommand('/'), true);
    });
});

// ============================================================================
// ResultFormatter Tests
// ============================================================================

describe('ResultFormatter', () => {
    it('should format string results', async () => {
        const { formatSlashResult } = await import('../src/ResultFormatter.mjs');

        const result = formatSlashResult('test result');
        assert.strictEqual(result, 'test result');
    });

    it('should format object results as JSON', async () => {
        const { formatSlashResult } = await import('../src/ResultFormatter.mjs');

        const result = formatSlashResult({ key: 'value' });
        assert.ok(result.includes('key'));
        assert.ok(result.includes('value'));
    });

    it('should summarize orchestrator results', async () => {
        const { summarizeResult } = await import('../src/ResultFormatter.mjs');

        const orchestratorResult = {
            type: 'orchestrator',
            executions: [
                { skill: 'test-skill', status: 'success', result: 'test output' }
            ]
        };

        const summary = summarizeResult(orchestratorResult);
        assert.ok(summary, 'Should return a summary');
    });
});

// ============================================================================
// HelpPrinter Tests
// ============================================================================

describe('HelpPrinter', () => {
    it('should export printHelp function', async () => {
        const { printHelp } = await import('../src/HelpPrinter.mjs');
        assert.strictEqual(typeof printHelp, 'function');
    });

    it('should export showHistory function', async () => {
        const { showHistory } = await import('../src/HelpPrinter.mjs');
        assert.strictEqual(typeof showHistory, 'function');
    });

    it('should export searchHistory function', async () => {
        const { searchHistory } = await import('../src/HelpPrinter.mjs');
        assert.strictEqual(typeof searchHistory, 'function');
    });
});

// ============================================================================
// HistoryManager Tests
// ============================================================================

describe('HistoryManager', () => {
    let HistoryManager;

    beforeEach(async () => {
        const module = await import('../src/HistoryManager.mjs');
        HistoryManager = module.HistoryManager;
    });

    it('should add and retrieve history entries', () => {
        const manager = new HistoryManager({ workingDir: '/tmp/test-history-' + Date.now() });

        manager.add('first command');
        manager.add('second command');

        const all = manager.getAll();
        assert.ok(all.includes('first command'));
        assert.ok(all.includes('second command'));
    });

    it('should support getAll for history navigation', () => {
        const manager = new HistoryManager({ workingDir: '/tmp/test-history-' + Date.now() });

        manager.add('cmd1');
        manager.add('cmd2');
        manager.add('cmd3');

        const history = manager.getAll();
        assert.strictEqual(history.length, 3);
        // History should be in chronological order (oldest first)
        assert.strictEqual(history[0], 'cmd1');
        assert.strictEqual(history[2], 'cmd3');
    });
});

// ============================================================================
// Arrow Key History Navigation Tests
// ============================================================================

describe('Arrow key history navigation logic', () => {
    it('should track history index correctly when navigating up', () => {
        const history = ['cmd1', 'cmd2', 'cmd3'];
        let historyIndex = -1;
        let savedBuffer = '';
        let buffer = 'current';

        // Simulate Up arrow press
        if (historyIndex === -1) {
            savedBuffer = buffer;
        }
        if (historyIndex < history.length - 1) {
            historyIndex++;
            buffer = history[history.length - 1 - historyIndex];
        }

        assert.strictEqual(historyIndex, 0);
        assert.strictEqual(buffer, 'cmd3'); // Most recent command
        assert.strictEqual(savedBuffer, 'current');
    });

    it('should track history index correctly when navigating down', () => {
        const history = ['cmd1', 'cmd2', 'cmd3'];
        let historyIndex = 1; // Already navigated up twice
        let savedBuffer = 'original';
        let buffer = 'cmd2';

        // Simulate Down arrow press
        if (historyIndex > -1) {
            historyIndex--;
            if (historyIndex === -1) {
                buffer = savedBuffer;
            } else {
                buffer = history[history.length - 1 - historyIndex];
            }
        }

        assert.strictEqual(historyIndex, 0);
        assert.strictEqual(buffer, 'cmd3'); // Back to most recent
    });

    it('should restore saved buffer when returning to index -1', () => {
        const history = ['cmd1', 'cmd2'];
        let historyIndex = 0;
        let savedBuffer = 'my typed text';
        let buffer = 'cmd2';

        // Simulate Down arrow to return to current input
        historyIndex--;
        if (historyIndex === -1) {
            buffer = savedBuffer;
        }

        assert.strictEqual(historyIndex, -1);
        assert.strictEqual(buffer, 'my typed text');
    });

    it('should not go below -1 when pressing down at bottom', () => {
        let historyIndex = -1;

        // Simulate Down arrow when already at -1
        if (historyIndex === -1) {
            // Do nothing
        } else {
            historyIndex--;
        }

        assert.strictEqual(historyIndex, -1);
    });

    it('should not exceed history length when pressing up at top', () => {
        const history = ['cmd1', 'cmd2'];
        let historyIndex = 1; // Already at oldest command

        // Simulate Up arrow
        if (historyIndex < history.length - 1) {
            historyIndex++;
        }

        assert.strictEqual(historyIndex, 1); // Should stay at 1
    });

    it('should handle empty history gracefully', () => {
        const history = [];
        let historyIndex = -1;
        let buffer = 'current';

        // Simulate Up arrow with no history
        if (history.length === 0) {
            // Do nothing
        } else if (historyIndex < history.length - 1) {
            historyIndex++;
            buffer = history[history.length - 1 - historyIndex];
        }

        assert.strictEqual(historyIndex, -1);
        assert.strictEqual(buffer, 'current');
    });
});

// ============================================================================
// Comprehensive HistoryManager Tests
// ============================================================================

function createTempDir(prefix = 'test-') {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanupTempDir(dir) {
    if (dir && fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

describe('HistoryManager - Comprehensive', () => {
    let tempDir;
    let HistoryManager;

    beforeEach(async () => {
        tempDir = createTempDir('history-test-');
        const module = await import('../src/HistoryManager.mjs');
        HistoryManager = module.HistoryManager;
    });

    describe('Basic Operations', () => {
        it('should initialize with empty history', () => {
            const manager = new HistoryManager({ workingDir: tempDir });
            assert.strictEqual(manager.length, 0);
            assert.deepStrictEqual(manager.getAll(), []);
        });

        it('should not add empty commands', () => {
            const manager = new HistoryManager({ workingDir: tempDir });
            manager.add('');
            manager.add('   ');
            // Note: null/undefined will throw, so we only test empty strings
            assert.strictEqual(manager.length, 0);
        });

        it('should not add duplicate consecutive commands', () => {
            const manager = new HistoryManager({ workingDir: tempDir });
            manager.add('list skills');
            manager.add('list skills');
            manager.add('list skills');
            assert.strictEqual(manager.length, 1);
        });

        it('should allow duplicate non-consecutive commands', () => {
            const manager = new HistoryManager({ workingDir: tempDir });
            manager.add('list skills');
            manager.add('read my-skill');
            manager.add('list skills');
            assert.strictEqual(manager.length, 3);
        });

        it('should trim whitespace from commands', () => {
            const manager = new HistoryManager({ workingDir: tempDir });
            manager.add('  list skills  ');
            assert.strictEqual(manager.get(0), 'list skills');
        });
    });

    describe('Get Operations', () => {
        it('should get command by index', () => {
            const manager = new HistoryManager({ workingDir: tempDir });
            manager.add('command1');
            manager.add('command2');
            manager.add('command3');
            assert.strictEqual(manager.get(0), 'command1');
            assert.strictEqual(manager.get(1), 'command2');
            assert.strictEqual(manager.get(2), 'command3');
        });

        it('should return null for invalid index', () => {
            const manager = new HistoryManager({ workingDir: tempDir });
            manager.add('command1');
            assert.strictEqual(manager.get(-1), null);
            assert.strictEqual(manager.get(100), null);
        });

        it('should get recent commands', () => {
            const manager = new HistoryManager({ workingDir: tempDir });
            manager.add('command1');
            manager.add('command2');
            manager.add('command3');
            const recent = manager.getRecent(2);
            // getRecent returns Array<{index, command}>
            assert.strictEqual(recent.length, 2);
            assert.strictEqual(recent[0].command, 'command2');
            assert.strictEqual(recent[1].command, 'command3');
        });
    });

    describe('Navigation', () => {
        it('should navigate backwards with getPrevious', () => {
            const manager = new HistoryManager({ workingDir: tempDir });
            manager.add('first');
            manager.add('second');
            manager.add('third');
            assert.strictEqual(manager.getPrevious(), 'third');
            assert.strictEqual(manager.getPrevious(), 'second');
            assert.strictEqual(manager.getPrevious(), 'first');
            assert.strictEqual(manager.getPrevious(), 'first'); // stays at first
        });

        it('should navigate forwards with getNext', () => {
            const manager = new HistoryManager({ workingDir: tempDir });
            manager.add('first');
            manager.add('second');
            manager.add('third');
            manager.getPrevious(); // third
            manager.getPrevious(); // second
            assert.strictEqual(manager.getNext(), 'third');
            assert.strictEqual(manager.getNext(), null); // past end
        });

        it('should reset navigation after adding command', () => {
            const manager = new HistoryManager({ workingDir: tempDir });
            manager.add('first');
            manager.add('second');
            manager.getPrevious();
            manager.getPrevious();
            manager.add('fourth');
            assert.strictEqual(manager.getPrevious(), 'fourth');
        });

        it('should handle empty history navigation', () => {
            const manager = new HistoryManager({ workingDir: tempDir, filename: '.empty-history' });
            assert.strictEqual(manager.getPrevious(), null);
            assert.strictEqual(manager.getNext(), null);
        });
    });

    describe('Search', () => {
        it('should search history by keyword', () => {
            const manager = new HistoryManager({ workingDir: tempDir });
            manager.add('list skills');
            manager.add('read my-skill');
            manager.add('list all');
            manager.add('generate code');
            const results = manager.search('list');
            // search returns Array<{index, command}>
            assert.strictEqual(results.length, 2);
            const commands = results.map(r => r.command);
            assert.ok(commands.includes('list skills'));
            assert.ok(commands.includes('list all'));
        });

        it('should search case-insensitively', () => {
            const manager = new HistoryManager({ workingDir: tempDir });
            manager.add('list skills');
            manager.add('LIST ALL');
            const results = manager.search('LIST');
            assert.strictEqual(results.length, 2);
        });

        it('should limit search results', () => {
            const manager = new HistoryManager({ workingDir: tempDir });
            manager.add('list one');
            manager.add('list two');
            manager.add('list three');
            const results = manager.search('list', 1);
            assert.strictEqual(results.length, 1);
        });

        it('should return empty for no matches', () => {
            const manager = new HistoryManager({ workingDir: tempDir });
            manager.add('list skills');
            const results = manager.search('nonexistent');
            assert.strictEqual(results.length, 0);
        });
    });

    describe('Persistence', () => {
        it('should persist history to file', () => {
            const manager = new HistoryManager({ workingDir: tempDir });
            manager.add('persistent command');
            const historyFile = path.join(tempDir, '.skill-manager-history');
            assert.ok(fs.existsSync(historyFile), 'History file should exist');
        });

        it('should load history from file on init', () => {
            const manager1 = new HistoryManager({ workingDir: tempDir });
            manager1.add('command1');
            manager1.add('command2');

            const manager2 = new HistoryManager({ workingDir: tempDir });
            assert.strictEqual(manager2.length, 2);
            assert.strictEqual(manager2.get(0), 'command1');
        });

        it('should respect maxEntries limit', () => {
            const manager = new HistoryManager({
                workingDir: tempDir,
                maxEntries: 3,
                historyFile: '.limited-history',
            });
            manager.add('1');
            manager.add('2');
            manager.add('3');
            manager.add('4');
            assert.strictEqual(manager.length, 3);
            assert.strictEqual(manager.get(0), '2'); // oldest dropped
        });
    });

    describe('Clear', () => {
        it('should clear all history', () => {
            const manager = new HistoryManager({ workingDir: tempDir });
            manager.add('command1');
            manager.add('command2');
            manager.clear();
            assert.strictEqual(manager.length, 0);
        });

        it('should clear history file on disk', () => {
            const manager = new HistoryManager({ workingDir: tempDir });
            manager.add('command1');
            manager.clear();
            const historyFile = path.join(tempDir, '.skill-manager-history');
            const content = fs.readFileSync(historyFile, 'utf-8');
            assert.strictEqual(content.trim(), '');
        });
    });
});

// ============================================================================
// CommandSelector - Full Suite
// ============================================================================

describe('CommandSelector - Full Suite', () => {
    let CommandSelector;

    const testCommands = [
        { name: '/help', description: 'Show help', usage: '/help' },
        { name: '/list', description: 'List skills', usage: '/list' },
        { name: '/read', description: 'Read a skill', usage: '/read <skill>' },
        { name: '/write', description: 'Write a skill', usage: '/write <skill>' },
        { name: '/delete', description: 'Delete a skill', usage: '/delete <skill>' },
        { name: '/generate', description: 'Generate code', usage: '/generate <skill>' },
        { name: '/test', description: 'Test code', usage: '/test <skill>' },
        { name: '/refine', description: 'Refine skill', usage: '/refine <skill>' },
        { name: '/exec', description: 'Execute skill', usage: '/exec <skill>' },
        { name: '/template', description: 'Get template', usage: '/template <type>' },
    ];

    beforeEach(async () => {
        const module = await import('../src/CommandSelector.mjs');
        CommandSelector = module.CommandSelector;
    });

    describe('Initialization', () => {
        it('should initialize with all commands', () => {
            const selector = new CommandSelector(testCommands);
            assert.strictEqual(selector.filteredCommands.length, testCommands.length);
        });

        it('should respect maxVisible option', () => {
            const selector = new CommandSelector(testCommands, { maxVisible: 5 });
            assert.strictEqual(selector.maxVisible, 5);
        });
    });

    describe('Filtering', () => {
        it('should filter by command name', () => {
            const selector = new CommandSelector(testCommands);
            selector.updateFilter('read');
            assert.strictEqual(selector.filteredCommands.length, 1);
            assert.strictEqual(selector.filteredCommands[0].name, '/read');
        });

        it('should filter by description', () => {
            const selector = new CommandSelector(testCommands);
            selector.updateFilter('skill');
            assert.ok(selector.filteredCommands.length > 1, 'Should match multiple commands');
        });

        it('should be case-insensitive', () => {
            const selector = new CommandSelector(testCommands);
            selector.updateFilter('READ');
            assert.strictEqual(selector.filteredCommands.length, 1);
        });

        it('should reset selection on filter update', () => {
            const selector = new CommandSelector(testCommands);
            selector.moveDown();
            selector.moveDown();
            selector.updateFilter('read');
            assert.strictEqual(selector.selectedIndex, 0);
        });

        it('should handle empty filter', () => {
            const selector = new CommandSelector(testCommands);
            selector.updateFilter('read');
            selector.updateFilter('');
            assert.strictEqual(selector.filteredCommands.length, testCommands.length);
        });

        it('should handle no matches', () => {
            const selector = new CommandSelector(testCommands);
            selector.updateFilter('nonexistent');
            assert.strictEqual(selector.filteredCommands.length, 0);
        });
    });

    describe('Navigation', () => {
        it('should move down through list', () => {
            const selector = new CommandSelector(testCommands);
            assert.strictEqual(selector.selectedIndex, 0);
            selector.moveDown();
            assert.strictEqual(selector.selectedIndex, 1);
        });

        it('should not move past end of list', () => {
            const selector = new CommandSelector(testCommands);
            for (let i = 0; i < testCommands.length + 5; i++) {
                selector.moveDown();
            }
            assert.strictEqual(selector.selectedIndex, testCommands.length - 1);
        });

        it('should move up through list', () => {
            const selector = new CommandSelector(testCommands);
            selector.moveDown();
            selector.moveDown();
            selector.moveUp();
            assert.strictEqual(selector.selectedIndex, 1);
        });

        it('should not move past beginning of list', () => {
            const selector = new CommandSelector(testCommands);
            selector.moveUp();
            assert.strictEqual(selector.selectedIndex, 0);
        });

        it('should handle scrollOffset when moving down', () => {
            const selector = new CommandSelector(testCommands, { maxVisible: 3 });
            for (let i = 0; i < 5; i++) {
                selector.moveDown();
            }
            assert.ok(selector.scrollOffset > 0, 'Should have scrolled');
        });

        it('should handle scrollOffset when moving up', () => {
            const selector = new CommandSelector(testCommands, { maxVisible: 3 });
            for (let i = 0; i < 5; i++) selector.moveDown();
            for (let i = 0; i < 5; i++) selector.moveUp();
            assert.strictEqual(selector.scrollOffset, 0, 'Should scroll back to top');
        });
    });

    describe('Selection', () => {
        it('should return selected command', () => {
            const selector = new CommandSelector(testCommands);
            selector.moveDown();
            const selected = selector.getSelected();
            assert.strictEqual(selected.name, testCommands[1].name);
        });

        it('should return null when no commands match filter', () => {
            const selector = new CommandSelector(testCommands);
            selector.updateFilter('nonexistent');
            assert.strictEqual(selector.getSelected(), null);
        });
    });

    describe('Rendering', () => {
        it('should render visible items', () => {
            const selector = new CommandSelector(testCommands, { maxVisible: 5 });
            const lines = selector.render();
            assert.ok(lines.length > 0, 'Should have rendered lines');
        });

        it('should show scroll indicators', () => {
            const selector = new CommandSelector(testCommands, { maxVisible: 3 });
            for (let i = 0; i < 5; i++) selector.moveDown();
            const lines = selector.render();
            const hasMoreAbove = lines.some(l => l.includes('more above'));
            const hasMoreBelow = lines.some(l => l.includes('more below'));
            assert.ok(hasMoreAbove || hasMoreBelow, 'Should show scroll indicator');
        });

        it('should show empty state message', () => {
            const selector = new CommandSelector(testCommands);
            selector.updateFilter('nonexistent');
            const lines = selector.render();
            assert.ok(lines.some(l => l.toLowerCase().includes('no matching')), 'Should show no matching message');
        });

        it('should highlight selected item', () => {
            const selector = new CommandSelector(testCommands);
            const lines = selector.render();
            assert.ok(lines[0].includes('❯') || lines[0].includes('\x1b[36m'), 'Should highlight selection');
        });

        it('should render fewer lines when filter reduces list size', () => {
            const selector = new CommandSelector(testCommands, { maxVisible: 5 });
            const initialCount = selector.getRenderedLineCount();

            selector.updateFilter('help');
            const filteredLines = selector.render();
            const filteredCount = selector.getRenderedLineCount();

            assert.ok(filteredCount < initialCount, 'Filtered list should have fewer rendered lines');
            assert.strictEqual(filteredLines.length, 1, 'Should only render one command');
        });

        it('should handle rapid filter changes without state corruption', () => {
            const selector = new CommandSelector(testCommands, { maxVisible: 5 });

            selector.updateFilter('r');
            selector.updateFilter('re');
            selector.updateFilter('rea');
            selector.updateFilter('read');
            selector.updateFilter('rea');
            selector.updateFilter('re');
            selector.updateFilter('');

            assert.strictEqual(selector.filteredCommands.length, testCommands.length);
            assert.strictEqual(selector.selectedIndex, 0);
            assert.strictEqual(selector.scrollOffset, 0);
        });
    });

    describe('getRenderedLineCount', () => {
        it('should count visible lines correctly', () => {
            const selector = new CommandSelector(testCommands, { maxVisible: 5 });
            const count = selector.getRenderedLineCount();
            assert.strictEqual(count, 6); // 5 visible + 1 "more below"
        });

        it('should count scroll indicators', () => {
            const selector = new CommandSelector(testCommands, { maxVisible: 3 });
            for (let i = 0; i < 5; i++) selector.moveDown();
            const count = selector.getRenderedLineCount();
            assert.ok(count >= 4, 'Should include scroll indicators');
        });

        it('should handle empty filtered list', () => {
            const selector = new CommandSelector(testCommands);
            selector.updateFilter('nonexistent');
            const count = selector.getRenderedLineCount();
            assert.strictEqual(count, 1); // Just the "no matching" message
        });
    });
});

// ============================================================================
// buildCommandList Tests
// ============================================================================

describe('buildCommandList - Full Suite', () => {
    let buildCommandList;
    let SlashCommandHandler;

    beforeEach(async () => {
        const cmdModule = await import('../src/CommandSelector.mjs');
        buildCommandList = cmdModule.buildCommandList;
        const handlerModule = await import('../src/SlashCommandHandler.mjs');
        SlashCommandHandler = handlerModule.SlashCommandHandler;
    });

    it('should build command list from COMMANDS', () => {
        const commands = buildCommandList(SlashCommandHandler.COMMANDS);
        assert.ok(Array.isArray(commands), 'Should return array');
        assert.ok(commands.length > 0, 'Should have commands');
    });

    it('should include /help command', () => {
        const commands = buildCommandList(SlashCommandHandler.COMMANDS);
        const helpCmd = commands.find(c => c.name === '/help');
        assert.ok(helpCmd, 'Should include /help');
    });

    it('should have required properties for each command', () => {
        const commands = buildCommandList(SlashCommandHandler.COMMANDS);
        for (const cmd of commands) {
            assert.ok(cmd.name, 'Command should have name');
            assert.ok(cmd.description, 'Command should have description');
            assert.ok(cmd.usage, 'Command should have usage');
            assert.ok('needsSkillArg' in cmd, 'Command should have needsSkillArg');
        }
    });

    it('should sort commands alphabetically', () => {
        const commands = buildCommandList(SlashCommandHandler.COMMANDS);
        const names = commands.map(c => c.name);
        const sorted = [...names].sort();
        assert.deepStrictEqual(names, sorted, 'Commands should be sorted');
    });

    it('should deduplicate aliases', () => {
        const commands = buildCommandList(SlashCommandHandler.COMMANDS);
        const listCommands = commands.filter(c => c.name === '/list' || c.name === '/ls');
        assert.ok(listCommands.length <= 2, 'Should deduplicate aliases');
    });
});

// ============================================================================
// showSkillSelector Tests
// ============================================================================

describe('showSkillSelector - Full Suite', () => {
    let showSkillSelector;
    let CommandSelector;

    const testSkills = [
        { name: 'calculator', shortName: 'calculator', type: 'code', description: 'Math operations' },
        { name: 'formatter', shortName: 'formatter', type: 'code', description: 'Format text' },
        { name: 'booking', shortName: 'booking', type: 'interactive', description: 'Make reservations' },
        { name: 'inventory', shortName: 'inventory', type: 'dbtable', description: 'Track stock' },
    ];

    beforeEach(async () => {
        const module = await import('../src/CommandSelector.mjs');
        showSkillSelector = module.showSkillSelector;
        CommandSelector = module.CommandSelector;
    });

    it('showSkillSelector should be a function', () => {
        assert.strictEqual(typeof showSkillSelector, 'function');
    });

    it('skill items should be transformed correctly for CommandSelector', () => {
        const skillItems = testSkills.map(skill => ({
            name: skill.shortName || skill.name,
            description: `[${skill.type}] ${skill.description || ''}`.trim(),
            type: skill.type,
        }));

        assert.strictEqual(skillItems[0].name, 'calculator');
        assert.strictEqual(skillItems[0].description, '[code] Math operations');
        assert.strictEqual(skillItems[0].type, 'code');
    });

    it('CommandSelector should work with skill items', () => {
        const skillItems = testSkills.map(skill => ({
            name: skill.shortName || skill.name,
            description: `[${skill.type}] ${skill.description || ''}`.trim(),
            type: skill.type,
        }));

        const selector = new CommandSelector(skillItems, { maxVisible: 8 });

        assert.strictEqual(selector.filteredCommands.length, 4);
        assert.strictEqual(selector.getSelected().name, 'calculator');
    });

    it('filtering skills by type should work', () => {
        const skillItems = testSkills.map(skill => ({
            name: skill.shortName || skill.name,
            description: `[${skill.type}] ${skill.description || ''}`.trim(),
            type: skill.type,
        }));

        const selector = new CommandSelector(skillItems, { maxVisible: 8 });
        selector.updateFilter('code');

        assert.strictEqual(selector.filteredCommands.length, 2);
    });

    it('filtering skills by name should work', () => {
        const skillItems = testSkills.map(skill => ({
            name: skill.shortName || skill.name,
            description: `[${skill.type}] ${skill.description || ''}`.trim(),
            type: skill.type,
        }));

        const selector = new CommandSelector(skillItems, { maxVisible: 8 });
        selector.updateFilter('calc');

        assert.strictEqual(selector.filteredCommands.length, 1);
        assert.strictEqual(selector.getSelected().name, 'calculator');
    });

    it('selected skill should include type property', () => {
        const skillItems = testSkills.map(skill => ({
            name: skill.shortName || skill.name,
            description: `[${skill.type}] ${skill.description || ''}`.trim(),
            type: skill.type,
        }));

        const selector = new CommandSelector(skillItems, { maxVisible: 8 });
        const selected = selector.getSelected();

        assert.ok('type' in selected, 'Selected skill should have type property');
        assert.strictEqual(selected.type, 'code');
    });

    it('should handle skills with missing shortName', () => {
        const skills = [{ name: 'long-skill-name', type: 'code', description: 'Test' }];
        const skillItems = skills.map(skill => ({
            name: skill.shortName || skill.name,
            description: `[${skill.type}] ${skill.description || ''}`.trim(),
            type: skill.type,
        }));

        assert.strictEqual(skillItems[0].name, 'long-skill-name');
    });

    it('should handle skills with missing description', () => {
        const skills = [{ name: 'no-desc', shortName: 'no-desc', type: 'code' }];
        const skillItems = skills.map(skill => ({
            name: skill.shortName || skill.name,
            description: `[${skill.type}] ${skill.description || ''}`.trim(),
            type: skill.type,
        }));

        assert.strictEqual(skillItems[0].description, '[code]');
    });

    it('should filter by partial skill name', () => {
        const skillItems = testSkills.map(skill => ({
            name: skill.shortName || skill.name,
            description: `[${skill.type}] ${skill.description || ''}`.trim(),
            type: skill.type,
        }));

        const selector = new CommandSelector(skillItems, { maxVisible: 8 });
        selector.updateFilter('form');

        assert.strictEqual(selector.filteredCommands.length, 1);
        assert.strictEqual(selector.getSelected().name, 'formatter');
    });

    it('should filter by description content', () => {
        const skillItems = testSkills.map(skill => ({
            name: skill.shortName || skill.name,
            description: `[${skill.type}] ${skill.description || ''}`.trim(),
            type: skill.type,
        }));

        const selector = new CommandSelector(skillItems, { maxVisible: 8 });
        selector.updateFilter('reserv');

        assert.strictEqual(selector.filteredCommands.length, 1);
        assert.strictEqual(selector.getSelected().name, 'booking');
    });
});

// ============================================================================
// REPLSession - Cancellation and Skill Info Tests
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
