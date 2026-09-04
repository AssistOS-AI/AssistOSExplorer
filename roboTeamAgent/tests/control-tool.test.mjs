import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const AGENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function runControl(port) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['tools/control.mjs', 'start-simple-task'], {
            cwd: AGENT_ROOT,
            env: {
                ...process.env,
                ROBOTEAM_SERVICE_PORT: String(port),
                ROBOTEAM_INTERNAL_TOKEN: 'test-token',
                ROBOTEAM_TASK_POLL_INTERVAL_MS: '25',
            },
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.once('error', reject);
        child.once('close', (code) => resolve({ code, stdout, stderr }));
        child.stdin.end(JSON.stringify({
            tool: 'startSimpleALATaskForRobot',
            input: { robotName: 'Analyst', cwd: '/workspace', task: 'Inspect files' },
        }));
    });
}

function runInterruptedDesktopControl(port) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['tools/control.mjs', 'start-desktop-task'], {
            cwd: AGENT_ROOT,
            env: {
                ...process.env,
                ROBOTEAM_SERVICE_PORT: String(port),
                ROBOTEAM_INTERNAL_TOKEN: 'test-token',
                ROBOTEAM_TASK_POLL_INTERVAL_MS: '25',
            },
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        let signalled = false;
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => {
            stderr += chunk;
            if (!signalled && stderr.includes('RoboTeam task state: running.')) {
                signalled = true;
                child.kill('SIGTERM');
            }
        });
        child.once('error', reject);
        child.once('close', (code) => resolve({ code, stdout, stderr }));
        child.stdin.end(JSON.stringify({
            tool: 'startDesktopTaskForRobot',
            input: { robotName: 'Analyst', cwd: '/workspace', task: 'Inspect the desktop' },
        }));
    });
}

test('start tool stays alive, streams progress, and returns the final ALA result', async (t) => {
    let statusCalls = 0;
    const server = http.createServer((request, response) => {
        const chunks = [];
        request.on('data', (chunk) => chunks.push(chunk));
        request.on('end', () => {
            assert.equal(request.headers['x-roboteam-internal-token'], 'test-token');
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            let result;
            if (body.operation === 'start-simple-task') {
                result = { ok: true, taskId: 'robot-task-1', state: 'queued' };
            } else {
                statusCalls += 1;
                result = statusCalls === 1
                    ? { ok: true, task: { taskId: 'robot-task-1', type: 'simple', state: 'running', logTail: 'first message\n', logSeq: 1, result: '' } }
                    : { ok: true, task: { taskId: 'robot-task-1', type: 'simple', state: 'completed', logTail: 'first message\nsecond message\n', logSeq: 2, result: 'finished work\n' } };
            }
            response.writeHead(body.operation === 'start-simple-task' ? 202 : 200, { 'content-type': 'application/json' });
            response.end(JSON.stringify(result));
        });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => server.close());

    const result = await runControl(server.address().port);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { outputText: 'finished work' });
    assert.match(result.stderr, /RoboTeam task robot-task-1 queued/u);
    assert.match(result.stderr, /first message/u);
    assert.match(result.stderr, /second message/u);
    assert.match(result.stderr, /RoboTeam task state: completed/u);
});

test('an interrupted GUI tool stops its exact task and returns a native continuation handle', async (t) => {
    const robotId = 'analyst-a1b2c3';
    const robotTaskId = '12345678-1234-4123-8123-123456789abc';
    const requests = [];
    const server = http.createServer((request, response) => {
        const chunks = [];
        request.on('data', (chunk) => chunks.push(chunk));
        request.on('end', () => {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            requests.push(body);
            let result;
            if (body.operation === 'start-desktop-task') {
                result = { ok: true, robotId, robotName: 'Analyst', type: 'desktop', taskId: robotTaskId, state: 'queued' };
            } else if (body.operation === 'task-status') {
                result = { ok: true, task: { taskId: robotTaskId, type: 'desktop', state: 'running', logTail: '', result: '' } };
            } else {
                result = { ok: true, taskId: 'stop-operation', state: 'running' };
            }
            response.writeHead(body.operation === 'task-status' ? 200 : 202, { 'content-type': 'application/json' });
            response.end(JSON.stringify(result));
        });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => server.close());

    const result = await runInterruptedDesktopControl(server.address().port);
    assert.equal(result.code, 143, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.continuation.version, 1);
    assert.equal(output.continuation.toolName, 'resumeTaskForRobot');
    const decoded = JSON.parse(Buffer.from(output.continuation.handle, 'base64url').toString('utf8'));
    assert.deepEqual(decoded, { robotId, taskId: robotTaskId });
    assert.ok(requests.some((body) => (
        body.operation === 'take-control'
        && body.robotId === robotId
        && body.taskId === robotTaskId
    )));
});

test('resume tool decodes its handle and follows the replacement task to completion', async (t) => {
    const robotId = 'analyst-a1b2c3';
    const interruptedTaskId = '12345678-1234-4123-8123-123456789abc';
    const resumedTaskId = 'abcdefab-cdef-4abc-8def-abcdefabcdef';
    const handle = Buffer.from(JSON.stringify({ robotId, taskId: interruptedTaskId }), 'utf8').toString('base64url');
    const requests = [];
    const server = http.createServer((request, response) => {
        const chunks = [];
        request.on('data', (chunk) => chunks.push(chunk));
        request.on('end', () => {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            requests.push(body);
            const result = body.operation === 'resume-task'
                ? { ok: true, robotId, robotName: 'Analyst', type: 'desktop', taskId: resumedTaskId, state: 'queued' }
                : { ok: true, task: { taskId: resumedTaskId, type: 'desktop', state: 'completed', logTail: '', result: 'resumed result\n' } };
            response.writeHead(body.operation === 'resume-task' ? 202 : 200, { 'content-type': 'application/json' });
            response.end(JSON.stringify(result));
        });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => server.close());

    const result = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['tools/control.mjs', 'resume-task'], {
            cwd: AGENT_ROOT,
            env: {
                ...process.env,
                ROBOTEAM_SERVICE_PORT: String(server.address().port),
                ROBOTEAM_INTERNAL_TOKEN: 'test-token',
                ROBOTEAM_TASK_POLL_INTERVAL_MS: '25',
            },
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.once('error', reject);
        child.once('close', (code) => resolve({ code, stdout, stderr }));
        child.stdin.end(JSON.stringify({
            tool: 'resumeTaskForRobot',
            input: { handle, prompt: 'Continue from the current state.' },
        }));
    });

    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { outputText: 'resumed result' });
    assert.deepEqual(requests[0], { operation: 'resume-task', robotId, taskId: interruptedTaskId });
});
