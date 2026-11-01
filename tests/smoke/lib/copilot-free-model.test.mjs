import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { FREE_COPILOT_MODEL, configureFreeCopilotRobot, configureFreeCopilotRobots, observeFreeCopilotRoutes } from './copilot-free-model.mjs';

function setupFixture() {
    const calls = [];
    const response = (payload, status = 200) => ({ status: () => status, json: async () => payload });
    const fixture = { calls, config: { ok: true, codingAgent: 'opencode', models: { opencode: FREE_COPILOT_MODEL } },
        robots: [{ id: 'default-id', name: 'default' }, { id: 'probe-id', name: 'probe' }], patchStatus: 200 };
    fixture.page = { url: () => 'http://fixture.test/explorer/index.html', request: {
        get: async route => {
            calls.push({ method: 'GET', route });
            if (route.startsWith('/auth/token')) return response({ browserMutation: { routeKey: 'roboTeamAgent', origin: 'http://fixture.test', csrfToken: 'synthetic-proof' } });
            if (route.endsWith('/api/robots')) return response({ ok: true, canAdmin: true, robots: fixture.robots });
            return response(fixture.config);
        },
        patch: async (route, options) => {
            calls.push({ method: 'PATCH', route, options });
            return response({ ok: true, robot: { id: route.split('/').at(-2), codingAgents: ['opencode'] } }, fixture.patchStatus);
        },
    } };
    return fixture;
}

test('authenticated model setup PATCHes the default and every probe through the normal controller route with persisted readback', async () => {
    const fixture = setupFixture();
    const receipts = await configureFreeCopilotRobots(fixture.page);
    assert.deepEqual(receipts.map(row => row.robotId), ['default-id', 'probe-id']);
    const mutations = fixture.calls.filter(call => call.method === 'PATCH');
    assert.equal(mutations.length, 2);
    for (const mutation of mutations) {
        assert.deepEqual(mutation.options.data, { codingAgents: ['opencode'], model: FREE_COPILOT_MODEL });
        assert.equal(mutation.options.headers['x-ploinky-browser-csrf-token'], 'synthetic-proof');
        assert.equal(mutation.options.maxRedirects, 0);
    }
    assert.ok(!JSON.stringify(receipts).includes('synthetic-proof'));
});

test('model setup refuses missing default, busy robot and a persisted fallback without another mutation', async () => {
    const missing = setupFixture(); missing.robots.shift();
    await assert.rejects(configureFreeCopilotRobots(missing.page), /default robot/u);
    assert.equal(missing.calls.filter(call => call.method === 'PATCH').length, 0);
    const busy = setupFixture(); busy.patchStatus = 409;
    await assert.rejects(configureFreeCopilotRobot(busy.page, 'probe-id'), /cannot fall back/u);
    assert.equal(busy.calls.filter(call => call.method === 'PATCH').length, 1);
    const fallback = setupFixture(); fallback.config.models.opencode = 'opencode/glm-5.3-flash-free';
    await assert.rejects(configureFreeCopilotRobot(fallback.page, 'probe-id'), /Persisted model/u);
    assert.equal(fallback.calls.filter(call => call.method === 'PATCH').length, 1);
});

async function routeFixture() {
    const page = new EventEmitter(), cdp = new EventEmitter(), context = new EventEmitter(), attachments = [];
    cdp.send = async command => assert.equal(command, 'Network.enable');
    let detached = false;
    cdp.detach = async () => { detached = true; };
    context.pages = () => [page]; context.newCDPSession = async () => cdp;
    const finish = await observeFreeCopilotRoutes(context, { attach: async (name, value) => attachments.push({ name, value }) });
    await new Promise(resolve => setImmediate(resolve));
    cdp.emit('Network.requestWillBeSent', { requestId: 'stream', request: {
        url: 'http://fixture.test/webchat/stream?agent=roboTeamAgent&tabId=tab&pageInstanceId=page',
    } });
    return { page, cdp, finish, attachments, detached: () => detached,
        submit(status = 204) { page.emit('request', {
            url: () => 'http://fixture.test/webchat/input?agent=roboTeamAgent&tabId=tab&pageInstanceId=page',
            method: () => 'POST', response: async () => ({ status: () => status }),
        }); },
        state(model = FREE_COPILOT_MODEL, backend = 'opencode', targetTabId = 'tab') {
            cdp.emit('Network.eventSourceMessageReceived', { requestId: 'stream', eventName: 'runtime-state', data: JSON.stringify({ model, backend, targetTabId }) });
        },
    };
}

test('actual route evidence requires a post-submission SSE state for every accepted input and preserves only public identities', async () => {
    const fixture = await routeFixture();
    fixture.state(); // Initial model selection alone does not prove a turn.
    fixture.submit(); fixture.state(); fixture.submit(); fixture.state();
    await fixture.finish();
    const receipt = JSON.parse(fixture.attachments[0].value.body);
    assert.equal(receipt.attempts.length, 2);
    assert.ok(receipt.attempts.every(attempt => attempt.accepted && attempt.routes.length === 1));
    assert.equal(fixture.detached(), true);
});

test('missing actual event, wrong tab, fallback, wrong backend and rejected input all fail with capture released', async () => {
    for (const scenario of ['initial-only', 'wrong-tab', 'fallback', 'backend', 'rejected']) {
        const fixture = await routeFixture(); fixture.state(); fixture.submit(scenario === 'rejected' ? 403 : 204);
        if (scenario === 'wrong-tab') fixture.state(FREE_COPILOT_MODEL, 'opencode', 'other-tab');
        if (scenario === 'fallback') fixture.state('opencode/glm-5.3-flash-free');
        if (scenario === 'backend') fixture.state(FREE_COPILOT_MODEL, 'codex');
        await assert.rejects(fixture.finish(), undefined, scenario);
        assert.equal(fixture.detached(), true);
    }
});
