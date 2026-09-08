import test from 'node:test';
import assert from 'node:assert/strict';

import {
    COMMAND_DEFINITIONS,
    SlashCommandHandler,
    SUB_OPTIONS,
} from '../src/repl/SlashCommandHandler.mjs';
import {
    buildCompletionSelectorItems,
    getSubOptionArgumentSource,
} from '../src/repl/InteractivePrompt.mjs';
import {
    buildCommandList,
    buildSubOptionList,
    createCommandSelection,
} from '../src/ui/CommandSelector.mjs';

test('CLI command catalog exposes task and session submenus', async () => {
    const commands = buildCommandList(COMMAND_DEFINITIONS);
    const task = commands.find((command) => command.name === '/task');
    const session = commands.find((command) => command.name === '/session');

    assert.equal(task.hasSubOptions, true);
    assert.deepEqual(task.subOptions, ['view', 'continue', 'stop', 'model', 'login']);
    assert.equal(session.hasSubOptions, true);
    assert.deepEqual(session.subOptions, ['new', 'resume']);

    const taskOptions = await buildSubOptionList('task', task.subOptions);
    assert.equal(taskOptions.find((option) => option.name === '/task view').args, 'required');
    assert.equal(taskOptions.find((option) => option.name === '/task continue').args, 'required');
});

test('every hierarchical CLI command selects the appropriate next input', () => {
    const expectedSources = {
        'task view': 'tasks',
        'task continue': 'tasks',
        'task stop': 'tasks',
        'task model': 'tasks',
        'task login': 'tasks',
        'skills enable': 'text',
        'skills disable': 'text',
        'skill enable': 'skills',
        'skill disable': 'skills',
        'list skills': 'none',
        'list repos': 'none',
        'add repo': 'text',
        'remove repo': 'text',
        'remove skill': 'skills',
        'update repos': 'none',
        'session new': 'none',
        'session resume': 'sessions',
    };

    for (const [command, options] of Object.entries(SUB_OPTIONS)) {
        for (const [subOption, definition] of Object.entries(options)) {
            assert.equal(
                getSubOptionArgumentSource(command, subOption, definition),
                expectedSources[`${command} ${subOption}`],
                `unexpected selection flow for /${command} ${subOption}`,
            );
        }
    }
});

test('dynamic picker selections preserve opaque task and session ids', () => {
    const taskId = 'task_313867f2a315ee603892849e';
    const [item] = buildCompletionSelectorItems([{
        value: taskId,
        label: 'Inspect task handling',
        description: 'finished',
    }]);
    const selected = createCommandSelection(item);

    assert.equal(selected.name, 'Inspect task handling');
    assert.equal(selected.value, taskId);
    assert.equal(selected.args, '');
});

test('session resume completions are available to the CLI selector and Tab completion', () => {
    const sessionId = '123e4567-e89b-42d3-a456-426614174000';
    const handler = new SlashCommandHandler({
        executeSkill: async () => null,
        getUserSkills: () => [],
        getSkills: () => [],
        getSessions: () => ({
            currentSessionId: sessionId,
            sessions: [{
                sessionId,
                preview: 'Investigate task UI',
                updatedAt: '2026-07-24T09:00:00.000Z',
            }],
        }),
    });

    assert.deepEqual(handler.getSubOptions('session'), ['new', 'resume']);
    assert.equal(handler.getSessionCompletions()[0].value, sessionId);
    assert.deepEqual(
        handler.getCompletions('/session resume ')[0],
        [`/session resume ${sessionId}`],
    );
});

test('native selector cancellation releases terminal listeners and restores raw mode', async (t) => {
    const { showCommandSelector } = await import('../src/ui/CommandSelector.mjs');
    const stdin = process.stdin;
    const descriptors = Object.fromEntries(['isTTY', 'isRaw', 'setRawMode', 'resume'].map((key) => [key, Object.getOwnPropertyDescriptor(stdin, key)]));
    const restore = () => {
        for (const [key, descriptor] of Object.entries(descriptors)) {
            if (descriptor) Object.defineProperty(stdin, key, descriptor);
            else delete stdin[key];
        }
    };
    t.after(restore);
    Object.defineProperties(stdin, {
        isTTY: { configurable: true, value: true },
        isRaw: { configurable: true, writable: true, value: true },
        setRawMode: { configurable: true, value: (raw) => { stdin.isRaw = raw; } },
        resume: { configurable: true, value: () => stdin },
    });
    const output = t.mock.method(process.stdout, 'write', () => true);
    const beforeData = stdin.listeners('data');
    const beforeResize = process.stdout.listeners('resize');
    const controller = new AbortController();
    const selection = showCommandSelector([{ name: 'Deny', value: 'decline' }, { name: 'Allow', value: 'accept' }], { signal: controller.signal });
    controller.abort();
    assert.equal(await selection, null);
    assert.deepEqual(stdin.listeners('data'), beforeData);
    assert.deepEqual(process.stdout.listeners('resize'), beforeResize);
    assert.equal(stdin.isRaw, true);
    output.mock.restore();
    restore();
});
