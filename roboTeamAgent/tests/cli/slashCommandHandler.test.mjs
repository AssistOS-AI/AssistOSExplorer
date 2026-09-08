import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SlashCommandHandler, buildSlashCommandCatalog } from '../roboTeamAgent/copilot/src/repl/SlashCommandHandler.mjs';
import { getQuickReference, getCommandHelp } from '../roboTeamAgent/copilot/src/ui/HelpSystem.mjs';

function handler(options = {}) {
    return new SlashCommandHandler({ getSkills: () => [], getUserSkills: () => [], ...options });
}

const removed = ['write', 'delete', 'validate', 'template', 'generate', 'build', 'test', 'run-tests', 'refine', 'specs', 'specs-write', 'write-tests', 'scaffold', 'tier'];

test('removed commands cannot execute or appear in public command surfaces', async () => {
    const commands = handler({ executeSkill: () => assert.fail('removed commands must not execute skills') });
    const catalog = new Set(buildSlashCommandCatalog().map((entry) => entry.name));
    const help = new Set(getCommandHelp().map((entry) => entry.name));
    for (const name of removed) {
        const result = await commands.executeSlashCommand(name, 'anything');
        assert.match(result.error, /Unknown command/);
        assert.equal(catalog.has(`/${name}`), false);
        assert.equal(help.has(name), false);
        assert.equal(commands.getCompletions(`/${name}`)[0].includes(`/${name}`), false);
        assert.doesNotMatch(getQuickReference(), new RegExp(`/${name}(?:\\s|$)`));
    }
    assert.match((await commands.executeSlashCommand('update', 'some-skill section')).error, /Unknown command/);
});

test('native model IDs remain opaque and default clears only the selected backend', async () => {
    const commands = handler({ loadModels: async () => ({ backend: 'opencode', models: ['provider/model-v2', 'vendor/MixedCase'] }) });
    assert.deepEqual(await commands.executeSlashCommand('model', 'provider/model-v2'), {
        handled: true, backend: 'opencode', modelChange: 'provider/model-v2',
    });
    assert.deepEqual(await commands.executeSlashCommand('model', 'default'), {
        handled: true, backend: 'opencode', modelChange: null,
    });
    assert.match((await commands.executeSlashCommand('model', 'vendor/mixedcase')).error, /Unknown model/);
    assert.deepEqual(commands.getCompletions('/model model-v')[0], ['/model provider/model-v2']);
});

test('exec awaits engine completion rather than returning when a worker starts', async () => {
    let release;
    const completion = new Promise((resolve) => { release = resolve; });
    const commands = handler({ executeSkill: async (name, prompt) => {
        assert.equal(name, 'launch-robot');
        assert.equal(prompt, 'browser: first line\nsecond  line');
        return completion;
    } });
    let settled = false;
    const execution = commands.executeSlashCommand('exec', 'launch-robot browser: first line\nsecond  line', {
        context: { backgroundTaskManager: { createTaskStartWaiter: () => assert.fail('host must not detach the ALA turn') } },
    }).then((value) => { settled = true; return value; });
    await Promise.resolve();
    assert.equal(settled, false);
    release('https://workspace.example/robot/session');
    assert.equal((await execution).result, 'https://workspace.example/robot/session');
});

test('hierarchical continuation preserves multiline prompt and exact originating IDs', async () => {
    const origin = { sessionId: 'session-a', assistantMessageId: 'message-a', turnId: 'turn-a' };
    const taskId = 'task_1234567890abcdef12345678';
    const commands = handler({ continueTask: async (id, prompt, context) => {
        assert.equal(id, taskId);
        assert.equal(prompt, 'first line\nsecond  line');
        assert.equal(context, origin);
        return { id };
    } });
    const result = await commands.executeSlashCommand('task', `continue ${taskId} first line\nsecond  line`, { context: origin });
    assert.equal(result.error, undefined);
    assert.match(result.result, new RegExp(taskId));
});

test('deterministic catalog commands never use the execution engine', async () => {
    const commands = handler({
        getSkills: () => [{ name: 'bash', builtIn: true, enabled: true }, { name: 'external', enabled: false }],
        executeSkill: () => assert.fail('catalog operations cannot execute the model'),
        readSkill: async (name) => { assert.equal(name, 'external'); return '# External descriptor'; },
        removeSkill: async (name) => { if (name === 'bash') throw new Error('Packaged skills cannot be removed'); },
    });
    assert.match((await commands.executeSlashCommand('list', 'skills')).result, /external.*disabled/);
    assert.equal((await commands.executeSlashCommand('read', 'external')).result, '# External descriptor');
    assert.match((await commands.executeSlashCommand('remove', 'skill bash')).error, /cannot be removed/);
    assert.equal((await commands.executeSlashCommand('remove', 'skill external')).error, undefined);
});

test('permission failure is surfaced rather than reported as applied', async () => {
    const commands = handler({ getPermissions: () => 'ask-for-approval', setPermissions: async () => { throw new Error('settings are read-only'); } });
    assert.match((await commands.executeSlashCommand('permissions', 'full-access')).error, /read-only/);
});
