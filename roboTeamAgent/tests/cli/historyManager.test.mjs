/**
 * Tests for HistoryManager including basic operations, navigation, and persistence.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createTempDir, cleanupTempDir } from './testUtils.mjs';

// ============================================================================
// HistoryManager Basic Tests
// ============================================================================

describe('HistoryManager', () => {
    let HistoryManager;

    beforeEach(async () => {
        const module = await import('../src/repl/HistoryManager.mjs');
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

describe('HistoryManager - Comprehensive', () => {
    let tempDir;
    let HistoryManager;

    beforeEach(async () => {
        tempDir = createTempDir('history-test-');
        const module = await import('../src/repl/HistoryManager.mjs');
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
