import assert from 'node:assert/strict';
import test from 'node:test';
import { authHeader, routerFetch, signedHeaders, signedPrincipal } from './helpers/router-signed.mjs';
import { CONTAINER_SENTINEL, TOKEN, startHttpFixture } from './helpers/live-sessions-http-fixture.mjs';
import { LiveSessionsRegistry } from '../server/live-sessions/registry.mjs';
import { frameViolation, rowViolation } from '../server/live-sessions/contract.mjs';

// Live Sessions routes on the RoboTeam service port. Signed requests are minted
// by the sibling Ploinky checkout's real Router minter and verified by its real
// Agent helper (helpers/router-signed.mjs). The robot store is a stub, so these
// cases need no /proc and run on every platform.
const USER_REQUIRED = 'Live Sessions require a signed-in user';
const RUN_ID = 'rt_abcdefghijklmnopqrstuvwx';

const ROUTES = [
    ['GET', '/api/live-sessions'],
    ['GET', `/api/live-sessions/${RUN_ID}/stream`],
    ['GET', `/api/live-sessions/${RUN_ID}/transcript`],
    ['POST', `/api/live-sessions/${RUN_ID}/messages`, JSON.stringify({ message: 'hello' })],
    ['POST', `/api/live-sessions/${RUN_ID}/stop`, '{}'],
    ['GET', `/live-sessions/${RUN_ID}`],
];

test('every Live Sessions route refuses internal-token callers, even with forwarded or signed users', async (t) => {
    const fixture = await startHttpFixture(t);
    const internal = { 'x-roboteam-internal-token': TOKEN };
    for (const [method, route, body] of ROUTES) {
        const variants = {
            bare: internal,
            forwardedAdmin: { ...internal, 'x-roboteam-user-id': 'owner-1', 'x-roboteam-user-roles': '["admin"]' },
            signedAdmin: { ...internal, ...signedHeaders(signedPrincipal({ id: 'owner-1', roles: ['admin'] }), method, route, body ?? '') },
        };
        for (const [name, headers] of Object.entries(variants)) {
            const response = await fetch(`${fixture.baseUrl}${route}`, { method, headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) }, body });
            const payload = await response.json();
            assert.equal(response.status, 403, `${method} ${route} ${name}`);
            assert.deepEqual(payload, { ok: false, error: USER_REQUIRED }, `${method} ${route} ${name}`);
        }
    }
});

test('Live Sessions routes reject unsigned and forged identities before any lookup', async (t) => {
    const fixture = await startHttpFixture(t);
    for (const [method, route, body] of ROUTES) {
        const forged = { 'x-ploinky-auth-info': JSON.stringify({ user: { id: 'owner-1', username: 'owner', roles: ['admin'] } }) };
        assert.equal((await fetch(`${fixture.baseUrl}${route}`, { method, body })).status, 401, `${method} ${route} unsigned`);
        assert.equal((await fetch(`${fixture.baseUrl}${route}`, { method, headers: forged, body })).status, 401, `${method} ${route} forged`);
        // A wrong internal token is no internal call; without a signed user it is unauthenticated.
        assert.equal((await fetch(`${fixture.baseUrl}${route}`, { method, headers: { 'x-roboteam-internal-token': 'wrong' }, body })).status, 401, `${method} ${route} wrong token`);
    }
});

// A registry with one run per owner state, owned by member-1 where verified.
function liveFixture(controls = {}) {
    const registry = new LiveSessionsRegistry({ log: () => {}, urlBase: '/base-agent-additional-server/roboTeamAgent/3001' });
    const calls = { messages: [], stops: 0, transcripts: 0 };
    const own = registry.admit({ kind: 'robot-task', title: 'Own task', ownerState: 'verified', ownerPrincipal: 'user:member-1',
        controls: { message: controls.message || (async (text) => { calls.messages.push(text); return 'delivered'; }),
            stop: controls.stop || (async () => { calls.stops += 1; }) },
        transcript: controls.transcript || (async () => { calls.transcripts += 1; return 'own transcript text'; }) }).id;
    const other = registry.admit({ kind: 'robot-task', title: 'Other task', ownerState: 'verified', ownerPrincipal: 'user:member-2',
        transcript: async () => { calls.transcripts += 1; return 'other transcript'; } }).id;
    const system = registry.admit({ kind: 'workflow-phase', title: 'System phase', ownerState: 'system', controls: { stop: async () => {} } }).id;
    const unverified = registry.admit({ kind: 'copilot-turn', title: 'Turn', ownerState: 'unverified' }).id;
    return { registry, calls, own, other, system, unverified };
}

const USER = () => ({ 'x-ploinky-auth-info': authHeader('member-1', ['user']) });
const BOB = () => ({ 'x-ploinky-auth-info': authHeader('member-2', ['user']) });
const ADMIN = () => ({ 'x-ploinky-auth-info': authHeader('owner-1', ['admin']) });

async function json(response) { return { status: response.status, body: await response.json() }; }
function postJson(baseUrl, route, body, headers) {
    return routerFetch(`${baseUrl}${route}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
}

test('a signed user lists exactly their own runs; administrators list every run', async (t) => {
    const live = liveFixture();
    const fixture = await startHttpFixture(t, { liveSessions: live.registry });
    const own = await json(await routerFetch(`${fixture.baseUrl}/api/live-sessions`, { headers: USER() }));
    assert.equal(own.status, 200);
    assert.deepEqual(Object.keys(own.body), ['ok', 'version', 'sessions']);
    assert.equal(own.body.ok, true);
    assert.equal(own.body.version, 1);
    assert.deepEqual(own.body.sessions.map((row) => row.id), [live.own]);
    assert.equal(own.body.sessions[0].isOwner, true);
    const admin = await json(await routerFetch(`${fixture.baseUrl}/api/live-sessions`, { headers: ADMIN() }));
    assert.deepEqual(new Set(admin.body.sessions.map((row) => row.id)), new Set([live.own, live.other, live.system, live.unverified]));
    for (const row of admin.body.sessions) assert.equal(rowViolation(row, 'roboTeamAgent'), null);
    assert.equal(admin.body.sessions.find((row) => row.id === live.own).capabilities.message, false, 'administrators never message');
});

test('unsigned identity fields never widen Live Sessions authority', async (t) => {
    const live = liveFixture();
    const fixture = await startHttpFixture(t, { liveSessions: live.registry });
    const headers = signedHeaders(signedPrincipal({ id: 'member-1', roles: ['user'] }), 'GET', '/api/live-sessions');
    const authInfo = JSON.parse(headers['x-ploinky-auth-info']);
    authInfo.user = { id: 'owner-1', username: 'owner-1', roles: ['admin'] };
    const widened = await json(await fetch(`${fixture.baseUrl}/api/live-sessions`, { headers: { 'x-ploinky-auth-info': JSON.stringify(authInfo) } }));
    assert.equal(widened.status, 200);
    assert.deepEqual(widened.body.sessions.map((row) => row.id), [live.own]);
});

test('a wrong signed path or body is refused and a non-entitled user is forbidden', async (t) => {
    const live = liveFixture();
    const fixture = await startHttpFixture(t, { liveSessions: live.registry });
    const member = signedPrincipal({ id: 'member-1', roles: ['user'] });
    const otherPath = signedHeaders(member, 'GET', '/api/robots/other');
    assert.equal((await fetch(`${fixture.baseUrl}/api/live-sessions`, { headers: otherPath })).status, 401);
    const signedBody = signedHeaders(member, 'POST', `/api/live-sessions/${live.own}/messages`, JSON.stringify({ message: 'signed' }));
    const tampered = await fetch(`${fixture.baseUrl}/api/live-sessions/${live.own}/messages`, { method: 'POST', headers: { ...signedBody, 'content-type': 'application/json' }, body: JSON.stringify({ message: 'changed' }) });
    assert.equal(tampered.status, 401);
    assert.deepEqual(live.calls.messages, []);
    const outsider = { id: 'self-1', username: 'self', email: '', roles: ['selfRegistered'], capabilities: ['selfregistered.dashboard.access'] };
    const refused = await json(await fetch(`${fixture.baseUrl}/api/live-sessions`, { headers: signedHeaders(outsider, 'GET', '/api/live-sessions') }));
    assert.equal(refused.status, 403);
    assert.equal(refused.body.error, 'Explorer access permission is required to use RoboTeam');
});

// Signed owners reach task and workflow launches; body fields and internal
// callers never set one, and a continuation never changes it.
const ROBOT = { id: 'robot-abc', name: 'Robot', codingAgents: ['codex'] };
function fakeRoboFlow(calls) {
    calls.flows = []; calls.schedules = []; calls.runNow = [];
    return {
        startFlow: async (input) => { calls.flows.push(input); return { id: 'flow' }; },
        saveSchedule: async (...args) => { calls.schedules.push(args); return { id: 'cron' }; },
        runScheduleNow: async (...args) => { calls.runNow.push(args); return { flow: null }; },
    };
}

async function post(baseUrl, route, body, headers) {
    const text = JSON.stringify(body);
    const response = await routerFetch(`${baseUrl}${route}`, { method: route.includes('cron_') && !route.endsWith('run-now') ? 'PUT' : 'POST',
        headers: { 'content-type': 'application/json', ...headers }, body: text });
    return { status: response.status, body: await response.json() };
}

test('task starts and continuations take the owner from the signed principal only', async (t) => {
    const calls = {};
    const fixture = await startHttpFixture(t, { robots: [ROBOT], calls });
    const user = { 'x-ploinky-auth-info': authHeader('member-1', ['user']) };
    const start = { robotId: ROBOT.id, operation: 'start-simple-task', cwd: '/w', task: 'x', ownerPrincipal: 'user:mallory' };
    assert.equal((await post(fixture.baseUrl, '/api/control', start, user)).status, 202);
    assert.equal(calls.startTask[0].request.ownerPrincipal, 'user:member-1');
    const internal = { 'x-roboteam-internal-token': TOKEN, 'x-roboteam-user-id': 'member-1', 'x-roboteam-user-roles': '["admin"]' };
    assert.equal((await post(fixture.baseUrl, '/api/control', start, internal)).status, 202);
    assert.equal(calls.startTask[1].request.ownerPrincipal, null, 'internal callers launch system work');
    const resume = { robotId: ROBOT.id, operation: 'resume-task', taskId: '11111111-1111-4111-8111-111111111111', prompt: 'go', ownerPrincipal: 'user:mallory' };
    assert.equal((await post(fixture.baseUrl, '/api/control', resume, user)).status, 202);
    assert.deepEqual(calls.resumeTask, [{ taskId: resume.taskId, prompt: 'go', rest: [] }], 'a continuation passes no owner');
});

test('workflow launches, Cron saves and Run now take the owner from the signed principal only', async (t) => {
    const calls = {};
    const fixture = await startHttpFixture(t, { roboflow: fakeRoboFlow(calls), calls });
    const user = { 'x-ploinky-auth-info': authHeader('member-1', ['user']) };
    const admin = { 'x-ploinky-auth-info': authHeader('owner-1', ['admin']) };
    assert.equal((await post(fixture.baseUrl, '/api/roboflow/flows', { workflowTypeId: 'w', objective: 'o', ownerPrincipal: 'user:mallory' }, user)).status, 201);
    assert.equal(calls.flows[0].ownerPrincipal, 'user:member-1');
    assert.equal(calls.flows[0].createdBy, 'member-1');
    const internal = { 'x-roboteam-internal-token': TOKEN, 'x-roboteam-user-id': 'member-1', 'x-roboteam-user-roles': '["admin"]' };
    assert.equal((await post(fixture.baseUrl, '/api/roboflow/flows', { workflowTypeId: 'w', ownerPrincipal: 'user:mallory' }, internal)).status, 201);
    assert.equal(calls.flows[1].ownerPrincipal, null);
    const cron = `cron_${'a'.repeat(24)}`;
    assert.equal((await post(fixture.baseUrl, '/api/roboflow/schedules', { workflowTypeId: 'w', ownerPrincipal: 'user:mallory' }, admin)).status, 201);
    assert.equal((await post(fixture.baseUrl, `/api/roboflow/schedules/${cron}`, { revision: 1 }, admin)).status, 200);
    assert.equal((await post(fixture.baseUrl, `/api/roboflow/schedules/${cron}/run-now`, { revision: 2 }, admin)).status, 200);
    assert.deepEqual(calls.schedules.map((args) => [args[1], args[2], args[3]]), [
        ['owner-1', undefined, { ownerPrincipal: 'user:owner-1' }],
        ['owner-1', cron, { ownerPrincipal: 'user:owner-1' }],
    ]);
    assert.deepEqual(calls.runNow, [[cron, 2, 'owner-1', { ownerPrincipal: 'user:owner-1' }]]);
    assert.equal((await post(fixture.baseUrl, '/api/roboflow/schedules', { workflowTypeId: 'w' }, internal)).status, 201);
    assert.deepEqual(calls.schedules[2][3], { ownerPrincipal: null }, 'an internal saver makes a system job');
});

test('messages: owner only, exact receipt shapes for every outcome, concurrent receipts stay separate', async (t) => {
    const pending = new Map();
    const live = liveFixture({ message: (text) => new Promise((resolve, reject) => pending.set(text, { resolve, reject })) });
    const fixture = await startHttpFixture(t, { liveSessions: live.registry });
    const route = `/api/live-sessions/${live.own}/messages`;
    assert.equal((await postJson(fixture.baseUrl, route, { message: 'x' }, ADMIN())).status, 403, 'a non-owner administrator cannot message');
    assert.equal((await postJson(fixture.baseUrl, route, { message: 'x' }, BOB())).status, 404);
    for (const body of [{}, { message: '' }, { message: '   \n\t' }, { message: 7 }, { message: 'x', extra: true }, { message: 'x'.repeat(32769) }, '[1]']) {
        assert.equal((await postJson(fixture.baseUrl, route, body, USER())).status, 400, JSON.stringify(body));
    }
    const sends = ['delivered', 'queued', 'rejected', 'ended', 'unknown'].map((text) => postJson(fixture.baseUrl, route, { message: text }, USER()));
    for (let i = 0; i < 100 && pending.size < 5; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    pending.get('queued').resolve('queued');
    pending.get('delivered').resolve('delivered');
    pending.get('rejected').reject(Object.assign(new Error('Busy.'), { liveOutcome: 'rejected' }));
    pending.get('ended').reject(Object.assign(new Error('gone'), { liveOutcome: 'run_ended' }));
    pending.get('unknown').reject(Object.assign(new Error('timeout'), { liveOutcome: 'unknown' }));
    const results = await Promise.all(sends.map(async (send) => json(await send)));
    assert.deepEqual(results, [
        { status: 200, body: { delivery: 'delivered' } },
        { status: 200, body: { delivery: 'queued' } },
        { status: 409, body: { error: 'rejected', detail: 'Busy.' } },
        { status: 409, body: { error: 'run_ended' } },
        { status: 504, body: { error: 'delivery_unknown' } },
    ]);
    live.registry.end(live.own, 'finished');
    assert.deepEqual(await json(await postJson(fixture.baseUrl, route, { message: 'late' }, USER())), { status: 409, body: { error: 'run_ended' } });
});

test('stop: owner or administrator, exact response, control failures mapped', async (t) => {
    const live = liveFixture();
    const fixture = await startHttpFixture(t, { liveSessions: live.registry });
    const route = (id) => `/api/live-sessions/${id}/stop`;
    assert.equal((await postJson(fixture.baseUrl, route(live.own), {}, BOB())).status, 404);
    assert.equal((await postJson(fixture.baseUrl, route(live.own), { force: true }, ADMIN())).status, 400);
    assert.deepEqual(await json(await postJson(fixture.baseUrl, route(live.own), {}, ADMIN())), { status: 200, body: { ok: true } });
    assert.equal(live.calls.stops, 1, 'an administrator stop calls the control once');
    assert.equal((await postJson(fixture.baseUrl, route(live.system), {}, USER())).status, 404, 'system runs are hidden from users');
    const reconnecting = liveFixture({ stop: async () => { throw Object.assign(new Error('the run publisher is reconnecting; try again'), { statusCode: 409 }); } });
    const failing = liveFixture({ stop: async () => { throw new Error('internal detail'); } });
    for (const [registry, id, status, error] of [[reconnecting.registry, reconnecting.own, 409, 'the run publisher is reconnecting; try again'], [failing.registry, failing.own, 500, 'request failed']]) {
        const server = await startHttpFixture(t, { liveSessions: registry });
        assert.deepEqual(await json(await postJson(server.baseUrl, route(id), {}, USER())), { status, body: { ok: false, error } });
    }
});

test('streams: owner and administrator watch, others get 404, cursor delta and bounded stream lifetime', async (t) => {
    const live = liveFixture();
    live.registry.output(live.own, 'first line\n');
    live.registry.output(live.own, 'second line\n');
    const fixture = await startHttpFixture(t, { liveSessions: live.registry, streamLifetimeMs: 150 });
    const read = async (headers, id = live.own, extra = {}) => {
        const response = await routerFetch(`${fixture.baseUrl}/api/live-sessions/${id}/stream`, { headers: { ...headers, ...extra } });
        return { status: response.status, type: response.headers.get('content-type'), text: await response.text() };
    };
    const owner = await read(USER());
    assert.equal(owner.status, 200);
    assert.match(owner.type, /^text\/event-stream/u);
    assert.match(owner.text, /id: 1\nevent: output/u);
    assert.match(owner.text, /event: status\ndata: \{"status":"running"\}/u);
    for (const block of owner.text.split('\n\n').filter((item) => item.startsWith('id:') || item.startsWith('event:'))) {
        const event = /event: (.*)/u.exec(block)[1];
        assert.equal(frameViolation(event, JSON.parse(/data: (.*)/u.exec(block)[1])), null, block);
    }
    const delta = await read(USER(), live.own, { 'last-event-id': '1' });
    assert.doesNotMatch(delta.text, /first line/u);
    assert.match(delta.text, /second line/u);
    assert.equal((await read(ADMIN())).status, 200);
    assert.equal((await read(BOB())).status, 404);
    assert.equal((await read(USER(), live.system)).status, 404);
    assert.equal((await read(USER(), live.unverified)).status, 404);
    // Each stream ends within its admission lifetime, so a reconnect re-checks
    // the signed administrator decision; a demoted viewer then gets 404.
    assert.equal((await read(ADMIN(), live.other)).status, 200);
    assert.equal((await read({ 'x-ploinky-auth-info': authHeader('owner-1', ['user']) }, live.other)).status, 404);
    assert.equal(live.registry.viewerTotal, 0, 'ended streams release their viewer slots');
});

test('transcripts: owner reads text, foreign callers get 404 without resolution, never container logs', async (t) => {
    const calls = {};
    const live = liveFixture();
    const pending = live.registry.admit({ kind: 'robot-task', title: 'Not started', ownerState: 'verified', ownerPrincipal: 'user:member-1', transcript: async () => null }).id;
    const fixture = await startHttpFixture(t, { liveSessions: live.registry, calls });
    const get = async (id, headers) => {
        const response = await routerFetch(`${fixture.baseUrl}/api/live-sessions/${id}/transcript`, { headers });
        return { status: response.status, type: response.headers.get('content-type'), nosniff: response.headers.get('x-content-type-options'), text: await response.text() };
    };
    const own = await get(live.own, USER());
    assert.deepEqual(own, { status: 200, type: 'text/plain; charset=utf-8', nosniff: 'nosniff', text: 'own transcript text' });
    assert.equal(live.calls.transcripts, 1);
    const foreign = await get(live.other, USER());
    assert.equal(foreign.status, 404);
    assert.equal(live.calls.transcripts, 1, 'a foreign transcript is never resolved');
    const unavailable = await get(pending, USER());
    assert.equal(unavailable.status, 404);
    assert.match(unavailable.text, /not available/u);
    assert.equal((await get(live.unverified, ADMIN())).status, 404, 'a run without a transcript has none');
    for (const response of [own, foreign, unavailable]) assert.doesNotMatch(response.text, new RegExp(CONTAINER_SENTINEL, 'u'));
    assert.equal(calls.containerLogs, undefined, 'container logs are never read');
});

test('the view page is text-only, unframeable and served only for a visible run', async (t) => {
    const live = liveFixture();
    const fixture = await startHttpFixture(t, { liveSessions: live.registry });
    const page = await routerFetch(`${fixture.baseUrl}/live-sessions/${live.own}`, { headers: USER() });
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /^text\/html/u);
    assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/u);
    assert.match(page.headers.get('content-security-policy'), /script-src 'sha256-/u);
    assert.equal(page.headers.get('x-frame-options'), 'DENY');
    const html = await page.text();
    assert.match(html, /textContent/u);
    assert.doesNotMatch(html, /innerHTML|insertAdjacentHTML|outerHTML|document\.write/u);
    assert.equal((await routerFetch(`${fixture.baseUrl}/live-sessions/${live.other}`, { headers: USER() })).status, 404);
    assert.equal((await routerFetch(`${fixture.baseUrl}/live-sessions/${live.system}`, { headers: ADMIN() })).status, 200);
});

test('unknown Live Sessions paths and methods are not found', async (t) => {
    const live = liveFixture();
    const fixture = await startHttpFixture(t, { liveSessions: live.registry });
    for (const [method, route] of [['GET', `/api/live-sessions/${live.own}`], ['DELETE', `/api/live-sessions/${live.own}/stop`],
        ['GET', `/api/live-sessions/${live.own}/messages`], ['POST', '/api/live-sessions'], ['GET', '/live-sessions/'], ['GET', `/api/live-sessions/bad%2fid/stream`]]) {
        assert.equal((await routerFetch(`${fixture.baseUrl}${route}`, { method, headers: USER() })).status, 404, `${method} ${route}`);
    }
});

test('a recorded turn that cannot be rendered is reported once per error class, without content', async () => {
    const { httpServerInternals } = await import('../server/http-server.mjs');
    const { renderRecordedTurn } = httpServerInternals;
    const lines = [];
    const original = console.error;
    console.error = (...args) => lines.push(args.join(' '));
    try {
        assert.equal(renderRecordedTurn(() => { throw new TypeError('secret transcript text'); }), null);
        assert.equal(renderRecordedTurn(() => { throw new TypeError('other secret'); }), null);
        assert.equal(renderRecordedTurn(() => { throw Object.assign(new Error('x'), { code: 'EBROKEN' }); }), null);
        assert.equal(renderRecordedTurn(() => { throw Object.assign(new Error('y'), { code: 'EOTHER' }); }), null);
        assert.equal(renderRecordedTurn(() => { throw Object.assign(new Error('z'), { code: 'EOTHER' }); }), null);
        assert.equal(renderRecordedTurn(() => 'rendered'), 'rendered');
    } finally { console.error = original; }
    assert.deepEqual(lines, ['[roboTeamAgent] a recorded turn could not be rendered (TypeError)',
        '[roboTeamAgent] a recorded turn could not be rendered (Error:EBROKEN)',
        '[roboTeamAgent] a recorded turn could not be rendered (Error:EOTHER)']);
});

test('a message of 32768 characters that encodes to far more than 64 KiB is accepted; one more character is refused', async (t) => {
    const received = [];
    const live = liveFixture({ message: async (text) => { received.push(text); return 'delivered'; } });
    const fixture = await startHttpFixture(t, { liveSessions: live.registry });
    const route = `/api/live-sessions/${live.own}/messages`;
    const cjk = '漢'.repeat(32768);
    const control = '\u0001'.repeat(32768);
    assert.ok(Buffer.byteLength(JSON.stringify({ message: control })) > 190 * 1024);
    assert.deepEqual(await json(await postJson(fixture.baseUrl, route, { message: cjk }, USER())), { status: 200, body: { delivery: 'delivered' } });
    assert.deepEqual(await json(await postJson(fixture.baseUrl, route, { message: control }, USER())), { status: 200, body: { delivery: 'delivered' } });
    assert.equal((await postJson(fixture.baseUrl, route, { message: `${cjk}漢` }, USER())).status, 400);
    assert.deepEqual(received.map((text) => text.length), [32768, 32768]);
    // Other routes keep their 64 KiB limit.
    const other = await postJson(fixture.baseUrl, '/api/control', { robotId: 'robot-abc', operation: 'x', pad: '漢'.repeat(32768) }, USER());
    assert.equal(other.status, 400);
    assert.match((await other.json()).error, /too large/u);
});

test('a recorded turn that cannot be read is reported without content; a missing record is silent', async (t) => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const { httpServerInternals } = await import('../server/http-server.mjs');
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'turn-lookup-')));
    const previousRoot = process.env.PLOINKY_WORKSPACE_ROOT;
    process.env.PLOINKY_WORKSPACE_ROOT = root;
    t.after(async () => {
        if (previousRoot === undefined) delete process.env.PLOINKY_WORKSPACE_ROOT; else process.env.PLOINKY_WORKSPACE_ROOT = previousRoot;
        await fs.rm(root, { recursive: true, force: true });
    });
    const sessionId = '11111111-2222-4333-8444-555555555555';
    const messageId = '66666666-7777-4888-8999-aaaaaaaaaaaa';
    const lines = [];
    const original = console.error;
    console.error = (...args) => lines.push(args.join(' '));
    try {
        assert.equal(httpServerInternals.lookupRecordedTurn(root, sessionId, messageId), null, 'missing session');
        assert.equal(httpServerInternals.lookupRecordedTurn(root, 'not-a-session', messageId), null, 'invalid id');
        assert.deepEqual(lines, [], 'missing records are not defects');
        await fs.mkdir(path.join(root, '.roboteam', 'sessions', sessionId), { recursive: true });
        await fs.writeFile(path.join(root, '.roboteam', 'sessions', sessionId, 'config.json'), '{ broken SECRET-CONTENT');
        assert.equal(httpServerInternals.lookupRecordedTurn(root, sessionId, messageId), null);
        assert.equal(httpServerInternals.lookupRecordedTurn(root, sessionId, messageId), null);
    } finally { console.error = original; }
    assert.deepEqual(lines, ['[roboTeamAgent] a recorded turn could not be read (SyntaxError)']);
});

test('a failing transcript read answers 500 and logs only the error class and code', async (t) => {
    const live = liveFixture({ transcript: async () => { throw Object.assign(new Error('SECRET /workspace/path rt_abc'), { code: 'EIO' }); } });
    const fixture = await startHttpFixture(t, { liveSessions: live.registry });
    const lines = [];
    const original = console.error;
    console.error = (...args) => lines.push(args.join(' '));
    let response;
    try { response = await routerFetch(`${fixture.baseUrl}/api/live-sessions/${live.own}/transcript`, { headers: USER() }); }
    finally { console.error = original; }
    assert.equal(response.status, 500);
    assert.equal(await response.text(), 'The transcript is unavailable.');
    assert.deepEqual(lines, ['[live-sessions] a transcript could not be read (Error:EIO)']);
});
