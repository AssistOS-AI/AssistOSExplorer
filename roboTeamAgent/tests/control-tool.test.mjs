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
    assert.doesNotMatch(result.stderr, /RoboTeam task state: completed/u);
});

test('empty ALA output does not synthesize a completion message', async (t) => {
    const server = http.createServer((request, response) => {
        let raw = '';
        request.on('data', (chunk) => { raw += chunk; });
        request.on('end', () => {
            const body = JSON.parse(raw);
            response.setHeader('content-type', 'application/json');
            response.end(JSON.stringify(body.operation === 'start-simple-task'
                ? { ok: true, taskId: 'empty-task' }
                : { ok: true, task: { type: 'simple', state: 'completed', result: '', logTail: '' } }));
        });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => server.close());
    const result = await runControl(server.address().port);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).outputText, '');
    assert.doesNotMatch(result.stderr + result.stdout, /task state: completed|task completed\./u);
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
    assert.equal(JSON.parse(result.stdout).outputText, 'resumed result');
    assert.equal(JSON.parse(result.stdout).continuation.toolName, 'resumeTaskForRobot');
    assert.deepEqual(requests[0], { operation: 'resume-task', robotId, taskId: interruptedTaskId,
        prompt: 'Continue from the current state.' });
});

// robot_list grants are minted by the sibling Ploinky RouterRequestTokenService
// and passed through its real Agent verifier, as AgentServer does before a tool
// runs. This section fails to load if that checkout is missing.
const PLOINKY_ROOT = new URL('../../../ploinky/', import.meta.url);
// Ploinky's signer resolves AchillesAgentLib only from an explicit source.
process.env.PLOINKY_AGENTLIB_DIR ||= fileURLToPath(new URL('node_modules/achillesAgentLib', PLOINKY_ROOT));
const { RouterRequestTokenService } = await import(new URL('cli/server/security/tokens/RouterRequestTokenService.js', PLOINKY_ROOT).href);
const { verifyRouterRequestFromHeaders } = await import(new URL('Agent/lib/invocationAuth.mjs', PLOINKY_ROOT).href);
const { computeRchTool } = await import(new URL('Agent/lib/requestHash.mjs', PLOINKY_ROOT).href);
const ROBOTEAM_ID = 'agent:AchillesCLI/roboTeamAgent';
const ROBOTEAM_SECRET = Buffer.alloc(32, 7);
const grantMinter = new RouterRequestTokenService({ resolveAgentSecret: () => ROBOTEAM_SECRET });

async function verifiedRobotListGrant(claims) {
    const rch = computeRchTool({ method: 'POST', path: '/mcp', tool: 'robot_list', arguments: {} });
    const { token } = await grantMinter.mintWithPayload({ targetAgentId: ROBOTEAM_ID, method: 'POST', path: '/mcp', tool: 'robot_list', rch, ...claims });
    const verified = verifyRouterRequestFromHeaders({ authorization: `Bearer ${token}` }, {
        env: { PLOINKY_AGENT_ID: ROBOTEAM_ID, PLOINKY_AGENT_SECRET: ROBOTEAM_SECRET.toString('hex') },
        method: 'POST', path: '/mcp', tool: 'robot_list', rch,
    });
    assert.equal(verified.ok, true, verified.reason);
    return verified.payload;
}

function runRobotList(port, metadata) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['tools/control.mjs', 'robot-list'], {
            cwd: AGENT_ROOT,
            env: { ...process.env, ROBOTEAM_SERVICE_PORT: String(port), ROBOTEAM_INTERNAL_TOKEN: 'test-token' },
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.once('error', reject);
        child.once('close', (code) => resolve({ code, stdout, stderr }));
        child.stdin.end(JSON.stringify({ tool: 'robot_list', input: {}, metadata }));
    });
}

test('robot_list sends the agent origin proof only for an agent acting on its own behalf', async (t) => {
    const requests = [];
    const server = http.createServer((request, response) => {
        requests.push({ method: request.method, url: request.url, headers: request.headers });
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ ok: true, canAdmin: false, robots: [{ id: 'robot-a1b2c3', repositories: [{ skillsets: [{ id: 'on' }, { id: 'off', enabled: false }] }] }] }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => server.close());
    const port = server.address().port;
    const agent = 'agent:AssistOSExplorer/explorer';

    const own = await runRobotList(port, { invocation: await verifiedRobotListGrant({
        sub: agent, actor: { kind: 'agent', id: agent, roles: [] }, caller: { kind: 'agent', id: agent, roles: ['agent'] },
    }) });
    assert.equal(own.code, 0, own.stderr);
    assert.deepEqual(JSON.parse(own.stdout).robots[0].repositories[0].skillsets, [{ id: 'on' }]);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, 'GET');
    assert.equal(requests[0].url, '/api/robots');
    assert.equal(requests[0].headers['x-roboteam-internal-token'], 'test-token');
    assert.equal(requests[0].headers['x-roboteam-listing-origin'], 'agent');
    assert.deepEqual(Object.keys(requests[0].headers).filter((name) => name.startsWith('x-roboteam-user-')), []);

    const denied = {
        'direct user': { invocation: await verifiedRobotListGrant({
            sub: 'user:member-1', actor: { kind: 'user', id: 'user:member-1', roles: ['admin'], capabilities: ['explorer.access'] },
        }) },
        'delegated user': { invocation: await verifiedRobotListGrant({
            sub: agent, actor: { kind: 'agent', id: agent, roles: [] }, caller: { kind: 'agent', id: agent, roles: ['agent'] },
            usr: { id: 'member-1', username: 'member', roles: ['admin'] },
            delegation: { jti: 'grant-1', scope: ['robots:list'], sourceAgentId: agent },
        }) },
        'singular delegation': { invocation: await verifiedRobotListGrant({
            sub: agent, actor: { kind: 'agent', id: agent, roles: [] }, delegation: { sourceAgentId: agent, tool: 'robot_list' },
        }) },
        'forwarded metadata user': { user: { id: 'member-1', roles: ['admin'] }, invocation: await verifiedRobotListGrant({
            sub: agent, actor: { kind: 'agent', id: agent, roles: [] },
        }) },
        'mismatched subject': { invocation: await verifiedRobotListGrant({
            sub: 'agent:AssistOSExplorer/other', actor: { kind: 'agent', id: agent, roles: [] },
        }) },
        'missing grant': {},
    };
    for (const [name, metadata] of Object.entries(denied)) {
        const result = await runRobotList(port, metadata);
        assert.notEqual(result.code, 0, name);
        assert.match(result.stderr, /Access denied: robot_list is available only to an agent acting on its own behalf/, name);
    }
    assert.equal(requests.length, 1, 'denied callers never reach the HTTP service');
});
