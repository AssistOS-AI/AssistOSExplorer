/**
 * Tests for index.mjs module exports.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

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
