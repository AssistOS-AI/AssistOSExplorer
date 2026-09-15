import test from 'node:test';
import assert from 'node:assert/strict';
import { SlashCommandHandler } from '../src/repl/SlashCommandHandler.mjs';

test('/model validates effort against the selected native model before persistence', async () => {
    const handler = new SlashCommandHandler({ loadModels: async () => ({ backend: 'codex', models: [
        { id: 'reasoner', efforts: ['low', 'high'] }, { id: 'plain', efforts: [] },
    ] }) });
    const selected = await handler.executeSlashCommand('model', 'reasoner high');
    assert.equal(selected.modelChange, 'reasoner');
    assert.equal(selected.effortChange, 'high');
    for (const input of ['reasoner bogus', 'plain high', 'reasoner high extra', 'default high']) {
        const result = await handler.executeSlashCommand('model', input);
        assert.ok(result.error, input);
        assert.equal(result.modelChange, undefined);
    }
    assert.equal((await handler.executeSlashCommand('model', 'reasoner default')).effortChange, null);
    assert.equal((await handler.executeSlashCommand('model', 'reasoner')).effortChange, null);
    assert.equal((await handler.executeSlashCommand('model', 'default')).modelChange, null);
});
