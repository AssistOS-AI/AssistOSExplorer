/**
 * Tests for HelpPrinter and HelpSystem.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

describe('HelpPrinter', () => {
    it('should export printHelp function', async () => {
        const { printHelp } = await import('../skill-manager/src/ui/HelpPrinter.mjs');
        assert.strictEqual(typeof printHelp, 'function');
    });

    it('should export showHistory function', async () => {
        const { showHistory } = await import('../skill-manager/src/ui/HelpPrinter.mjs');
        assert.strictEqual(typeof showHistory, 'function');
    });

    it('should export searchHistory function', async () => {
        const { searchHistory } = await import('../skill-manager/src/ui/HelpPrinter.mjs');
        assert.strictEqual(typeof searchHistory, 'function');
    });
});

describe('HelpSystem', () => {
    it('should export showHelp function', async () => {
        const { showHelp } = await import('../skill-manager/src/ui/HelpSystem.mjs');
        assert.strictEqual(typeof showHelp, 'function');
    });

    it('should export getHelpTopics function', async () => {
        const { getHelpTopics } = await import('../skill-manager/src/ui/HelpSystem.mjs');
        assert.strictEqual(typeof getHelpTopics, 'function');
    });

    it('should export getCommandHelp function', async () => {
        const { getCommandHelp } = await import('../skill-manager/src/ui/HelpSystem.mjs');
        assert.strictEqual(typeof getCommandHelp, 'function');
    });

    it('should have help for /tier command', async () => {
        const { showHelp } = await import('../skill-manager/src/ui/HelpSystem.mjs');
        const tierHelp = showHelp('tier');
        assert.ok(tierHelp, 'Should return help for tier');
        assert.ok(tierHelp.includes('tier'), 'Tier help should mention tier');
    });

    it('should have help for /model command', async () => {
        const { showHelp } = await import('../skill-manager/src/ui/HelpSystem.mjs');
        const modelHelp = showHelp('model');
        assert.ok(modelHelp, 'Should return help for model');
        assert.ok(modelHelp.includes('model'), 'Model help should mention model');
        assert.ok(modelHelp.includes('clear'), 'Model help should mention clear');
        assert.ok(modelHelp.includes('pin'), 'Model help should mention pinning');
    });

    it('should include /model in command reference', async () => {
        const { showHelp } = await import('../skill-manager/src/ui/HelpSystem.mjs');
        const commandsHelp = showHelp('commands');
        assert.ok(commandsHelp.includes('/model'), 'Command reference should include /model');
        assert.ok(commandsHelp.includes('/tier'), 'Command reference should include /tier');
    });

    it('should list model in command help entries', async () => {
        const { getCommandHelp } = await import('../skill-manager/src/ui/HelpSystem.mjs');
        const entries = getCommandHelp();
        const modelEntry = entries.find(e => e.name === 'model');
        assert.ok(modelEntry, 'Should have model command help entry');
        assert.ok(modelEntry.title, 'Model help entry should have title');
    });

    it('should return quick reference from getQuickReference', async () => {
        const { getQuickReference } = await import('../skill-manager/src/ui/HelpSystem.mjs');
        const ref = getQuickReference();
        assert.ok(ref, 'Should return quick reference');
        assert.ok(ref.includes('Skill Manager'), 'Quick reference should mention Skill Manager');
    });
});
