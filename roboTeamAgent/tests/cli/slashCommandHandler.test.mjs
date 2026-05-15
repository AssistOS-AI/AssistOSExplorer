/**
 * Tests for SlashCommandHandler with hierarchical command structure.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

describe('SlashCommandHandler', () => {
    it('should have static COMMANDS property', async () => {
        const { SlashCommandHandler, COMMAND_DEFINITIONS } = await import('../achilles-cli/src/repl/SlashCommandHandler.mjs');

        assert.ok(SlashCommandHandler.COMMANDS, 'Should have COMMANDS property');
        assert.strictEqual(SlashCommandHandler.COMMANDS, COMMAND_DEFINITIONS, 'COMMANDS should alias COMMAND_DEFINITIONS');
        assert.ok(COMMAND_DEFINITIONS.read, 'Should have read command');
        assert.ok(COMMAND_DEFINITIONS.exec, 'Should have exec command');
        assert.ok(COMMAND_DEFINITIONS.build, 'Should have build command');
    });

    it('should define hierarchical commands with subOptions', async () => {
        const { COMMAND_DEFINITIONS } = await import('../achilles-cli/src/repl/SlashCommandHandler.mjs');

        assert.ok(Array.isArray(COMMAND_DEFINITIONS.list.subOptions), 'list should have subOptions');
        assert.ok(COMMAND_DEFINITIONS.list.subOptions.includes('skills'), 'list should have skills sub-option');
        assert.ok(COMMAND_DEFINITIONS.list.subOptions.includes('repos'), 'list should have repos sub-option');

        assert.ok(Array.isArray(COMMAND_DEFINITIONS.add.subOptions), 'add should have subOptions');
        assert.ok(COMMAND_DEFINITIONS.add.subOptions.includes('repo'), 'add should have repo sub-option');

        assert.ok(Array.isArray(COMMAND_DEFINITIONS.remove.subOptions), 'remove should have subOptions');
        assert.ok(COMMAND_DEFINITIONS.remove.subOptions.includes('repo'), 'remove should have repo sub-option');
        assert.ok(COMMAND_DEFINITIONS.remove.subOptions.includes('skill'), 'remove should have skill sub-option');
    });

    it('should define SUB_OPTIONS for hierarchical commands', async () => {
        const { SUB_OPTIONS } = await import('../achilles-cli/src/repl/SlashCommandHandler.mjs');

        assert.ok(SUB_OPTIONS.list, 'Should have list sub-options');
        assert.ok(SUB_OPTIONS.list.skills, 'Should have list.skills');
        assert.ok(SUB_OPTIONS.list.repos, 'Should have list.repos');

        assert.ok(SUB_OPTIONS.add, 'Should have add sub-options');
        assert.ok(SUB_OPTIONS.add.repo, 'Should have add.repo');

        assert.ok(SUB_OPTIONS.remove, 'Should have remove sub-options');
        assert.ok(SUB_OPTIONS.remove.repo, 'Should have remove.repo');
        assert.ok(SUB_OPTIONS.remove.skill, 'Should have remove.skill');
    });

    it('should expose a structured slash command catalog', async () => {
        const { buildSlashCommandCatalog, SlashCommandHandler } = await import('../achilles-cli/src/repl/SlashCommandHandler.mjs');

        const catalog = buildSlashCommandCatalog();
        assert.ok(Array.isArray(catalog), 'Catalog should be an array');
        assert.ok(catalog.length > 0, 'Catalog should not be empty');

        const listEntry = catalog.find((entry) => entry.name === '/list');
        assert.ok(listEntry, 'Catalog should include /list');
        assert.ok(Array.isArray(listEntry.subCommands), '/list should expose subCommands');
        assert.ok(listEntry.subCommands.some((entry) => entry.name === 'skills'), '/list should include skills sub-command');
        assert.ok(listEntry.subCommands.some((entry) => entry.name === 'repos'), '/list should include repos sub-command');

        const updateEntry = catalog.find((entry) => entry.name === '/update');
        assert.ok(updateEntry, 'Catalog should include /update');
        assert.ok(updateEntry.subCommands.some((entry) => entry.name === 'repos'), '/update should include repos sub-command');

        const staticCatalog = SlashCommandHandler.getCommandCatalog();
        assert.deepStrictEqual(staticCatalog, catalog, 'Static catalog helper should match the exported catalog builder');
    });

    it('should parse slash commands correctly', async () => {
        const { SlashCommandHandler } = await import('../achilles-cli/src/repl/SlashCommandHandler.mjs');

        const handler = new SlashCommandHandler({
            executeSkill: async () => {},
            getUserSkills: () => [],
            getSkills: () => [],
        });

        const parsed = handler.parseSlashCommand('/read my-skill');
        assert.strictEqual(parsed.command, 'read');
        assert.strictEqual(parsed.subOption, null);
        assert.strictEqual(parsed.args, 'my-skill');
    });

    it('should parse hierarchical commands with sub-options', async () => {
        const { SlashCommandHandler } = await import('../achilles-cli/src/repl/SlashCommandHandler.mjs');

        const handler = new SlashCommandHandler({
            executeSkill: async () => {},
            getUserSkills: () => [],
            getSkills: () => [],
        });

        const parsed = handler.parseSlashCommand('/list repos');
        assert.strictEqual(parsed.command, 'list');
        assert.strictEqual(parsed.subOption, 'repos');
        assert.strictEqual(parsed.args, '');

        const parsed2 = handler.parseSlashCommand('/add repo https://github.com/foo/bar.git my-repo');
        assert.strictEqual(parsed2.command, 'add');
        assert.strictEqual(parsed2.subOption, 'repo');
        assert.strictEqual(parsed2.args, 'https://github.com/foo/bar.git my-repo');

        const parsed3 = handler.parseSlashCommand('/update repos');
        assert.strictEqual(parsed3.command, 'update');
        assert.strictEqual(parsed3.subOption, 'repos');
        assert.strictEqual(parsed3.args, '');

        const parsed4 = handler.parseSlashCommand('/update my-skill Description');
        assert.strictEqual(parsed4.command, 'update');
        assert.strictEqual(parsed4.subOption, null);
        assert.strictEqual(parsed4.args, 'my-skill Description');
    });

    it('should identify slash commands', async () => {
        const { SlashCommandHandler } = await import('../achilles-cli/src/repl/SlashCommandHandler.mjs');

        const handler = new SlashCommandHandler({
            executeSkill: async () => {},
            getUserSkills: () => [],
            getSkills: () => [],
        });

        assert.strictEqual(handler.isSlashCommand('/read'), true);
        assert.strictEqual(handler.isSlashCommand('read'), false);
        assert.strictEqual(handler.isSlashCommand('/'), true);
    });

    it('should get sub-options for hierarchical commands', async () => {
        const { SlashCommandHandler } = await import('../achilles-cli/src/repl/SlashCommandHandler.mjs');

        const handler = new SlashCommandHandler({
            executeSkill: async () => {},
            getUserSkills: () => [],
            getSkills: () => [],
        });

        const listSubs = handler.getSubOptions('list');
        assert.ok(Array.isArray(listSubs), 'Should return array for list');
        assert.ok(listSubs.includes('skills'), 'list sub-options should include skills');
        assert.ok(listSubs.includes('repos'), 'list sub-options should include repos');

        const readSubs = handler.getSubOptions('read');
        assert.strictEqual(readSubs, null, 'read should have no sub-options');
    });

    it('should handle /tier with args returning tierChange', async () => {
        const { SlashCommandHandler } = await import('../achilles-cli/src/repl/SlashCommandHandler.mjs');

        const handler = new SlashCommandHandler({
            executeSkill: async () => {},
            getUserSkills: () => [],
            getSkills: () => [],
        });

        const result = await handler.executeSlashCommand('tier', 'fast');
        assert.strictEqual(result.handled, true);
    });

    it('should handle /tier with no args returning showTierPicker', async () => {
        const { SlashCommandHandler } = await import('../achilles-cli/src/repl/SlashCommandHandler.mjs');

        const handler = new SlashCommandHandler({
            executeSkill: async () => {},
            getUserSkills: () => [],
            getSkills: () => [],
        });

        const result = await handler.executeSlashCommand('tier', '');
        assert.strictEqual(result.handled, true);
        assert.ok(result.showTierPicker === true || result.error, 'Should show picker or error');
    });

    it('should handle /model command', async () => {
        const { SlashCommandHandler } = await import('../achilles-cli/src/repl/SlashCommandHandler.mjs');

        const handler = new SlashCommandHandler({
            executeSkill: async () => {},
            getUserSkills: () => [],
            getSkills: () => [],
        });

        const noArgs = await handler.executeSlashCommand('model', '');
        assert.strictEqual(noArgs.handled, true);
        assert.ok(noArgs.showModelPicker === true || noArgs.error, 'Should show picker or error');

        const clear = await handler.executeSlashCommand('model', 'clear');
        assert.strictEqual(clear.handled, true);
        if (!clear.error) {
            assert.strictEqual(clear.modelChange, null, '/model clear should set modelChange to null');
        }
    });

    it('should include commands in completions', async () => {
        const { SlashCommandHandler } = await import('../achilles-cli/src/repl/SlashCommandHandler.mjs');

        const handler = new SlashCommandHandler({
            executeSkill: async () => {},
            getUserSkills: () => [],
            getSkills: () => [],
        });

        const [completions] = handler.getCompletions('/');
        assert.ok(completions.includes('/model'), 'Completions should include /model');
        assert.ok(completions.includes('/tier'), 'Completions should include /tier');
        assert.ok(completions.includes('/list'), 'Completions should include /list');
        assert.ok(completions.includes('/add'), 'Completions should include /add');
        assert.ok(completions.includes('/remove'), 'Completions should include /remove');
    });

    it('should provide input hint for commands', async () => {
        const { SlashCommandHandler } = await import('../achilles-cli/src/repl/SlashCommandHandler.mjs');

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

    it('should provide sub-option hint for hierarchical commands', async () => {
        const { SlashCommandHandler } = await import('../achilles-cli/src/repl/SlashCommandHandler.mjs');

        const handler = new SlashCommandHandler({
            executeSkill: async () => {},
            getUserSkills: () => [],
            getSkills: () => [],
        });

        const hint = handler.getInputHint('/list ');
        assert.ok(hint, 'Should return a hint for /list ');
        assert.ok(hint.includes('skills') || hint.includes('repos'), 'Hint should mention sub-options');
    });

    it('should have getAvailableModels method', async () => {
        const { SlashCommandHandler } = await import('../achilles-cli/src/repl/SlashCommandHandler.mjs');

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
        const { SlashCommandHandler } = await import('../achilles-cli/src/repl/SlashCommandHandler.mjs');

        const handler = new SlashCommandHandler({
            executeSkill: async () => {},
            getUserSkills: () => [],
            getSkills: () => [],
        });

        const [completions] = handler.getCompletions('/model ');
        assert.ok(completions.some(c => c.includes('clear')), 'Model completions should include clear');
    });

    it('should route /list skills to list-skills skill', async () => {
        const { SlashCommandHandler } = await import('../achilles-cli/src/repl/SlashCommandHandler.mjs');

        const calls = [];
        const handler = new SlashCommandHandler({
            executeSkill: async (skillName, input) => {
                calls.push({ skillName, input });
                return { ok: true };
            },
            getUserSkills: () => [],
            getSkills: () => [],
        });

        const result = await handler.executeSlashCommand('list', 'skills');
        assert.strictEqual(result.handled, true);
        assert.strictEqual(calls.length, 1);
        assert.strictEqual(calls[0].skillName, 'list-skills');
        assert.strictEqual(calls[0].input, 'list');
    });

    it('should route /remove skill to delete-skill skill', async () => {
        const { SlashCommandHandler } = await import('../achilles-cli/src/repl/SlashCommandHandler.mjs');

        const calls = [];
        const handler = new SlashCommandHandler({
            executeSkill: async (skillName, input) => {
                calls.push({ skillName, input });
                return { ok: true };
            },
            getUserSkills: () => [],
            getSkills: () => [],
        });

        const result = await handler.executeSlashCommand('remove', 'skill my-skill');
        assert.strictEqual(result.handled, true);
        assert.strictEqual(calls.length, 1);
        assert.strictEqual(calls[0].skillName, 'delete-skill');
        assert.strictEqual(calls[0].input, 'my-skill');
    });

    it('should handle /build by calling buildSkills callback', async () => {
        const { SlashCommandHandler } = await import('../achilles-cli/src/repl/SlashCommandHandler.mjs');

        let called = 0;
        const handler = new SlashCommandHandler({
            executeSkill: async () => {},
            buildSkills: async () => { called += 1; },
            getUserSkills: () => [],
            getSkills: () => [],
        });

        const result = await handler.executeSlashCommand('build', '');
        assert.strictEqual(result.handled, true);
        assert.strictEqual(called, 1);
        assert.ok(typeof result.result === 'string' && result.result.includes('complete'));
    });

    it('should handle /reload command', async () => {
        const { SlashCommandHandler } = await import('../achilles-cli/src/repl/SlashCommandHandler.mjs');

        const handler = new SlashCommandHandler({
            executeSkill: async () => {},
            getUserSkills: () => [],
            getSkills: () => [],
        });

        const result = await handler.executeSlashCommand('reload', '');
        assert.strictEqual(result.handled, true);
        assert.ok(result.reloadSkills === true, 'Should signal reloadSkills');
    });

    it('should handle /history command', async () => {
        const { SlashCommandHandler } = await import('../achilles-cli/src/repl/SlashCommandHandler.mjs');

        const mockHistoryManager = {
            clear: () => {},
            getRecent: () => [],
            search: () => [],
        };

        const handler = new SlashCommandHandler({
            executeSkill: async () => {},
            getUserSkills: () => [],
            getSkills: () => [],
            historyManager: mockHistoryManager,
        });

        const noArgs = await handler.executeSlashCommand('history', '');
        assert.strictEqual(noArgs.handled, true);
        assert.ok(noArgs.showHistory === true, 'Should signal showHistory');

        const clear = await handler.executeSlashCommand('history', 'clear');
        assert.strictEqual(clear.handled, true);
        assert.ok(clear.result.includes('cleared'), 'Should confirm history cleared');
    });

    it('should handle /exit and /quit commands', async () => {
        const { SlashCommandHandler } = await import('../achilles-cli/src/repl/SlashCommandHandler.mjs');

        const handler = new SlashCommandHandler({
            executeSkill: async () => {},
            getUserSkills: () => [],
            getSkills: () => [],
        });

        const exitResult = await handler.executeSlashCommand('exit', '');
        assert.strictEqual(exitResult.handled, true);
        assert.ok(exitResult.exitRepl === true, 'Should signal exitRepl');

        const quitResult = await handler.executeSlashCommand('quit', '');
        assert.strictEqual(quitResult.handled, true);
        assert.ok(quitResult.exitRepl === true, 'Should signal exitRepl');
    });

    it('should return error for unknown commands', async () => {
        const { SlashCommandHandler } = await import('../achilles-cli/src/repl/SlashCommandHandler.mjs');

        const handler = new SlashCommandHandler({
            executeSkill: async () => {},
            getUserSkills: () => [],
            getSkills: () => [],
        });

        const result = await handler.executeSlashCommand('unknown-cmd', '');
        assert.strictEqual(result.handled, false);
        assert.ok(result.error, 'Should return error for unknown command');
    });

    it('should complete sub-options for hierarchical commands', async () => {
        const { SlashCommandHandler } = await import('../achilles-cli/src/repl/SlashCommandHandler.mjs');

        const handler = new SlashCommandHandler({
            executeSkill: async () => {},
            getUserSkills: () => [],
            getSkills: () => [],
        });

        const [completions] = handler.getCompletions('/list ');
        assert.ok(completions.some(c => c.includes('skills')), 'Should complete skills');
        assert.ok(completions.some(c => c.includes('repos')), 'Should complete repos');

        const [addCompletions] = handler.getCompletions('/add ');
        assert.ok(addCompletions.some(c => c.includes('repo')), 'Should complete repo');
    });
});
