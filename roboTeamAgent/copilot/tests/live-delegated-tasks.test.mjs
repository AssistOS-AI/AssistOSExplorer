import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createWebchatBackgroundTaskManager } from '../src/lib/webchat/webchatBackgroundTasks.mjs';

// Delegated copilot tasks as Live Sessions runs (P3.3 F4). The task journal
// takes workspace locks, which need Linux /proc.
const LINUX = existsSync('/proc/self/stat') ? false : 'workspace locks require Linux /proc';
const OWNER = Object.freeze({ claimId: 'c_turn' });

function recordingPublisher() {
    const record = { starts: [], runs: [] };
    return {
        record,
        startRun(options) {
            const run = { options, output: [], ends: [] };
            record.starts.push(options);
            record.runs.push(run);
            return {
                output(text, style) { run.output.push([style, text]); },
                status(text) { run.output.push(['status', text]); },
                end(result) { run.ends.push(result); },
            };
        },
    };
}

async function managerFor(t, { status = () => ({ status: 'running' }) } = {}) {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'achilles-live-tasks-'));
    const previousRoot = process.env.PLOINKY_WORKSPACE_ROOT;
    process.env.PLOINKY_WORKSPACE_ROOT = path.dirname(workspace);
    const calls = [];
    const agentClientModule = {
        setAgentTaskObserver() { return () => {}; },
        async createAgentClient(agentName) {
            return {
                getTaskStatus: async (taskId) => ({ id: taskId, ...status(agentName, taskId) }),
                cancelTask: async (taskId) => { calls.push(['cancel', agentName, taskId]); return { id: taskId, status: 'cancelled' }; },
            };
        },
    };
    const publisher = recordingPublisher();
    const manager = await createWebchatBackgroundTaskManager({ workingDir: workspace, emitProtocol: false, reattachExistingTasks: false,
        agentClientModule, livePublisher: publisher });
    t.after(async () => {
        manager.close();
        if (previousRoot === undefined) delete process.env.PLOINKY_WORKSPACE_ROOT; else process.env.PLOINKY_WORKSPACE_ROOT = previousRoot;
        await fs.rm(workspace, { recursive: true, force: true });
    });
    const origin = { workingDir: workspace, sessionId: '00000000-0000-4000-8000-0000000000aa', turnId: 'turn-1',
        assistantMessageId: '00000000-0000-4000-8000-0000000000bb', liveOwner: OWNER };
    return { manager, publisher, calls, origin, workspace };
}

async function until(predicate, label, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

test('a task launched by a turn publishes a copilot task with the turn\'s owner claim, its log and its end', { skip: LINUX }, async (t) => {
    let remote = { status: 'running' };
    const { manager, publisher, origin } = await managerFor(t, { status: () => remote });
    await manager.observeScriptTask({ agentName: 'otherAgent', taskId: 'remote-1', toolName: 'long_job', arguments: { prompt: 'Summarize the logs' } }, origin);
    // The run is started inside the turn, before observeScriptTask returns.
    assert.equal(publisher.record.starts.length, 1);
    const { onControl, ...start } = publisher.record.starts[0];
    assert.equal(typeof onControl, 'function');
    assert.deepEqual(start, { kind: 'copilot-task', title: 'Delegated task · Summarize the logs', cwd: origin.workingDir,
        robot: process.env.ROBOTEAM_COPILOT_ROBOT_NAME || '', owner: OWNER });
    const [run] = publisher.record.runs;
    assert.deepEqual(run.output[0], ['status', 'Delegated to otherAgent · long_job']);
    remote = { status: 'completed', logTail: 'step one\nstep two\n', logSeq: 2, result: { content: [{ type: 'text', text: 'done' }] } };
    await until(() => run.ends.length === 1, 'the task end');
    assert.ok(run.output.some(([style, text]) => style === 'output' && text.includes('step two')));
    assert.deepEqual(run.ends, [{ status: 'finished' }]);
});

test('RoboTeam tasks and RoboFlow launches are not published again; reattached tasks are not announced', { skip: LINUX }, async (t) => {
    const { manager, publisher, origin } = await managerFor(t);
    await manager.observeScriptTask({ agentName: 'roboTeamAgent', taskId: 'flow-task', toolName: 'roboflow_start_flow', arguments: { prompt: 'Run the flow' } }, origin);
    await manager.observeScriptTask({ agentName: 'roboTeamAgent', taskId: 'robot-task', toolName: 'start-cli-task', arguments: { prompt: 'Robot work' } }, origin);
    await manager.observeScriptTask({ agentName: 'otherAgent', taskId: 'no-origin', toolName: 'long_job', arguments: { prompt: 'x' } }, null);
    assert.deepEqual(publisher.record.starts, []);
});

test('Stop pauses the task through the signed cancel call; messages are refused', { skip: LINUX }, async (t) => {
    const { manager, publisher, origin, calls } = await managerFor(t);
    await manager.observeScriptTask({ agentName: 'otherAgent', taskId: 'remote-stop', toolName: 'long_job', arguments: { prompt: 'Stop me' } }, origin);
    const { onControl } = publisher.record.starts[0];
    assert.deepEqual(await onControl({ action: 'message', requestId: 'm1', message: 'hello' }), { outcome: 'rejected', detail: 'delegated tasks take no messages' });
    assert.equal(await onControl({ action: 'stop', requestId: 's1' }), 'delivered');
    assert.deepEqual(calls, [['cancel', 'otherAgent', 'remote-stop']]);
    assert.deepEqual(publisher.record.runs[0].ends, [{ status: 'stopped', reason: 'stopped' }]);
    assert.equal(await onControl({ action: 'stop', requestId: 's2' }), 'run_ended');
});
