import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { COORDINATOR_ADMISSION_TOOL, computeRchHttp, rawBodyHash } from '../server/coordinatorAuth.mjs';
import { DEFAULT_LIMITS, readConfig, startWorker } from '../server/main.mjs';
import { EVENT_PREFIX } from '../server/runtime/alaStreams.mjs';
import { makeTempDir } from './helpers/synthetic.mjs';

// The worker bootstrap in one process: real HTTP listeners on loopback, real S1 store and robot storage in a temporary data
// directory, a fake verifier secret, a fake sandbox preflight and a fake execution factory (no sandbox is started).

const SECRET_HEX = crypto.randomBytes(32).toString('hex');
const AUDIENCE = 'agent:RoboRepo/robo-work';
const COORDINATOR = 'agent:RoboRepo/roboTeamAgent';
const SESSION = 'session:chat-1.v2';

const b64 = (value) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
const sign = (payload, secret = Buffer.from(SECRET_HEX, 'hex')) => {
    const input = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}`;
    return `${input}.${crypto.createHmac('sha256', secret).update(input).digest('base64url')}`;
};
function hop(operation, bodyValue, { claims = null, secret } = {}) {
    const body = Buffer.from(JSON.stringify(bodyValue));
    const pathName = `/v1/coordinator/${operation}`;
    const iat = Math.floor(Date.now() / 1000);
    const payload = {
        typ: 'router-request', iss: 'ploinky-router', aud: AUDIENCE, sub: COORDINATOR,
        actor: { kind: 'agent', id: COORDINATOR, roles: [] }, caller: { kind: 'agent', id: COORDINATOR, roles: ['agent'] },
        method: 'POST', path: pathName, tool: COORDINATOR_ADMISSION_TOOL,
        rch: computeRchHttp({ method: 'POST', path: pathName, query: '', bodyHash: rawBodyHash(body) }),
        jti: crypto.randomBytes(16).toString('base64url'), iat, exp: iat + 30, ...(claims ?? {})
    };
    return { path: pathName, body, headers: { 'x-ploinky-auth-info': JSON.stringify({ invocationToken: sign(payload, secret), invocationBody: {} }), 'content-type': 'application/json' } };
}
const owner = (id, roles = ['user']) => ({
    usr: { id, username: id, email: '', roles },
    delegation: { jti: crypto.randomBytes(8).toString('hex'), scope: ['execution:owner'], sourceAgentId: COORDINATOR }
});
function post(port, request) {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: request.path, method: 'POST', headers: request.headers }, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => resolve({ status: res.statusCode, body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null }));
        });
        req.on('error', reject);
        req.end(request.body);
    });
}
const wait = async (predicate, label, ms = 5000) => {
    const deadline = Date.now() + ms;
    for (;;) {
        const value = await predicate();
        if (value) return value;
        if (Date.now() > deadline) assert.fail(`timed out: ${label}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
};

function environment(root, extra = {}) {
    return {
        PLOINKY_AGENT_SECRET: SECRET_HEX, PLOINKY_AGENT_ID: AUDIENCE, PLOINKY_WORKSPACE_ROOT: path.join(root, 'ws'), ROBO_WORK_DATA_DIR: path.join(root, 'data'),
        PORT: '0', ROBO_WORK_PROVIDER_PORT: '0', ROBO_WORK_COORDINATOR_HOST: '127.0.0.1', ...extra
    };
}

// A fake execution whose "ALA" waits for the prompt and then, with `auto`, answers at once (one event on stderr, the result on
// stdout, exit 0); without it the test releases the run with `run.finish(text)`.
function fakeFactory({ auto = true, answer = 'hello from the worker' } = {}) {
    const state = { store: null, runs: [], ends: [] };
    state.factory = {
        async open({ item, context }) {
            const stdin = new PassThrough();
            const stdout = new PassThrough();
            const stderr = new PassThrough();
            let exit;
            const exited = new Promise((resolve) => { exit = resolve; });
            const run = {
                item, received: [],
                event: (event) => stderr.write(`${EVENT_PREFIX.toString()}${JSON.stringify(event)}\n`),
                finish: (text) => { stdout.end(`${text}\n`); stderr.end(); exit({ exitCode: 0, signal: null }); }
            };
            state.runs.push(run);
            stdin.on('data', (chunk) => {
                for (const line of chunk.toString().split('\n').filter(Boolean)) run.received.push(JSON.parse(line));
                if (auto && run.received.length === 1) { run.event({ type: 'coding-agent-final', message: answer }); run.finish(answer); }
            });
            return {
                exited, start: async () => ({ stdin, stdout, stderr }),
                end: async (outcome) => {
                    state.ends.push({ executionId: item.executionId, outcome });
                    state.store.beginAttemptEnd(context, { executionId: item.executionId, attemptId: item.attemptId, expectedState: 'running', outcome });
                }
            };
        }
    };
    return state;
}

test('configuration: the secret, audience, coordinator and workspace come from the environment; nothing is accepted by default', () => {
    const config = readConfig(environment('/tmp/x'));
    assert.equal(config.secret.length, 32);
    assert.equal(config.audience, AUDIENCE);
    assert.deepEqual(config.coordinators, [COORDINATOR]);
    assert.match(config.workspaceId, /^ws-[0-9a-f]{24}$/u);
    assert.equal(readConfig(environment('/tmp/x')).workspaceId, config.workspaceId, 'stable across restarts');
    assert.equal(config.coordinatorPort, 0);
    assert.equal(readConfig({ ...environment('/tmp/x'), PORT: '' }).coordinatorPort, 7000);
    assert.equal(readConfig({ ...environment('/tmp/x'), PORT: '' }).providerPort, 0);
    for (const broken of [{ PLOINKY_AGENT_SECRET: 'abc' }, { PLOINKY_AGENT_ID: 'robo-work' }, { PLOINKY_WORKSPACE_ROOT: '' }, { PORT: '70000' }]) {
        assert.throws(() => readConfig({ ...environment('/tmp/x'), ...broken }), Error, JSON.stringify(broken));
    }
    assert.equal(DEFAULT_LIMITS.resultBytes < 1024 * 1024, true, 'a result fits the 1 MiB response bound of the RoboTeam hop');
});

test('bootstrap: signed coordinator calls reach the store; provision prepares the robot; an admitted task runs and completes; shutdown is clean', async (t) => {
    const root = makeTempDir(t);
    fs.mkdirSync(path.join(root, 'ws'));
    const logs = [];
    const fake = fakeFactory();
    const worker = await startWorker({
        env: environment(root),
        overrides: {
            preflight: Object.freeze({ ok: true, missing: [], masks: [], reason: null }), alaRoot: '/unused', factory: fake.factory,
            config: { coordinatorHost: '127.0.0.1' }, log: (event, fields) => logs.push({ event, ...fields })
        }
    });
    fake.store = worker.store;
    let closed = false;
    t.after(async () => { if (!closed) await worker.close(); });
    assert.equal(worker.recovered, true);
    assert.ok(worker.coordinatorPort > 0 && worker.providerPort > 0 && worker.coordinatorPort !== worker.providerPort);
    for (const name of ['state', 'robots', 'runtime']) assert.equal(fs.statSync(path.join(root, 'data', name)).isDirectory(), true, name);
    assert.equal((fs.statSync(path.join(root, 'data', 'state')).mode & 0o777), 0o700);

    // A coordinator-alone read, then refusals: wrong secret, wrong path, wrong port.
    assert.deepEqual(await post(worker.coordinatorPort, hop('robots/list', {})), { status: 200, body: { robots: [] } });
    assert.equal((await post(worker.coordinatorPort, hop('robots/list', {}, { secret: crypto.randomBytes(32) }))).status, 401);
    assert.equal((await post(worker.coordinatorPort, { path: '/v1/task-refs/lookup', body: Buffer.from('{}'), headers: {} })).status, 404, 'task references are not on the coordinator port');
    assert.equal((await post(worker.providerPort, { path: '/v1/coordinator/robots/list', body: Buffer.from('{}'), headers: {} })).status, 404, 'coordinator routes are not on the provider port');
    assert.equal((await post(worker.providerPort, { path: '/v1/task-refs/lookup', body: Buffer.from('{"originRequestId":"x"}'), headers: {} })).status, 401);

    // Provision as an administrator: the lifecycle driver prepares the robot HOME and S1 attests it.
    const provision = await post(worker.coordinatorPort, hop('robots/provision', {
        operationId: crypto.randomBytes(16).toString('base64url'), name: 'Robot', configuration: { backend: 'codex', settings: { models: { codex: 'gpt-x' } } }
    }, { claims: owner('root', ['admin']) }));
    assert.equal(provision.status, 200, JSON.stringify(provision.body));
    const { robotId } = provision.body;
    const robot = await wait(async () => {
        const view = await post(worker.coordinatorPort, hop('robots/get', { robotId }));
        return view.status === 200 && view.body.ready ? view.body : null;
    }, 'robot ready');
    assert.equal(robot.revision, 1);
    const where = path.join(root, 'data', 'robots', robotId);
    assert.equal(fs.statSync(path.join(where, 'home')).isDirectory(), true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(where, 'config', 'ala.json'), 'utf8')).codingAgent, 'codex');

    // Admit a version 2 task as a user, let the fake ALA answer, read the result and the relayed events.
    const originRequestId = crypto.randomBytes(16).toString('base64url');
    const admitted = await post(worker.coordinatorPort, hop('admissions', {
        originRequestId, robotId, configRevision: 1, kind: 'task',
        specification: { version: 2, prompt: 'native', displayText: 'plain', sessionId: SESSION, turnId: 'turn_1', cwd: path.join(root, 'ws', 'project'), permissions: 'full-access' }
    }, { claims: owner('alice') }));
    assert.equal(admitted.status, 200, JSON.stringify(admitted.body));
    const referenceId = admitted.body.taskRef.id;
    const finished = await wait(async () => {
        const read = await post(worker.coordinatorPort, hop(`references/${referenceId}/read`, {}, { claims: owner('alice') }));
        return read.status === 200 && read.body.state === 'completed' ? read.body : null;
    }, 'task completed');
    assert.equal(finished.result.outputText, 'hello from the worker');
    const events = await post(worker.coordinatorPort, hop(`references/${referenceId}/events`, { after: 0, limit: 100 }, { claims: owner('alice') }));
    assert.deepEqual(events.body.events.map((event) => event.type), ['state', 'state', 'ala', 'state', 'state']);
    assert.deepEqual(events.body.events[2].data.record, { type: 'coding-agent-final', message: 'hello from the worker' });
    assert.equal(fake.ends.length, 1);

    await worker.close();
    closed = true;
    await assert.rejects(post(worker.coordinatorPort, hop('robots/list', {})), /ECONNREFUSED|ECONNRESET/u);
    assert.ok(logs.some((entry) => entry.event === 'listening' && entry.sandbox === true));
    assert.equal(JSON.stringify(logs).includes(SECRET_HEX), false, 'the secret is never logged');
});

test('a worker whose sandbox preflight failed starts, answers reads and refuses provisioning with runtime_unavailable', async (t) => {
    const root = makeTempDir(t);
    fs.mkdirSync(path.join(root, 'ws'));
    const worker = await startWorker({
        env: environment(root), overrides: { preflight: Object.freeze({ ok: false, missing: ['bwrap'], masks: [], reason: 'missing tools: bwrap' }), alaRoot: null, config: { coordinatorHost: '127.0.0.1' }, log: () => {} }
    });
    t.after(() => worker.close());
    assert.equal(worker.dispatcher, null, 'no execution factory without a sandbox');
    assert.deepEqual(await post(worker.coordinatorPort, hop('robots/list', {})), { status: 200, body: { robots: [] } });
    const refused = await post(worker.coordinatorPort, hop('robots/provision', {
        operationId: crypto.randomBytes(16).toString('base64url'), name: 'Robot', configuration: { backend: 'codex', settings: {} }
    }, { claims: owner('root', ['admin']) }));
    assert.deepEqual(refused, { status: 503, body: { error: 'runtime_unavailable' } });
});

// ---- M-12: event subscription and control authorization over the real HTTP stack ---------------------------------------------

async function ready(t, { auto = false } = {}) {
    const root = makeTempDir(t);
    fs.mkdirSync(path.join(root, 'ws'));
    const fake = fakeFactory({ auto });
    const worker = await startWorker({
        env: environment(root),
        overrides: {
            preflight: Object.freeze({ ok: true, missing: [], masks: [], reason: null }), alaRoot: '/unused', factory: fake.factory,
            config: { coordinatorHost: '127.0.0.1' }, log: () => {}
        }
    });
    fake.store = worker.store;
    t.after(() => worker.close());
    const provision = await post(worker.coordinatorPort, hop('robots/provision', {
        operationId: crypto.randomBytes(16).toString('base64url'), name: 'Robot', configuration: { backend: 'codex', settings: {} }
    }, { claims: owner('root', ['admin']) }));
    const { robotId } = provision.body;
    await wait(async () => (await post(worker.coordinatorPort, hop('robots/get', { robotId }))).body.ready, 'robot ready');
    const specification = { version: 2, prompt: 'native', displayText: 'plain', sessionId: SESSION, turnId: 'turn:1', cwd: path.join(root, 'ws', 'project'), permissions: 'full-access' };
    const admit = async (claims, extra = {}) => {
        const response = await post(worker.coordinatorPort, hop('admissions', { originRequestId: crypto.randomBytes(16).toString('base64url'), robotId, configRevision: 1, kind: 'task', specification, ...extra }, { claims }));
        assert.equal(response.status, 200, JSON.stringify(response.body));
        return response.body.taskRef.id;
    };
    const control = (referenceId, body, claims) => post(worker.coordinatorPort, hop(`references/${referenceId}/control`, { operationId: crypto.randomBytes(16).toString('base64url'), ...body }, { claims }));
    const read = async (referenceId, claims, extra = {}) => (await post(worker.coordinatorPort, hop(`references/${referenceId}/read`, extra, { claims }))).body;
    return { root, worker, fake, robotId, admit, control, read };
}

function openStream(port, request, onLine) {
    return new Promise((resolve, reject) => {
        const lines = [];
        const req = http.request({ host: '127.0.0.1', port, path: request.path, method: 'POST', headers: request.headers }, (res) => {
            let buffer = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => {
                buffer += chunk;
                let index;
                while ((index = buffer.indexOf('\n')) >= 0) {
                    const line = JSON.parse(buffer.slice(0, index));
                    buffer = buffer.slice(index + 1);
                    lines.push(line);
                    if (process.env.DEBUG_STREAM) console.error('LINE', JSON.stringify(line).slice(0, 120));
                    onLine?.(line, res);
                }
            });
            res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], lines }));
            res.on('close', () => resolve({ status: res.statusCode, type: res.headers['content-type'], lines }));
        });
        req.on('error', reject);
        req.end(request.body);
    });
}

test('M-12 event subscription: authorized once at open, NDJSON with keep-alive, new events as they happen, a closing line when the reference is terminal', async (t) => {
    const { worker, fake, admit } = await ready(t);
    const alice = owner('alice');
    const referenceId = await admit(alice);
    await wait(() => fake.runs.length === 1 && fake.runs[0].received.length === 1, 'run started');
    const streaming = openStream(worker.coordinatorPort, hop(`references/${referenceId}/events`, { after: 0, stream: true }, { claims: alice }), (line) => {
        if (line.type === 'ala' && line.data.record.type === 'second') fake.runs[0].finish('streamed result');
    });
    await wait(() => fake.runs[0].received.length >= 1, 'subscribed');
    fake.runs[0].event({ type: 'first' });
    await new Promise((resolve) => setTimeout(resolve, 300));
    fake.runs[0].event({ type: 'second' });
    const result = await streaming;
    assert.equal(result.status, 200);
    assert.equal(result.type, 'application/x-ndjson');
    assert.deepEqual(result.lines[0], { keepalive: true }, 'the first line flushes the headers through the Router');
    const rows = result.lines.filter((line) => line.sequence !== undefined);
    assert.deepEqual(rows.map((row) => row.sequence), rows.map((_, index) => index + 1), 'one row per event, in order, from the cursor');
    assert.deepEqual(rows.filter((row) => row.type === 'ala').map((row) => row.data.record.type), ['first', 'second']);
    assert.equal(rows.at(-1).data.state, 'completed');
    // The terminal row carries the result, so the subscriber needs no read with another grant; earlier rows do not.
    assert.deepEqual(rows.at(-1).data.result, { outputText: 'streamed result', data: null });
    assert.equal(rows.at(-1).data.classification, 'completed');
    assert.equal(rows.filter((row) => row.type === 'state').slice(0, -1).some((row) => row.data.result !== undefined), false);
    // Without `stream` the plain page is unchanged and needs a limit.
    const plain = await post(worker.coordinatorPort, hop(`references/${referenceId}/events`, { after: 0, limit: 100 }, { claims: alice }));
    assert.equal(plain.status, 200);
    assert.equal(plain.body.events.at(-1).data.result, undefined);
    assert.equal((await post(worker.coordinatorPort, hop(`references/${referenceId}/events`, { after: 0 }, { claims: alice }))).status, 400);
    assert.deepEqual(result.lines.at(-1), { end: true, nextAfter: rows.at(-1).sequence });

    // Reattach with the cursor: a fresh request needs its own grant; the stream resumes after `after` and ends at once (terminal).
    const reattach = await openStream(worker.coordinatorPort, hop(`references/${referenceId}/events`, { after: 3, stream: true }, { claims: alice }));
    assert.equal(reattach.lines.filter((line) => line.sequence !== undefined)[0].sequence, 4);
    assert.equal((await post(worker.coordinatorPort, hop(`references/${referenceId}/events`, { after: 0, stream: true }, { claims: owner('mallory') }))).status, 404, 'an unrelated user cannot subscribe');
    assert.equal((await post(worker.coordinatorPort, hop(`references/${referenceId}/events`, { after: 0, limit: 10, stream: 'yes' }, { claims: alice }))).status, 400);
    assert.equal(JSON.stringify(result.lines).includes(SECRET_HEX), false, 'no credential is returned');
});

test('M-12 user controls: owner or administrator stop, owner-only message, an unrelated user sees nothing; each control carries its own grant', async (t) => {
    const { worker, fake, admit, control, read } = await ready(t);
    const alice = owner('alice');
    const referenceId = await admit(alice);
    await wait(() => fake.runs.length === 1 && fake.runs[0].received.length === 1, 'run started');
    assert.equal((await control(referenceId, { op: 'message', payload: { message: 'hi' } }, owner('mallory'))).status, 404, 'unrelated user: not visible');
    assert.equal((await control(referenceId, { op: 'stop' }, owner('mallory'))).status, 404);
    assert.equal((await control(referenceId, { op: 'message', payload: { message: 'admin says' } }, owner('root', ['admin']))).status, 403, 'an administrator sees the reference, but a message is owner-only');
    assert.equal((await control(referenceId, { op: 'message', payload: { message: 'wrapped', displayText: 'plain', id: 'm1' } }, alice)).status, 200);
    await wait(() => fake.runs[0].received.length === 2, 'message delivered to ALA');
    assert.deepEqual(fake.runs[0].received[1], { type: 'message', id: 'm1', message: 'wrapped', displayText: 'plain' });
    // The coordinator alone cannot control an interactive reference: without a binding it is forbidden, with one it is not visible.
    assert.equal((await control(referenceId, { op: 'stop' }, null)).status, 403);
    const flowId = `flow_${crypto.randomBytes(12).toString('hex')}`;
    assert.equal((await control(referenceId, { op: 'stop', bindingId: flowId }, null)).status, 404);
    assert.equal((await control(referenceId, { op: 'stop', bindingId: flowId }, alice)).status, 403, 'a user grant with a bindingId is ambiguous');
    // The owner's stop ends the run through the dispatcher.
    assert.equal((await control(referenceId, { op: 'stop' }, alice)).status, 200);
    await wait(async () => (await read(referenceId, alice)).state === 'cancelled', 'cancelled');
    assert.ok(fake.ends.some((entry) => entry.outcome.classification === 'cancelled'));
    // An administrator may stop another user's run.
    const second = await admit(alice);
    await wait(() => fake.runs.length === 2 && fake.runs[1].received.length === 1, 'second run started');
    assert.equal((await control(second, { op: 'stop' }, owner('root', ['admin']))).status, 200);
    await wait(async () => (await read(second, alice)).state === 'cancelled', 'cancelled by the administrator');
    void worker;
});

test('M-12 background row: the coordinator and the persisted flow binding read, subscribe to and stop their own flow work; nothing else', async (t) => {
    const { worker, fake, robotId, admit, control, read } = await ready(t);
    const alice = owner('alice');
    const flowId = `flow_${crypto.randomBytes(12).toString('hex')}`;
    const bound = await post(worker.coordinatorPort, hop('bindings', { operationId: crypto.randomBytes(16).toString('base64url'), bindingId: flowId }, { claims: alice }));
    assert.equal(bound.status, 200, JSON.stringify(bound.body));
    const specification = { version: 2, prompt: 'native', displayText: 'plain', sessionId: 'flow-session', turnId: 'phase1', cwd: path.join(worker.config.workspaceRoot, 'x'), permissions: 'full-access' };
    const admitted = await post(worker.coordinatorPort, hop('admissions', {
        originRequestId: crypto.randomBytes(16).toString('base64url'), robotId, configRevision: 1, kind: 'task', bindingId: flowId, specification
    }));
    assert.equal(admitted.status, 200, JSON.stringify(admitted.body));
    const flowRef = admitted.body.taskRef.id;
    await wait(() => fake.runs.length === 1 && fake.runs[0].received.length === 1, 'flow run started');
    assert.equal((await read(flowRef, null, { bindingId: flowId })).state, 'running');
    const events = await openStream(worker.coordinatorPort, hop(`references/${flowRef}/events`, { after: 0, stream: true, bindingId: flowId }), (line, res) => { if (line.sequence >= 2) res.destroy(); });
    assert.ok(events.lines.some((line) => line.type === 'state' && line.data.state === 'running'));
    const interactive = await admit(alice);
    assert.equal((await post(worker.coordinatorPort, hop(`references/${interactive}/read`, { bindingId: flowId }))).status, 404, 'an interactive reference is not visible to the flow binding');
    assert.equal((await control(flowRef, { op: 'message', payload: { message: 'x' }, bindingId: flowId }, null)).status, 403, 'a message is owner-only');
    assert.equal((await control(flowRef, { op: 'stop' }, null)).status, 403, 'no binding, no grant');
    assert.equal((await control(flowRef, { op: 'stop', bindingId: flowId }, null)).status, 200, 'system-initiated stop on cancel or timeout');
    await wait(async () => (await read(flowRef, null, { bindingId: flowId })).state === 'cancelled', 'flow run cancelled');
    void fake;
});

test('a refusal is logged with the request method and path (no query), so an unexpected caller can be identified', async (t) => {
    const root = makeTempDir(t);
    fs.mkdirSync(path.join(root, 'ws'));
    const logs = [];
    const worker = await startWorker({
        env: environment(root), overrides: { preflight: Object.freeze({ ok: false, missing: [], masks: [], reason: 'x' }), alaRoot: null, config: { coordinatorHost: '127.0.0.1' }, log: (event, fields) => logs.push({ event, ...fields }) }
    });
    t.after(() => worker.close());
    const unknown = await post(worker.coordinatorPort, { path: '/mcp?token=SECRET', body: Buffer.from('{}'), headers: {} });
    assert.equal(unknown.status, 404);
    const refusal = logs.find((entry) => entry.event === 'refusal');
    assert.deepEqual({ route: refusal.route, code: refusal.code, method: refusal.method, path: refusal.path }, { route: null, code: 'not_found', method: 'POST', path: '/mcp' });
    assert.equal(JSON.stringify(logs).includes('SECRET'), false);
});
