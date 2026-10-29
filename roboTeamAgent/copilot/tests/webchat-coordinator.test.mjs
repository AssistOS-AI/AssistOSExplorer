import test from 'node:test';
import './helpers/isolated-ala-home.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createWebchatCoordinator, loadWebchatVerifier, WEBCHAT_RUNTIME_OPEN_EVENT } from '../src/lib/webchat/webchatCoordinator.mjs';
import { MANIFEST_RUNTIME_SCOPE, normalizeWebchatMessage, webchatSignedArgs } from '../src/lib/webchat/webchatEnvelope.mjs';
import { createWebchatDispatcher } from '../src/lib/webchat/webchatRuntime.mjs';
import { WebchatOriginStore } from '../../server/worker-coordinator/webchat-origins.mjs';
import { newOriginId } from '../../server/worker-coordinator/identities.mjs';

// The WebChat row of the worker coordinator with envelopes minted by the sibling Ploinky
// checkout's real Router path (S3a serializer, runtime-open announcer and MCP invocation
// minter) for RoboTeam's real manifest, verified by the real Agent verifier. The hop is a
// recording stub; the origin store is a real SQLite file. No Linux facility is used.
const PLOINKY_ROOT = fileURLToPath(new URL('../../../../ploinky/', import.meta.url));
const MANIFEST_FILE = fileURLToPath(new URL('../../manifest.json', import.meta.url));
const AUDIENCE = 'agent:AchillesIDE/roboTeamAgent';
const savedEnv = { ...process.env };
const savedCwd = process.cwd();
const routerRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'wc-router-')));
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
    'routing.json': { routes: { roboTeamAgent: { repo: 'AchillesIDE', agent: 'roboTeamAgent', container: 'wc-router', hostPath: fixtureAgent, hostPort: 7402 } } },
    'agents.json': { 'wc-router': { type: 'agent', repoName: 'AchillesIDE', agentName: 'roboTeamAgent', instanceId: 'wc-router', enableGeneration: 'wc-router', auth: { mode: 'none' } } },
    'data/edge-routing/desired.json': { hosts: {} },
    'data/router-security/policy-state.json': { schema: 'router-policy', httpRoutes: [], mcpTools: [] },
})) {
    const file = path.join(routerRoot, '.ploinky', name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(value), { mode: 0o600 });
}
const { applyEdgeRoutingGeneration } = await load('cli/sandbox/edgeGeneration.js');
applyEdgeRoutingGeneration({ workspaceRoot: routerRoot, reason: 'webchat-coordinator-test' });
const { serializeWebchatEnvelopeForAgent, serializeWebchatRuntimeOpenEnvelope, buildWebchatInvocationArgs, shouldAnnounceWebchatRuntimeOpen } = await load('cli/server/handlers/webchat/messageEnvelope.js');
const { deriveAgentRequestSecret } = await load('cli/utils/security/masterKey.js');
const { extractManifestWebchatOptions } = await load('cli/server/webchat/commandResolver.js');
const AGENT_ENV = Object.freeze({ PLOINKY_AGENT_RUNTIME_ROOT: path.join(PLOINKY_ROOT, 'Agent'), PLOINKY_AGENT_ID: AUDIENCE,
    PLOINKY_AGENT_SECRET: deriveAgentRequestSecret(AUDIENCE, { encoding: 'hex' }) });

test.after(async () => {
    process.chdir(savedCwd);
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    await fs.rm(routerRoot, { recursive: true, force: true });
});

// The effective config a principal-scoped Router derives from RoboTeam's manifest.
const PRINCIPAL = Object.freeze({ agentName: 'roboTeamAgent', forwardEnvelope: true, runtimeScope: 'principal' });
const SHARED = Object.freeze({ agentName: 'roboTeamAgent', forwardEnvelope: true });
const U = { id: 'user-alice', roles: ['user'] };
const V = { id: 'user-victor', roles: ['admin'] };
const requestFor = (user) => ({ headers: { host: 'localhost' }, socket: {}, user, authMode: 'sso' });
const mint = ({ user = U, config = PRINCIPAL, tabId = 'tab_u', pageInstanceId = 'page_u', envelope = {} } = {}) => serializeWebchatEnvelopeForAgent({
    req: requestFor(user), effectiveConfig: config, tabId, pageInstanceId,
    envelope: { text: 'Hello', attachments: [], references: [], presentation: { visible: true }, ...envelope } });
const runtimeOpen = ({ user = U, config = PRINCIPAL, tabId = 'tab_u' } = {}) => serializeWebchatRuntimeOpenEnvelope({ req: requestFor(user), effectiveConfig: config, tabId, pageInstanceId: 'page_u' });
const edit = (line, change) => { const parsed = JSON.parse(line); change(parsed); return JSON.stringify(parsed); };
const TASK_REF = { version: 1, provider: 'agent:AchillesIDE/robo-work', id: 'K'.repeat(22) };
const accepted = (originRequestId) => ({ outcome: 'response', status: 200, json: { taskRef: TASK_REF, state: 'queued', originRequestId }, refusal: null });
const response = (status, json = {}, refusal = null) => ({ outcome: 'response', status, json, refusal });

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
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wc-origins-'));
    const store = new WebchatOriginStore({ file: path.join(dir, 'worker-coordinator', 'webchat-origins.sqlite'), ...options });
    t.after(async () => { store.close(); await fs.rm(dir, { recursive: true, force: true }); });
    return store;
}

async function coordinatorFor(t, { hop = stubHop(), store, logs = [], verifierEnv = AGENT_ENV } = {}) {
    const verifier = await loadWebchatVerifier(verifierEnv);
    assert.equal(typeof verifier, 'function');
    const coordinator = createWebchatCoordinator({ hop, store: store || await storeFor(t), verifier, log: (event) => logs.push(event) });
    return { coordinator, hop, logs };
}

const SPEC = Object.freeze({ version: 1, taskType: 'simple', prompt: 'SYNTHETIC transport-only task' });
const admitRequest = (extra = {}) => ({ conversationId: '00000000-0000-4000-8000-000000000001', robotId: newOriginId(), configRevision: 1, kind: 'task', specification: SPEC, ...extra });

test('event reconstruction: a genuine runtime-open verifies; adding, removing or altering event fails with zero hops', async (t) => {
    const store = await storeFor(t);
    // A row the user owns, so any verified envelope with a grant would make a hop.
    store.insertPersisted({ originRequestId: newOriginId(), principal: 'user:user-alice', tabId: 't', conversationId: 'c', digest: 'd', body: '{}' });
    store.settle(store.rows()[0].origin_request_id, 'unknown', ['persisted']);
    const { coordinator, hop } = await coordinatorFor(t, { store, hop: stubHop({ lookup: response(404, { error: 'not_found' }), admissions: response(400, { error: 'invalid_request' }) }) });
    assert.equal(shouldAnnounceWebchatRuntimeOpen({ ...PRINCIPAL, agentName: 'roboTeamAgent' }), true, 'the real manifest makes the Router announce runtime-open');
    const tampered = {
        'event added to an ordinary envelope': edit(mint(), (p) => { p.event = WEBCHAT_RUNTIME_OPEN_EVENT; }),
        'event removed from runtime-open': edit(runtimeOpen(), (p) => { delete p.event; }),
        'event value altered': edit(runtimeOpen(), (p) => { p.event = 'runtime-close'; }),
        'empty event added': edit(mint(), (p) => { p.event = ''; }),
    };
    for (const [name, line] of Object.entries(tampered)) {
        const seen = coordinator.onEnvelope(normalizeWebchatMessage(line));
        assert.equal(seen.event, '', name);
        await seen.done;
        assert.equal(coordinator.evidenceFor(normalizeWebchatMessage(line)).ok, false, name);
    }
    assert.equal(hop.calls.length, 0, 'no tampered envelope made a hop');
    const genuine = normalizeWebchatMessage(runtimeOpen());
    const evidence = coordinator.evidenceFor(genuine);
    assert.equal(evidence.ok, true);
    assert.equal(evidence.event, WEBCHAT_RUNTIME_OPEN_EVENT);
    assert.equal(evidence.principal, 'user:user-alice');
    assert.equal(JSON.parse(Buffer.from(evidence.grant.split('.')[1], 'base64url')).sub, 'user:user-alice');
    const seen = coordinator.onEnvelope(genuine);
    assert.equal(seen.event, WEBCHAT_RUNTIME_OPEN_EVENT);
    assert.deepEqual(await seen.done, { attempted: 1 });
    assert.equal(hop.calls[0].operation, 'lookup', 'the verified runtime-open reattached the row');
    assert.equal(hop.calls[0].grant, evidence.grant);
});

test('E12 agreement: principal-minted envelopes verify and match Ploinky\'s signed arguments; shared-minted ones fail', async (t) => {
    const { coordinator, hop } = await coordinatorFor(t);
    const variants = {
        ordinary: { line: () => mint() },
        hidden: { line: () => mint({ envelope: { text: '/tasks', presentation: { visible: false } } }) },
        references: { line: () => mint({ envelope: { references: [{ kind: 'workspace-path', path: 'docs/a.md', type: 'file', label: 'A' }] } }) },
        runtimeOpen: { line: () => runtimeOpen(), event: WEBCHAT_RUNTIME_OPEN_EVENT },
    };
    for (const [name, { line, event = '' }] of Object.entries(variants)) {
        const raw = line();
        const payload = JSON.parse(raw);
        const message = normalizeWebchatMessage(raw);
        assert.deepEqual(message.signedArgs, buildWebchatInvocationArgs({ effectiveConfig: PRINCIPAL, tabId: payload.sourceTabId,
            pageInstanceId: payload.sourcePageInstanceId, envelope: payload, event }), name);
        assert.equal(coordinator.evidenceFor(message).ok, true, name);
        assert.equal(typeof coordinator.evidenceFor(message).grant, 'string', `${name} carries the grant`);
        const shared = normalizeWebchatMessage(name === 'runtimeOpen' ? runtimeOpen({ config: SHARED }) : mint({ config: SHARED, envelope: JSON.parse(raw) }));
        assert.equal(coordinator.evidenceFor(shared).ok, false, `${name} minted by a shared-scope Router`);
    }
    // A payload field cannot select the scope.
    const forged = edit(mint(), (p) => { p.runtimeScope = 'shared'; });
    assert.deepEqual(normalizeWebchatMessage(forged).signedArgs, webchatSignedArgs(JSON.parse(forged)));
    assert.equal(normalizeWebchatMessage(forged).signedArgs.runtimeScope, 'principal');
    assert.equal(coordinator.evidenceFor(normalizeWebchatMessage(forged)).ok, true);
    assert.equal(webchatSignedArgs({}, { runtimeScope: null }).runtimeScope, undefined, 'an unknown scope adds nothing (fail closed)');
    assert.equal(hop.calls.length, 0);
});

test('single source: the shim scope is RoboTeam\'s manifest value as Ploinky reads it', async () => {
    const manifest = JSON.parse(await fs.readFile(MANIFEST_FILE, 'utf8'));
    assert.equal(MANIFEST_RUNTIME_SCOPE, 'principal');
    assert.equal(extractManifestWebchatOptions(manifest).runtimeScope, MANIFEST_RUNTIME_SCOPE);
});

test('the dispatcher sends runtime-open to the coordinator only: no turn, output or owner claim', async (t) => {
    const workingDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wc-dispatch-'));
    t.after(() => fs.rm(workingDir, { recursive: true, force: true }));
    const events = [];
    const output = [];
    const { coordinator: real } = await coordinatorFor(t, { hop: stubHop({ lookup: response(503, { error: 'runtime_unavailable' }) }) });
    const coordinator = { onEnvelope: (message) => { events.push(['onEnvelope', message.event]); return real.onEnvelope(message); } };
    const runtime = { workingDir,
        livePublisher: { claimOwner: () => { events.push(['claim']); return { claimId: 'c' }; }, releaseOwner: () => {} },
        sessionStore: { ensureCurrentSession: async () => { events.push(['session']); return { sessionId: 's', messages: [] }; }, loadSession: () => ({}) },
        engine: { getModel: async () => ({ backend: 'codex', model: null }), executeTurn: async () => { events.push(['turn']); return { outputText: 'x' }; } },
        historyManager: { add: async () => {} }, skillCatalog: { getSkills: () => [] }, settings: {} };
    const dispatcher = createWebchatDispatcher(runtime, { write: (value) => output.push(value), coordinator });
    t.after(() => dispatcher.cancel());
    dispatcher.receive(runtimeOpen());
    await dispatcher.drain();
    assert.deepEqual(events, [['onEnvelope', WEBCHAT_RUNTIME_OPEN_EVENT]]);
    assert.deepEqual(output, []);
    // An ordinary message still takes the unchanged turn path, after the coordinator saw it.
    dispatcher.receive(mint({ envelope: { text: 'Do the work' } }));
    await dispatcher.drain();
    assert.deepEqual(events.map(([kind]) => kind), ['onEnvelope', 'onEnvelope', 'claim', 'session', 'turn']);
});

test('process principal pin: a second user\'s verified envelope makes zero hops and is logged', async (t) => {
    const store = await storeFor(t);
    store.insertPersisted({ originRequestId: newOriginId(), principal: 'user:user-victor', tabId: 't', conversationId: 'c', digest: 'd', body: '{}' });
    store.settle(store.rows()[0].origin_request_id, 'unknown', ['persisted']);
    const logs = [];
    const { coordinator, hop } = await coordinatorFor(t, { store, logs });
    await coordinator.onEnvelope(normalizeWebchatMessage(runtimeOpen({ user: U }))).done;
    const victor = normalizeWebchatMessage(mint({ user: V, tabId: 'tab_v' }));
    const seen = coordinator.onEnvelope(victor);
    assert.deepEqual(await seen.done, { attempted: 0 });
    assert.equal(hop.calls.length, 0);
    assert.deepEqual(coordinator.evidenceFor(victor), { ok: false, code: 'runtime_principal_mismatch' });
    assert.ok(logs.includes('webchat.coordinator.runtime_principal_mismatch'));
    assert.equal((await coordinator.admit(coordinator.evidenceFor(victor), admitRequest())).body.error, 'owner_evidence_unavailable');
});

test('operator and unverified callers: admit refuses with owner_evidence_unavailable, storing and sending nothing', async (t) => {
    const store = await storeFor(t);
    const { coordinator, hop } = await coordinatorFor(t, { store });
    const refused = { status: 403, body: { error: 'owner_evidence_unavailable' } };
    assert.deepEqual(await coordinator.admit(null, admitRequest()), refused);
    assert.deepEqual(await coordinator.admit({ ok: true, principal: 'user:user-alice', grant: null }, admitRequest()), refused);
    assert.deepEqual(await coordinator.admit(coordinator.evidenceFor(normalizeWebchatMessage('plain operator text')), admitRequest()), refused);
    const guest = normalizeWebchatMessage(mint({ user: { id: 'guest:abc', roles: ['guest'] } }));
    assert.equal(coordinator.evidenceFor(guest).ok, false);
    assert.deepEqual(await coordinator.admit(coordinator.evidenceFor(guest), admitRequest()), refused);
    const truncated = normalizeWebchatMessage(edit(mint(), (p) => { p.invocation.token = p.invocation.token.slice(0, -4); }));
    assert.deepEqual(await coordinator.admit(coordinator.evidenceFor(truncated), admitRequest()), refused);
    const { coordinator: otherAudience } = await coordinatorFor(t, { store, verifierEnv: { ...AGENT_ENV, PLOINKY_AGENT_ID: 'agent:AchillesIDE/explorer' } });
    assert.deepEqual(await otherAudience.admit(otherAudience.evidenceFor(normalizeWebchatMessage(mint())), admitRequest()), refused);
    const noVerifier = createWebchatCoordinator({ hop, store, verifier: null });
    assert.deepEqual(await noVerifier.admit(noVerifier.evidenceFor(normalizeWebchatMessage(mint())), admitRequest()), refused);
    assert.deepEqual(await coordinator.control(null, TASK_REF, { operationId: 'O'.repeat(22), op: 'stop' }), refused);
    assert.equal(store.rows().length, 0);
    assert.equal(hop.calls.length, 0);
});

test('admit persists the origin before transmission and records the reference; one verification per message', async (t) => {
    const store = await storeFor(t);
    const hop = stubHop({ admissions: (call) => {
        const row = store.get(call.body.originRequestId);
        assert.equal(row.state, 'persisted', 'the row exists before the first transmission');
        assert.equal(row.admission_body, call.text);
        assert.equal(row.user_principal, 'user:user-alice');
        return accepted(call.body.originRequestId);
    } });
    const { coordinator } = await coordinatorFor(t, { store, hop });
    const message = normalizeWebchatMessage(mint());
    coordinator.onEnvelope(message);
    const evidence = coordinator.evidenceFor(message);
    assert.equal(evidence.ok, true, 'the cached evidence is reused, not re-verified against the replay cache');
    const result = await coordinator.admit(evidence, admitRequest({ kind: 'continuation', logicalId: newOriginId() }));
    assert.equal(result.status, 200);
    const [row] = store.rows();
    assert.equal(row.state, 'admitted');
    assert.deepEqual(JSON.parse(row.task_ref), TASK_REF);
    assert.equal(row.tab_id, 'tab_u');
    assert.equal(row.admission_body.includes(evidence.grant), false, 'no grant is stored');
    assert.equal(JSON.stringify(row).includes('invocation'), false);
    assert.equal(hop.calls[0].grant, evidence.grant);
    assert.deepEqual(Object.keys(hop.calls[0].body), ['originRequestId', 'robotId', 'configRevision', 'kind', 'specification', 'logical']);
    assert.equal((await coordinator.admit(evidence, admitRequest({ kind: 'session' }))).body.error, 'logical_kind_unavailable');
    assert.equal((await coordinator.admit(evidence, admitRequest({ owner: 'x' }))).body.error, 'invalid_request');
    assert.equal(store.rows().length, 1);
});

test('F1: an unmarked 502 or 504 leaves the row unknown and the next envelope reattaches it; refusals settle as refused', async (t) => {
    for (const status of [502, 504]) {
        const store = await storeFor(t);
        const hop = stubHop({ admissions: { outcome: 'unknown', status }, lookup: (call) => accepted(call.body.originRequestId) });
        const { coordinator } = await coordinatorFor(t, { store, hop });
        const result = await coordinator.admit(coordinator.evidenceFor(normalizeWebchatMessage(mint())), admitRequest());
        const [row] = store.rows();
        assert.deepEqual(result, { status: 503, body: { error: 'worker_reply_unknown', originRequestId: row.origin_request_id } }, String(status));
        assert.equal(row.state, 'unknown');
        await coordinator.onEnvelope(normalizeWebchatMessage(mint())).done;
        assert.deepEqual(hop.calls.map(({ operation }) => operation), ['admissions', 'lookup']);
        assert.equal(store.get(row.origin_request_id).state, 'admitted');
    }
    const refusals = {
        'marked 502': [response(502, {}, { stage: 'relay', cause: 'relay-busy' }), 'worker_route_unavailable'],
        'worker 503': [response(503, { error: 'runtime_unavailable' }), 'runtime_unavailable'],
        'worker 500': [response(500, { error: 'state_corrupt' }), 'state_corrupt'],
        'worker 404': [response(404, { error: 'not_found' }), 'not_found'],
        'worker 403': [response(403, { error: 'forbidden' }), 'forbidden'],
        unsent: [{ outcome: 'unsent' }, 'worker_unreachable'],
    };
    for (const [name, [outcome, code]] of Object.entries(refusals)) {
        const store = await storeFor(t);
        const hop = stubHop({ admissions: outcome });
        const { coordinator } = await coordinatorFor(t, { store, hop });
        const result = await coordinator.admit(coordinator.evidenceFor(normalizeWebchatMessage(mint())), admitRequest());
        assert.equal(result.body.error, code, name);
        assert.equal(store.rows()[0].state, 'refused', name);
        assert.equal(store.rows()[0].error, code, name);
        await coordinator.onEnvelope(normalizeWebchatMessage(mint())).done;
        assert.equal(hop.calls.length, 1, `${name}: a refused row is never looked up again`);
    }
});

test('lost reply across runtimes: a new runtime\'s runtime-open recovers U\'s row; V\'s runtime-open reattaches none of U\'s rows', async (t) => {
    const store = await storeFor(t);
    const first = await coordinatorFor(t, { store, hop: stubHop({ admissions: { outcome: 'unknown', status: 502 } }) });
    await first.coordinator.admit(first.coordinator.evidenceFor(normalizeWebchatMessage(mint())), admitRequest());
    const [row] = store.rows();
    assert.equal(row.state, 'unknown');
    const victor = await coordinatorFor(t, { store, hop: stubHop() });
    await victor.coordinator.onEnvelope(normalizeWebchatMessage(runtimeOpen({ user: V, tabId: 'tab_v' }))).done;
    assert.equal(victor.hop.calls.length, 0, 'V reattaches none of U\'s rows');
    // The worker never saw the admission: lookup 404, then the stored bytes are sent again.
    const second = await coordinatorFor(t, { store, hop: stubHop({ lookup: response(404, { error: 'not_found' }) }) });
    const open = normalizeWebchatMessage(runtimeOpen());
    await second.coordinator.onEnvelope(open).done;
    assert.deepEqual(second.hop.calls.map(({ operation }) => operation), ['lookup', 'admissions']);
    assert.equal(second.hop.calls[1].text, row.admission_body, 'the stored bytes are retransmitted unchanged');
    assert.equal(second.hop.calls[1].grant, second.coordinator.evidenceFor(open).grant, 'with the current envelope grant');
    assert.equal(store.get(row.origin_request_id).state, 'admitted');
    assert.deepEqual(JSON.parse(store.get(row.origin_request_id).task_ref), TASK_REF);
});

test('admitted rows are read until terminal, then deleted; failed lookups release the claim', async (t) => {
    const store = await storeFor(t);
    let state = 'running';
    const hop = stubHop({ read: () => response(200, { taskRef: TASK_REF, state }) });
    const { coordinator } = await coordinatorFor(t, { store, hop });
    await coordinator.admit(coordinator.evidenceFor(normalizeWebchatMessage(mint())), admitRequest());
    await coordinator.onEnvelope(normalizeWebchatMessage(mint())).done;
    assert.equal(store.rows()[0].state, 'admitted', 'a running reference is kept');
    assert.equal(hop.calls.at(-1).operation, `references/${TASK_REF.id}/read`);
    state = 'completed';
    await coordinator.onEnvelope(normalizeWebchatMessage(mint())).done;
    assert.equal(store.rows().length, 0, 'a terminal snapshot deletes the row');
    const failing = await coordinatorFor(t, { store, hop: stubHop({ admissions: { outcome: 'unknown' }, lookup: { outcome: 'unknown', status: 504 } }) });
    await failing.coordinator.admit(failing.coordinator.evidenceFor(normalizeWebchatMessage(mint())), admitRequest());
    await failing.coordinator.onEnvelope(normalizeWebchatMessage(mint())).done;
    assert.equal(store.rows()[0].state, 'unknown', 'the claim is released for the next envelope');
});

test('caps: per-user and total in-flight limits refuse without evicting; refused rows do not count', async (t) => {
    const store = await storeFor(t, { limits: { perUser: 2, total: 3 } });
    const hop = stubHop({ admissions: { outcome: 'unknown', status: 502 } });
    const { coordinator } = await coordinatorFor(t, { store, hop });
    const evidence = coordinator.evidenceFor(normalizeWebchatMessage(mint()));
    await coordinator.admit(evidence, admitRequest());
    await coordinator.admit(evidence, admitRequest());
    assert.deepEqual(await coordinator.admit(evidence, admitRequest()), { status: 503, body: { error: 'capacity_exceeded' } });
    assert.equal(hop.calls.length, 2);
    assert.equal(store.rows().length, 2, 'nothing was evicted');
    store.insertPersisted({ originRequestId: newOriginId(), principal: 'user:someone', tabId: 't', conversationId: 'c', digest: 'd', body: '{}' });
    assert.deepEqual(store.insertPersisted({ originRequestId: newOriginId(), principal: 'user:third', tabId: 't', conversationId: 'c', digest: 'd', body: '{}' }),
        { ok: false, code: 'capacity_exceeded' }, 'the total cap');
    for (const row of store.rows().filter((entry) => entry.user_principal === 'user:user-alice')) store.settle(row.origin_request_id, 'refused', ['unknown']);
    hop.calls.length = 0;
    assert.equal((await coordinator.admit(evidence, admitRequest())).body.error, 'worker_reply_unknown', 'refused rows free capacity');
});

test('concurrent reattach: two runtimes of the same user claim each row once (compare-and-set)', async (t) => {
    const store = await storeFor(t);
    const origins = [];
    for (let index = 0; index < 5; index += 1) {
        const originRequestId = newOriginId();
        origins.push(originRequestId);
        store.insertPersisted({ originRequestId, principal: 'user:user-alice', tabId: 't', conversationId: 'c', digest: 'd', body: `{"originRequestId":"${originRequestId}"}` });
        store.settle(originRequestId, 'unknown', ['persisted']);
    }
    // The barrier holds both runtimes' first hops until both have read their rows.
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let pending = 0;
    const lookups = [];
    const barrierHop = () => stubHop({ lookup: async (call) => {
        lookups.push(call.body.originRequestId);
        pending += 1;
        if (pending === 2) release();
        await gate;
        return accepted(call.body.originRequestId);
    } });
    const a = await coordinatorFor(t, { store, hop: barrierHop() });
    const b = await coordinatorFor(t, { store, hop: barrierHop() });
    const [ra, rb] = await Promise.all([a.coordinator.onEnvelope(normalizeWebchatMessage(runtimeOpen({ tabId: 'tab_a' }))).done,
        b.coordinator.onEnvelope(normalizeWebchatMessage(runtimeOpen({ tabId: 'tab_b' }))).done]);
    assert.equal(lookups.length, 5, 'one lookup per row in total');
    assert.deepEqual([...lookups].sort(), [...origins].sort(), 'each row exactly once');
    assert.equal(ra.attempted + rb.attempted, 5);
    assert.ok(ra.attempted > 0 && rb.attempted > 0, 'both runtimes worked concurrently');
    assert.ok(store.rows().every((row) => row.state === 'admitted'));
});

test('eight processes insert into one store concurrently without losing a row', async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wc-origins-multi-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'worker-coordinator', 'webchat-origins.sqlite');
    new WebchatOriginStore({ file }).open();
    const moduleUrl = new URL('../../server/worker-coordinator/webchat-origins.mjs', import.meta.url).href;
    const script = `import { WebchatOriginStore } from ${JSON.stringify(moduleUrl)}; import crypto from 'node:crypto';
        const store = new WebchatOriginStore({ file: process.argv[1], limits: { perUser: 1000, total: 1000 } });
        for (let i = 0; i < 10; i += 1) { const r = store.insertPersisted({ originRequestId: crypto.randomBytes(16).toString('base64url'),
            principal: 'user:p' + process.argv[2], tabId: 't', conversationId: 'c', digest: 'd', body: '{}' }); if (!r.ok) process.exit(3); }
        store.close();`;
    const codes = await Promise.all(Array.from({ length: 8 }, (_, index) => new Promise((resolve) => {
        const child = spawn(process.execPath, ['--input-type=module', '-e', script, file, String(index)], { stdio: ['ignore', 'ignore', 'inherit'] });
        child.on('close', resolve);
    })));
    assert.deepEqual(codes, Array(8).fill(0));
    const store = new WebchatOriginStore({ file });
    t.after(() => store.close());
    assert.equal(store.rows().length, 80);
    assert.equal((fsSync.statSync(file).mode & 0o777), 0o600);
    assert.equal((fsSync.statSync(path.dirname(file)).mode & 0o777), 0o700);
});

test('control relays with the envelope grant; the origin store refuses a symlinked location', async (t) => {
    const hop = stubHop({ control: response(200, { outcome: 'delivered' }) });
    const { coordinator } = await coordinatorFor(t, { hop });
    const evidence = coordinator.evidenceFor(normalizeWebchatMessage(mint()));
    const request = { operationId: 'O'.repeat(22), op: 'message', payload: { text: 'continue' } };
    assert.deepEqual(await coordinator.control(evidence, TASK_REF, request), { status: 200, body: { outcome: 'delivered' } });
    assert.deepEqual(hop.calls[0], { operation: `references/${TASK_REF.id}/control`, text: JSON.stringify(request), body: request, grant: evidence.grant });
    assert.equal((await coordinator.control(evidence, { id: 'short' }, request)).body.error, 'invalid_request');
    assert.equal((await coordinator.control(evidence, TASK_REF, { ...request, extra: 1 })).body.error, 'invalid_request');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wc-origins-link-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    await fs.mkdir(path.join(dir, 'real'));
    await fs.symlink(path.join(dir, 'real'), path.join(dir, 'worker-coordinator'));
    assert.throws(() => new WebchatOriginStore({ file: path.join(dir, 'worker-coordinator', 'webchat-origins.sqlite') }).open(), /Unsafe/);
    const failing = createWebchatCoordinator({ hop, store: new WebchatOriginStore({ file: path.join(dir, 'worker-coordinator', 'x.sqlite') }), verifier: await loadWebchatVerifier(AGENT_ENV) });
    const failingEvidence = failing.evidenceFor(normalizeWebchatMessage(mint()));
    assert.deepEqual(await failing.admit(failingEvidence, admitRequest()), { status: 503, body: { error: 'worker_coordinator_unavailable' } });
    assert.deepEqual(await failing.onEnvelope(normalizeWebchatMessage(mint())).done, { attempted: 0 });
});

test('a WebChat process loads SQLite only when it opens the origin store, and prints no warning', async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wc-origins-lazy-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const runtimeUrl = new URL('../src/lib/webchat/webchatRuntime.mjs', import.meta.url).href;
    const storeUrl = new URL('../../server/worker-coordinator/webchat-origins.mjs', import.meta.url).href;
    const script = `const loaded = () => process.moduleLoadList.some((name) => /sqlite/.test(name));
        await import(${JSON.stringify(runtimeUrl)});
        const { WebchatOriginStore } = await import(${JSON.stringify(storeUrl)});
        const before = loaded();
        const store = new WebchatOriginStore({ file: process.argv[1] });
        store.rows();
        store.close();
        process.stdout.write(JSON.stringify({ before, after: loaded() }));`;
    const result = await new Promise((resolve) => {
        const child = spawn(process.execPath, ['--input-type=module', '-e', script, path.join(dir, 'worker-coordinator', 'origins.sqlite')],
            { cwd: dir, env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, PLOINKY_WORKSPACE_ROOT: dir }, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '', stderr = '';
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { before: false, after: true });
    assert.equal(result.stderr, '', 'nothing reaches the chat through stderr');
});

test('F1 reattach starvation: an unknown row newer than 17 running admitted rows is looked up on the next envelope', async (t) => {
    let clock = 1_000_000;
    const store = await storeFor(t, { now: () => clock });
    const script = { read: response(200, { state: 'running' }) };
    const hop = stubHop(script);
    const { coordinator } = await coordinatorFor(t, { store, hop });
    const evidence = coordinator.evidenceFor(normalizeWebchatMessage(mint()));
    for (let index = 0; index < 17; index += 1) {
        clock += 1;
        assert.equal((await coordinator.admit(evidence, admitRequest())).status, 200, 'F1 precondition: admission accepted');
    }
    clock = 1_005_000;
    script.admissions = { outcome: 'unknown', status: 502 };
    assert.equal((await coordinator.admit(evidence, admitRequest())).body.error, 'worker_reply_unknown', 'F1 precondition: reply unknown');
    const rows = store.rows();
    const admitted = (row) => row.state === 'admitted';
    const unknown = rows.find((row) => row.state === 'unknown');
    assert.ok(unknown, 'F1 precondition: one unknown row');
    assert.equal(rows.filter(admitted).length, 17, 'F1 precondition: 17 admitted rows');
    assert.ok(rows.filter(admitted).every((r) => r.updated_at < unknown.updated_at), 'F1 precondition: unknown row is newest');
    const before = hop.calls.length;
    await coordinator.onEnvelope(normalizeWebchatMessage(mint())).done;
    const lookups = hop.calls.slice(before).filter((call) => call.operation === 'lookup');
    assert.equal(lookups.length, 1, 'F1: the unknown row is looked up');
    assert.equal(lookups[0].body.originRequestId, unknown.origin_request_id);
});
