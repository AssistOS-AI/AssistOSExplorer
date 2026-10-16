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

test('/model resolves gateway model IDs that contain spaces', async () => {
    const handler = new SlashCommandHandler({ loadModels: async () => ({ backend: 'opencode', models: [
        { id: 'soul-gateway/openference/Qwen3.8 27b', efforts: [] },
        { id: 'space model', efforts: ['low', 'high'] },
        { id: 'space', efforts: [] },
    ] }) });
    const spaced = await handler.executeSlashCommand('model', 'soul-gateway/openference/Qwen3.8 27b');
    assert.equal(spaced.modelChange, 'soul-gateway/openference/Qwen3.8 27b');
    assert.equal(spaced.effortChange, null);
    const withEffort = await handler.executeSlashCommand('model', 'space model high');
    assert.equal(withEffort.modelChange, 'space model');
    assert.equal(withEffort.effortChange, 'high');
    const noEffort = await handler.executeSlashCommand('model', 'space model');
    assert.equal(noEffort.modelChange, 'space model');
    assert.equal(noEffort.effortChange, null);
    const defaultEffort = await handler.executeSlashCommand('model', 'space model default');
    assert.equal(defaultEffort.modelChange, 'space model');
    assert.equal(defaultEffort.effortChange, null);
    for (const input of ['space model bogus', 'space model high extra']) {
        const result = await handler.executeSlashCommand('model', input);
        assert.ok(result.error, input);
        assert.equal(result.modelChange, undefined);
    }
});

test('/model prefers the longest matching model ID', async () => {
    const handler = new SlashCommandHandler({ loadModels: async () => ({ backend: 'opencode', models: [
        { id: 'a', efforts: [] }, { id: 'a b', efforts: [] },
    ] }) });
    assert.equal((await handler.executeSlashCommand('model', 'a b')).modelChange, 'a b');
    assert.equal((await handler.executeSlashCommand('model', 'a')).modelChange, 'a');
});
