import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    __testables,
    createWebchatBackgroundTaskManager,
} from '../src/lib/webchatBackgroundTasks.mjs';
import {
    getTask,
    ingestTaskEvent,
    readTaskLog,
    setTaskModel,
} from '../src/lib/workspaceTasks.mjs';
import { runWithSkillRuntimeOrigin } from '../src/lib/skillTaskOrigin.mjs';


test('background task ids are stable per target agent and remote task', () => {
    const first = __testables.localTaskId('opencodeAgent', 'abc');
    assert.equal(first, __testables.localTaskId('opencodeAgent', 'abc'));
    assert.notEqual(first, __testables.localTaskId('piAgent', 'abc'));
    assert.match(first, /^task_[0-9a-f]{24}$/);
});

test('task descriptions prefer prompt-like arguments and remain bounded', () => {
    assert.equal(
        __testables.describeTask('agent', 'execute', { prompt: '  build\n  the project  ' }),
        'build the project',
    );
    assert.equal(__testables.describeTask('agent', 'execute', {}), 'agent.execute');
    assert.ok(__testables.describeTask('agent', 'execute', { query: 'x'.repeat(400) }).length <= 240);
});

test('ongoing task restoration ignores malformed lines and terminal tasks', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'achilles-task-journal-'));
    const history = path.join(workspace, '.data', 'achilles-cli', 'tasks');
    fs.mkdirSync(history, { recursive: true });
    const ongoingId = 'task_aaaaaaaaaaaaaaaaaaaaaaaa';
    const finishedId = 'task_bbbbbbbbbbbbbbbbbbbbbbbb';
    fs.writeFileSync(path.join(history, 'agent_tasks'), [
        JSON.stringify({ id: ongoingId, targetAgent: 'one', remoteTaskId: '1', status: 'ongoing' }),
        '{partial',
        JSON.stringify({ id: finishedId, targetAgent: 'two', remoteTaskId: '2', status: 'finished' }),
        '',
    ].join('\n'));
    const tasks = __testables.readOngoingTasks(workspace);
    assert.deepEqual(tasks.map((task) => task.id), [ongoingId]);
});

test('remote task statuses map to the four WebChat states', () => {
    assert.equal(__testables.normalizeStatus('pending'), 'ongoing');
    assert.equal(__testables.normalizeStatus('running'), 'ongoing');
    assert.equal(__testables.normalizeStatus('completed'), 'finished');
    assert.equal(__testables.normalizeStatus('cancelled'), 'stopped');
    assert.equal(__testables.normalizeStatus('failed'), 'error');
});

test('continuation metadata binds the provider tool and opaque handle to its target agent', () => {
    assert.deepEqual(__testables.normalizeContinuation({
        version: 1,
        toolName: 'continue-task',
        handle: 'opaque-session-handle',
    }, 'opencodeAgent'), {
        version: 1,
        targetAgent: 'opencodeAgent',
        toolName: 'continue-task',
        handle: 'opaque-session-handle',
    });
    assert.deepEqual(__testables.normalizeContinuation({
        version: 1,
    }, 'piAgent', 'continue-task'), {
        version: 1,
        targetAgent: 'piAgent',
        toolName: 'continue-task',
    });
});

test('terminal task result text is exposed separately from the live log', () => {
    assert.equal(__testables.taskResultText({
        result: {
            content: [
                { type: 'text', text: 'Final answer' },
                { type: 'image', data: 'ignored' },
            ],
        },
    }), 'Final answer');
    assert.equal(__testables.taskResultText({ result: null }), '');
});

test('AchillesCLI declares generic task-view commands only for continuable terminal tasks', () => {
    const task = __testables.presentTask({
        id: 'task_111111111111111111111111',
        status: 'finished',
        continuation: { handle: 'opaque-task-handle' },
    });
    assert.deepEqual(task.commands, [
        {
            name: '/model',
            command: '/task model task_111111111111111111111111',
            description: 'Choose the execution model for this task',
            loadingLabel: 'Loading models…',
            argMatchMode: 'fragment',
            argCompletions: [],
        },
        {
            name: '/login',
            command: '/task login task_111111111111111111111111',
            description: 'Connect a provider in this task agent',
            loadingLabel: 'Loading providers…',
        },
    ]);
    const withCatalog = __testables.presentTask(task, new Map([[
        task.id,
        [{ key: 'openai/gpt-test', label: 'GPT Test', description: 'OpenAI model' }],
    ]]));
    assert.deepEqual(withCatalog.commands[0].argCompletions, [{
        value: 'openai/gpt-test',
        label: 'GPT Test',
        description: 'OpenAI model',
    }]);
    assert.deepEqual(__testables.presentTask({ ...task, status: 'ongoing' }).commands, []);
});

test('AchillesCLI manager stops and continues tasks through agent commands', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'achilles-task-actions-'));
    const ongoingId = 'task_111111111111111111111111';
    const finishedId = 'task_222222222222222222222222';
    const createdAt = '2026-07-23T10:00:00.000Z';
    let observer = null;
    const calls = [];
    const published = [];
    const agentClientModule = {
        setAgentTaskObserver(next) {
            observer = next;
            return () => { observer = null; };
        },
        async createAgentClient(agentName) {
            calls.push(['client', agentName]);
            return {
                async cancelTask(remoteTaskId) {
                    calls.push(['cancel', remoteTaskId]);
                    return { id: remoteTaskId, status: 'cancelled', updatedAt: createdAt };
                },
                async ensureAgentRunning(targetAgent, options) {
                    calls.push(['ensure', targetAgent, options]);
                },
                async callToolWithoutWait(toolName, args) {
                    calls.push(['continue', toolName, args]);
                    await observer({
                        agentName,
                        taskId: 'remote-next',
                        toolName,
                        arguments: args,
                        metadata: { status: 'queued', createdAt, updatedAt: createdAt },
                        getTaskStatus: async () => ({ id: 'remote-next', status: 'queued' }),
                    });
                },
            };
        },
    };

    try {
        await ingestTaskEvent(workspace, { task: {
            id: ongoingId,
            targetAgent: 'worker',
            remoteTaskId: 'remote-running',
            toolName: 'run-task',
            status: 'ongoing',
            remoteStatus: 'queued',
            createdAt,
            updatedAt: createdAt,
        } });
        await ingestTaskEvent(workspace, { task: {
            id: finishedId,
            targetAgent: 'worker',
            remoteTaskId: 'remote-finished',
            toolName: 'run-task',
            status: 'finished',
            remoteStatus: 'completed',
            createdAt,
            updatedAt: createdAt,
            continuation: {
                version: 1,
                targetAgent: 'worker',
                toolName: 'continue-task',
                handle: 'opaque-task-handle',
            },
        } });

        const manager = await createWebchatBackgroundTaskManager({
            workingDir: workspace,
            emitProtocol: false,
            onPublish: (event) => published.push(event),
            agentClientModule,
        });
        try {
            const stopped = await manager.stopTask(ongoingId);
            assert.equal(stopped.status, 'stopped');
            assert.equal(stopped.remoteStatus, 'cancelled');

            const continued = await manager.continueTask(finishedId, 'finish the tests');
            assert.equal(continued.id, finishedId);
            assert.equal(continued.turn, 2);
            assert.equal(continued.status, 'ongoing');
            assert.equal(continued.remoteStatus, 'queued');
            assert.equal(getTask(workspace, finishedId).remoteTaskId, 'remote-next');
            assert.match(readTaskLog(workspace, finishedId).text, /you> finish the tests/);
            const continuationEvent = published.find((event) => event.event === 'continued');
            assert.equal(continuationEvent.task.id, finishedId);
            assert.match(continuationEvent.logAppend, /you> finish the tests/);
            assert.doesNotMatch(continuationEvent.logAppend, /\[Continuation \d+\]/);
            assert.equal(continuationEvent.logOffset, readTaskLog(workspace, finishedId).nextOffset);
        } finally {
            manager.close();
        }
        assert.deepEqual(calls, [
            ['client', 'worker'],
            ['cancel', 'remote-running'],
            ['client', 'worker'],
            ['ensure', 'worker', { mode: 'global' }],
            ['continue', 'continue-task', { handle: 'opaque-task-handle', prompt: 'finish the tests' }],
        ]);
    } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
    }
});

test('active task messages use the declared tool without creating another task', async (t) => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'achilles-live-input-'));
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
    const taskId = 'task_aaaaaaaaaaaaaaaaaaaaaaaa';
    const calls = [];
    const events = [];
    await ingestTaskEvent(workspace, { task: {
        id: taskId, targetAgent: 'worker', remoteTaskId: 'running-id', status: 'ongoing',
        continuation: { version: 1, targetAgent: 'worker', toolName: 'resume-work',
            messageToolName: 'message-work', handle: 'saved-session-handle' },
    } });
    const manager = await createWebchatBackgroundTaskManager({
        workingDir: workspace, emitProtocol: false, onPublish: (event) => events.push(event),
        agentClientModule: {
            setAgentTaskObserver() { return () => {}; },
            async createAgentClient(agent) {
                assert.equal(agent, 'worker');
                return { async callTool(name, args) {
                    calls.push({ name, args });
                    return { content: [{ type: 'text', text: JSON.stringify({ delivery: 'queued' }) }] };
                } };
            },
        },
    });
    t.after(() => manager.close());
    const sent = await manager.continueTask(taskId, 'check the current screen');
    assert.equal(sent.delivery, 'queued');
    assert.equal(getTask(workspace, taskId).remoteTaskId, 'running-id');
    assert.deepEqual(calls, [{ name: 'message-work', args: { handle: 'saved-session-handle', prompt: 'check the current screen' } }]);
    assert.match(readTaskLog(workspace, taskId).text, /User \(queued\): check the current screen/);
    assert.ok(events.some((event) => event.action === 'continue' && event.ok && event.delivery === 'queued'));
});

test('AchillesCLI passes a persisted task model explicitly to continuation', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'achilles-task-model-continuation-'));
    const taskId = 'task_aaaaaaaaaaaaaaaaaaaaaaaa';
    let observer = null;
    let continuationArgs = null;
    const agentClientModule = {
        setAgentTaskObserver(next) {
            observer = next;
            return () => { observer = null; };
        },
        async createAgentClient(agentName) {
            return {
                async ensureAgentRunning() {},
                async callToolWithoutWait(toolName, args) {
                    continuationArgs = args;
                    await observer({
                        agentName,
                        taskId: 'remote-selected-model',
                        toolName,
                        arguments: args,
                        metadata: { status: 'queued' },
                        getTaskStatus: async () => ({ id: 'remote-selected-model', status: 'queued' }),
                    });
                },
            };
        },
    };

    try {
        await ingestTaskEvent(workspace, { task: {
            id: taskId,
            targetAgent: 'piAgent',
            remoteTaskId: 'remote-original',
            toolName: 'execute-task',
            status: 'finished',
            continuation: {
                version: 1,
                targetAgent: 'piAgent',
                toolName: 'continue-task',
                handle: 'opaque-selected-model-handle',
            },
        } });
        await setTaskModel(workspace, taskId, {
            key: 'anthropic/claude-sonnet',
            provider: 'anthropic',
            model: 'claude-sonnet',
            label: 'Claude Sonnet',
        });
        const manager = await createWebchatBackgroundTaskManager({
            workingDir: workspace,
            emitProtocol: false,
            agentClientModule,
        });
        try {
            await manager.continueTask(taskId, 'Use the selected model');
        } finally {
            manager.close();
        }
        assert.deepEqual(continuationArgs, {
            handle: 'opaque-selected-model-handle',
            prompt: 'Use the selected model',
            model: 'claude-sonnet',
            provider: 'anthropic',
        });
    } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
    }
});

test('a completed continuation persists its terminal state on the current turn', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'achilles-task-continuation-'));
    const taskId = 'task_333333333333333333333333';
    const createdAt = '2026-07-23T10:00:00.000Z';
    const continuationStartedAt = '2026-07-24T06:39:10.000Z';
    const completedAt = '2026-07-24T06:39:14.000Z';
    let observer = null;
    const agentClientModule = {
        setAgentTaskObserver(next) {
            observer = next;
            return () => { observer = null; };
        },
        async createAgentClient(agentName) {
            return {
                async ensureAgentRunning() { },
                async callToolWithoutWait(toolName, args) {
                    await observer({
                        agentName,
                        taskId: 'remote-turn-two',
                        toolName,
                        arguments: args,
                        metadata: {
                            status: 'queued',
                            createdAt: continuationStartedAt,
                            updatedAt: continuationStartedAt,
                        },
                        getTaskStatus: async () => ({
                            id: 'remote-turn-two',
                            status: 'completed',
                            updatedAt: completedAt,
                            logTail: 'Working on the continuation.\n',
                            logSeq: 1,
                            result: { content: [{ type: 'text', text: 'Done.' }] },
                        }),
                    });
                },
            };
        },
    };

    try {
        await ingestTaskEvent(workspace, {
            task: {
                id: taskId,
                targetAgent: 'worker',
                remoteTaskId: 'remote-turn-one',
                toolName: 'run-task',
                status: 'finished',
                remoteStatus: 'completed',
                createdAt,
                updatedAt: createdAt,
                turn: 1,
                continuation: {
                    version: 1,
                    targetAgent: 'worker',
                    toolName: 'continue-task',
                    handle: 'opaque-task-handle',
                },
                logRetention: 'full',
            },
            log: { tail: 'First answer', seq: 1 },
            finalOutput: 'First answer',
        });

        const manager = await createWebchatBackgroundTaskManager({
            workingDir: workspace,
            emitProtocol: false,
            agentClientModule,
        });
        try {
            const continued = await manager.continueTask(taskId, 'continue');
            assert.equal(continued.turn, 2);
            assert.deepEqual(
                continued.finalOutputRanges.map(({ turn, length }) => ({ turn, length })),
                [{ turn: 1, length: 'First answer'.length }],
            );

            let stored = getTask(workspace, taskId);
            const deadline = Date.now() + 500;
            while (stored?.status !== 'finished' && Date.now() < deadline) {
                await new Promise((resolve) => setTimeout(resolve, 5));
                stored = getTask(workspace, taskId);
            }

            assert.equal(stored.status, 'finished');
            assert.equal(stored.remoteStatus, 'completed');
            assert.equal(stored.remoteTaskId, 'remote-turn-two');
            assert.equal(stored.turn, 2);
            assert.equal(stored.createdAt, createdAt);
            assert.equal(stored.executionStartedAt, continuationStartedAt);
            assert.equal(stored.updatedAt, completedAt);
            assert.deepEqual(
                stored.finalOutputRanges.map(({ turn, length }) => ({ turn, length })),
                [
                    { turn: 1, length: 'First answer'.length },
                    { turn: 2, length: 'Done.'.length },
                ],
            );
            const storedLog = readTaskLog(workspace, taskId).text;
            assert.equal(
                stored.finalOutputRanges.map(({ offset, length }) => storedLog.slice(offset, offset + length)).join('|'),
                'First answer|Done.',
            );
            assert.match(storedLog, /Working on the continuation\.\n\n\[task result\]\nDone\.\n$/u);
        } finally {
            manager.close();
        }
    } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
    }
});

test('reattachment starts a manual target agent before polling its task', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'achilles-task-reattach-'));
    const taskId = 'task_444444444444444444444444';
    const createdAt = '2026-07-24T07:00:00.000Z';
    let targetRunning = false;
    const calls = [];
    const agentClientModule = {
        setAgentTaskObserver() {
            return () => { };
        },
        async createAgentClient(agentName) {
            calls.push(['client', agentName]);
            return {
                async ensureAgentRunning(targetAgent, options) {
                    calls.push(['ensure', targetAgent, options]);
                    targetRunning = true;
                },
                async getTaskStatus(remoteTaskId) {
                    assert.equal(targetRunning, true);
                    calls.push(['status', remoteTaskId]);
                    return {
                        id: remoteTaskId,
                        status: 'completed',
                        updatedAt: createdAt,
                    };
                },
            };
        },
    };

    try {
        await ingestTaskEvent(workspace, { task: {
            id: taskId,
            targetAgent: 'manual-worker',
            remoteTaskId: 'remote-running',
            toolName: 'run-task',
            sessionId: 'previous-session', assistantMessageId: 'previous-message', turnId: 'previous-turn',
            status: 'ongoing',
            remoteStatus: 'running',
            createdAt,
            updatedAt: createdAt,
        } });

        const manager = await createWebchatBackgroundTaskManager({
            workingDir: workspace,
            emitProtocol: false,
            agentClientModule,
            onTaskStarted() { calls.push(['unexpected-transcript-insertion']); },
        });
        try {
            let stored = getTask(workspace, taskId);
            const deadline = Date.now() + 750;
            while (stored?.status !== 'finished' && Date.now() < deadline) {
                await new Promise((resolve) => setTimeout(resolve, 10));
                stored = getTask(workspace, taskId);
            }

            assert.equal(stored.status, 'finished');
            assert.equal(stored.sessionId, 'previous-session');
            assert.equal(stored.assistantMessageId, 'previous-message');
            assert.deepEqual(calls, [
                ['client', 'manual-worker'],
                ['ensure', 'manual-worker', { mode: 'global' }],
                ['status', 'remote-running'],
            ]);
        } finally {
            manager.close();
        }
    } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
    }
});

test('overlapping launches notify only their initiating turn and retain session association', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'achilles-task-origins-'));
    let observer;
    const started = [];
    const manager = await createWebchatBackgroundTaskManager({
        workingDir: workspace, emitProtocol: false,
        async onTaskStarted(task, origin) {
            await Promise.resolve();
            started.push({ taskId: task.id, ...origin });
        },
        agentClientModule: {
            setAgentTaskObserver(callback) { observer = callback; return () => {}; },
        },
    });
    try {
        const alpha = Object.freeze({ workingDir: workspace, sessionId: 'alpha', assistantMessageId: 'alpha-message', turnId: 'alpha-turn' });
        const beta = Object.freeze({ workingDir: workspace, sessionId: 'beta', assistantMessageId: 'beta-message', turnId: 'beta-turn' });
        const alphaWaiter = manager.createTaskStartWaiter(alpha);
        const betaWaiter = manager.createTaskStartWaiter(beta);
        let alphaResolved = false;
        alphaWaiter.promise.then(() => { alphaResolved = true; });
        let release;
        const gate = new Promise((resolve) => { release = resolve; });
        const event = (id) => ({ agentName: 'worker', toolName: 'execute-task', taskId: id,
            arguments: { prompt: id, robotName: 'analyst' }, metadata: { status: 'queued' }, getTaskStatus: () => new Promise(() => {}) });
        const pendingAlpha = runWithSkillRuntimeOrigin(alpha, async () => {
            await gate;
            return observer(event('remote-alpha'));
        });
        const betaResult = await runWithSkillRuntimeOrigin(beta, () => observer(event('remote-beta')));
        assert.equal((await betaWaiter.promise).id, betaResult.id);
        assert.equal(alphaResolved, false);
        release();
        const alphaResult = await pendingAlpha;
        assert.equal((await alphaWaiter.promise).id, alphaResult.id);
        assert.deepEqual(started.map(({ sessionId, assistantMessageId, turnId }) => ({ sessionId, assistantMessageId, turnId })), [
            { sessionId: 'beta', assistantMessageId: 'beta-message', turnId: 'beta-turn' },
            { sessionId: 'alpha', assistantMessageId: 'alpha-message', turnId: 'alpha-turn' },
        ]);
        assert.equal(getTask(workspace, alphaResult.id).sessionId, 'alpha');
        assert.equal(getTask(workspace, betaResult.id).sessionId, 'beta');
        assert.equal((await betaWaiter.promise).robotName, 'analyst');
        assert.equal(getTask(workspace, betaResult.id).robotName, 'analyst');
    } finally {
        manager.close();
        fs.rmSync(workspace, { recursive: true, force: true });
    }
});

test('ambiguous remote continuation remains visible and cannot be automatically retried', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'achilles-task-uncertain-'));
    const taskId = 'task_555555555555555555555555';
    let launches = 0;
    let manager;
    try {
        await ingestTaskEvent(workspace, { task: { id: taskId, targetAgent: 'worker', remoteTaskId: 'old',
            status: 'finished', continuation: { version: 1, targetAgent: 'worker',
                toolName: 'continue-task', handle: 'opaque-task-handle' } } });
        manager = await createWebchatBackgroundTaskManager({ workingDir: workspace, emitProtocol: false,
            agentClientModule: {
                setAgentTaskObserver() { return () => {}; },
                async createAgentClient() { return {
                    async ensureAgentRunning() {},
                    async callToolWithoutWait() { launches += 1; throw new Error('connection lost after submission'); },
                }; },
            },
        });
        await assert.rejects(manager.continueTask(taskId, 'finish the work'), /connection lost/);
        const task = getTask(workspace, taskId);
        assert.equal(task.remoteTaskId, 'old');
        assert.equal(task.continuationAttempt.status, 'uncertain');
        assert.equal(task.continuationAttempt.message, 'finish the work');
        assert.match(task.continuationAttempt.error, /reconcile/i);
        await assert.rejects(manager.continueTask(taskId, 'retry'), /requires_reconciliation/);
        assert.equal(launches, 1);
    } finally {
        manager?.close();
        fs.rmSync(workspace, { recursive: true, force: true });
    }
});
