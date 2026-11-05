import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validateConfig, assertBox, assertVictimUnchanged, assertRefused, assertDeleted, assertEmptyPrivateListing, decodeMcpResult, assertProtectedPathRefusal, sha256 } from './controller/contracts.mjs';
import { BASELINE_REVISION, BASELINE_METHOD, BASELINE_DIRECTORIES, baselineSymlinkControl } from './controller/baseline-control.mjs';
import { runVerifiedScenario, dualHome, manifests, grantRefusals, symlinkHelpers, safeDelete, walkUpAndDiscovery, workspaceStorage } from './controller-scenarios.mjs';
import { explorerProtectedListing } from './controller/explorer-api.mjs';
import { ControllerRuntime } from './controller/runtime.mjs';
import { FREE_MODEL } from './controller/robots.mjs';
import { assertAdminToken, cookieHeader, privateJson, openControllerSession } from './controller/auth-session.mjs';

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

test('cleanup failure or absent confirmation cannot become successful evidence', () => {
    assertDeleted({ ok: true, result: { deleted: true } });
    for (const result of [null, { ok: false }, { ok: true, result: {} },
        { ok: true, result: { deleted: false } }]) assert.throws(() => assertDeleted(result));
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

test('Explorer private API needs an actual empty listing and never an error or absent payload', () => {
    assertEmptyPrivateListing([]);
    for (const payload of [null, {}, '[]', [{ name: 'roboWorkAgent' }]]) assert.throws(() => assertEmptyPrivateListing(payload));
    assert.deepEqual(decodeMcpResult({ result: { content: [{ type: 'text', text: '[]' }] } }), []);
    for (const body of [{ error: { message: 'denied' } }, { result: { isError: true, content: [{ type: 'text', text: '[]' }] } },
        { result: { content: [] } }]) assert.throws(() => decodeMcpResult(body));
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

test('H2 rejects wrong immutable GUI ID, foreign source, changed persistent inode and residual GUI', async () => {
    for (const options of [{ wrongId: true }, { wrongSource: true }, { changedHome: true }, { residual: true }, { failed: true }]) {
        const runtime = guiFixture(options);
        await assert.rejects(dualHome(runtime));
        assert.equal(runtime.calls.at(-1), 'delete');
        if (options.residual) assert.ok(!runtime.calls.includes('gui_ensure:desktop'));
        if (options.failed) assert.equal(runtime.calls.filter(call => call === 'gui_ensure:browser').length, 1);
    }
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
                if (input.folders[0]?.source === input.cwd) return { ok: false, code: 'FOLDER_REFUSED' };
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

test('I10 retains all eighteen refusals, proves the private workspace targets exist, and fails without the native terminal prerequisite', async () => {
    await assert.rejects(grantRefusals(isolationFixture()), error => {
        assert.equal(error.code, 'CONTROLLER_PREREQUISITE');
        assert.equal(error.evidence.observations.length, 18);
        assert.deepEqual(new Set(error.evidence.observations.map(row => row.code)), new Set(['CWD_REFUSED', 'FOLDER_REFUSED']));
        // Both new targets are refused as a cwd and as a folder.
        const hashes = new Set(error.evidence.observations.map(row => row.pathHash));
        for (const target of ['/task/fixture/.data/roboTeamAgent', '/task/fixture/.ploinky-box']) assert.ok(hashes.has(sha256(target)), target);
        assert.equal(error.sentinel, undefined); return true;
    });
    await assert.rejects(grantRefusals(isolationFixture({ admitted: true })), /unexpectedly admitted a native run/u);
    // A target the service cannot see would make its refusal meaningless, so the scenario stops before any refusal.
    const runtime = isolationFixture();
    const node = runtime.node;
    runtime.node = async (id, body, input) => { if (input?.op === 'exists') throw new Error('Refusal target is not a directory: /task/fixture/.ploinky-box'); return node(id, body, input); };
    await assert.rejects(grantRefusals(runtime), /Refusal target is not a directory/u);
    assert.ok(!runtime.observations.includes('run_start'), 'No refusal was attempted against a target that was not proven to exist.');
});

function walkFixture({ recorderRan = true, discoveryEntries = [], turnEntries = [], siblingLoaded = false, parentLoaded = false, ownLoaded = true, discoveryFails = false, turnExit = 0 } = {}) {
    const state = { discovered: false, turned: false }, calls = [], owned = new Map();
    const record = entries => ({ cwd: '/task/fixture/controller-w1/child', entries });
    return { config: config(), calls, state, probes: {
        owned,
        async create() { calls.push('create'); owned.set('owned-w1', {}); return 'owned-w1'; },
        async remove(id) { assert.equal(id, 'owned-w1'); calls.push('delete'); owned.delete(id); return { ok: true, result: { deleted: true } }; },
    }, async node(id, body, input) {
        calls.push(`node:${input.op}`);
        if (input.op === 'folders') return { ino: 1, dev: 2 };
        if (input.op === 'observe') {
            const records = !recorderRan ? [] : state.turned ? [record(discoveryEntries), record(turnEntries)] : state.discovered ? [record(discoveryEntries)] : [];
            return { records, sibling: siblingLoaded, parent: parentLoaded, own: ownLoaded };
        }
        return true;
    }, async mcp(tool, input) {
        calls.push(tool);
        if (tool === 'robot_models') { state.discovered = true; return { ok: !discoveryFails, result: [] }; }
        if (tool === 'run_start' || tool === 'run_input') return { ok: true, result: {} };
        if (tool === 'run_read') { state.turned = true; return { ok: true, result: { state: 'exited', exit: { code: turnExit }, next: 1, records: [{ seq: 1, stream: 'stdout', data: '' }] } }; }
        if (tool === 'run_list') return { ok: true, result: [] };
        if (tool === 'gui_stop') return { ok: true, result: { state: 'stopped' } };
        throw new Error(`Unexpected tool ${tool}`);
    } };
}

test('W1 passes only when the working folder canary ran, the parent and sibling canaries stayed silent and the home recorder saw an empty .data twice', async () => {
    const runtime = walkFixture();
    const result = await walkUpAndDiscovery(runtime);
    assert.deepEqual(result.markers, { own: true, parent: false, sibling: false });
    assert.equal(result.discoveryRecords, 2);
    assert.ok(runtime.calls.indexOf('robot_models') < runtime.calls.indexOf('run_start'), 'Discovery precedes the turn');
    assert.equal(runtime.calls.at(-1), 'node:remove'); assert.ok(runtime.calls.includes('delete'));
});

test('W1 fails for each hole it can see and still removes what it created', async () => {
    const fails = async (options, pattern) => {
        const runtime = walkFixture(options);
        await assert.rejects(walkUpAndDiscovery(runtime), pattern, JSON.stringify(options));
        assert.equal(runtime.calls.at(-1), 'node:remove', 'The owned folders are removed');
        assert.ok(runtime.calls.includes('delete') && runtime.probes.owned.size === 0, 'The owned robot is removed');
    };
    await fails({ siblingLoaded: true }, /sibling folder plugin was loaded/u);
    await fails({ parentLoaded: true }, /parent folder plugin was loaded/u);
    await fails({ ownLoaded: false }, /working folder canary did not run/u);
    await fails({ recorderRan: false }, /home plugin never ran during model discovery/u);
    await fails({ discoveryEntries: ['.private'] }, /Discovery saw workspace \.data entries/u);
    await fails({ turnEntries: ['.private'] }, /robot saw workspace \.data entries/u);
    await fails({ discoveryFails: true }, /Model discovery failed/u);
    await fails({ turnExit: 5 }, /probe turn failed/u);
    // A recorder that ran only in discovery proves nothing about the turn.
    const runtime = walkFixture(); const mcp = runtime.mcp;
    runtime.mcp = async (tool, input) => { const answer = await mcp(tool, input); if (tool === 'run_read') runtime.state.turned = false; return answer; };
    await assert.rejects(walkUpAndDiscovery(runtime), /never ran during the turn/u);
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

test('source proof rejects a wrong revision, a dirty checkout and runtime bytes that differ', async () => {
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
        await assert.rejects(runtime.verifyFiles({ root, subdir: '', runtimePath: '/code' }, runtime.config.rt), /Runtime source differs/u);
    } finally { await fs.rm(root, { recursive: true }); }
});
