import assert from 'node:assert/strict';
import test from 'node:test';

import { action, launchRobotInternals } from '../src/skills/launch-robot/scripts/action.mjs';
import { ROBOTEAM_AGENT } from '../src/lib/roboTeamClient.mjs';

test('delegates CLI work asynchronously without requesting a GUI session', async () => {
    const calls = [];
    const result = await action({ promptText: 'cli Analyst: review code', workingDir: '/workspace/project',
        agentClient: { async callToolWithoutWait(tool, input) {
            calls.push({ tool, input }); return { metadata: { taskId: 'cli-task' } };
        } } });
    assert.match(result, /Robot CLI task cli-task started/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].tool, 'startSimpleALATaskForRobot');
    assert.equal(calls[0].input.cwd, '/workspace/project');
});

test('normalizes whole and individual robot skill selections for the SDK payload', () => {
    const request = launchRobotInternals.normalizeRequest(JSON.stringify({ mode: 'desktop', task: 'Review',
        skillSets: ['documents'], skillset: 'research', skills: ['documents/read-pdf', 'research/check'] }));
    assert.equal(request.skills, 'documents/read-pdf,research/check');
    assert.equal(request.skillSets, 'documents');
    assert.equal(request.skillset, 'research');
    assert.throws(() => launchRobotInternals.normalizeRequest('{"mode":"desktop","task":"x","skills":{}}'), /string or array/);
});

test('starts a desktop robot and publishes its link and returns it to the model', async () => {
    const calls = [];
    const presentations = [];
    const result = await action({
        publishLiveSession: async (...args) => presentations.push(args),
        promptText: 'desktop Analyst: inspect the application',
        workingDir: '/workspace/project',
        pollIntervalMs: 1,
        agentClient: {
            callToolWithoutWait: async (toolName, input, options) => {
                calls.push({ toolName, input, options });
                if (toolName === 'startDesktopTaskForRobot') {
                    return { metadata: { taskId: 'task-1', status: 'running', backgroundTask: { detached: true } } };
                }
                return { ok: true, sessionUrl: '/robo/live/' };
            },
            getTaskStatus: async () => ({ id: 'task-1', status: 'running' }),
        },
    });

    assert.equal(result, 'Robot task task-1 started. [Open live desktop](/robo/live/)');
    assert.deepEqual(presentations, [['task-1', { mode: 'desktop', url: '/robo/live/' }]]);
    assert.deepEqual(calls, [
        {
            toolName: 'startDesktopTaskForRobot',
            input: {
                robotName: 'Analyst',
                cwd: '/workspace/project',
                task: 'inspect the application',
                ca: 'codex',
            },
            options: undefined,
        },
        {
            toolName: 'getSessionUrlForRobotDesktop',
            input: { robotName: 'Analyst' },
            options: undefined,
        },
    ]);
});

test('starts a browser robot from JSON with optional execution hints', async () => {
    const calls = [];
    const result = await action({
        promptText: JSON.stringify({
            mode: 'browser', robotName: 'Publisher', task: 'publish the draft',
            ca: 'pi', model: 'fast', skillSets: 'editorial',
        }),
        workingDir: '/workspace/site',
        pollIntervalMs: 1,
        agentClient: {
            callToolWithoutWait: async (toolName, input) => {
                calls.push({ toolName, input });
                if (toolName === 'startBrowserTaskForRobot') {
                    return { metadata: { taskId: 'task-2', status: 'running' } };
                }
                return { ok: true, sessionUrl: '/browser/live/' };
            },
            getTaskStatus: async () => ({ id: 'task-2', status: 'running' }),
        },
    });

    assert.equal(result, 'Robot task task-2 started. [Open live browser](/browser/live/)');
    assert.deepEqual(calls[0], {
        toolName: 'startBrowserTaskForRobot',
        input: {
            robotName: 'Publisher', cwd: '/workspace/site', task: 'publish the draft',
            ca: 'pi', model: 'fast', skillSets: 'editorial',
        },
    });
});

test('rejects non-visible robot modes before making an MCP call', async () => {
    let called = false;
    const result = await action({
        promptText: '{"mode":"simple","robotName":"Analyst","task":"work"}',
        agentClient: { callToolWithoutWait: async () => { called = true; } },
    });
    assert.match(result, /mode must be desktop, browser, or cli/u);
    assert.equal(called, false);
});

test('normalizes the compact launch syntax deterministically', () => {
    assert.deepEqual(
        launchRobotInternals.normalizeRequest('browser Research Robot: compare the two pages'),
        {
            mode: 'browser', robotName: 'Research Robot', task: 'compare the two pages', ca: 'codex',
        },
    );
});

test('reports an async RoboTeam failure while waiting for the live session', async () => {
    const result = await action({
        promptText: 'desktop Analyst: inspect the application',
        workingDir: '/workspace/project',
        pollIntervalMs: 1,
        agentClient: {
            callToolWithoutWait: async () => ({ metadata: { taskId: 'task-failed', status: 'running' } }),
            getTaskStatus: async () => ({ id: 'task-failed', status: 'failed', error: 'ALA login is required' }),
        },
    });

    assert.equal(result, 'Could not start the RoboTeam task: ALA login is required');
});

test('omitted robot names use default consistently for launch and ready-link polling', async () => {
    for (const promptText of ['desktop: inspect the application', '{"mode":"browser","task":"compare pages"}']) {
        const calls = [];
        const result = await action({
            promptText,
            workingDir: '/workspace/project',
            pollIntervalMs: 1,
            agentClient: {
                callToolWithoutWait: async (toolName, input) => {
                    calls.push({ toolName, input });
                    return toolName.startsWith('start')
                        ? { metadata: { taskId: 'default-task', status: 'running' } }
                        : { sessionUrl: '/authenticated/live/' };
                },
                getTaskStatus: async () => ({ status: 'running' }),
            },
        });
        assert.match(result, /Robot task default-task started/);
        assert.match(result, /\/authenticated\/live\//);
        assert.equal(calls[0].input.robotName, 'default');
        assert.equal(calls[0].input.cwd, '/workspace/project');
        assert.equal(calls[1].input.robotName, 'default');
    }
});

test('explicit invalid robot names fail before delegation instead of selecting default', async () => {
    for (const robotName of ['', '   ', null, false, 4, {}, []]) {
        let called = false;
        const result = await action({
            promptText: JSON.stringify({ mode: 'desktop', robotName, task: 'inspect' }),
            agentClient: { callToolWithoutWait: async () => { called = true; } },
        });
        assert.match(result, /robotName must be a nonblank string/);
        assert.equal(called, false);
    }
});

test('an unknown named robot is never retried using default', async () => {
    const names = [];
    const result = await action({
        promptText: 'browser Missing Robot: compare pages',
        agentClient: {
            callToolWithoutWait: async (_toolName, input) => {
                names.push(input.robotName);
                return { ok: false, error: 'Unknown robot: Missing Robot' };
            },
        },
    });
    assert.match(result, /Unknown robot: Missing Robot/);
    assert.deepEqual(names, ['Missing Robot']);
});
