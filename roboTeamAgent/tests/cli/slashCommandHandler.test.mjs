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
});
