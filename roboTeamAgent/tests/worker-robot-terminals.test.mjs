import assert from 'node:assert/strict';
import test from 'node:test';

import { ROBOT_TERMINALS_CLOSE_PATH, ROBOT_TERMINAL_TARGET_PATH, handleWorkerRoutes } from '../server/worker-coordinator/browser-routes.mjs';
import { mapHopOutcome } from '../server/worker-coordinator/errors.mjs';
import { createRobotProvisioner } from '../server/worker-coordinator/robot-provisioning.mjs';
import { WorkerError } from '../server/worker-coordinator/worker-client.mjs';
import { closeRobotTerminals, discoverRobotTerminal, openRobotTerminal, robotTerminalTarget } from '../public/terminal.js';

// RoboWork M-8 (F-3) and M-54 on the RoboTeam side: the administrator endpoints that return the WORKER robot ID after the ensure and close
// a robot's terminals; the terminals_open refusal with its count; the card choosing exactly the provider row of the worker robot ID.

const grant = (sub) => `h.${Buffer.from(JSON.stringify({ typ: 'user-delegation', sub })).toString('base64url')}.s`;
const request = (principal) => ({ method: 'POST', headers: { 'x-ploinky-auth-info': JSON.stringify({ delegations: { providerAdmission: { token: grant(principal) } } }) } });
const admin = { ok: true, internal: false, canAdmin: true, principal: 'user:admin' };
const user = { ok: true, internal: false, canAdmin: false, principal: 'user:alice' };

async function call(pathname, { access = admin, body = { robotId: 'default-ab12cd' }, provisioning, principal = access.principal ?? 'user:admin' } = {}) {
    let sent;
    await handleWorkerRoutes({ req: request(principal), res: {}, pathname, access, rawBody: Buffer.from(JSON.stringify(body)), hop: {}, provisioning,
        sendJson: (res, status, payload) => { sent = { status, payload }; } });
    return sent;
}

test('F-3: an administrator gets the worker robot ID after the ensure; a non-administrator is forbidden and nothing runs', async () => {
    const seen = [];
    const provisioning = {
        terminalTarget: async (robotId, auth) => { seen.push({ robotId, auth }); return { targetId: 'WorkerRobotId_0123456789', label: 'solo', provider: 'robo-work' }; },
        closeTerminals: async () => assert.fail('not this route')
    };
    assert.deepEqual(await call(ROBOT_TERMINAL_TARGET_PATH, { provisioning }), { status: 200, payload: { ok: true, targetId: 'WorkerRobotId_0123456789', label: 'solo', provider: 'robo-work' } });
    assert.deepEqual(seen, [{ robotId: 'default-ab12cd', auth: { grant: grant('user:admin') } }]);
    const never = { terminalTarget: async () => assert.fail('must not run'), closeTerminals: async () => assert.fail('must not run') };
    for (const pathname of [ROBOT_TERMINAL_TARGET_PATH, ROBOT_TERMINALS_CLOSE_PATH]) {
        assert.deepEqual(await call(pathname, { access: user, provisioning: never }), { status: 403, payload: { error: 'forbidden' } });
        assert.equal((await call(pathname, { access: { ok: true, internal: true, canAdmin: true }, provisioning: never })).payload.error, 'owner_evidence_unavailable');
        for (const body of [{}, { robotId: '../x' }, { robotId: 'default-ab12cd', dir: '/etc' }]) assert.equal((await call(pathname, { body, provisioning: never })).payload.error, 'invalid_request');
    }
});

test('an unready robot is a plain refusal with its message; Close terminals answers the counts', async () => {
    const provisioning = {
        terminalTarget: async () => { const error = new WorkerError('worker_robot_stale', 409); error.message = 'worker_robot_stale: Ask an administrator to open robot "solo" to update it.'; throw error; },
        closeTerminals: async () => ({ closed: 2, unverified: 0 })
    };
    assert.deepEqual(await call(ROBOT_TERMINAL_TARGET_PATH, { provisioning }), { status: 409, payload: { error: 'worker_robot_stale', message: 'Ask an administrator to open robot "solo" to update it.' } });
    assert.deepEqual(await call(ROBOT_TERMINALS_CLOSE_PATH, { provisioning }), { status: 200, payload: { ok: true, closed: 2, unverified: 0 } });
    assert.equal((await call(ROBOT_TERMINALS_CLOSE_PATH, { provisioning: null })).payload.error, 'worker_coordinator_unavailable');
});

test('M-54: a worker terminals_open refusal keeps its count, and configure/delete name it; Close terminals calls the worker with the worker robot ID', async () => {
    assert.deepEqual(mapHopOutcome({ outcome: 'response', status: 409, json: { error: 'terminals_open', terminals: 3 }, refusal: null }), { status: 409, body: { error: 'terminals_open', terminals: 3 } });
    const calls = [];
    const client = {
        getRobot: async () => ({ revision: 1, ready: true, preparing: false, lifecycle: 'ready', configuration: { backend: 'codex', settings: { codingAgents: ['other'] } } }),
        configure: async () => { throw new WorkerError('terminals_open', 409, { terminals: 2 }); },
        deleteRobot: async () => { throw new WorkerError('terminals_open', 409, { terminals: 1 }); },
        closeTerminals: async (body, auth) => { calls.push({ body, auth }); return { robotId: body.robotId, closed: 1, unverified: 0 }; }
    };
    const provisioner = createRobotProvisioner({ client, robotStore: { withRobot: async () => {} } });
    const robot = { id: 'default-ab12cd', name: 'solo', codingAgents: ['codex'], worker: { robotId: 'WorkerRobotId_0123456789' } };
    await assert.rejects(provisioner.ensureReady(robot, { grant: 'g' }), (error) => error.code === 'terminals_open' && /2 terminals are open on robot "solo"/u.test(error.message));
    await assert.rejects(provisioner.deleteRobot(robot, { grant: 'g' }), (error) => error.code === 'terminals_open' && /1 terminal is open/u.test(error.message));
    assert.deepEqual(await provisioner.closeTerminals(robot, { grant: 'g' }), { closed: 1, unverified: 0 });
    assert.deepEqual(calls, [{ body: { robotId: 'WorkerRobotId_0123456789' }, auth: { grant: 'g' } }]);
    // F-3: after the ensure, the worker robot ID and the label its inventory shows (the worker robot's name, else its ID).
    const ready = { revision: 1, ready: true, preparing: false, lifecycle: 'ready', name: 'solo', configuration: provisioner.desiredConfiguration(robot) };
    const readyClient = { ...client, getRobot: async () => ready };
    const readyProvisioner = createRobotProvisioner({ client: readyClient, robotStore: { withRobot: async () => {} } });
    assert.deepEqual(await readyProvisioner.terminalTarget(robot, { grant: 'g' }), { targetId: 'WorkerRobotId_0123456789', label: 'solo' });
    const unnamed = createRobotProvisioner({ client: { ...readyClient, getRobot: async () => ({ ...ready, name: 'bad\u0007' }) }, robotStore: { withRobot: async () => {} } });
    assert.deepEqual(await unnamed.terminalTarget(robot, { grant: 'g' }), { targetId: 'WorkerRobotId_0123456789', label: 'WorkerRobotId_0123456789' });
    await assert.rejects(readyProvisioner.terminalTarget(robot, {}), (error) => error.code === 'owner_evidence_unavailable');
    await assert.rejects(provisioner.closeTerminals(robot, {}), (error) => error.code === 'owner_evidence_unavailable');
    assert.deepEqual(await provisioner.closeTerminals({ ...robot, worker: {} }, { grant: 'g' }), { closed: 0, unverified: 0 });
});

const LAUNCH = 'L'.repeat(40);
const DISCOVERY = 'D'.repeat(40);
function discoveryFetch(targets, extra = {}) {
    const calls = [];
    const fetchImpl = async (url, options) => {
        calls.push({ url, options });
        if (options.method === 'DELETE') return { ok: true, status: 200, json: async () => ({ ok: true }) };
        return { ok: true, status: 200, json: async () => ({ ok: true, discovery: { id: DISCOVERY, directory: '', expiresAt: Date.now() + 60000, agentTargetsAvailable: true, targets, ...extra } }) };
    };
    return { calls, fetchImpl };
}

test('the card picks exactly the provider row of the worker robot ID (never RoboTeam\'s id), with no folder (HOME) and no profile', async () => {
    const targets = [
        { launch: 'B'.repeat(40), kind: 'box', label: 'Ploinky Box', detail: 'box', access: 'rw', cwdDisplay: '/' },
        { launch: 'O'.repeat(40), kind: 'provider', targetId: 'OtherWorkerRobot_000000', label: 'other', detail: 'robo-work', access: 'rw', cwdDisplay: '/home/robot' },
        { launch: 'X'.repeat(40), kind: 'provider', provider: 'other-provider', targetId: 'WorkerRobotId_0123456789', label: 'solo', detail: 'other-provider', access: 'rw', cwdDisplay: 'Home' },
        { launch: LAUNCH, kind: 'provider', provider: 'robo-work', targetId: 'WorkerRobotId_0123456789', label: 'solo', detail: 'robo-work', access: 'rw', cwdDisplay: '/home/robot' },
        { launch: 'R'.repeat(40), kind: 'provider', targetId: 'default-ab12cd', label: 'roboteam id', detail: 'robo-work', access: 'rw', cwdDisplay: '/home/robot' }
    ];
    const { calls, fetchImpl } = discoveryFetch(targets);
    // Another provider advertising the same id is never picked (review #2): provider AND targetId must match.
    const target = { targetId: 'WorkerRobotId_0123456789', label: 'solo', provider: 'robo-work' };
    const result = await discoverRobotTerminal('', target, { fetchImpl, cookie: 'ploinky_browser_csrf=tok' });
    assert.equal(result.url, `/webtty/#launch=${LAUNCH}`);
    assert.deepEqual(JSON.parse(calls[0].options.body), { dir: '' }, 'no profile, no path');
    // No row for the robot: refused, the discovery is cancelled.
    const missing = discoveryFetch(targets.slice(0, 2));
    await assert.rejects(discoverRobotTerminal('', target, { fetchImpl: missing.fetchImpl, cookie: '' }), /no terminal available/u);
    assert.equal(missing.calls.at(-1).options.method, 'DELETE');
    // The provider unavailable (delta note 5): a plain line, never a fallback target.
    const down = discoveryFetch(targets.slice(0, 1), { providers: [{ name: 'robo-work', available: false, reason: 'unavailable' }] });
    await assert.rejects(discoverRobotTerminal('', target, { fetchImpl: down.fetchImpl, cookie: '' }), /worker is not running/u);
    // Rows without targetId (the T1-P browser shape) are never bound by label, even a unique one: fail closed, discovery cancelled.
    const plain = discoveryFetch(targets.map(({ targetId, ...row }) => { void targetId; return row; }));
    await assert.rejects(discoverRobotTerminal('', target, { fetchImpl: plain.fetchImpl, cookie: '' }), /does not identify robot terminals/u);
    assert.equal(plain.calls.at(-1).options.method, 'DELETE');
    // Only the other provider serves the id: refused, never its terminal.
    const foreign = discoveryFetch(targets.filter((row) => row.provider !== 'robo-work'));
    await assert.rejects(discoverRobotTerminal('', target, { fetchImpl: foreign.fetchImpl, cookie: '' }), /no terminal available/u);
});

test('openRobotTerminal asks for the target first, then discovers; refusals reach the popup as plain text; Close terminals posts the RoboTeam id', async () => {
    const api = async (route, options) => {
        assert.deepEqual(options, { method: 'POST', body: { robotId: 'default-ab12cd' } });
        if (route === 'api/worker/robots/terminal-target') return { ok: true, targetId: 'WorkerRobotId_0123456789', label: 'solo', provider: 'robo-work' };
        if (route === 'api/worker/robots/terminals/close') return { ok: true, closed: 2, unverified: 1 };
        throw new Error('unexpected');
    };
    const robot = { id: 'default-ab12cd', name: 'solo' };
    assert.deepEqual(await robotTerminalTarget(robot, api), { targetId: 'WorkerRobotId_0123456789', label: 'solo', provider: 'robo-work' });
    assert.deepEqual(await closeRobotTerminals(robot, api), { closed: 2, unverified: 1 });
    const popup = { closed: false, opener: {}, document: { title: '', body: { textContent: '', appendChild() {} }, createElement: () => ({ click() {} }) } };
    const refusing = async () => { throw Object.assign(new Error('forbidden'), { status: 403 }); };
    await assert.rejects(openRobotTerminal(robot, refusing, { windowRef: { open: () => popup }, discover: async () => assert.fail('no discovery without a target') }), /administrators only/u);
    assert.match(popup.document.body.textContent, /administrators only/u);
    const seen = [];
    await openRobotTerminal(robot, api, { windowRef: { open: () => ({ ...popup, opener: {} }) }, discover: async (dir, id) => { seen.push([dir, id]); return { url: '/webtty/#launch=x', cancel: async () => {} }; } });
    assert.deepEqual(seen, [['', { targetId: 'WorkerRobotId_0123456789', label: 'solo', provider: 'robo-work' }]]);
});
