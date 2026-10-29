import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runWorkerTaskReference } from '../tools/worker-task-reference.mjs';
import { COORDINATOR_BASE_ENV, createWorkerCoordinatorHop } from '../server/worker-coordinator/hop.mjs';
import { newOriginId } from '../server/worker-coordinator/identities.mjs';

// The MCP-row tool program over the real coordinator hop against a local private-listener
// stand-in, so the recorded headers and bytes are what the hop actually sends.
const PLOINKY_ROOT = fileURLToPath(new URL('../../../ploinky/', import.meta.url));
const TOOL = fileURLToPath(new URL('../tools/worker-task-reference.mjs', import.meta.url));
process.env.PLOINKY_AGENTLIB_DIR ||= path.join(PLOINKY_ROOT, 'node_modules', 'achillesAgentLib');
const BASE = '/base-agent-additional-server/robo-work/7311';
const ENV = Object.freeze({
    PLOINKY_AGENT_RUNTIME_ROOT: path.join(PLOINKY_ROOT, 'Agent'), PLOINKY_AGENT_ID: 'agent:AchillesIDE/roboTeamAgent',
    PLOINKY_AGENT_INSTANCE_ID: 'i-1', PLOINKY_AGENT_ENABLE_GENERATION: 'g-1', PLOINKY_AGENT_PRIVATE_SECRET: crypto.randomBytes(32).toString('hex'),
    [COORDINATOR_BASE_ENV]: BASE,
});
const TASK_REF = { version: 1, provider: 'agent:AchillesIDE/robo-work', id: 'T'.repeat(22) };
const jwt = (payload) => ['eyJhbGciOiJIUzI1NiJ9', Buffer.from(JSON.stringify(payload)).toString('base64url'), 'c2ln'].join('.');
// A coordinator-shaped grant in the forwarded invocation (review M3): a tool that attached it
// would send a grant the Router accepts, so its absence on the wire is meaningful.
const COORDINATOR_GRANT = jwt({ typ: 'user-delegation', sub: 'user:alice', allowedTargets: ['agent:AchillesIDE/robo-work'],
    allowedTools: ['__coordinator_admission__'], scope: ['execution:owner'] });
const ORIGIN_TOKEN = jwt({ typ: 'task-ref-origin', originRequestId: 'x' });

async function listener(t, reply = (body) => [200, { taskRef: TASK_REF, state: 'queued', originRequestId: JSON.parse(body).originRequestId }]) {
    const seen = [];
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf8');
            seen.push({ url: req.url, headers: req.headers, rawHeaders: req.rawHeaders, body });
            const answer = reply(body, req);
            if (!answer) { req.socket.destroy(); return; }
            res.writeHead(answer[0], { 'content-type': 'application/json' });
            res.end(JSON.stringify(answer[1]));
        });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }));
    return { seen, url: `http://127.0.0.1:${server.address().port}` };
}

const payloadFor = (input = {}, metadata = {}) => ({
    tool: 'robot_task_reference',
    input: { originRequestId: newOriginId(), robotId: newOriginId(), configRevision: 2, task: { type: 'simple', prompt: 'List the open issues' }, ...input },
    metadata: { taskRefOrigin: ORIGIN_TOKEN, user: { id: 'alice', roles: ['user'] },
        invocation: { sub: 'user:alice', actor: { kind: 'user', id: 'user:alice' }, usr: { id: 'alice' },
            delegations: { providerAdmission: { token: COORDINATOR_GRANT, targetAgentId: 'agent:AchillesIDE/robo-work', tools: ['__coordinator_admission__'], scope: ['execution:owner'] } } },
        ...metadata },
});

test('the tool forwards the origin token and tool name, never a user grant, and prints the worker admission', async (t) => {
    const stub = await listener(t);
    const hop = createWorkerCoordinatorHop({ env: ENV, routerUrl: stub.url });
    const payload = payloadFor();
    const result = await runWorkerTaskReference({ payload, toolName: 'robot_task_reference', hop });
    assert.equal(result.ok, true);
    assert.deepEqual(JSON.parse(result.output), { taskRef: TASK_REF, state: 'queued', originRequestId: payload.input.originRequestId });
    assert.equal(stub.seen.length, 1);
    const [seen] = stub.seen;
    assert.equal(seen.url, `${BASE}/v1/coordinator/admissions`);
    const names = seen.rawHeaders.filter((_, index) => index % 2 === 0).map((name) => name.toLowerCase());
    assert.equal(names.includes('x-ploinky-user-delegation'), false, 'no grant header, although the invocation carries a coordinator grant');
    assert.equal(seen.body.includes(COORDINATOR_GRANT), false, 'the grant is not in the body either');
    assert.equal(names.filter((name) => name === 'ploinky-agent-assertion').length, 1);
    assert.deepEqual(JSON.parse(seen.body), { originRequestId: payload.input.originRequestId, robotId: payload.input.robotId, configRevision: 2,
        kind: 'task', specification: { version: 1, taskType: 'simple', prompt: 'List the open issues' }, taskRefOrigin: ORIGIN_TOKEN, originTool: 'robot_task_reference' });
});

test('the tool refuses without an origin token or with invalid input, before any request', async (t) => {
    const stub = await listener(t);
    const hop = createWorkerCoordinatorHop({ env: ENV, routerUrl: stub.url });
    const run = (payload, toolName = 'robot_task_reference') => runWorkerTaskReference({ payload, toolName, hop });
    assert.deepEqual(await run(payloadFor({}, { taskRefOrigin: undefined })), { ok: false, code: 'owner_evidence_unavailable' });
    assert.deepEqual(await run(payloadFor({}, { taskRefOrigin: '' })), { ok: false, code: 'owner_evidence_unavailable' });
    for (const input of [{ originRequestId: 'A'.repeat(21) }, { kind: 'continuation' }, { logicalId: newOriginId() }, { task: { type: 'simple', prompt: '' } }, { extra: 1 }]) {
        assert.deepEqual(await run(payloadFor(input)), { ok: false, code: 'invalid_request' }, JSON.stringify(input));
    }
    assert.deepEqual(await run(payloadFor(), 'bad tool name'), { ok: false, code: 'invalid_request' });
    assert.deepEqual(await runWorkerTaskReference({ payload: payloadFor(), toolName: undefined, hop }), { ok: false, code: 'invalid_request' });
    assert.equal(stub.seen.length, 0);
});

test('a refused or lost admission fails the tool once, without a retry', async (t) => {
    const refused = await listener(t, () => [403, { error: 'forbidden', reason: 'origin_binding' }]);
    const refusedResult = await runWorkerTaskReference({ payload: payloadFor(), toolName: 'robot_task_reference', hop: createWorkerCoordinatorHop({ env: ENV, routerUrl: refused.url }) });
    assert.deepEqual(refusedResult, { ok: false, code: 'forbidden' });
    assert.equal(refused.seen.length, 1);
    const dropped = await listener(t, () => null);
    const lost = await runWorkerTaskReference({ payload: payloadFor(), toolName: 'robot_task_reference', hop: createWorkerCoordinatorHop({ env: ENV, routerUrl: dropped.url }) });
    assert.deepEqual(lost, { ok: false, code: 'worker_reply_unknown' });
    assert.equal(dropped.seen.length, 1, 'no transport retry: the origin token is single-use');
});

test('the program run as a process fails closed with a stderr code and no output when the hop is unconfigured', async () => {
    const run = (env, stdin) => new Promise((resolve) => {
        const child = spawn(process.execPath, [TOOL, 'robot_task_reference'], { env: { PATH: process.env.PATH, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = '', stderr = '';
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.on('close', (code) => resolve({ code, stdout, stderr }));
        child.stdin.end(stdin);
    });
    const unconfigured = await run({ ...ENV, [COORDINATOR_BASE_ENV]: '', PLOINKY_AGENTLIB_DIR: process.env.PLOINKY_AGENTLIB_DIR }, JSON.stringify(payloadFor()));
    assert.deepEqual(unconfigured, { code: 1, stdout: '', stderr: 'worker admission failed: worker_coordinator_unavailable\n' });
    const noDescriptor = await run({ ...ENV, PLOINKY_AGENTLIB_DIR: process.env.PLOINKY_AGENTLIB_DIR }, JSON.stringify(payloadFor()));
    assert.deepEqual(noDescriptor, { code: 1, stdout: '', stderr: 'worker admission failed: worker_coordinator_unavailable\n' });
    const malformed = await run(ENV, '{not json');
    assert.deepEqual(malformed, { code: 1, stdout: '', stderr: 'worker admission failed: invalid_request\n' });
});
