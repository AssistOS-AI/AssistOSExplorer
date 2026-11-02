import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configureRequiredCopilotModels } from './account-preflight.mjs';
import { FREE_COPILOT_MODEL, configureFreeCopilotRobot, configureFreeCopilotRobots, observeFreeCopilotRoutes,
    requireFreeCopilotSetup, requiresFreeCopilotSetup } from './copilot-free-model.mjs';

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

test('model setup refuses foreign route, origin and missing administrator mutation proof before PATCH', async () => {
    for (const proof of [undefined, {}, { routeKey: 'explorer', origin: 'http://fixture.test', csrfToken: 'synthetic-proof' },
        { routeKey: 'roboTeamAgent', origin: 'http://foreign.test', csrfToken: 'synthetic-proof' }]) {
        const fixture = setupFixture(); fixture.proof = proof;
        await assert.rejects(configureFreeCopilotRobot(fixture.page, 'probe-id'));
        assert.equal(fixture.calls.filter(call => call.method === 'PATCH').length, 0);
    }
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
        submit(status = 204) { page.emit('request', {
            url: () => 'http://fixture.test/webchat/input?agent=roboTeamAgent&tabId=tab&pageInstanceId=page',
            method: () => 'POST', response: async () => ({ status: () => status }),
        }); },
        state(model = FREE_COPILOT_MODEL, backend = 'opencode', targetTabId = 'tab', targetPageInstanceId = 'page') {
            cdp.emit('Network.eventSourceMessageReceived', { requestId: 'stream', eventName: 'runtime-state', data: JSON.stringify({ model, backend, targetTabId, targetPageInstanceId }) });
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

test('account setup requires the opt-in before any request and configures every deployed robot with a public receipt', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-model-setup-'));
    try {
        const fixture = setupFixture(), requirements = { freeCopilotSetup: true };
        await assert.rejects(configureRequiredCopilotModels(fixture.page, requirements, { SMOKE_ARTIFACT_DIR: root }), /SMOKE_ROBOWORK_MODEL_SETUP/u);
        assert.equal(fixture.calls.length, 0);
        await configureRequiredCopilotModels(fixture.page, requirements, { SMOKE_ROBOWORK_MODEL_SETUP: '1', SMOKE_ARTIFACT_DIR: root });
        const receipt = fs.readFileSync(path.join(root, 'copilot-model-setup.json'), 'utf8');
        assert.deepEqual(JSON.parse(receipt).receipts.map(row => row.robotId), ['default-id', 'probe-id']);
        assert.ok(!receipt.includes('synthetic-proof'));
        const nonModel = setupFixture();
        await configureRequiredCopilotModels(nonModel.page, {}, {});
        assert.equal(nonModel.calls.length, 0);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('multi-account model tests aggregate the owner turn while a whole test with no submissions still fails', async () => {
    const attempts = [];
    const admin = await routeFixture({ attempts }), owner = await routeFixture({ attempts }), foreign = await routeFixture({ attempts });
    owner.submit(); owner.state();
    await owner.finish(); await admin.finish(); await foreign.finish();
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].accepted, true);
    for (const fixture of [admin, owner, foreign]) assert.equal(fixture.detached(), true);
    const empty = [], first = await routeFixture({ attempts: empty }), second = await routeFixture({ attempts: empty });
    await assert.rejects(first.finish(), /at least one accepted/u);
    await assert.rejects(second.finish(), /at least one accepted/u);
});

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

test('every Copilot cohort requires explicit model setup and non-model profiles do not claim a turn', () => {
    for (const value of [undefined, '', '0', 'true', FREE_COPILOT_MODEL]) {
        assert.throws(() => requireFreeCopilotSetup({ SMOKE_ROBOWORK_MODEL_SETUP: value }), /SMOKE_ROBOWORK_MODEL_SETUP=1/u);
    }
    requireFreeCopilotSetup({ SMOKE_ROBOWORK_MODEL_SETUP: '1' });
    for (const spec of ['05-copilot-folder-launch', '06-copilot-live-skills', '06-copilot-codex-delegation',
        '07-copilot-codex-native', '07-live-sessions', '08-robowork-restart', '70-copilot-semantic-routing']) {
        assert.equal(requiresFreeCopilotSetup(`specs/${spec}.spec.mjs`), true, spec);
    }
    assert.equal(requiresFreeCopilotSetup('specs/00-bootstrap.spec.mjs'), false);
    assert.equal(requiresFreeCopilotSetup('specs/09-robowork-features.spec.mjs'), false);
});

test('a model test with zero accepted submissions fails even when an initial route event exists', async () => {
    const fixture = await routeFixture(); fixture.state();
    await assert.rejects(fixture.finish(), /at least one accepted Copilot input/u);
    assert.equal(fixture.detached(), true);
});
