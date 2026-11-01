import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validateConfig, assertBox, selectAgent, assertNoAgentExec, assertVictimUnchanged,
    assertRefused, assertDualHome, assertDeleted, assertEmptyPrivateListing, assertBrowserOrigin,
    decodeMcpResult, normalizeMcpOutcome, assertNoMarker, sha256 } from './controller/contracts.mjs';
import { BASELINE_REVISION, BASELINE_METHOD, BASELINE_DIRECTORIES, baselineSymlinkControl } from './controller/baseline-control.mjs';
import { runControllerScenario, runVerifiedScenario, dualHome, manifests, otherAgentMasks,
    grantRefusals, symlinkHelpers, safeDelete, workspaceStorage } from './controller-scenarios.mjs';
import { ControllerRuntime } from './controller/runtime.mjs';
import { explorerListing } from './controller/explorer-api.mjs';
import { FREE_MODEL, ProbeRobots, assertFreeConfig } from './controller/robots.mjs';
import { ControllerSession, assertAdminToken, cookieHeader, privateJson, openControllerSession } from './controller/auth-session.mjs';

const hash = 'a'.repeat(64);
const config = () => ({
    engine: 'podman', fixture: '/task/fixture', workspace: '/task/fixture', ploinkyRoot: '/task/ploinky',
    ploinkyRevision: 'a'.repeat(40), box: { id: hash, image: `sha256:${hash}`, startedAt: '2026-11-01T00:00:00Z' },
    rt: 'b'.repeat(64), rw: 'c'.repeat(64), attacker: 'owned-attacker', victim: 'owned-victim',
    sources: ['rt', 'rw', 'ala'].map(role => ({ role, root: `/task/${role}`, revision: 'b'.repeat(40),
        subdir: { rt: 'roboTeamAgent', rw: 'roboWorkAgent', ala: '' }[role], runtimePath: role === 'ala' ? '/opt/ala' : '/code' })),
});

test('config requires immutable distinct containers, exact revisions and all source roles', () => {
    validateConfig(config());
    for (const change of [c => { c.rt = c.rw; }, c => { c.box.id = 'short'; },
        c => { c.sources.pop(); }, c => { c.sources[0].revision = 'main'; },
        c => { c.fixture = '/'; }, c => { c.attacker = c.victim; }]) {
        const value = config(); change(value); assert.throws(() => validateConfig(value));
    }
});

test('wrong fixture, image, exact container and generation cannot satisfy Box proof', () => {
    const c = config();
    const good = { Id: c.box.id, Image: c.box.image, State: { Running: true, StartedAt: c.box.startedAt },
        Mounts: [{ Type: 'bind', Source: c.fixture, Destination: c.workspace }] };
    assertBox(c, good);
    for (const change of [row => { row.Id = 'd'.repeat(64); }, row => { row.Image = 'foreign'; },
        row => { row.State.StartedAt = 'other'; }, row => { row.State.Running = false; },
        row => { row.Mounts[0].Source = '/other/fixture'; }]) {
        const row = structuredClone(good); change(row); assert.throws(() => assertBox(c, row));
    }
});

test('orphan, nonexistent, foreign and ambiguous registry IDs fail', () => {
    const id = config().rt;
    const row = { type: 'agent', agentName: 'roboTeamAgent', repoName: 'AchillesIDE', containerId: id };
    assert.equal(selectAgent({ owned: row }, id, 'roboTeamAgent')[0], 'owned');
    for (const registry of [{}, { owned: { ...row, containerId: hash } },
        { owned: { ...row, repoName: 'foreign' } }, { first: row, second: row }]) {
        assert.throws(() => selectAgent(registry, id, 'roboTeamAgent'));
    }
});

test('manifest negative fixture detects agentExec and empty inventory is never passing', () => {
    assert.equal(assertNoAgentExec([{ name: 'safe', manifest: {} }]).count, 1);
    assert.throws(() => assertNoAgentExec([]));
    assert.throws(() => assertNoAgentExec([{ name: 'bad', manifest: { routerAccess: { agentExec: true } } }]));
    assert.throws(() => assertNoAgentExec([{ name: 'missing' }]));
});

test('victim control detects missing marker, bytes, modes, link and tree mutation', () => {
    const before = { markerHash: hash, treeHash: 'b'.repeat(64), entries: 4 };
    assertVictimUnchanged(before, { ...before });
    assert.throws(() => assertVictimUnchanged({ ...before, markerHash: '' }, { ...before, markerHash: '' }));
    for (const after of [{ ...before, markerHash: 'c'.repeat(64) }, { ...before, treeHash: 'c'.repeat(64) },
        { ...before, entries: 3 }]) assert.throws(() => assertVictimUnchanged(before, after));
});

test('grant rejection must be observed with exact refusal code, never transport error or success', () => {
    assertRefused({ ok: false, code: 'CWD_REFUSED' }, 'CWD_REFUSED');
    assert.throws(() => assertRefused({ ok: true, code: 'CWD_REFUSED' }, 'CWD_REFUSED'));
    assert.throws(() => assertRefused({ ok: false, code: 'TARGET_INACTIVE' }, 'CWD_REFUSED'));
    assert.throws(() => assertRefused(null, 'CWD_REFUSED'));
});

test('dual home requires positive directory identity on both device and inode', () => {
    const stat = { dev: 1, ino: 2, directory: true };
    assertDualHome([stat, { ...stat }]);
    for (const other of [{ ...stat, dev: 2 }, { ...stat, ino: 3 }, { ...stat, directory: false }]) {
        assert.throws(() => assertDualHome([stat, other]));
    }
    assert.throws(() => assertDualHome([]));
});

test('cleanup failure or absent confirmation cannot become successful evidence', () => {
    assertDeleted({ ok: true, result: { deleted: true } });
    for (const result of [null, { ok: false }, { ok: true, result: {} },
        { ok: true, result: { deleted: false } }]) assert.throws(() => assertDeleted(result));
});

test('unfinished scenarios refuse even a supplied fake passing config before any live access', async () => {
    for (const scenario of ['P1', 'E1', 'RA1', 'unknown']) {
        await assert.rejects(runControllerScenario({ pass: true, results: { ok: true } }, scenario),
            error => error.code === 'ACCEPTANCE_PENDING' && !error.sentinel);
    }
});

test('M17 selection uses the exact free route and preserves unavailable CLI observations', () => {
    const selected = { ok: true, codingAgent: 'opencode', models: { opencode: FREE_MODEL }, agents: [{ name: 'opencode', available: false }] };
    assertFreeConfig(selected); assert.equal(selected.agents[0].available, false);
    assert.throws(() => assertFreeConfig({ ...selected, models: { opencode: 'opencode/glm-5.3-flash-free' } }));
    assert.throws(() => assertFreeConfig({ ...selected, codingAgent: 'codex' }));
});

test('M17 normal provisioning records POST then exact model PATCH and GET, with API-only deletion', async () => {
    const calls = [], robots = [{ id: 'default-one', name: 'default' }];
    let created;
    const runtime = { config: config(), node: async (_id, _code, input) => input.id === created?.id
        ? { id: created.id, name: created.name, createdAt: created.createdAt } : true,
    auth: { async roboTeam(method, apiPath, body) {
        calls.push({ method, apiPath, body });
        if (apiPath === 'api/robots' && method === 'GET') return { status: 200, payload: { ok: true, canAdmin: true, robots: structuredClone(robots) } };
        if (apiPath === 'api/robots' && method === 'POST') {
            created = { id: 'generated-probe', name: body.name, createdAt: '2026-11-01T00:00:00Z' }; robots.push(created);
            return { status: 201, payload: { ok: true, robot: created } };
        }
        if (method === 'PATCH') return { status: 200, payload: { ok: true }, proofGeneration: 'actual-proof-generation' };
        if (method === 'GET') return { status: 200, payload: { ok: true, codingAgent: 'opencode', models: { opencode: FREE_MODEL }, agents: [{ available: false }] } };
        if (apiPath === 'api/control') return { status: 200, payload: { ok: true, deleted: created.name } };
        throw Error('Unexpected API call');
    } } };
    const probes = new ProbeRobots(runtime);
    await assert.rejects(probes.remove('foreign-probe')); assert.equal(calls.length, 0);
    const id = await probes.create('owned'); assert.equal(id, 'generated-probe');
    const mutation = calls.find(call => call.method === 'PATCH');
    assert.deepEqual(mutation.body, { codingAgents: ['opencode'], model: FREE_MODEL });
    assert.equal(mutation.apiPath, 'api/robots/generated-probe/coding-agents');
    await probes.remove(id); assert.equal(probes.owned.size, 0);
    assert.ok(calls.some(call => call.apiPath === 'api/control' && call.body.operation === 'robot-delete'));
});

test('M17 normal setup configures the default and victim and failed PATCH retains only its exact owned cleanup target', async () => {
    const selected = { ok: true, codingAgent: 'opencode', models: { opencode: FREE_MODEL } };
    const mutations = [];
    let failPatch = false, created;
    const runtime = { config: config(), async node(_id, body, input) {
        if (body.includes('metadata.json')) return { id: input.id, name: created.name, createdAt: created.createdAt };
        return true;
    }, auth: { async roboTeam(method, route, body) {
        if (method === 'GET' && route === 'api/robots') return { status: 200, payload: { ok: true, canAdmin: true,
            robots: [{ id: 'unit-default', name: 'default' }, { id: config().victim, name: 'victim' }] } };
        if (method === 'PATCH') { mutations.push(route); return { status: failPatch ? 409 : 200, payload: { ok: !failPatch } }; }
        if (method === 'GET') return { status: 200, payload: selected };
        if (route === 'api/robots') {
            created = { id: 'unit-owned-probe', name: body.name, createdAt: '2026-11-01T00:00:00Z' };
            return { status: 201, payload: { ok: true, robot: created } };
        }
        assert.equal(route, 'api/control'); assert.equal(body.robotId, created.id);
        return { status: 200, payload: { ok: true, deleted: created.name } };
    } } };
    const probes = new ProbeRobots(runtime);
    await probes.setup();
    assert.deepEqual(mutations, ['api/robots/unit-default/coding-agents', `api/robots/${config().victim}/coding-agents`]);
    failPatch = true;
    await assert.rejects(probes.create('failed-patch'), /Normal RoboTeam model PATCH failed/u);
    assert.deepEqual([...probes.owned.keys()], [created.id]);
    await probes.cleanup(); assert.equal(probes.owned.size, 0);
});

test('auth refuses guests and stale/wrong-origin cookies and needs owned private credential files', async () => {
    const user = { ok: true, user: { id: 'actual-admin', roles: ['admin'] } };
    assert.match(assertAdminToken(user), /^[a-f0-9]{64}$/u);
    assert.throws(() => assertAdminToken({ ok: true, user: { id: 'guest', roles: ['admin', 'guest'] } }));
    const state = { cookies: [{ name: 'session', value: 'private', domain: '127.0.0.1', path: '/', expires: -1 }] };
    assert.equal(cookieHeader(state, 'http://127.0.0.1:8080'), 'session=private');
    assert.throws(() => cookieHeader(state, 'http://localhost:8080'));
    assert.throws(() => cookieHeader({ cookies: [{ ...state.cookies[0], expires: 1 }] }, 'http://127.0.0.1:8080'));
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'controller-private-input-'));
    try {
        const file = path.join(root, 'account.json'); await fs.writeFile(file, '{}', { mode: 0o644 });
        await assert.rejects(privateJson(file), error => error.code === 'CONTROLLER_PREREQUISITE');
        await fs.chmod(file, 0o600); assert.deepEqual(await privateJson(file), {});
        await fs.symlink(file, path.join(root, 'link.json'));
        await assert.rejects(privateJson(path.join(root, 'link.json')), error => error.code === 'CONTROLLER_PREREQUISITE');
    } finally { await fs.rm(root, { recursive: true }); }
    await assert.rejects(openControllerSession({ config: {} }), error => error.code === 'CONTROLLER_PREREQUISITE');
});

test('fresh mutation proof is route/origin bound and no forwarding/user grant headers are sent', async () => {
    const requests = [];
    const runtime = { receipts: [] };
    const session = new ControllerSession(runtime, 'http://127.0.0.1:8080', async (url, options) => {
        requests.push({ url, options });
        return { status: 200, headers: new Map(), json: async () => ({ browserMutation: {
            csrfToken: 'private-csrf', routeKey: 'roboTeamAgent', origin: 'http://127.0.0.1:8080', generation: 'fresh-generation',
        } }) };
    }, async () => {}, false);
    await session.roboTeam('PATCH', 'api/robots/owned-probe/coding-agents', { codingAgents: ['opencode'], model: FREE_MODEL });
    assert.ok(requests[0].url.endsWith('/auth/token?mutationRoute=roboTeamAgent'));
    assert.equal(requests[1].options.headers.origin, session.origin);
    assert.equal(requests[1].options.headers['x-ploinky-browser-csrf-token'], 'private-csrf');
    assert.equal(requests[1].options.headers['x-ploinky-auth-info'], undefined);
    assert.equal(requests[1].options.headers.authorization, undefined);
    await assert.rejects(session.roboTeam('POST', 'api/arbitrary', {}));
});

test('Explorer private API needs an actual empty listing and never an error or absent payload', () => {
    assertEmptyPrivateListing([]);
    for (const payload of [null, {}, '[]', [{ name: 'roboWorkAgent' }]]) assert.throws(() => assertEmptyPrivateListing(payload));
    assert.deepEqual(decodeMcpResult({ result: { content: [{ type: 'text', text: '[]' }] } }), []);
    for (const body of [{ error: { message: 'denied' } }, { result: { isError: true, content: [{ type: 'text', text: '[]' }] } },
        { result: { content: [] } }]) assert.throws(() => decodeMcpResult(body));
});

test('authenticated API origin must belong to an exact Box published local port', () => {
    const box = { NetworkSettings: { Ports: { '8080/tcp': [{ HostPort: '18080' }] } } };
    assertBrowserOrigin('http://127.0.0.1:18080', box);
    for (const origin of ['http://127.0.0.1:8080', 'http://foreign.example:18080',
        'http://127.0.0.1:18080/other', 'http://user:secret@127.0.0.1:18080']) {
        assert.throws(() => assertBrowserOrigin(origin, box));
    }
});

test('real SDK error wrappers preserve typed tool refusals without treating transport failure as refusal', () => {
    const envelope = { code: 'CWD_REFUSED', error: 'Directory contains protected storage' };
    assertRefused(normalizeMcpOutcome(envelope), 'CWD_REFUSED');
    assertRefused(normalizeMcpOutcome({ isError: true, content: [{ type: 'text', text: JSON.stringify(envelope) }] }), 'CWD_REFUSED');
    assertRefused(normalizeMcpOutcome(null, { code: -32603, message: `MCP error -32603: ${JSON.stringify(envelope)}` }), 'CWD_REFUSED');
    assert.throws(() => assertRefused(normalizeMcpOutcome(null, { code: 'ECONNREFUSED', message: 'unavailable' }), 'CWD_REFUSED'));
    assert.throws(() => assertRefused(normalizeMcpOutcome({ code: 'CWD_REFUSED', ok: true }), 'CWD_REFUSED'));
    assert.throws(() => assertRefused(normalizeMcpOutcome({ isError: true, content: [{ type: 'text', text: 'CWD_REFUSED' }] }), 'CWD_REFUSED'));
});

test('output marker detector catches nested text, object keys and partial-string leaks without printing bytes', () => {
    const marker = 'unique-private-marker'; const digest = sha256(marker);
    assertNoMarker({ content: [{ text: 'safe empty output' }] }, digest, Buffer.byteLength(marker));
    for (const output of [{ content: [{ text: `prefix ${marker} suffix` }] }, { [marker]: true },
        { records: [{ data: Buffer.from(marker).toString('base64') }] }]) {
        assert.throws(() => assertNoMarker(output, digest, Buffer.byteLength(marker)), /Victim marker leaked/u);
    }
    assert.throws(() => assertNoMarker({}, digest, 0));
});

test('identity-only config rejects inline credentials, result overrides and managed source checkouts', () => {
    for (const change of [c => { c.token = 'private'; }, c => { c.pass = true; },
        c => { c.box.environment = {}; }, c => { c.sources[0].root = '/task/.ploinky/repos/AchillesIDE'; },
        c => { c.explorer = { origin: 'http://127.0.0.1:8080', storageState: '/private/state.json', cookies: [] }; }]) {
        const value = config(); change(value); assert.throws(() => validateConfig(value));
    }
    const value = config(); const frozen = validateConfig(value); value.rw = hash;
    assert.notEqual(frozen.rw, value.rw);
});

test('missing MCP result cannot satisfy a successful helper call', () => {
    for (const result of [null, undefined, 'refused', { error: 'untyped error' }]) {
        assert.equal(normalizeMcpOutcome(result).ok, false);
    }
});

function guiFixture({ wrongId = false, wrongSource = false, changedHome = false, residual = false, failed = false } = {}) {
    let active, preparing = true;
    const calls = [];
    const robot = 'new-owned-home';
    const runtime = { config: config(), calls, probes: {
        async create() { calls.push('create'); return robot; },
        async remove(id) { assert.equal(id, robot); calls.push('delete'); },
    }, async mcp(tool, input) {
        if (tool === 'robot_status') {
            assert.deepEqual(input.robotIds, [robot]); calls.push(tool);
            return { ok: true, result: { robots: [{ id: robot, gui: { mode: active.mode, state: failed ? 'failed' : 'running' } }] } };
        }
        assert.equal(input.robotId, robot);
        calls.push(`${tool}:${input.mode || ''}`);
        if (tool === 'run_list') return { ok: true, result: [] };
        if (tool === 'gui_stop') { active = null; return { ok: true, result: { state: 'stopped' } }; }
        assert.equal(tool, 'gui_ensure'); assert.equal(input.allowReplace, false);
        assert.ok(!active || active.mode === input.mode, 'A second GUI was launched before the first stopped.');
        active = { mode: input.mode, id: (input.mode === 'browser' ? 'd' : 'e').repeat(64) };
        if (preparing) { preparing = false; return { ok: true, result: { state: 'starting', mode: input.mode } }; }
        return { ok: true, result: { state: 'running', mode: input.mode } };
    }, async inner(id, args) {
        assert.equal(id, runtime.config.rw);
        if (args[1] === 'ps') {
            calls.push(active ? `discover:${active.mode}` : 'absent');
            return active ? active.id : residual ? 'f'.repeat(64) : '';
        }
        assert.ok(active);
        if (args[1] === 'inspect') return JSON.stringify([{ Id: wrongId ? hash : active.id,
            State: { Running: true }, Config: { Labels: { 'io.assistos.robowork.robot-id': robot,
                'io.assistos.robowork.mode': active.mode, 'io.assistos.robowork.gui': '1' } },
            Mounts: ['/config', `/home/${robot}`].map(Destination => ({ Type: 'bind', Destination,
                Source: wrongSource ? '/data/robots/foreign/home' : `/data/robots/${robot}/home` })),
        }]);
        assert.equal(args[1], 'exec');
        const inode = changedHome && active.mode === 'desktop' ? 3 : 2;
        return `1:${inode}:directory\n1:${inode}:directory\n`;
    } };
    return runtime;
}

test('H2 waits for preparation and checks Browser then Desktop sequentially on one owned home', async () => {
    const runtime = guiFixture(); const evidence = await dualHome(runtime);
    assert.deepEqual(evidence.map(row => row.mode), ['browser', 'desktop']);
    assert.deepEqual(evidence[0].stats, evidence[1].stats);
    assert.ok(runtime.calls.indexOf('absent') < runtime.calls.indexOf('gui_ensure:desktop'));
    assert.equal(runtime.calls.filter(call => call === 'create').length, 1);
    assert.equal(runtime.calls.at(-1), 'delete');
});

test('H2 rejects wrong immutable GUI ID, foreign source, changed persistent inode and residual GUI', async () => {
    for (const options of [{ wrongId: true }, { wrongSource: true }, { changedHome: true }, { residual: true }, { failed: true }]) {
        const runtime = guiFixture(options);
        await assert.rejects(dualHome(runtime));
        assert.equal(runtime.calls.at(-1), 'delete');
        if (options.residual) assert.ok(!runtime.calls.includes('gui_ensure:desktop'));
        if (options.failed) assert.equal(runtime.calls.filter(call => call === 'gui_ensure:browser').length, 1);
    }
});

test('source proof rejects wrong revision, dirty checkout and mismatched runtime bytes', async () => {
    const runtime = new ControllerRuntime(config());
    runtime.command = async () => 'c'.repeat(40);
    await assert.rejects(runtime.verifyRevision('/task/rt', 'b'.repeat(40)), /Wrong source revision/u);
    runtime.command = async (_command, args) => args.includes('rev-parse') ? 'b'.repeat(40) : ' M source.mjs';
    await assert.rejects(runtime.verifyRevision('/task/rt', 'b'.repeat(40)), /Dirty source revision/u);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'controller-source-'));
    try {
        await fs.writeFile(path.join(root, 'source.mjs'), 'expected');
        runtime.command = async () => 'source.mjs\0';
        runtime.node = async (_id, _body, input) => input.files.map(([file, kind]) => [file, kind, hash]);
        await assert.rejects(runtime.verifyFiles({ root, subdir: '', runtimePath: '/code' }, runtime.config.rt),
            /Runtime source differs/u);
    } finally { await fs.rm(root, { recursive: true }); }
});

function controllerApiFixture(runtime, listings = directory => directory.endsWith('/.private') ? [] : [{ name: 'positive-control' }]) {
    const calls = [];
    runtime.auth = {
        async mutationHeaders(route) { assert.equal(route, 'explorer'); return { headers: { 'x-ploinky-browser-csrf-token': 'unit-proof' }, generation: 'unit-generation' }; },
        async request(pathname, options) {
            assert.equal(pathname, '/explorer/mcp'); calls.push(options);
            if (options.body.method === 'initialize') return { status: 200, headers: { 'mcp-session-id': 'unit-session' },
                payload: { result: { protocolVersion: '2025-06-18' } } };
            assert.equal(options.body.params.name, 'list_directory_detailed');
            assert.equal(options.headers['mcp-session-id'], 'unit-session');
            return { status: 200, payload: { result: { content: [{ type: 'text',
                text: JSON.stringify(listings(options.body.params.arguments.path)) }] } } };
        },
    };
    return calls;
}

test('I8 inventories every active agent and uses the controlled Explorer API positive and empty controls', async () => {
    const snapshot = { markerHash: hash, treeHash: hash, entries: 1 };
    const runtime = { config: config(), registry: { rt: { type: 'agent', containerId: config().rt },
        rw: { type: 'agent', containerId: config().rw }, third: { type: 'agent', containerId: 'd'.repeat(64) } },
    snapshot: async () => snapshot, nodes: [], async node(id, body, input) {
        this.nodes.push(id);
        if (body.includes('manifestHash')) return { manifestHash: hash, entries: [] };
        if (!input) return [this.config.victim];
        return { ino: 1, dev: 2 };
    } };
    const calls = controllerApiFixture(runtime);
    const result = await otherAgentMasks(runtime);
    assert.equal(result.inventory.length, 3);
    assert.ok(result.inventory.some(row => row.containerId === 'd'.repeat(64)));
    assert.equal(result.privateApiEmpty, true);
    assert.equal(calls.filter(call => call.body.method === 'tools/call').length, 2);
    controllerApiFixture(runtime, () => ({ error: 'not a listing' }));
    await assert.rejects(otherAgentMasks(runtime));
});

test('Explorer API never accepts an error-shaped or missing listing as empty', async () => {
    const runtime = {};
    controllerApiFixture(runtime, () => []);
    assert.deepEqual((await explorerListing(runtime, '/task/.data/.private')).listing, []);
    runtime.auth.request = async () => ({ status: 503, payload: {}, headers: {} });
    await assert.rejects(explorerListing(runtime, '/task/.data/.private'));
});

test('I9 reads nonempty object manifests for every active agent and rejects agentExec', async () => {
    const runtime = { registry: { one: { type: 'agent', containerId: hash } }, node: async () => ({}) };
    assert.equal((await manifests(runtime)).count, 1);
    runtime.node = async () => ({ routerAccess: { agentExec: true } });
    await assert.rejects(manifests(runtime));
});

function isolationFixture({ leak = false, mutateVictim = false, admitted = false, activeRun = false, leakOnRead = false } = {}) {
    const marker = 'unit-victim-marker'; const observations = [];
    const before = { markerHash: sha256(marker), markerLength: marker.length, treeHash: hash, entries: 1 };
    let snapshots = 0, lists = 0, running = activeRun;
    const runtime = { config: config(), observations,
        async snapshot() { snapshots++; return mutateVictim && snapshots > 1 ? { ...before, treeHash: 'b'.repeat(64) } : before; },
        probes: { async create() { return 'owned-new-probe'; }, async remove() {
            observations.push('robot_delete'); return { ok: true, result: { deleted: true } };
        } },
        async node() { return { ino: 1, dev: 2 }; },
        async command() { return BASELINE_METHOD + BASELINE_DIRECTORIES; },
        async mcp(tool, input) {
            observations.push(tool);
            if (tool === 'run_list') return { ok: true, result: running
                ? [{ runId: 'unit-owned-run', robotId: 'owned-new-probe', state: 'running' }]
                : admitted && ++lists > 1 ? [{ runId: 'unexpected' }] : [] };
            if (tool === 'run_stop') return { ok: true, result: {} };
            if (tool === 'run_read') return { ok: true, result: { state: 'exited', next: 1,
                records: input.after === 0 ? [{ seq: 1, data: Buffer.from(leakOnRead ? marker : 'unit-output').toString('base64') }] : [] } };
            if (tool === 'run_release') { running = false; return { ok: true, result: {} }; }
            if (tool === 'gui_stop') { assert.equal(running, false); return { ok: true, result: { state: 'stopped' } }; }
            if (tool === 'run_start' && input.tag?.padding) {
                const target = input.folders[0]?.source || input.cwd;
                const code = target.includes('controller-grants-') && !target.endsWith('victim-link') ? 'INVALID_INPUT'
                    : input.folders.length ? 'FOLDER_REFUSED' : 'CWD_REFUSED';
                return { ok: false, code };
            }
            return { ok: false, code: 'HOME_OPERATION_FAILED', ...(leak ? { output: marker } : {}) };
        },
    };
    return runtime;
}

test('I2 exercises all seven helper operations and refuses victim mutation or output disclosure', async () => {
    const runtime = isolationFixture();
    const result = await symlinkHelpers(runtime);
    assert.deepEqual(result.observations.map(row => row.tool), ['robot_ensure', 'robot_status', 'robot_config',
        'robot_models', 'gui_ensure', 'run_start', 'robot_delete']);
    assert.equal(result.negativeControl.victimAfterMode, 0o700);
    for (const options of [{ leak: true }, { mutateVictim: true }]) await assert.rejects(symlinkHelpers(isolationFixture(options)));
});

test('I2 stops and drains owned native output before GUI cleanup and rejects encoded marker disclosure', async () => {
    const runtime = isolationFixture({ activeRun: true });
    await symlinkHelpers(runtime);
    assert.equal(runtime.observations.filter(tool => tool === 'run_read').length, 2);
    assert.ok(runtime.observations.indexOf('run_release') < runtime.observations.indexOf('gui_stop'));
    await assert.rejects(symlinkHelpers(isolationFixture({ activeRun: true, leakOnRead: true })), /Victim marker leaked/u);
});

test('I10 records exact CWD/folder refusals and remains pending without a real native symlink fixture', async () => {
    await assert.rejects(grantRefusals(isolationFixture()), error => {
        assert.equal(error.code, 'ACCEPTANCE_PENDING'); assert.equal(error.scenario, 'I10');
        assert.equal(error.evidence.observations.length, 14);
        assert.deepEqual(new Set(error.evidence.observations.map(row => row.code)), new Set(['CWD_REFUSED', 'FOLDER_REFUSED']));
        assert.equal(error.sentinel, undefined); return true;
    });
    await assert.rejects(grantRefusals(isolationFixture({ admitted: true })), /unexpectedly admitted a native run/u);
});

test('I11 uses a newly provisioned deletion target and rejects changed victim bytes or modes', async () => {
    const runtime = isolationFixture();
    assert.equal((await safeDelete(runtime)).attackerAbsent, true);
    assert.equal(runtime.observations.at(-1), 'robot_delete');
    await assert.rejects(safeDelete(isolationFixture({ mutateVictim: true })), /Victim tree bytes, links or modes changed/u);
});

test('H3 requires empty named-volume inventories and the exact workspace private-data bind', async () => {
    const c = config(); const root = `${c.workspace}/.data/.private/roboWorkAgent`;
    const inspection = { Mounts: [{ Type: 'bind', Source: root, Destination: '/data' }] };
    const runtime = { config: c, inspections: new Map([[c.rw, inspection]]),
        box: async args => args[0] === 'du' ? `42\t${root}` : '[]', inner: async () => '[]' };
    assert.deepEqual(await workspaceStorage(runtime), { namedVolumes: 0, workspaceBind: true, privateDataKiB: 42 });
    runtime.inner = async () => '[{"Name":"foreign"}]'; await assert.rejects(workspaceStorage(runtime), /Named volumes exist/u);
    runtime.inner = async () => '[]'; inspection.Mounts[0].Source = '/foreign/private';
    await assert.rejects(workspaceStorage(runtime), /not the selected workspace bind/u);
});

test('final changed runtime identity or failed cleanup prevents a controller success sentinel', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'controller-session-'));
    const fetchBefore = globalThis.fetch;
    try {
        const state = path.join(root, 'state.json');
        await fs.writeFile(state, JSON.stringify({ cookies: [{ name: 'session', value: 'unit-private',
            domain: '127.0.0.1', path: '/', expires: -1 }] }), { mode: 0o600 });
        globalThis.fetch = async url => {
            const payload = url.endsWith('/auth/token') ? { ok: true, user: { id: 'unit-admin', roles: ['admin'] } }
                : url.includes('/auth/token?') ? { browserMutation: { csrfToken: 'unit-private', routeKey: 'roboTeamAgent',
                    origin: 'http://127.0.0.1:18080', generation: 'unit-generation' } }
                    : url.endsWith('/api/robots') ? { ok: true, canAdmin: true, robots: [{ id: 'unit-default', name: 'default' }] }
                        : { ok: true, codingAgent: 'opencode', models: { opencode: FREE_MODEL } };
            return new Response(JSON.stringify(payload), { status: 200 });
        };
        for (const failure of [null, 'identity', 'cleanup', 'pending-cleanup']) {
            let checks = 0;
            const c = config(); c.explorer = { origin: 'http://127.0.0.1:18080', storageState: state };
            const runtime = { config: c, receipts: [], registry: { one: { type: 'agent', containerId: hash } },
                async verify() { checks++; return { fixture: 'owned', agents: failure === 'identity' && checks > 1 ? ['foreign'] : ['owned'] }; },
                async command() { return JSON.stringify([{ NetworkSettings: { Ports: { '8080/tcp': [{ HostPort: '18080' }] } } }]); },
                async node() {
                    if (failure === 'cleanup' || failure === 'pending-cleanup') runtime.auth.close = async () => { throw Error('Failed close'); };
                    if (failure === 'pending-cleanup') throw Object.assign(new Error('Pending fixture'), { code: 'ACCEPTANCE_PENDING' });
                    return {};
                },
            };
            if (!failure) assert.equal((await runVerifiedScenario(runtime, 'I9')).scenario, 'I9');
            else await assert.rejects(runVerifiedScenario(runtime, 'I9'), failure === 'identity'
                ? /Runtime identity changed/u : error => error.code === 'CONTROLLER_CLEANUP_FAILED');
        }
    } finally { globalThis.fetch = fetchBefore; await fs.rm(root, { recursive: true }); }
});

test('approved immutable baseline recipe actually changes only scratch victim mode and cleans up', async () => {
    const execute = promisify(execFile);
    const root = fileURLToPath(new URL('../../..', import.meta.url));
    const { stdout } = await execute('git', ['-C', root, 'show', `${BASELINE_REVISION}:roboTeamAgent/server/runtime-manager.mjs`]);
    const result = await baselineSymlinkControl(stdout);
    assert.equal(result.victimBeforeMode, 0o755); assert.equal(result.victimAfterMode, 0o700);
    assert.equal(result.revision, BASELINE_REVISION);
    await assert.rejects(baselineSymlinkControl(stdout.replace('await fs.chmod(directory, 0o700);', '')));
});

test('standalone CLI missing prerequisites exits nonzero without success sentinel', async () => {
    const execute = promisify(execFile);
    const runner = fileURLToPath(new URL('./controller-scenarios.mjs', import.meta.url));
    const help = await execute(process.execPath, [runner, '--help']);
    assert.match(help.stdout, /I11 creates and deletes/u);
    await assert.rejects(execute(process.execPath, [runner]), error => {
        assert.equal(error.code, 1); assert.equal(error.stdout, '');
        assert.match(error.stderr, /CONTROLLER_ASSERTION_FAILED/u);
        assert.doesNotMatch(error.stderr, /ROBOWORK_CONTROLLER_PROBE_V1/u);
        return true;
    });
});
