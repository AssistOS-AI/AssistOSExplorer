import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { FREE_COPILOT_MODEL, configureFreeCopilotRobot, observeFreeCopilotRoutes } from './copilot-free-model.mjs';

function setupFixture() {
    const calls = [];
    const response = (payload, status = 200) => ({ status: () => status, json: async () => payload });
    const fixture = { calls, config: { ok: true, codingAgent: 'opencode', models: { opencode: FREE_COPILOT_MODEL } },
        proof: { routeKey: 'roboTeamAgent', origin: 'http://fixture.test', csrfToken: 'synthetic-proof' },
        robots: [{ id: 'default-id', name: 'default' }, { id: 'probe-id', name: 'probe' }], patchStatus: 200 };
    fixture.page = { url: () => 'http://fixture.test/explorer/index.html', request: {
        get: async route => {
            calls.push({ method: 'GET', route });
            if (route === '/auth/token?mutationRoute=roboTeamAgent' || route === '/auth/token?agent=roboTeamAgent') return response({ browserMutation: fixture.proof });
            if (route.startsWith('/auth/token')) return response({}, 400);
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

test('model setup refuses foreign route, origin and missing administrator mutation proof before PATCH', async () => {
    for (const proof of [undefined, {}, { routeKey: 'explorer', origin: 'http://fixture.test', csrfToken: 'synthetic-proof' },
        { routeKey: 'roboTeamAgent', origin: 'http://foreign.test', csrfToken: 'synthetic-proof' }]) {
        const fixture = setupFixture(); fixture.proof = proof;
        await assert.rejects(configureFreeCopilotRobot(fixture.page, 'probe-id'));
        assert.equal(fixture.calls.filter(call => call.method === 'PATCH').length, 0);
    }
});

async function routeFixture(options) {
    const page = new EventEmitter(), cdp = new EventEmitter(), context = new EventEmitter(), attachments = [];
    page.url = () => 'http://fixture.test/webchat';
    cdp.send = async command => assert.equal(command, 'Network.enable');
    let detached = false;
    cdp.detach = async () => { detached = true; };
    context.pages = () => [page]; context.newCDPSession = async () => cdp;
    const finish = await observeFreeCopilotRoutes(context, { attach: async (name, value) => attachments.push({ name, value }) }, options);
    await new Promise(resolve => setImmediate(resolve));
    cdp.emit('Network.requestWillBeSent', { requestId: 'stream', request: {
        url: 'http://fixture.test/webchat/stream?agent=roboTeamAgent&tabId=tab&pageInstanceId=page',
    } });
    return { page, cdp, finish, attachments, detached: () => detached,
        submit(status = 204, body = JSON.stringify({ __webchatMessage: 1, version: 1,
            text: 'Reply with the fixture acknowledgement.', attachments: [], presentation: { visible: true } })) { page.emit('request', {
            url: () => 'http://fixture.test/webchat/input?agent=roboTeamAgent&tabId=tab&pageInstanceId=page',
            method: () => 'POST', postData: () => body, response: async () => ({ status: () => status }),
        }); },
        state(model = FREE_COPILOT_MODEL, backend = 'opencode', targetTabId = 'tab', targetPageInstanceId = 'page') {
            cdp.emit('Network.eventSourceMessageReceived', { requestId: 'stream', eventName: 'runtime-state', data: JSON.stringify({ model, backend, targetTabId, targetPageInstanceId }) });
        },
    };
}

test('missing actual event, wrong tab, fallback, wrong backend and rejected input all fail with capture released', async () => {
    for (const scenario of ['initial-only', 'wrong-tab', 'wrong-page', 'unscoped', 'foreign-stream', 'fallback', 'backend', 'rejected']) {
        const fixture = await routeFixture(); fixture.state(); fixture.submit(scenario === 'rejected' ? 403 : 204);
        if (scenario === 'wrong-tab') fixture.state(FREE_COPILOT_MODEL, 'opencode', 'other-tab');
        if (scenario === 'wrong-page') fixture.state(FREE_COPILOT_MODEL, 'opencode', 'tab', 'other-page');
        if (scenario === 'unscoped') fixture.state(FREE_COPILOT_MODEL, 'opencode', null, null);
        if (scenario === 'foreign-stream') {
            fixture.cdp.emit('Network.requestWillBeSent', { requestId: 'stream', request: {
                url: 'http://foreign.test/webchat/stream?agent=roboTeamAgent&tabId=tab&pageInstanceId=page',
            } });
            fixture.state();
        }
        if (scenario === 'fallback') fixture.state('opencode/glm-5.3-flash-free');
        if (scenario === 'backend') fixture.state(FREE_COPILOT_MODEL, 'codex');
        await assert.rejects(fixture.finish(), undefined, scenario);
        assert.equal(fixture.detached(), true);
    }
});

test('a model test with zero accepted submissions fails even when an initial route event exists', async () => {
    const fixture = await routeFixture(); fixture.state();
    await assert.rejects(fixture.finish(), /at least one accepted Copilot input/u);
    assert.equal(fixture.detached(), true);
});
