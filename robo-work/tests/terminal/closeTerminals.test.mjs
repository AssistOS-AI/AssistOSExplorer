import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import test from 'node:test';

import { COORDINATOR_ADMISSION_TOOL, computeRchHttp, createReplayCache, createVerifierConfig, rawBodyHash } from '../../server/coordinatorAuth.mjs';
import { createCoordinatorAdapter } from '../../server/coordinatorAdapter.mjs';
import { createCoordinatorHttpHandler } from '../../server/providerHttp.mjs';
import { S6_LIMITS, WORKSPACE, count, makeTempDir, newId, openStore, readyRobot, syntheticContext } from '../helpers/synthetic.mjs';

// M-54 over HTTP: the Close terminals coordinator route (administrator grant only, the store knows the robot, the terminal path ends them)
// and the configure refusal that names the open terminals (409 {error: 'terminals_open', terminals: n}).

const PROVIDER = 'agent:RoboRepo/robo-work';
const COORDINATOR = 'agent:RoboRepo/roboTeamAgent';
const CLOSE = '/v1/coordinator/robots/terminals/close';
const CONFIGURE = '/v1/coordinator/robots/configure';

const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const sign = (payload, secret) => { const input = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}`; return `${input}.${crypto.createHmac('sha256', secret).update(input).digest('base64url')}`; };
const owner = (id, roles) => ({ usr: { id, username: id, email: '', roles }, delegation: { jti: crypto.randomBytes(8).toString('hex'), scope: ['execution:owner'], sourceAgentId: COORDINATOR } });

function request(secret, path, bodyValue, claims) {
    const body = Buffer.from(JSON.stringify(bodyValue));
    const iat = Math.floor(Date.now() / 1000);
    const payload = {
        typ: 'router-request', iss: 'ploinky-router', aud: PROVIDER, sub: COORDINATOR, actor: { kind: 'agent', id: COORDINATOR }, caller: { kind: 'agent', id: COORDINATOR },
        method: 'POST', path, tool: COORDINATOR_ADMISSION_TOOL, rch: computeRchHttp({ method: 'POST', path, query: '', bodyHash: rawBodyHash(body) }),
        jti: crypto.randomBytes(16).toString('base64url'), iat, exp: iat + 30, ...claims
    };
    const stream = Readable.from([body]);
    stream.method = 'POST';
    stream.url = path;
    stream.headers = { 'x-ploinky-auth-info': JSON.stringify({ invocationToken: sign(payload, secret) }) };
    return stream;
}

function send(handler, req) {
    return new Promise((resolve) => {
        const res = { statusCode: 0, headers: {}, setHeader(name, value) { this.headers[name] = value; }, end(payload) { resolve({ status: this.statusCode, body: JSON.parse(String(payload)) }); } };
        handler(req, res);
    });
}

function rig(t) {
    const dir = makeTempDir(t);
    const store = openStore(dir, { limits: S6_LIMITS });
    t.after(() => store.close());
    const robotId = readyRobot(store, syntheticContext({ robotOwnerId: `workspace:${WORKSPACE}`, scope: 'scope-robots' }));
    const secret = crypto.randomBytes(32);
    const verifier = createVerifierConfig({ secret, audience: PROVIDER, coordinators: [COORDINATOR], replayCache: createReplayCache() });
    const closed = [];
    const terminals = { closeRobot: async (id) => { closed.push(id); return { closed: 2, unverified: 0 }; } };
    const handler = createCoordinatorHttpHandler({ adapter: createCoordinatorAdapter({ store, workspaceId: WORKSPACE, verifier, terminals }), limits: { requestBytes: 65536 } });
    return { dir, store, robotId, secret, handler, closed };
}

test('Close terminals: an administrator grant closes the robot terminals; no grant, a non-administrator, an unknown robot and a replay are refused and close nothing', async (t) => {
    const { dir, robotId, secret, handler, closed } = rig(t);
    const ok = await send(handler, request(secret, CLOSE, { robotId }, owner('root', ['admin'])));
    assert.deepEqual(ok, { status: 200, body: { robotId, closed: 2, unverified: 0 } });
    assert.deepEqual(closed, [robotId]);
    assert.equal((await send(handler, request(secret, CLOSE, { robotId }, {}))).status, 403);
    assert.equal((await send(handler, request(secret, CLOSE, { robotId }, owner('bob', ['user'])))).status, 403);
    assert.equal((await send(handler, request(secret, CLOSE, { robotId: newId() }, owner('root', ['admin'])))).status, 404);
    assert.equal((await send(handler, request(secret, CLOSE, { robotId, extra: 1 }, owner('root', ['admin'])))).status, 400);
    assert.deepEqual(closed, [robotId], 'nothing else was closed');
    assert.ok(count(dir, 'token_replay') >= 5, 'every verified token was consumed');
});

test('configure while terminals are open is 409 terminals_open with the count', async (t) => {
    const { store, robotId, secret, handler } = rig(t);
    store.admitTerminal({ robotId, ownerId: 'user:root', maxPerRobot: 4, maxTotal: 16 });
    store.admitTerminal({ robotId, ownerId: 'user:root', maxPerRobot: 4, maxTotal: 16 });
    store.admitTerminal({ robotId, ownerId: 'user:root', maxPerRobot: 4, maxTotal: 16 });
    const refused = await send(handler, request(secret, CONFIGURE, { operationId: newId(), robotId, expectedRevision: 1, configuration: { backend: 'synthetic', settings: { x: 1 } } }, owner('root', ['admin'])));
    assert.deepEqual(refused, { status: 409, body: { error: 'terminals_open', terminals: 3 } });
});
