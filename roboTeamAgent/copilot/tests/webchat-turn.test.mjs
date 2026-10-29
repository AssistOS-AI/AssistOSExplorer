import test from 'node:test';
import './helpers/isolated-ala-home.mjs';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createWebchatCoordinator, loadWebchatVerifier } from '../src/lib/webchat/webchatCoordinator.mjs';
import { normalizeWebchatMessage } from '../src/lib/webchat/webchatEnvelope.mjs';
import { createWebchatDispatcher } from '../src/lib/webchat/webchatRuntime.mjs';
import { WebchatOriginStore } from '../../server/worker-coordinator/webchat-origins.mjs';
import { newOriginId } from '../../server/worker-coordinator/identities.mjs';

// WebChat turn admission (S6 source-only subset delta Part C; interface note §2.3(9) "Turn
// admission"), the F1 follow-up batch and rotation (Part B), and the D-F6 §17 D6-6 WebChat rule.
// Envelopes are minted by the sibling Ploinky checkout's real Router path for RoboTeam's real
// manifest and verified by the real Agent verifier, as in webchat-coordinator.test.mjs. The hop
// is a recording stub; the origin store is a real SQLite file. Nothing here launches a turn.
const PLOINKY_ROOT = fileURLToPath(new URL('../../../../ploinky/', import.meta.url));
const MANIFEST_FILE = fileURLToPath(new URL('../../manifest.json', import.meta.url));
const RUNTIME_SOURCE = fileURLToPath(new URL('../src/lib/webchat/webchatRuntime.mjs', import.meta.url));
const AUDIENCE = 'agent:AchillesIDE/roboTeamAgent';
const savedEnv = { ...process.env };
const savedCwd = process.cwd();
const routerRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'wt-router-')));
for (const key of Object.keys(process.env)) if (/^(PLOINKY_|SSO_)/u.test(key) && key !== 'PLOINKY_AGENTLIB_DIR') delete process.env[key];
process.env.PLOINKY_AGENTLIB_DIR ||= path.join(PLOINKY_ROOT, 'node_modules', 'achillesAgentLib');
process.env.PLOINKY_MASTER_KEY = randomBytes(32).toString('hex');
process.env.PLOINKY_WORKSPACE_ROOT = routerRoot;
process.env.PLOINKY_ROUTER_HOST_PORT = '18080';
process.chdir(routerRoot);
const load = (relative) => import(pathToFileURL(path.join(PLOINKY_ROOT, relative)).href);
const fixtureAgent = path.join(routerRoot, 'roboTeamAgent');
await fs.mkdir(fixtureAgent);
await fs.copyFile(MANIFEST_FILE, path.join(fixtureAgent, 'manifest.json'));
for (const [name, value] of Object.entries({
    'routing.json': { routes: { roboTeamAgent: { repo: 'AchillesIDE', agent: 'roboTeamAgent', container: 'wt-router', hostPath: fixtureAgent, hostPort: 7402 } } },
    'agents.json': { 'wt-router': { type: 'agent', repoName: 'AchillesIDE', agentName: 'roboTeamAgent', instanceId: 'wt-router', enableGeneration: 'wt-router', auth: { mode: 'none' } } },
    'data/edge-routing/desired.json': { hosts: {} },
    'data/router-security/policy-state.json': { schema: 'router-policy', httpRoutes: [], mcpTools: [] },
})) {
    const file = path.join(routerRoot, '.ploinky', name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(value), { mode: 0o600 });
}
const { applyEdgeRoutingGeneration } = await load('cli/sandbox/edgeGeneration.js');
applyEdgeRoutingGeneration({ workspaceRoot: routerRoot, reason: 'webchat-turn-test' });
const { serializeWebchatEnvelopeForAgent, serializeWebchatRuntimeOpenEnvelope } = await load('cli/server/handlers/webchat/messageEnvelope.js');
const { deriveAgentRequestSecret } = await load('cli/utils/security/masterKey.js');
const AGENT_ENV = Object.freeze({ PLOINKY_AGENT_RUNTIME_ROOT: path.join(PLOINKY_ROOT, 'Agent'), PLOINKY_AGENT_ID: AUDIENCE,
    PLOINKY_AGENT_SECRET: deriveAgentRequestSecret(AUDIENCE, { encoding: 'hex' }) });

test.after(async () => {
    process.chdir(savedCwd);
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    await fs.rm(routerRoot, { recursive: true, force: true });
});

const PRINCIPAL = Object.freeze({ agentName: 'roboTeamAgent', forwardEnvelope: true, runtimeScope: 'principal' });
const U = { id: 'user-alice', roles: ['user'] };
const requestFor = (user) => ({ headers: { host: 'localhost' }, socket: {}, user, authMode: 'sso' });
const mint = ({ user = U, tabId = 'tab_u', envelope = {} } = {}) => serializeWebchatEnvelopeForAgent({
    req: requestFor(user), effectiveConfig: PRINCIPAL, tabId, pageInstanceId: 'page_u',
    envelope: { text: 'Hello', attachments: [], references: [], presentation: { visible: true }, ...envelope } });
const runtimeOpen = ({ user = U, tabId = 'tab_u' } = {}) => serializeWebchatRuntimeOpenEnvelope({ req: requestFor(user), effectiveConfig: PRINCIPAL, tabId, pageInstanceId: 'page_u' });
const taskRef = (id = 'T'.repeat(22)) => ({ version: 1, provider: 'agent:AchillesIDE/robo-work', id });
const response = (status, json = {}, refusal = null) => ({ outcome: 'response', status, json, refusal });
const accepted = (originRequestId) => response(200, { taskRef: taskRef(), state: 'queued', originRequestId });
const isRead = (call) => call.operation.startsWith('references/') && call.operation.endsWith('/read');
const readId = (call) => call.operation.split('/')[1];

function stubHop(script = {}) {
    const calls = [];
    return {
        calls,
        async call(operation, body, { grant } = {}) {
            const text = Buffer.isBuffer(body) ? body.toString('utf8') : typeof body === 'string' ? body : JSON.stringify(body);
            const call = { operation, text, body: JSON.parse(text), grant };
            calls.push(call);
            const key = operation.startsWith('references/') ? operation.split('/').pop() : operation;
            const reply = script[key];
            const outcome = typeof reply === 'function' ? await reply(call, calls) : reply;
            if (outcome instanceof Error) throw outcome;
            return outcome || accepted(call.body.originRequestId);
        },
    };
}

async function storeFor(t, options = {}) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wt-origins-'));
    const store = new WebchatOriginStore({ file: path.join(dir, 'worker-coordinator', 'webchat-origins.sqlite'), ...options });
    t.after(async () => { store.close(); await fs.rm(dir, { recursive: true, force: true }); });
    return store;
}

async function coordinatorFor(t, { hop = stubHop(), store, logs = [] } = {}) {
    const verifier = await loadWebchatVerifier(AGENT_ENV);
    assert.equal(typeof verifier, 'function');
    const coordinator = createWebchatCoordinator({ hop, store: store || await storeFor(t), verifier, log: (event) => logs.push(event) });
    return { coordinator, hop, logs };
}

// An admitted origin row for `principal` holding the reference `id`, stamped at the store's clock.
function seedAdmitted(store, { principal = 'user:user-alice', id = newOriginId() } = {}) {
    const originRequestId = newOriginId();
    store.insertPersisted({ originRequestId, principal, tabId: 't', conversationId: 'c', digest: 'd', body: '{}' });
    assert.equal(store.settle(originRequestId, 'admitted', ['persisted'], { taskRef: taskRef(id) }), true, 'fixture: row admitted');
    return { originRequestId, id };
}

function seedUnknown(store, { principal = 'user:user-alice' } = {}) {
    const originRequestId = newOriginId();
    store.insertPersisted({ originRequestId, principal, tabId: 't', conversationId: 'c', digest: 'd', body: JSON.stringify({ originRequestId }) });
    assert.equal(store.settle(originRequestId, 'unknown', ['persisted']), true, 'fixture: row unknown');
    return originRequestId;
}

const CONVERSATION = '00000000-0000-4000-8000-0000000000aa';
const TURN_SPEC = Object.freeze({ version: 1, prompt: 'SYNTHETIC transport-only turn' });
const turnRequest = (extra = {}) => ({ conversationId: CONVERSATION, robotId: newOriginId(), configRevision: 1, specification: TURN_SPEC, ...extra });

test('admitTurn persists the origin before transmission and sends the turn body with the envelope grant', async (t) => {
    const store = await storeFor(t);
    const hop = stubHop({ admissions: (call) => {
        const row = store.get(call.body.originRequestId);
        assert.equal(row.state, 'persisted', 'the row exists before the first transmission');
        assert.equal(row.admission_body, call.text, 'the stored bytes are the transmitted bytes');
        return accepted(call.body.originRequestId);
    } });
    const { coordinator } = await coordinatorFor(t, { store, hop });
    const evidence = coordinator.evidenceFor(normalizeWebchatMessage(mint()));
    const request = turnRequest();
    const result = await coordinator.admitTurn(evidence, request);
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.taskRef, taskRef());
    assert.equal(hop.calls.length, 1);
    const [call] = hop.calls;
    assert.equal(call.operation, 'admissions');
    assert.equal(call.grant, evidence.grant, 'admitTurn sends the envelope grant');
    assert.deepEqual(Object.keys(call.body), ['originRequestId', 'robotId', 'configRevision', 'kind', 'logical', 'specification']);
    assert.deepEqual(call.body, { originRequestId: call.body.originRequestId, robotId: request.robotId, configRevision: 1, kind: 'turn',
        logical: { sessionKey: CONVERSATION }, specification: TURN_SPEC });
    assert.match(call.body.originRequestId, /^[A-Za-z0-9_-]{22}$/u);
    const [row] = store.rows();
    assert.equal(row.state, 'admitted');
    assert.equal(row.conversation_id, CONVERSATION, 'the origin row stores the conversation');
    assert.equal(row.user_principal, 'user:user-alice');
    assert.equal(row.tab_id, 'tab_u');
    assert.deepEqual(JSON.parse(row.task_ref), taskRef());
    assert.equal(row.admission_body.includes(evidence.grant), false, 'no grant is stored');
});

test('admitTurn refuses without owner evidence and rejects malformed requests, storing and sending nothing', async (t) => {
    const store = await storeFor(t);
    const { coordinator, hop } = await coordinatorFor(t, { store });
    const refused = { status: 403, body: { error: 'owner_evidence_unavailable' } };
    assert.deepEqual(await coordinator.admitTurn(null, turnRequest()), refused);
    assert.deepEqual(await coordinator.admitTurn({ ok: true, principal: 'user:user-alice', grant: null }, turnRequest()), refused);
    assert.deepEqual(await coordinator.admitTurn(coordinator.evidenceFor(normalizeWebchatMessage('plain operator text')), turnRequest()), refused);
    const evidence = coordinator.evidenceFor(normalizeWebchatMessage(mint()));
    const invalid = {
        'kind supplied': turnRequest({ kind: 'turn' }),
        'logicalId supplied': turnRequest({ logicalId: newOriginId() }),
        'authority key': turnRequest({ owner: 'user:user-victor' }),
        'missing specification': (({ specification, ...rest }) => rest)(turnRequest()),
        'conversation of 129 characters': turnRequest({ conversationId: 'c'.repeat(129) }),
        'empty conversation': turnRequest({ conversationId: '' }),
        'conversation with a slash': turnRequest({ conversationId: 'a/b' }),
        'short robot id': turnRequest({ robotId: 'short' }),
        'revision 0': turnRequest({ configRevision: 0 }),
        'revision as string': turnRequest({ configRevision: '1' }),
        'specification array': turnRequest({ specification: [] }),
        'request array': [],
    };
    for (const [name, request] of Object.entries(invalid)) {
        assert.deepEqual(await coordinator.admitTurn(evidence, request), { status: 400, body: { error: 'invalid_request' } }, name);
    }
    assert.equal((await coordinator.admitTurn(evidence, turnRequest({ conversationId: 'c'.repeat(128) }))).status, 200, '128 characters is accepted');
    assert.equal(store.rows().length, 1);
    assert.equal(hop.calls.length, 1);
    const noStore = createWebchatCoordinator({ hop, store: null, verifier: await loadWebchatVerifier(AGENT_ENV) });
    assert.deepEqual(await noStore.admitTurn(noStore.evidenceFor(normalizeWebchatMessage(mint())), turnRequest()),
        { status: 503, body: { error: 'worker_coordinator_unavailable' } });
    assert.equal(hop.calls.length, 1);
});

test('admit keeps refusing turn work with logical_kind_unavailable; session work enters only through admitTurn', async (t) => {
    const store = await storeFor(t);
    const { coordinator, hop } = await coordinatorFor(t, { store });
    const evidence = coordinator.evidenceFor(normalizeWebchatMessage(mint()));
    const request = { conversationId: CONVERSATION, robotId: newOriginId(), configRevision: 1, kind: 'turn', specification: TURN_SPEC };
    assert.deepEqual(await coordinator.admit(evidence, request), { status: 400, body: { error: 'logical_kind_unavailable' } }, 'admit refuses turn');
    assert.deepEqual(await coordinator.admit(evidence, { ...request, kind: 'session' }), { status: 400, body: { error: 'logical_kind_unavailable' } });
    assert.equal(store.rows().length, 0, 'admit stored nothing for turn work');
    assert.equal(hop.calls.length, 0, 'admit sent nothing for turn work');
});

test('an unknown turn outcome stays recoverable: the next envelope resends the stored turn bytes; refusals settle refused', async (t) => {
    const store = await storeFor(t);
    let sends = 0;
    const hop = stubHop({
        admissions: (call) => { sends += 1; return sends === 1 ? { outcome: 'unknown', status: 502 } : accepted(call.body.originRequestId); },
        lookup: response(404, { error: 'not_found' }),
    });
    const { coordinator } = await coordinatorFor(t, { store, hop });
    const result = await coordinator.admitTurn(coordinator.evidenceFor(normalizeWebchatMessage(mint())), turnRequest());
    const [row] = store.rows();
    assert.deepEqual(result, { status: 503, body: { error: 'worker_reply_unknown', originRequestId: row.origin_request_id } });
    assert.equal(row.state, 'unknown', 'an unknown turn outcome is recorded unknown, not refused');
    const open = normalizeWebchatMessage(runtimeOpen());
    await coordinator.onEnvelope(open).done;
    assert.deepEqual(hop.calls.map(({ operation }) => operation), ['admissions', 'lookup', 'admissions']);
    assert.equal(hop.calls[2].text, row.admission_body, 'the stored turn bytes are retransmitted unchanged');
    assert.equal(hop.calls[2].body.kind, 'turn');
    assert.equal(hop.calls[2].grant, coordinator.evidenceFor(open).grant, 'with the current envelope grant');
    assert.equal(store.get(row.origin_request_id).state, 'admitted');
    const refusals = {
        'session robot conflict': [response(409, { error: 'operation_conflict' }), 'operation_conflict', 409],
        'default runtime': [response(503, { error: 'runtime_unavailable' }), 'runtime_unavailable', 503],
        'marked 502': [response(502, {}, { stage: 'relay', cause: 'relay-busy' }), 'worker_route_unavailable', 503],
        unsent: [{ outcome: 'unsent' }, 'worker_unreachable', 503],
    };
    for (const [name, [outcome, code, status]] of Object.entries(refusals)) {
        const refusedStore = await storeFor(t);
        const refusedHop = stubHop({ admissions: outcome });
        const { coordinator: other } = await coordinatorFor(t, { store: refusedStore, hop: refusedHop });
        assert.deepEqual(await other.admitTurn(other.evidenceFor(normalizeWebchatMessage(mint())), turnRequest()), { status, body: { error: code } }, name);
        assert.equal(refusedStore.rows()[0].state, 'refused', name);
        await other.onEnvelope(normalizeWebchatMessage(mint())).done;
        assert.equal(refusedHop.calls.length, 1, `${name}: a refused turn is never retried`);
    }
});

test('lost turn reply across runtimes: a new runtime\'s runtime-open recovers the turn with one lookup and the same reference', async (t) => {
    const store = await storeFor(t);
    const first = await coordinatorFor(t, { store, hop: stubHop({ admissions: { outcome: 'unknown', status: 504 } }) });
    await first.coordinator.admitTurn(first.coordinator.evidenceFor(normalizeWebchatMessage(mint())), turnRequest());
    const [row] = store.rows();
    const second = await coordinatorFor(t, { store, hop: stubHop({ lookup: (call) => response(200, { taskRef: taskRef(), state: 'queued', originRequestId: call.body.originRequestId }) }) });
    await second.coordinator.onEnvelope(normalizeWebchatMessage(runtimeOpen())).done;
    assert.deepEqual(second.hop.calls.map(({ operation }) => operation), ['lookup']);
    assert.equal(second.hop.calls[0].body.originRequestId, row.origin_request_id);
    assert.equal(store.get(row.origin_request_id).state, 'admitted');
    assert.deepEqual(JSON.parse(store.get(row.origin_request_id).task_ref), taskRef());
});

test('a terminal turn read deletes the row, including paused and human-input; a running turn is kept', async (t) => {
    for (const state of ['completed', 'failed', 'cancelled', 'interrupted', 'paused', 'human-input']) {
        const store = await storeFor(t);
        let current = 'running';
        const hop = stubHop({ read: () => response(200, { taskRef: taskRef(), state: current }) });
        const { coordinator } = await coordinatorFor(t, { store, hop });
        await coordinator.admitTurn(coordinator.evidenceFor(normalizeWebchatMessage(mint())), turnRequest());
        await coordinator.onEnvelope(normalizeWebchatMessage(mint())).done;
        assert.equal(store.rows().length, 1, `${state}: a running turn is kept`);
        current = state;
        await coordinator.onEnvelope(normalizeWebchatMessage(mint())).done;
        assert.equal(store.rows().length, 0, `${state}: the terminal read deleted the row`);
    }
});

test('the dispatcher never calls admitTurn or admit, and its source does not name admitTurn', async (t) => {
    const source = await fs.readFile(RUNTIME_SOURCE, 'utf8');
    assert.equal(/admitTurn/u.test(source), false, 'webchatRuntime.mjs does not reference admitTurn');
    const workingDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wt-dispatch-'));
    t.after(() => fs.rm(workingDir, { recursive: true, force: true }));
    const calls = [];
    const { coordinator: real } = await coordinatorFor(t, { hop: stubHop({ lookup: response(503, { error: 'runtime_unavailable' }) }) });
    const coordinator = {
        evidenceFor: (message) => real.evidenceFor(message),
        onEnvelope: (message) => { calls.push('onEnvelope'); return real.onEnvelope(message); },
        reattach: (evidence) => real.reattach(evidence),
        admit: async () => { calls.push('admit'); return { status: 500, body: { error: 'unexpected' } }; },
        admitTurn: async () => { calls.push('admitTurn'); return { status: 500, body: { error: 'unexpected' } }; },
        control: async () => { calls.push('control'); return { status: 500, body: { error: 'unexpected' } }; },
        close: () => {},
    };
    const turns = [];
    const runtime = { workingDir,
        livePublisher: { claimOwner: () => ({ claimId: 'c' }), releaseOwner: () => {} },
        sessionStore: { ensureCurrentSession: async () => ({ sessionId: 's', messages: [] }), loadSession: () => ({}) },
        engine: { getModel: async () => ({ backend: 'codex', model: null }), executeTurn: async () => { turns.push('turn'); return { outputText: 'x' }; } },
        historyManager: { add: async () => {} }, skillCatalog: { getSkills: () => [] }, settings: {} };
    const dispatcher = createWebchatDispatcher(runtime, { write: () => {}, coordinator });
    t.after(() => dispatcher.cancel());
    dispatcher.receive(runtimeOpen());
    dispatcher.receive(mint({ envelope: { text: 'Do the work' } }));
    await dispatcher.drain();
    assert.deepEqual(calls.filter((name) => name !== 'onEnvelope'), [], 'the dispatcher never calls admitTurn, admit or control');
    assert.deepEqual(calls, ['onEnvelope', 'onEnvelope']);
    assert.deepEqual(turns, ['turn'], 'the ordinary message still takes the unchanged local turn path');
});

test('follow-up batch: recovery rows are selected first, admitted rows are bounded by followBatch', async (t) => {
    let clock = 1_000;
    const store = await storeFor(t, { now: () => clock, limits: { reattachBatch: 2, followBatch: 3 } });
    // Admitted rows are older than every recovery row, so a single oldest-first batch would hold only admitted rows.
    const admitted = Array.from({ length: 5 }, () => { clock += 1; return seedAdmitted(store); });
    clock = 2_000;
    const unknown = Array.from({ length: 4 }, () => { clock += 1; return seedUnknown(store); });
    const rows = store.candidates('user:user-alice');
    assert.deepEqual(rows.map((row) => row.state), ['unknown', 'unknown', 'admitted', 'admitted', 'admitted']);
    assert.deepEqual(rows.slice(0, 2).map((row) => row.origin_request_id), unknown.slice(0, 2), 'oldest recovery rows first');
    assert.deepEqual(rows.slice(2).map((row) => row.origin_request_id), admitted.slice(0, 3).map((row) => row.originRequestId), 'oldest admitted rows next');
    assert.deepEqual(store.candidates('user:user-victor'), [], 'another user\'s candidates are empty');
    const hop = stubHop({ lookup: response(503, { error: 'runtime_unavailable' }), read: response(200, { state: 'running' }) });
    const { coordinator } = await coordinatorFor(t, { store, hop });
    clock = 3_000;
    const seen = await coordinator.onEnvelope(normalizeWebchatMessage(mint())).done;
    assert.deepEqual(seen, { attempted: 5 });
    assert.deepEqual(hop.calls.map((call) => (isRead(call) ? 'read' : call.operation)), ['lookup', 'lookup', 'read', 'read', 'read']);
});

test('rotation: 20 running admitted rows are all read across two envelopes because kept rows are re-stamped', async (t) => {
    let clock = 1_000;
    const store = await storeFor(t, { now: () => clock });
    const seeded = Array.from({ length: 20 }, () => { clock += 1; return seedAdmitted(store); });
    const hop = stubHop({ read: response(200, { state: 'running' }) });
    const { coordinator } = await coordinatorFor(t, { store, hop });
    clock = 5_000;
    assert.deepEqual(await coordinator.onEnvelope(normalizeWebchatMessage(mint())).done, { attempted: 16 }, 'followBatch defaults to 16');
    clock = 5_001;
    assert.deepEqual(await coordinator.onEnvelope(normalizeWebchatMessage(mint())).done, { attempted: 16 });
    const read = new Set(hop.calls.filter(isRead).map(readId));
    assert.equal(read.size, 20, 'every admitted row was read within two envelopes');
    assert.ok(seeded.every(({ id }) => read.has(id)));
    assert.equal(store.rows().length, 20, 'running rows are kept');
});

test('touch is a compare-and-set: it re-stamps only an unchanged admitted row', async (t) => {
    let clock = 1_000;
    const store = await storeFor(t, { now: () => clock });
    const { originRequestId } = seedAdmitted(store);
    const row = store.get(originRequestId);
    clock = 900;
    assert.equal(store.touch(row), true);
    assert.equal(store.get(originRequestId).updated_at, row.updated_at + 1, 'a clock behind the row still moves it forward');
    assert.equal(store.touch(row), false, 'a stale read does not re-stamp');
    clock = 5_000;
    assert.equal(store.touch(store.get(originRequestId)), true);
    assert.equal(store.get(originRequestId).updated_at, 5_000);
    const unknown = store.get(seedUnknown(store));
    assert.equal(store.touch(unknown), false, 'only admitted rows are re-stamped');
    assert.equal(store.get(unknown.origin_request_id).updated_at, unknown.updated_at);
    store.remove(originRequestId, 'admitted');
    assert.equal(store.touch({ ...row, updated_at: 5_000 }), false, 'a removed row is left alone');
});

test('concurrent follow-ups: two runtimes that read the same admitted rows re-stamp each row once (compare-and-set)', async (t) => {
    const store = await storeFor(t);
    const seeded = Array.from({ length: 5 }, () => seedAdmitted(store));
    const second = new WebchatOriginStore({ file: store.file });
    t.after(() => second.close());
    const touches = [];
    for (const [name, instance] of [['a', store], ['b', second]]) {
        const touch = instance.touch.bind(instance);
        instance.touch = (row) => { const won = touch(row); touches.push({ name, origin: row.origin_request_id, won }); return won; };
    }
    // The barrier holds both runtimes' first read until both have read their rows (E-M1).
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let pending = 0;
    const barrierHop = () => stubHop({ read: async () => {
        pending += 1;
        if (pending === 2) release();
        await gate;
        return response(200, { state: 'running' });
    } });
    const a = await coordinatorFor(t, { store, hop: barrierHop() });
    const b = await coordinatorFor(t, { store: second, hop: barrierHop() });
    const [ra, rb] = await Promise.all([a.coordinator.onEnvelope(normalizeWebchatMessage(runtimeOpen({ tabId: 'tab_a' }))).done,
        b.coordinator.onEnvelope(normalizeWebchatMessage(runtimeOpen({ tabId: 'tab_b' }))).done]);
    assert.deepEqual([ra.attempted, rb.attempted], [5, 5], 'both runtimes read every row');
    assert.equal(touches.length, 10);
    for (const { originRequestId } of seeded) {
        assert.equal(touches.filter((entry) => entry.origin === originRequestId && entry.won).length, 1, 'each row is re-stamped exactly once');
    }
});

test('D6-6: the shim reads no reference outside the user\'s own origin rows and exposes no read surface', async (t) => {
    const store = await storeFor(t);
    // V owns a generation observation reference; U owns one execution reference.
    const victorGeneration = seedAdmitted(store, { principal: 'user:user-victor' });
    const aliceOwn = seedAdmitted(store, { principal: 'user:user-alice' });
    const victorStamp = store.get(victorGeneration.originRequestId).updated_at;
    const hop = stubHop({ read: response(200, { state: 'running' }) });
    const { coordinator } = await coordinatorFor(t, { store, hop });
    assert.deepEqual(Object.keys(coordinator).sort(), ['admit', 'admitTurn', 'close', 'control', 'evidenceFor', 'onEnvelope', 'reattach'],
        'no read or events operation is exposed to a WebChat caller');
    await coordinator.onEnvelope(normalizeWebchatMessage(mint())).done;
    await coordinator.onEnvelope(normalizeWebchatMessage(runtimeOpen())).done;
    const reads = hop.calls.filter(isRead).map(readId);
    assert.equal(reads.includes(victorGeneration.id), false, 'U\'s envelopes never read V\'s generation reference');
    assert.deepEqual([...new Set(reads)], [aliceOwn.id], 'only the reference in U\'s own origin row is read');
    assert.ok(hop.calls.every((call) => !call.operation.endsWith('/events')), 'no events read is forwarded');
    const victorRow = store.get(victorGeneration.originRequestId);
    assert.equal(victorRow.state, 'admitted', 'V\'s row is untouched');
    assert.equal(victorRow.updated_at, victorStamp, 'V\'s row is not re-stamped by U\'s reattach');
});
