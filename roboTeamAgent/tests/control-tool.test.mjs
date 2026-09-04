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
