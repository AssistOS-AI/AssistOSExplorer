import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// The helper is imported inside each test so a missing module fails the named test, not the whole file.
const load = () => import('./conversation-skills.mjs');
const smokeRoot = fileURLToPath(new URL('..', import.meta.url));
const read = relative => fs.readFileSync(`${smokeRoot}${relative}`, 'utf8');

const ORIGIN = 'http://127.0.0.1:8088';
const BASE = '/base-agent-additional-server/roboTeamAgent/3001/';
const ROBOT = 'default-abc123';

function link(robotId, sessionId, suffix = '') {
    return `${BASE}conversation-skills/${robotId}/${sessionId}${suffix}`;
}

test('the RoboTeam base path is the Router route of the RoboTeam agent', async () => {
    const { ROBOTEAM_BASE_PATH } = await load();
    assert.equal(ROBOTEAM_BASE_PATH, BASE);
});

test('a RoboTeam conversation skills link binds one robot id and one conversation UUID to the selected origin', async () => {
    const { conversationFromSkillsURL } = await load();
    const sessionId = randomUUID();
    assert.deepEqual(conversationFromSkillsURL(link(ROBOT, sessionId), ORIGIN), { robotId: ROBOT, sessionId });
    assert.deepEqual(conversationFromSkillsURL(`${ORIGIN}${link(ROBOT, sessionId)}`, ORIGIN, { robotId: ROBOT }), { robotId: ROBOT, sessionId });
    assert.deepEqual(conversationFromSkillsURL(link(ROBOT, sessionId), `${ORIGIN}/ignored/path`), { robotId: ROBOT, sessionId });
});

test('robot ids follow the RoboTeam rule of 3 to 64 lowercase letters, digits and hyphens', async () => {
    const { conversationFromSkillsURL } = await load();
    const sessionId = randomUUID();
    const make = length => `a${'b'.repeat(length - 1)}`;
    assert.throws(() => conversationFromSkillsURL(link(make(2), sessionId), ORIGIN));
    assert.equal(conversationFromSkillsURL(link(make(3), sessionId), ORIGIN).robotId, make(3));
    assert.equal(conversationFromSkillsURL(link(make(64), sessionId), ORIGIN).robotId, make(64));
    assert.throws(() => conversationFromSkillsURL(link(make(65), sessionId), ORIGIN));
    for (const bad of ['Default-abc123', '-default-abc', 'default_abc123', 'def ault']) {
        assert.throws(() => conversationFromSkillsURL(link(bad, sessionId), ORIGIN), undefined, bad);
    }
});

test('a link is rejected for another robot, origin, path, UUID, query, fragment or encoding', async () => {
    const { conversationFromSkillsURL } = await load();
    const sessionId = randomUUID();
    const good = link(ROBOT, sessionId);
    const rejected = {
        'another robot id': () => conversationFromSkillsURL(good, ORIGIN, { robotId: 'other-abc123' }),
        'another origin': () => conversationFromSkillsURL(`https://other.example${good}`, ORIGIN),
        'protocol-relative origin': () => conversationFromSkillsURL(`//other.example${good}`, ORIGIN),
        'another port': () => conversationFromSkillsURL(`http://127.0.0.1:9999${good}`, ORIGIN),
        'a conversation that is not a UUID': () => conversationFromSkillsURL(link(ROBOT, 'not-a-uuid'), ORIGIN),
        'an uppercase UUID': () => conversationFromSkillsURL(link(ROBOT, sessionId.toUpperCase()), ORIGIN),
        'a missing conversation': () => conversationFromSkillsURL(`${BASE}conversation-skills/${ROBOT}`, ORIGIN),
        'a missing robot id': () => conversationFromSkillsURL(`${BASE}conversation-skills/${sessionId}`, ORIGIN),
        'an extra segment': () => conversationFromSkillsURL(link(ROBOT, sessionId, '/x'), ORIGIN),
        'a trailing slash': () => conversationFromSkillsURL(link(ROBOT, sessionId, '/'), ORIGIN),
        'a query string': () => conversationFromSkillsURL(`${good}?dir=/tmp`, ORIGIN),
        'an empty query marker': () => conversationFromSkillsURL(`${good}?`, ORIGIN),
        'a fragment': () => conversationFromSkillsURL(`${good}#x`, ORIGIN),
        'a missing base path': () => conversationFromSkillsURL(`/conversation-skills/${ROBOT}/${sessionId}`, ORIGIN),
        'a dot-segment detour': () => conversationFromSkillsURL(`/x/..${good}`, ORIGIN),
        'an encoded dot segment': () => conversationFromSkillsURL(link(ROBOT, '%2e%2e'), ORIGIN),
        'a null href': () => conversationFromSkillsURL(null, ORIGIN),
        'the retired Explorer link': () => conversationFromSkillsURL(`/explorer/index.html?${new URLSearchParams([['copilot-robot', 'default'], ['copilot-session', sessionId]])}`, ORIGIN),
    };
    for (const [name, call] of Object.entries(rejected)) assert.throws(call, undefined, name);
});

// Runs the helper's in-page function in Node with stubbed browser globals, recording every request.
function fakePage(url, respond) {
    const requests = [];
    return { requests, url: () => url,
        async evaluate(fn, arg) {
            const saved = { location: Object.getOwnPropertyDescriptor(globalThis, 'location'), fetch: Object.getOwnPropertyDescriptor(globalThis, 'fetch') };
            Object.defineProperty(globalThis, 'location', { configurable: true, writable: true, value: new URL(url) });
            Object.defineProperty(globalThis, 'fetch', { configurable: true, writable: true, value: async (target, init = {}) => {
                const headers = Object.fromEntries(new Headers(init.headers || {}));
                const record = { url: String(target), method: init.method || 'GET', headers, body: init.body, credentials: init.credentials };
                requests.push(record);
                const { status = 200, json } = await respond(record);
                return { ok: status >= 200 && status < 300, status, json: async () => { if (json === undefined) throw new Error('no body'); return json; } };
            } });
            try { return await fn(arg); }
            finally {
                for (const [name, descriptor] of Object.entries(saved)) {
                    if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name];
                }
            }
        } };
}
const TOKEN = { browserMutation: { csrfToken: 'csrf-1', routeKey: 'roboTeamAgent' } };

test('a GET sends no mutation proof and no body', async () => {
    const { roboTeamApi } = await load();
    const page = fakePage(`${ORIGIN}${BASE}`, () => ({ json: { ok: true, robots: [] } }));
    assert.deepEqual(await roboTeamApi(page, { path: 'api/robots' }), { status: 200, payload: { ok: true, robots: [] } });
    assert.equal(page.requests.length, 1);
    assert.equal(page.requests[0].url, `${ORIGIN}${BASE}api/robots`);
    assert.equal(page.requests[0].method, 'GET');
    assert.equal(page.requests[0].headers['x-ploinky-browser-csrf-token'], undefined);
    assert.equal(page.requests[0].body, undefined);
    assert.equal(page.requests[0].credentials, 'include');
});

test('a PATCH first obtains the RoboTeam route proof and sends it as x-ploinky-browser-csrf-token', async () => {
    const { roboTeamApi } = await load();
    const sessionId = randomUUID();
    const path = `api/robots/${ROBOT}/conversations/${sessionId}/skills`;
    const body = { identity: 'workspace:x/.agents/skills/a', enabled: false, policyVersion: 3 };
    const page = fakePage(`${ORIGIN}${BASE}conversation-skills/${ROBOT}/${sessionId}`,
        record => (record.url.includes('/auth/token') ? { json: TOKEN } : { status: 409, json: { ok: false, error: 'skill policy changed; reload before updating' } }));
    const result = await roboTeamApi(page, { method: 'patch', path, body });
    assert.deepEqual(result, { status: 409, payload: { ok: false, error: 'skill policy changed; reload before updating' } });
    assert.equal(page.requests.length, 2);
    assert.equal(page.requests[0].url, `${ORIGIN}/auth/token?mutationRoute=roboTeamAgent`);
    assert.equal(page.requests[0].method, 'GET');
    assert.equal(page.requests[1].url, `${ORIGIN}${BASE}${path}`);
    assert.equal(page.requests[1].method, 'PATCH');
    assert.equal(page.requests[1].headers['x-ploinky-browser-csrf-token'], 'csrf-1');
    assert.equal(page.requests[1].headers['content-type'], 'application/json');
    assert.deepEqual(JSON.parse(page.requests[1].body), body);
    assert.equal(page.requests[1].credentials, 'include');
});

test('an unusable or foreign mutation proof sends no mutation', async () => {
    const { roboTeamApi } = await load();
    for (const reply of [{ status: 403, json: {} }, { json: {} }, { json: { browserMutation: { csrfToken: 'x', routeKey: 'explorer' } } },
        { json: { browserMutation: { routeKey: 'roboTeamAgent' } } }, { json: { browserMutation: { csrfToken: 'x', routeKey: 'roboTeamAgent', origin: 'https://other.example' } } }]) {
        const page = fakePage(`${ORIGIN}${BASE}`, () => reply);
        await assert.rejects(roboTeamApi(page, { method: 'POST', path: 'api/robots', body: {} }), /mutation proof/i);
        assert.equal(page.requests.length, 1, 'only the proof request may be sent');
    }
});

test('roboTeamApi runs only on a RoboTeam page and only against relative api paths', async () => {
    const { roboTeamApi } = await load();
    const outside = fakePage(`${ORIGIN}/webchat?agent=roboTeamAgent`, () => ({ json: {} }));
    await assert.rejects(roboTeamApi(outside, { path: 'api/robots' }), /RoboTeam page/);
    assert.equal(outside.requests.length, 0);
    const page = fakePage(`${ORIGIN}${BASE}`, () => ({ json: TOKEN }));
    for (const path of ['/api/robots', 'https://other.example/api/robots', '//other.example/api/robots', 'api/../../auth/token', 'api/%2e%2e/x',
        'api/robots#x', 'dashboard', '', 'api/robots with space', undefined]) {
        await assert.rejects(roboTeamApi(page, { path }), undefined, String(path));
    }
    await assert.rejects(roboTeamApi(page, { method: 'PUT', path: 'api/robots' }), /method/i);
    assert.equal(page.requests.length, 0);
});

test('a non-JSON reply still returns its status with an empty payload', async () => {
    const { roboTeamApi } = await load();
    const page = fakePage(`${ORIGIN}${BASE}`, () => ({ status: 502 }));
    assert.deepEqual(await roboTeamApi(page, { path: 'api/robots' }), { status: 502, payload: {} });
});

test('the robot id lookup needs exactly one robot with the requested name', async () => {
    const { roboTeamRobotId } = await load();
    const robots = list => fakePage(`${ORIGIN}${BASE}`, () => ({ json: { ok: true, canAdmin: false, robots: list } }));
    assert.equal(await roboTeamRobotId(robots([{ id: ROBOT, name: 'default' }, { id: 'other-abc123', name: 'other' }])), ROBOT);
    assert.equal(await roboTeamRobotId(robots([{ id: 'other-abc123', name: 'other' }, { id: 'abc-123', name: 'second' }]), 'second'), 'abc-123');
    await assert.rejects(roboTeamRobotId(robots([])), /exactly one/);
    await assert.rejects(roboTeamRobotId(robots([{ id: ROBOT, name: 'default' }, { id: 'copy-abc123', name: 'default' }])), /exactly one/);
    await assert.rejects(roboTeamRobotId(robots([{ id: 'BAD_ID', name: 'default' }])), /robot id/);
    await assert.rejects(roboTeamRobotId(fakePage(`${ORIGIN}${BASE}`, () => ({ status: 401, json: { error: 'authenticated Ploinky user is required' } }))), /401/);
});

test('the helper pins the SPEC DOM contract and never builds markup from page text', async () => {
    const source = read('lib/conversation-skills.mjs');
    for (const required of ['#sessionSettingsLink', '#settingsBtn', '#conversationSkillsStatus', '#conversationSkillsList', '#conversationSkillsRefresh',
        'li.conversation-skill-row', 'button.conversation-skill-toggle', 'data-policy-version', 'data-loaded', 'aria-pressed',
        'x-ploinky-browser-csrf-token', 'mutationRoute', 'Current selection loaded. Changes apply at the next execution.']) {
        assert.ok(source.includes(required), `The helper must use ${required}.`);
    }
    assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML/);
});

const RETIRED = ['settings-modal', 'copilotSettingsStatus', 'copilotSettingsList', 'toggleCopilotSkill', 'getCopilotContext',
    ['copilot', 'robot'].join('-'), ['copilot', 'session'].join('-'), 'conversationFromSettingsURL'];

test('spec 06 and the approval module no longer reference the retired Explorer Settings modal or its link format', () => {
    for (const file of ['specs/06-copilot-live-skills.spec.mjs', 'lib/copilot-live-skills.mjs', 'lib/copilot-live-skills-approval.mjs']) {
        const source = read(file);
        for (const retired of RETIRED) assert.ok(!source.includes(retired), `${file} still contains ${retired}.`);
    }
});

test('spec 06 drives the RoboTeam page through the conversation skills helpers', () => {
    const spec = read('specs/06-copilot-live-skills.spec.mjs');
    assert.match(spec, /from '\.\.\/lib\/conversation-skills\.mjs'/);
    for (const name of ['conversationFromSkillsURL', 'openConversationSkills', 'conversationSkillsState', 'setConversationSkill',
        'refreshConversationSkills', 'roboTeamRobotId']) {
        assert.match(spec, new RegExp(`\\b${name}\\b`), `spec 06 must use ${name}.`);
    }
    assert.doesNotMatch(spec, /function currentModal|currentModal\(/);
    assert.match(spec, /robotId: fixture\.robotId/);
});

test('the approval module reads the conversation from the RoboTeam link', () => {
    const approval = read('lib/copilot-live-skills-approval.mjs');
    assert.match(approval, /conversationFromSkillsURL\(settingsURL, baseURL, \{ robotId: fixture\.robotId \}\)\.sessionId/);
});

const LABEL = 'unexecuted until the deployment gate (D1/D2); Copilot-family flows are excluded from the 2026-10-02 post-merge acceptance';

test('the rewritten settings steps and the gate documents carry the unexecuted label', () => {
    assert.ok(read('specs/06-copilot-live-skills.spec.mjs').includes(LABEL), 'spec 06 needs the label.');
    assert.ok(read('copilot-live-skills.md').includes(LABEL), 'copilot-live-skills.md needs the label.');
    assert.ok(read('README.md').includes(LABEL), 'README.md needs the label.');
    assert.match(read('specs/06-copilot-live-skills.spec.mjs'), /blocked on SET-2/);
});

test('the gate documents name RoboTeam\'s Conversation skills page instead of the retired settings surface', () => {
    for (const file of ['copilot-live-skills.md', 'README.md']) {
        assert.match(read(file), /RoboTeam's Conversation skills page \(WebChat menu\)/, file);
    }
    assert.ok(!read('copilot-live-skills.md').includes('Conversation skills UI'));
});

test('the retired link parser is gone from the live-skills library', async () => {
    const library = await import('./copilot-live-skills.mjs');
    assert.equal(library.conversationFromSettingsURL, undefined);
});
