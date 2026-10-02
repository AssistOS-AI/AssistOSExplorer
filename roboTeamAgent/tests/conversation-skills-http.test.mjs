import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import test from 'node:test';
import { createRoboTeamServer } from '../server/http-server.mjs';
import { DEFAULT_ROBOT_ID, OTHER_ROBOT_ID, SKILL_IDENTITY, authHeader, createConversationSkillsFixture } from './helpers/conversation-skills-fixture.mjs';

// The real RobotStore reads /proc, so this suite runs the real HTTP server with the
// stub robot registry from the shared fixture.
async function start(t) {
    const f = await createConversationSkillsFixture();
    const { sessionId } = await f.addSession();
    const runtimeManager = { workspaceRoot: f.workspaceRoot, status: () => ({ state: 'stopped' }), activePort: () => null, hasUnfinishedTasks: () => false };
    const server = createRoboTeamServer({ robotStore: f.robotStore, runtimeManager, skillsets: f.skillsets, internalToken: 'test-token', publicBasePath: '/rt/', mcpPort: 65534 });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => { await new Promise(resolve => server.close(resolve)); await f.close(); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const url = (robotId = DEFAULT_ROBOT_ID, id = sessionId) => `${base}/api/robots/${robotId}/conversations/${id}/skills`;
    const call = async (target, { method = 'GET', actor = authHeader(), body, raw, headers = {} } = {}) => {
        const response = await fetch(target, { method, headers: { ...(actor ? { 'x-ploinky-auth-info': actor } : {}),
            ...(body !== undefined || raw !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
        body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body) });
        const text = await response.text();
        let payload; try { payload = JSON.parse(text); } catch { payload = text; }
        return { status: response.status, payload, response };
    };
    return { ...f, sessionId, base, url, call };
}

test('page and scripts are served to a signed-in user with the injected base and refused without identity', async t => {
    const f = await start(t);
    for (const suffix of ['', '/', `/${DEFAULT_ROBOT_ID}/${f.sessionId}`, `/${DEFAULT_ROBOT_ID}/${f.sessionId}/`, '/not-a-valid-link']) {
        const page = await f.call(`${f.base}/conversation-skills${suffix}`);
        assert.equal(page.status, 200, suffix);
        assert.match(page.response.headers.get('content-type'), /^text\/html/);
        assert.match(page.payload, /<base href="\/rt\/">/);
        for (const id of ['conversationSkillsStatus', 'conversationSkillsSummary', 'conversationSkillsRefresh', 'conversationSkillsList']) assert.match(page.payload, new RegExp(`id="${id}"`));
        assert.equal((await f.call(`${f.base}/conversation-skills${suffix}`, { actor: null })).status, 401);
    }
    for (const name of ['conversation-skills.js', 'conversation-skills-model.js']) {
        const script = await f.call(`${f.base}/${name}`);
        assert.equal(script.status, 200, name);
        assert.match(script.response.headers.get('content-type'), /^text\/javascript/);
        assert.equal((await f.call(`${f.base}/${name}`, { actor: null })).status, 401);
    }
});

test('GET reads exactly the named conversation and PATCH changes it with the browser-sent body', async t => {
    const f = await start(t);
    const read = await f.call(f.url());
    assert.equal(read.status, 200);
    assert.equal(read.payload.ok, true);
    assert.equal(read.payload.robotId, DEFAULT_ROBOT_ID);
    assert.equal(read.payload.scope, 'conversation');
    assert.equal(read.payload.sessionId, f.sessionId);
    const row = read.payload.skills.find(skill => skill.identity === SKILL_IDENTITY);
    assert.equal(row.enabled, false);
    const patched = await f.call(f.url(), { method: 'PATCH', body: { identity: SKILL_IDENTITY, enabled: true, policyVersion: read.payload.policyVersion } });
    assert.equal(patched.status, 200);
    assert.equal(patched.payload.policyVersion, read.payload.policyVersion + 1);
    assert.equal(patched.payload.skills.find(skill => skill.identity === SKILL_IDENTITY).enabled, true);
    assert.deepEqual((await f.policyFiles(DEFAULT_ROBOT_ID)).filter(name => name.startsWith('defaults-')), []);
});

test('authorization: no identity is 401 and the internal-token actor is 403 on both verbs', async t => {
    const f = await start(t);
    assert.equal((await f.call(f.url(), { actor: null })).status, 401);
    assert.equal((await f.call(f.url(), { actor: null, method: 'PATCH', body: {} })).status, 401);
    for (const method of ['GET', 'PATCH']) {
        const internal = await f.call(f.url(), { actor: null, method, body: method === 'PATCH' ? {} : undefined,
            headers: { 'x-roboteam-internal-token': 'test-token', 'x-roboteam-user-id': 'tool' } });
        assert.equal(internal.status, 403, method);
        assert.equal(internal.payload.error, 'conversation skills require a signed-in user');
    }
    assert.deepEqual(await f.policyFiles(DEFAULT_ROBOT_ID), []);
});

test('only GET and PATCH exist; queries, including dir, are refused', async t => {
    const f = await start(t);
    for (const method of ['POST', 'PUT', 'DELETE']) {
        const response = await f.call(f.url(), { method, body: {} });
        assert.equal(response.status, 404, method);
        assert.equal(response.payload.error, 'not found');
    }
    for (const query of ['?dir=/tmp', '?x=1', '?sessionId=other']) {
        const read = await f.call(`${f.url()}${query}`);
        assert.equal(read.status, 400, query);
        assert.equal(read.payload.error, 'conversation skills requests take no query parameters');
        assert.equal((await f.call(`${f.url()}${query}`, { method: 'PATCH', body: {} })).status, 400);
    }
});

test('error injection: malformed, array and mistyped bodies and extra keys are 400 and change nothing', async t => {
    const f = await start(t);
    const { payload } = await f.call(f.url());
    const good = { identity: SKILL_IDENTITY, enabled: true, policyVersion: payload.policyVersion };
    const patch = options => f.call(f.url(), { method: 'PATCH', ...options });
    assert.equal((await patch({ raw: '{"identity"' })).status, 400);
    assert.equal((await patch({ raw: '[]' })).status, 400);
    assert.equal((await patch({ raw: '"text"' })).status, 400);
    assert.equal((await patch({ body: { ...good, enabled: 'true' } })).status, 400);
    const extra = await patch({ body: { ...good, dir: '/tmp' } });
    assert.equal(extra.status, 400);
    assert.equal(extra.payload.error, 'unexpected field: dir');
    assert.equal((await patch({ body: { ...good, policyVersion: 2 ** 53 } })).status, 400);
    assert.equal((await patch({ body: { ...good, policyVersion: -1 } })).status, 400);
    assert.equal((await patch({ body: { ...good, policyVersion: '1' } })).status, 400);
    assert.equal((await patch({ body: { ...good, identity: '' } })).status, 400);
    const unicode = await patch({ body: { ...good, identity: '技能/名字' } });
    assert.equal(unicode.status, 400);
    assert.equal(unicode.payload.error, 'skill identity is unavailable');
    const large = await patch({ body: { ...good, identity: 'x'.repeat(70 * 1024) } });
    assert.equal(large.status, 400);
    assert.equal(large.payload.error, 'request body is too large');
    // A rejected change may persist the conversation's own policy (as the MCP tool does); it never touches robot defaults.
    assert.deepEqual((await f.policyFiles(DEFAULT_ROBOT_ID)).filter(name => name !== `${f.sessionId}.json`), []);
    assert.equal((await f.call(f.url())).payload.policyVersion, payload.policyVersion);
    assert.equal((await f.call(f.url())).payload.skills.find(skill => skill.identity === SKILL_IDENTITY).enabled, false);
});

test('orphans: unknown robot, unknown conversation, wrong robot and malformed ids map to their statuses', async t => {
    const f = await start(t);
    const expectError = async (target, status, message, options) => {
        const response = await f.call(target, options);
        assert.equal(response.status, status, target);
        assert.equal(response.payload.error, message, target);
    };
    await expectError(f.url('missing-abc123'), 404, 'robot not found');
    await expectError(f.url(DEFAULT_ROBOT_ID, crypto.randomUUID()), 404, 'Conversation is unavailable in registered projects');
    await expectError(f.url(OTHER_ROBOT_ID), 409, 'This conversation uses another robot. Open it with that robot, or create a new session.');
    await expectError(f.url(DEFAULT_ROBOT_ID, 'not-a-uuid'), 400, 'invalid conversation id');
    await expectError(f.url('AB'), 400, 'invalid robot id');
    await expectError(f.url(OTHER_ROBOT_ID), 409, 'This conversation uses another robot. Open it with that robot, or create a new session.',
        { method: 'PATCH', body: { identity: SKILL_IDENTITY, enabled: true, policyVersion: 1 } });
    assert.deepEqual(await f.policyFiles(OTHER_ROBOT_ID), []);
    assert.deepEqual(await f.policyFiles(DEFAULT_ROBOT_ID), []);
});

test('idempotency and concurrency over HTTP: a replay is 409 and two equal-version toggles yield one 200 and one 409', async t => {
    const f = await start(t);
    const { payload } = await f.call(f.url());
    const body = { identity: SKILL_IDENTITY, enabled: true, policyVersion: payload.policyVersion };
    assert.equal((await f.call(f.url(), { method: 'PATCH', body })).status, 200);
    const file = f.policyFile(DEFAULT_ROBOT_ID, f.sessionId);
    const bytes = await fs.readFile(file);
    const replay = await f.call(f.url(), { method: 'PATCH', body });
    assert.equal(replay.status, 409);
    assert.equal(replay.payload.error, 'skill policy changed; reload before updating');
    assert.deepEqual(await fs.readFile(file), bytes);
    const version = payload.policyVersion + 1;
    const results = await Promise.all([false, false].map(enabled => f.call(f.url(), { method: 'PATCH', body: { identity: SKILL_IDENTITY, enabled, policyVersion: version } })));
    assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
    assert.equal((await f.call(f.url())).payload.policyVersion, version + 1);
});
