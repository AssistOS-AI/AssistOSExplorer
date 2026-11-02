import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fsSync from 'node:fs';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validateConfig, assertBox, selectAgent, assertNoAgentExec, assertVictimUnchanged,
    assertRefused, assertDualHome, assertDeleted, assertEmptyPrivateListing, assertBrowserOrigin,
    decodeMcpResult, normalizeMcpOutcome, assertNoMarker, assertProtectedPathRefusal, sha256 } from './controller/contracts.mjs';
import { BASELINE_REVISION, BASELINE_METHOD, BASELINE_DIRECTORIES, baselineSymlinkControl } from './controller/baseline-control.mjs';
import { runControllerScenario, runVerifiedScenario, dualHome, manifests, otherAgentMasks,
    grantRefusals, symlinkHelpers, safeDelete, workspaceStorage } from './controller-scenarios.mjs';
import { ControllerRuntime } from './controller/runtime.mjs';
import { explorerListing, explorerProtectedListing } from './controller/explorer-api.mjs';
import { FREE_MODEL, ProbeRobots, assertFreeConfig } from './controller/robots.mjs';
import { ControllerSession, assertAdminToken, cookieHeader, privateJson, openControllerSession } from './controller/auth-session.mjs';
import { NATIVE_PROBE, nativeSymlinkControl, assertNativeReceipt, assertNativeObservation, assertNativeCleanup } from './controller/native-terminal.mjs';

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

test('Box image proof accepts the same complete raw or prefixed immutable digest', () => {
    const c = config();
    const inspection = { Id: c.box.id, State: { Running: true, StartedAt: c.box.startedAt },
        Mounts: [{ Type: 'bind', Source: c.fixture, Destination: c.workspace }] };
    for (const Image of [hash, `sha256:${hash}`]) assertBox(c, { ...inspection, Image });
});

test('Box image proof rejects wrong digests, malformed encodings and a different immutable container', () => {
    const c = config();
    const inspection = { Id: c.box.id, State: { Running: true, StartedAt: c.box.startedAt },
        Mounts: [{ Type: 'bind', Source: c.fixture, Destination: c.workspace }] };
    for (const Image of ['d'.repeat(64), `sha256:${'d'.repeat(64)}`, hash.slice(1), `sha256:${hash.slice(1)}`,
        hash.toUpperCase(), `sha256:${hash.toUpperCase()}`, `${hash}\n`, `sha256:${hash}\n`, ` ${hash}`,
        `sha512:${hash}`, `sha256:sha256:${hash}`, '', null, 123]) {
        assert.throws(() => assertBox(c, { ...inspection, Image }));
    }
    assert.throws(() => assertBox(c, { ...inspection, Image: hash, Id: 'd'.repeat(64) }));
    for (const image of [hash, `sha256:${hash}\n`, `sha256:${hash.toUpperCase()}`]) {
        assert.throws(() => validateConfig({ ...c, box: { ...c.box, image } }));
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

test('controller cookies select root Router cookies from normal mixed-path browser state', () => {
    const common = { domain: '127.0.0.1', expires: -1, secure: false };
    const state = { cookies: [
        { ...common, name: 'router-session', value: 'unit-session', path: '/' },
        { ...common, name: 'router-csrf', value: 'unit-csrf', path: '/' },
        { ...common, name: 'provider-session', value: 'unit-provider',
            path: '/base-agent-additional-server/userPersistoAgent/7000/service/' },
    ] };
    assert.equal(cookieHeader(state, 'http://127.0.0.1:8080'), 'router-session=unit-session; router-csrf=unit-csrf');
});

test('controller cookies still require a usable valid root cookie on the selected host', () => {
    const root = { domain: '127.0.0.1', expires: -1, secure: false, name: 'router-session', value: 'unit-session', path: '/' };
    for (const change of [{ path: '/base-agent-additional-server/userPersistoAgent/7000/service/' },
        { domain: 'foreign.example' }, { expires: 1 }, { secure: true }, { name: 'bad cookie' }, { value: 'bad;value' }]) {
        assert.throws(() => cookieHeader({ cookies: [{ ...root, ...change }] }, 'http://127.0.0.1:8080'));
    }
    assert.throws(() => cookieHeader({ cookies: [root] }, 'http://localhost:8080'));
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

function controllerApiFixture(runtime, listings = () => [{ name: 'positive-control' }], refusal) {
    const calls = [];
    runtime.auth = {
        async mutationHeaders(route) { assert.equal(route, 'explorer'); return { headers: { 'x-ploinky-browser-csrf-token': 'unit-proof' }, generation: 'unit-generation' }; },
        async request(pathname, options) {
            assert.equal(pathname, '/explorer/mcp'); calls.push(options);
            if (options.body.method === 'initialize') return { status: 200, headers: { 'mcp-session-id': 'unit-session' },
                payload: { result: { protocolVersion: '2025-06-18' } } };
            assert.equal(options.body.params.name, 'list_directory_detailed');
            assert.equal(options.headers['mcp-session-id'], 'unit-session');
            const directory = options.body.params.arguments.path;
            if (directory.endsWith('/.private')) return { status: 200, payload: refusal || {
                result: { isError: true, content: [{ type: 'text', text: `MCP error -32603: Access denied: protected path "${directory}"` }] },
            } };
            return { status: 200, payload: { result: { content: [{ type: 'text',
                text: JSON.stringify(listings(directory)) }] } } };
        },
    };
    return calls;
}

test('I8 inventories every active agent and requires Explorer positive listing, root invisibility and protected-path refusal', async () => {
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
    assert.equal(result.privateApiRefused.code, 'EXPLORER_PROTECTED_PATH');
    assert.equal(result.workspacePrivateRootHidden, true);
    assert.equal(calls.filter(call => call.body.method === 'tools/call').length, 3);
    controllerApiFixture(runtime, () => ({ error: 'not a listing' }));
    await assert.rejects(otherAgentMasks(runtime));
    controllerApiFixture(runtime, directory => directory === runtime.config.workspace ? [{ name: '.data' }] : [{ name: 'positive-control' }]);
    await assert.rejects(otherAgentMasks(runtime), /exposes private storage/u);
    controllerApiFixture(runtime, undefined, { result: { isError: true, content: [{ type: 'text', text: 'unavailable' }] } });
    await assert.rejects(otherAgentMasks(runtime), /different reason or path/u);
});

test('Explorer API never accepts an error-shaped or missing listing as empty', async () => {
    const runtime = {};
    controllerApiFixture(runtime, () => []);
    assert.deepEqual((await explorerListing(runtime, '/task/ordinary')).listing, []);
    runtime.auth.request = async () => ({ status: 503, payload: {}, headers: {} });
    await assert.rejects(explorerListing(runtime, '/task/.data/.private'));
});

test('I8 accepts only exact protected-path MCP refusal and rejects generic errors, wrong paths and successful empty replies', async () => {
    const directory = '/task/.data/.private'; const message = `Access denied: protected path "${directory}"`;
    const errorResult = text => ({ result: { isError: true, content: [{ type: 'text', text }] } });
    assert.equal(assertProtectedPathRefusal(errorResult(message), directory).code, 'EXPLORER_PROTECTED_PATH');
    assertProtectedPathRefusal({ error: { code: -32603, message } }, directory);
    for (const body of [errorResult('Access denied'), errorResult('unavailable'), errorResult(`${message} extra data`),
        errorResult('Access denied: protected path "/foreign"'), { error: { code: -32003, message } },
        { error: { code: -32603, message, data: ['private entry'] } }, { result: { content: [{ type: 'text', text: message }] } },
        { result: { content: [{ type: 'text', text: '[]' }] } },
        { result: { isError: true, content: [{ type: 'text', text: message }, { type: 'text', text: 'private entry' }] } }]) {
        assert.throws(() => assertProtectedPathRefusal(body, directory));
    }
    const runtime = {}; controllerApiFixture(runtime);
    assert.equal((await explorerProtectedListing(runtime, directory)).refusal.code, 'EXPLORER_PROTECTED_PATH');
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
                records: input.after === 0 ? [{ seq: 1, stream: 'stdout', data: Buffer.from(leakOnRead ? marker : 'unit-output').toString('base64') }] : [] } };
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

function splitMarkerFixture({ pages = false, separateStreams = false, separateRuns = false } = {}) {
    const runtime = isolationFixture();
    const marker = 'unit-victim-marker';
    const records = [marker.slice(0, 8), marker.slice(8)].map((part, index) => ({
        seq: index + 1, stream: separateStreams && index === 1 ? 'stderr' : 'stdout',
        data: Buffer.from(part).toString('base64'),
    }));
    const runs = new Set(separateRuns ? ['unit-run-one', 'unit-run-two'] : ['unit-run-one']);
    const mcp = runtime.mcp;
    runtime.mcp = async (tool, input) => {
        if (tool === 'run_list') return { ok: true, result: [...runs].map(runId => ({
            runId, robotId: 'owned-new-probe', state: 'exited',
        })) };
        if (tool === 'run_read') {
            const output = (separateRuns ? [records[input.runId === 'unit-run-one' ? 0 : 1]] : records)
                .filter(record => record.seq > input.after).slice(0, pages ? 1 : 2);
            return { ok: true, result: { state: 'exited', next: output.at(-1)?.seq ?? input.after, records: output } };
        }
        if (tool === 'run_release') { runs.delete(input.runId); return { ok: true, result: {} }; }
        return mcp.call(runtime, tool, input);
    };
    return runtime;
}

test('I2 rejects a decoded marker split across records in one native stream', async () => {
    await assert.rejects(symlinkHelpers(splitMarkerFixture()), /Victim marker leaked/u);
});

test('I2 rejects a decoded marker split across run_read pages in one native stream', async () => {
    await assert.rejects(symlinkHelpers(splitMarkerFixture({ pages: true })), /Victim marker leaked/u);
});

test('I2 keeps unrelated native streams and runs separate while scanning marker fragments', async () => {
    for (const options of [{ separateStreams: true }, { separateRuns: true }]) {
        assert.equal((await symlinkHelpers(splitMarkerFixture(options))).observations.at(-1).tool, 'robot_delete');
    }
});

test('I10 retains all fourteen refusals and fails without the native terminal prerequisite', async () => {
    await assert.rejects(grantRefusals(isolationFixture()), error => {
        assert.equal(error.code, 'CONTROLLER_PREREQUISITE');
        assert.equal(error.evidence.observations.length, 14);
        assert.deepEqual(new Set(error.evidence.observations.map(row => row.code)), new Set(['CWD_REFUSED', 'FOLDER_REFUSED']));
        assert.equal(error.sentinel, undefined); return true;
    });
    await assert.rejects(grantRefusals(isolationFixture({ admitted: true })), /unexpectedly admitted a native run/u);
});

test('I10 runs the finite native control only after fourteen exact refusals and no admitted runs', async () => {
    const runtime = isolationFixture();
    const result = await grantRefusals(runtime, async (observed, input) => {
        assert.equal(observed, runtime);
        assert.equal(runtime.observations.filter(row => row === 'run_start').length, 16);
        assert.equal(runtime.observations.filter(row => row === 'run_list').length, 2);
        assert.equal(input.attacker, 'owned-new-probe');
        assert.ok(input.project.startsWith(`${runtime.config.workspace}/controller-grants-`));
        return { unitFixture: true };
    });
    assert.equal(result.observations.length, 14);
    assert.equal(result.nativeTerminal.unitFixture, true);
    assert.equal(runtime.observations.filter(row => row === 'run_list').length, 3);
    await assert.rejects(grantRefusals(isolationFixture({ mutateVictim: true }), async () => ({})), /Victim tree bytes, links or modes changed/u);
});

test('I10 retains the exact owned project when terminal cleanup is unproven', async () => {
    const runtime = isolationFixture(); let removed = false;
    runtime.node = async (_id, body) => { if (body.includes('fs.rmdirSync(input.project)')) removed = true; return { ino: 1, dev: 2 }; };
    await assert.rejects(grantRefusals(runtime, async (_runtime, { attacker, project }) => {
        throw Object.assign(new Error('unit cleanup failed'), { code: 'CONTROLLER_CLEANUP_FAILED',
            evidence: { nativeTerminal: { cleanupConfirmed: false, attacker, project, sessionId: 'owned-session' } } });
    }), error => {
        assert.equal(error.code, 'CONTROLLER_CLEANUP_FAILED');
        assert.equal(error.evidence.observations.length, 14);
        assert.equal(error.evidence.nativeTerminal.attacker, 'owned-new-probe');
        return true;
    });
    assert.equal(removed, false);
    assert.ok(!runtime.observations.includes('robot_delete'));
    assert.deepEqual(runtime.retainedNativeTerminal.projectOwner, {
        project: runtime.retainedNativeTerminal.project, ino: 1, dev: 2,
    });
});

function nativeIdentityFixture() {
    const target = { runtime: 'podman', containerId: 'c'.repeat(64), containerName: 'owned-rw', instanceId: 'instance', enableGeneration: 'generation' };
    const expected = { attacker: 'owned-new-probe', project: '/task/project', victim: 'owned-victim', nonce: 'unit-nonce' };
    const record = { schema: 'ploinky-webtty-recovery/v2', targetKind: 'agent', ptyState: 'pty-ready', target,
        marker: 'm'.repeat(32), worker: { pid: 10, startToken: 'linux-proc:100' },
        agent: { containerId: target.containerId, marker: 'm'.repeat(32), translatedCwd: expected.project,
            execId: 'd'.repeat(64), clientProcess: { pid: 11, startToken: 'linux-proc:101' }, innerProcess: {
                innerPid: 12, boxPid: 112, innerSessionId: 12, innerStartToken: 'linux-proc:102', boxStartToken: 'linux-proc:102',
            } },
        agentStartup: { containerId: target.containerId, marker: 'm'.repeat(32), translatedCwd: expected.project,
            translatedHome: '/task/.data/roboWorkAgent/terminal/owned-new-probe', profile: { provider: 'roboWorkAgent', id: 'owned-new-probe.default' } } };
    const observed = { nonce: expected.nonce, home: '/home/owned-new-probe', user: expected.attacker, cwd: expected.project,
        pid: 4, startToken: '102', pidNamespace: 'pid:[100]', tty: true, profileEnv: false,
        link: '/data/robots/owned-victim/home', readable: false, denial: 'ENOENT' };
    const proof = { nonce: expected.nonce, innerPid: 4, startToken: '102', pidNamespace: 'pid:[100]',
        serviceNamespace: 'pid:[99]', homeMatches: true, ttyMatches: true, receiptAncestor: true };
    return { target, expected, record, observed, proof };
}

test('I10 rejects wrong CID/generation, profile, cwd, marker, foreign or incomplete native receipts', () => {
    const { target, expected, record } = nativeIdentityFixture();
    const check = value => assertNativeReceipt(value, target, `${expected.attacker}.default`, expected.project);
    check(record);
    for (const change of [r => { r.target.containerId = 'e'.repeat(64); }, r => { r.target.enableGeneration = 'foreign'; },
        r => { r.agent.containerId = 'e'.repeat(64); }, r => { r.agentStartup.profile.id = 'foreign.default'; },
        r => { r.agentStartup.profile.provider = 'roboTeamAgent'; }, r => { r.agent.translatedCwd = '/foreign'; },
        r => { r.agent.marker = 'foreign'; }, r => { r.ptyState = 'pty-starting'; },
        r => { r.cleanupState = 'unproven'; }, r => { r.agent = null; }, r => { r.worker.pid = 0; }]) {
        const value = structuredClone(record); change(value); assert.throws(() => check(value));
    }
});

test('I10 rejects wrong nonce/HOME/cwd/TTY, unsandboxed namespace, foreign process ancestry and readable victim link', () => {
    const fixture = nativeIdentityFixture();
    const { observed, expected, proof } = fixture;
    assertNativeObservation(observed, expected, proof);
    for (const change of [r => { r.nonce = 'wrong'; }, r => { r.home = '/data/robots/owned-new-probe/home'; },
        r => { r.cwd = '/foreign'; }, r => { r.tty = false; }, r => { r.profileEnv = true; },
        r => { r.readable = true; r.denial = null; }, r => { r.denial = 'EIO'; }, r => { r.link = '/foreign'; }]) {
        const value = structuredClone(observed); change(value);
        assert.throws(() => assertNativeObservation(value, expected, proof));
    }
    for (const change of [r => { r.nonce = 'wrong'; }, r => { r.serviceNamespace = observed.pidNamespace; },
        r => { r.startToken = '999'; }, r => { r.innerPid = 9; }, r => { r.receiptAncestor = false; },
        r => { r.homeMatches = false; }, r => { r.ttyMatches = false; }]) {
        const value = structuredClone(proof); change(value);
        assert.throws(() => assertNativeObservation(observed, expected, value));
    }
});

test('I10 cleanup requires every exact record/process/ExecID/session absence and an empty stub', () => {
    const good = { recordAbsent: true, processesAbsent: true, execAbsent: true, sessionAbsent: true, stubEmpty: true };
    assertNativeCleanup(good);
    for (const key of Object.keys(good)) {
        assert.throws(() => assertNativeCleanup({ ...good, [key]: false }));
        const absent = { ...good }; delete absent[key]; assert.throws(() => assertNativeCleanup(absent));
    }
});

test('I10 browser requests use a fresh launch document, bounded signals and fail closed on aborts', async () => {
    for (const abortedRequest of [null, 'auth', 'input', 'failure-exit', 'live-list', 'launch-response']) {
        const { target, expected, record, observed, proof } = nativeIdentityFixture();
        const calls = [], signals = new Map(); let recordReads = 0;
        const owner = { name: 'owned-name' }; record.agentStartup.profile.label = owner.name;
        const sessionId = 's'.repeat(32), launch = 'l'.repeat(32);
        const runtime = { config: { rw: target.containerId, workspace: '/task', victim: expected.victim,
            explorer: { storageState: '/unit/private-state' } },
        auth: { origin: 'http://127.0.0.1', principalHash: 'unit-principal' },
        probes: { owned: new Map([[expected.attacker, owner]]) }, registry: {},
        async verify() { return { unitIdentity: true }; },
        async node(_id, body) { return body.includes('process.execPath') ? '/usr/bin/node' : { dev: 1, ino: 2 }; } };
        let pages = 0, launchPage, waiterPage;
        const makePage = () => {
            const number = ++pages; let documentUrl = 'about:blank';
            const listeners = new Map();
            return { on(event, listener) { listeners.set(event, listener); }, setDefaultTimeout(ms) { assert.equal(ms, 30000); }, async goto(url) {
                if (url.includes('#launch=')) {
                    assert.notEqual(documentUrl, runtime.auth.origin + '/webtty/', 'Same-document hash navigation cannot rerun the WebTTY bootstrap');
                    launchPage = number;
                    listeners.get('request')?.({ url: () => runtime.auth.origin + '/webtty/sessions', method: () => 'POST' });
                }
                documentUrl = url;
            },
            async evaluate(callback, argument) {
                // Profile import/discovery is separately owned by the normal
                // client. Every fetch callback below executes unchanged in VM.
                if (callback.toString().includes('await import(')) return `/webtty/#launch=${launch}`;
                return callback(argument);
            },
            async waitForResponse() { waiterPage = number;
                if (abortedRequest === 'launch-response') throw Object.assign(new Error('unit response deadline'), { name: 'TimeoutError' });
                return { status: () => 201, request: () => ({ postDataJSON: () => ({ launch }) }),
                async json() { return { ok: true, session: { id: sessionId, role: 'owner', profileLabel: owner.name,
                    target: { kind: 'agent', detail: 'AchillesIDE/roboWorkAgent', access: 'rw', cwdDisplay: expected.project } } }; } }; },
            async waitForFunction() {},
            locator(selector) { return { async textContent() { return selector === '#message' ? 'Terminal closed: terminal_clean.'
                : `I10_NATIVE_${expected.nonce} ${Buffer.from(JSON.stringify(observed)).toString('base64')} I10_EXIT_${expected.nonce} 0`; } }; },
            };
        };
        const context = { async newPage() { return makePage(); }, async close() { calls.push('close-context'); } };
        const browser = { async newContext() { return context; }, async close() { calls.push('close-browser'); } };
        let uuid = 0;
        const execute = vm.runInNewContext(`(${nativeSymlinkControl.toString()})`, {
            assert, Buffer, URL, NATIVE_PROBE, ID: /^[A-Za-z0-9_-]{32}$/u,
            prerequisite: message => new Error(message), requireSmoke: () => ({ chromium: { async launch() { return browser; } } }),
            selectAgent: () => [target.containerName, target], privateJson: async () => ({}),
            randomUUID: () => uuid++ === 0 ? expected.nonce : 'unit-release',
            records: async () => recordReads++ === 0 ? [] : [{ name: 'owned-receipt.json', record }],
            assertNativeReceipt: (value, selected, ...args) => assertNativeReceipt(value, JSON.parse(JSON.stringify(selected)), ...args),
            assertAdminToken: () => 'unit-principal', assertNoMarker() {},
            processProof: async () => proof, assertNativeObservation,
            cleanupProof: async () => ({ recordAbsent: true, processesAbsent: true, execAbsent: true, stubEmpty: true }),
            assertNativeCleanup, delay: async () => {}, quote: value => JSON.stringify(value), sha256,
            AbortSignal: { timeout(ms) { assert.equal(ms, 30000); const controller = new AbortController();
                signals.set(controller.signal, controller); return controller.signal; } },
            async fetch(route, options) {
                const kind = route === '/auth/token' ? 'auth' : route === '/webtty/live-sessions' ? 'live-list'
                    : JSON.parse(options.body).data.endsWith('exit 1\r') ? 'failure-exit' : 'input';
                calls.push(kind);
                assert.ok(signals.has(options?.signal), `${kind} requires its own bounded browser signal`);
                // Enter the failure path before its normal-exit request when
                // that request is the selected abort target.
                if (kind === abortedRequest || (abortedRequest === 'failure-exit' && kind === 'input')) {
                    const error = Object.assign(new Error('unit request deadline'), { name: 'TimeoutError' });
                    signals.get(options.signal).abort(error); throw options.signal.reason;
                }
                return { status: 200, async json() { return kind === 'auth' ? {} : { ok: true, sessions: [] }; } };
            },
        });
        const operation = execute(runtime, { attacker: expected.attacker, project: expected.project,
            victim: { markerHash: hash, markerLength: 1 } });
        if (abortedRequest === null) {
            assert.equal((await operation).exitCode, 0);
            assert.equal(pages, 2); assert.equal(launchPage, 2); assert.equal(waiterPage, launchPage);
        } else await assert.rejects(operation, error => {
            if (abortedRequest === 'auth' || abortedRequest === 'input') assert.equal(error.name, 'TimeoutError', `${abortedRequest}: ${error.message}`);
            else {
                assert.equal(error.code, 'CONTROLLER_CLEANUP_FAILED');
                assert.equal(error.evidence.nativeTerminal.cleanupConfirmed, false);
                if (abortedRequest === 'launch-response') {
                    assert.equal(error.evidence.nativeTerminal.primaryStage, 'terminal-launch');
                    assert.equal(error.evidence.nativeTerminal.sessionRequestObserved, true);
                    assert.equal(error.evidence.nativeTerminal.sessionRequestFailed, false);
                    assert.equal(error.evidence.nativeTerminal.sessionResponseStatus, null);
                    assert.ok(!JSON.stringify(error.evidence).includes(launch), 'Failure evidence must not contain the launch ticket');
                } else assert.equal(runtime.retainedNativeTerminal.sessionId, sessionId);
            }
            return true;
        });
        if (abortedRequest !== null && abortedRequest !== 'launch-response') assert.ok(calls.includes(abortedRequest));
        if (abortedRequest === 'input') assert.ok(calls.includes('failure-exit'), 'Input abort must attempt normal owned-session exit');
        assert.deepEqual(calls.slice(-2), ['close-context', 'close-browser']);
    }
});

test('I10 finite command attempts a real file read and never echoes victim bytes with synthetic proc identities', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'i10-command-'));
    try {
        const project = path.join(root, 'project'), victim = path.join(root, 'victim');
        await fs.mkdir(project); await fs.mkdir(victim);
        const marker = `private-victim-${randomUUID()}`;
        await fs.writeFile(path.join(victim, 'marker-B'), marker);
        await fs.symlink(victim, path.join(project, 'victim-link'));
        for (const readable of [true, false]) {
            if (!readable) await fs.unlink(path.join(victim, 'marker-B'));
            const input = { project, nonce: 'local-unit', release: 'unit-release' };
            let line, released, exit;
            // Only /proc identity is synthetic here; the symlink and victim
            // marker read use real temporary files. This is no namespace proof.
            const probeFs = { ...fsSync,
                readFileSync(file, ...args) { return file === '/proc/self/stat' ? `1 (node) ${Array(20).fill('1').join(' ')}` : fsSync.readFileSync(file, ...args); },
                readlinkSync(file) { return file === '/proc/self/ns/pid' ? 'pid:[100]' : fsSync.readlinkSync(file); },
            };
            vm.runInNewContext(NATIVE_PROBE, {
                require(name) { assert.equal(name, 'node:fs'); return probeFs; },
                Buffer, console: { log(value) { line = value; } },
                process: { argv: ['node', JSON.stringify(input)], env: {}, pid: 1, cwd: () => project,
                    stdin: { once(event, listener) { assert.equal(event, 'data'); released = listener; } },
                    stdout: {}, exit(code) { exit = code; } },
                setTimeout(_fn, ms) { assert.equal(ms, 45000); return 1; }, clearTimeout() {},
            });
            assert.equal(exit, undefined);
            released(Buffer.from('unit-release\n')); assert.equal(exit, 0);
            assert.ok(!line.includes(marker));
            const observed = JSON.parse(Buffer.from(line.trim().split(' ')[1], 'base64').toString());
            assert.equal(observed.readable, readable);
            assert.equal(observed.denial, readable ? null : 'ENOENT');
        }
    } finally { await fs.rm(root, { recursive: true }); }
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
        for (const failure of [null, 'identity', 'cleanup', 'pending-cleanup', 'retained-terminal']) {
            let checks = 0;
            const c = config(); c.explorer = { origin: 'http://127.0.0.1:18080', storageState: state };
            const runtime = { config: c, receipts: [], registry: { one: { type: 'agent', containerId: hash } },
                async verify() { checks++; return { fixture: 'owned', agents: failure === 'identity' && checks > 1 ? ['foreign'] : ['owned'] }; },
                async command() { return JSON.stringify([{ NetworkSettings: { Ports: { '8080/tcp': [{ HostPort: '18080' }] } } }]); },
                async node() {
                    if (failure === 'cleanup' || failure === 'pending-cleanup') runtime.auth.close = async () => { throw Error('Failed close'); };
                    if (failure === 'pending-cleanup') throw Object.assign(new Error('Pending fixture'), { code: 'ACCEPTANCE_PENDING' });
                    if (failure === 'retained-terminal') {
                        runtime.probes.owned.set('owned-new-probe', { name: 'owned-name', createdAt: 'unit-created' });
                        runtime.retainedNativeTerminal = { cleanupConfirmed: false, attacker: 'owned-new-probe', sessionId: 'owned-session' };
                        throw new Error('Retained terminal primary');
                    }
                    return {};
                },
            };
            if (!failure) assert.equal((await runVerifiedScenario(runtime, 'I9')).scenario, 'I9');
            else if (failure === 'retained-terminal') await assert.rejects(runVerifiedScenario(runtime, 'I9'), error => {
                assert.match(error.message, /Retained terminal primary/u);
                assert.equal(error.evidence.nativeTerminal.sessionId, 'owned-session');
                assert.equal(runtime.probes.owned.has('owned-new-probe'), true);
                return true;
            });
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
