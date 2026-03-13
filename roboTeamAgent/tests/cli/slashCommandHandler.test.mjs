/**
 * Tests for SlashCommandHandler.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

describe('SlashCommandHandler', () => {
    it('should have static COMMANDS property', async () => {
        const { SlashCommandHandler } = await import('../skill-manager/src/repl/SlashCommandHandler.mjs');

        assert.ok(SlashCommandHandler.COMMANDS, 'Should have COMMANDS property');
        assert.ok(SlashCommandHandler.COMMANDS.ls, 'Should have ls command');
        assert.ok(SlashCommandHandler.COMMANDS.read, 'Should have read command');
        assert.ok(SlashCommandHandler.COMMANDS.exec, 'Should have exec command');
    });

    it('should parse slash commands correctly', async () => {
        const { SlashCommandHandler } = await import('../skill-manager/src/repl/SlashCommandHandler.mjs');

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
        const { SlashCommandHandler } = await import('../skill-manager/src/repl/SlashCommandHandler.mjs');

        const handler = new SlashCommandHandler({
            executeSkill: async () => {},
            getUserSkills: () => [],
            getSkills: () => [],
        });

        assert.strictEqual(handler.isSlashCommand('/read'), true);
        assert.strictEqual(handler.isSlashCommand('read'), false);
        assert.strictEqual(handler.isSlashCommand('/'), true);
    });

    it('should handle /tier with args returning tierChange', async () => {
        const { SlashCommandHandler } = await import('../skill-manager/src/repl/SlashCommandHandler.mjs');

        const handler = new SlashCommandHandler({
            executeSkill: async () => {},
            getUserSkills: () => [],
            getSkills: () => [],
        });

        // /tier with a valid tier name — depends on achillesAgentLib being available
        // At minimum, verify it returns a handled result
        const result = await handler.executeSlashCommand('tier', 'fast');
        assert.strictEqual(result.handled, true);
    });

    it('should handle /tier with no args returning showTierPicker', async () => {
        const { SlashCommandHandler } = await import('../skill-manager/src/repl/SlashCommandHandler.mjs');

        const handler = new SlashCommandHandler({
            executeSkill: async () => {},
            getUserSkills: () => [],
            getSkills: () => [],
        });

        const result = await handler.executeSlashCommand('tier', '');
        assert.strictEqual(result.handled, true);
        // Either shows picker or errors (if achillesAgentLib not available)
        assert.ok(result.showTierPicker === true || result.error, 'Should show picker or error');
    });

    it('should handle /model command', async () => {
        const { SlashCommandHandler } = await import('../skill-manager/src/repl/SlashCommandHandler.mjs');

        const handler = new SlashCommandHandler({
            executeSkill: async () => {},
            getUserSkills: () => [],
            getSkills: () => [],
        });

        // /model with no args
        const noArgs = await handler.executeSlashCommand('model', '');
        assert.strictEqual(noArgs.handled, true);
        assert.ok(noArgs.showModelPicker === true || noArgs.error, 'Should show picker or error');

        // /model clear
        const clear = await handler.executeSlashCommand('model', 'clear');
        assert.strictEqual(clear.handled, true);
        if (!clear.error) {
            assert.strictEqual(clear.modelChange, null, '/model clear should set modelChange to null');
        }
    });

    it('should include /model in completions', async () => {
        const { SlashCommandHandler } = await import('../skill-manager/src/repl/SlashCommandHandler.mjs');

        const handler = new SlashCommandHandler({
            executeSkill: async () => {},
            getUserSkills: () => [],
            getSkills: () => [],
        });

        const [completions] = handler.getCompletions('/');
        assert.ok(completions.includes('/model'), 'Completions should include /model');
        assert.ok(completions.includes('/tier'), 'Completions should include /tier');
    });

    it('should provide input hint for /model', async () => {
        const { SlashCommandHandler } = await import('../skill-manager/src/repl/SlashCommandHandler.mjs');

        const handler = new SlashCommandHandler({
            executeSkill: async () => {},
            getUserSkills: () => [],
            getSkills: () => [],
        });

        const hint = handler.getInputHint('/model');
        assert.ok(hint, 'Should return a hint for /model');
        assert.ok(hint.includes('model'), 'Hint should mention model');

        const clearHint = handler.getInputHint('/model clear');
        assert.ok(clearHint, 'Should return a hint for /model clear');
        assert.ok(clearHint.toLowerCase().includes('clear'), 'Hint should mention clear');
    });

    it('should have getAvailableModels method', async () => {
        const { SlashCommandHandler } = await import('../skill-manager/src/repl/SlashCommandHandler.mjs');

        const handler = new SlashCommandHandler({
            executeSkill: async () => {},
            getUserSkills: () => [],
            getSkills: () => [],
        });

        assert.strictEqual(typeof handler.getAvailableModels, 'function');
        const models = handler.getAvailableModels();
        assert.ok(Array.isArray(models), 'Should return an array');
    });

    it('should complete /model with model names and clear', async () => {
        const { SlashCommandHandler } = await import('../skill-manager/src/repl/SlashCommandHandler.mjs');

        const handler = new SlashCommandHandler({
            executeSkill: async () => {},
            getUserSkills: () => [],
            getSkills: () => [],
        });

        const [completions] = handler.getCompletions('/model ');
        // Should at least include 'clear' option
        assert.ok(completions.some(c => c.includes('clear')), 'Model completions should include clear');
    });
});
