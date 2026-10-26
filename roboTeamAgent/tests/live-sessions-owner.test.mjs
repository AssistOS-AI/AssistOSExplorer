import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LiveSessionsIpcServer, loadOwnerVerifier } from '../server/live-sessions/ipc-server.mjs';
import { LiveSessionsRegistry } from '../server/live-sessions/registry.mjs';
import { ipcClient, socketFixture } from './helpers/live-sessions-ipc-client.mjs';

// Owner claims with tokens minted by the sibling Ploinky checkout's real Router
// path (WebChat envelope serializer and MCP invocation minter), verified by the
// production loader against the real Agent helper. No test-local hash is used.
// Router modules bind the workspace at import time, so this file owns an
// isolated Router workspace for its whole process.
const PLOINKY_ROOT = fileURLToPath(new URL('../../../ploinky/', import.meta.url));
const AUDIENCE = 'agent:AchillesIDE/roboTeamAgent';
const savedEnv = { ...process.env };
const savedCwd = process.cwd();
const routerRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ls-owner-')));
for (const key of Object.keys(process.env)) if (/^(PLOINKY_|SSO_)/u.test(key) && key !== 'PLOINKY_AGENTLIB_DIR') delete process.env[key];
process.env.PLOINKY_AGENTLIB_DIR ||= path.join(PLOINKY_ROOT, 'node_modules', 'achillesAgentLib');
process.env.PLOINKY_MASTER_KEY = randomBytes(32).toString('hex');
process.env.PLOINKY_WORKSPACE_ROOT = routerRoot;
process.env.PLOINKY_ROUTER_HOST_PORT = '18080';
process.chdir(routerRoot);
const load = (relative) => import(pathToFileURL(path.join(PLOINKY_ROOT, relative)).href);
const fixtureAgent = path.join(routerRoot, 'fixture-agent');
await fs.mkdir(fixtureAgent);
await fs.writeFile(path.join(fixtureAgent, 'manifest.json'), JSON.stringify({ webchat: { forwardEnvelope: true } }));
for (const [name, value] of Object.entries({
    'routing.json': { routes: { roboTeamAgent: { repo: 'AchillesIDE', agent: 'roboTeamAgent', container: 'ls-owner', hostPath: fixtureAgent, hostPort: 7402 } } },
    'agents.json': { 'ls-owner': { type: 'agent', repoName: 'AchillesIDE', agentName: 'roboTeamAgent', instanceId: 'ls-owner', enableGeneration: 'ls-owner', auth: { mode: 'none' } } },
    'data/edge-routing/desired.json': { hosts: {} },
    'data/router-security/policy-state.json': { schema: 'router-policy', httpRoutes: [], mcpTools: [] },
})) {
    const file = path.join(routerRoot, '.ploinky', name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(value), { mode: 0o600 });
}
const { applyEdgeRoutingGeneration } = await load('cli/sandbox/edgeGeneration.js');
applyEdgeRoutingGeneration({ workspaceRoot: routerRoot, reason: 'live-sessions-owner-test' });
const { serializeWebchatEnvelopeForAgent } = await load('cli/server/handlers/webchat/messageEnvelope.js');
const { buildInvocationContextForProviderCall } = await load('cli/server/mcp-proxy/index.js');
const { deriveAgentRequestSecret } = await load('cli/utils/security/masterKey.js');
const { verifyRouterRequestFromHeaders } = await load('Agent/lib/invocationAuth.mjs');
const { computeRchTool } = await load('Agent/lib/requestHash.mjs');
const { createMemoryReplayCache } = await load('Agent/lib/jwtVerify.mjs');
const AGENT_ENV = { PLOINKY_AGENT_RUNTIME_ROOT: path.join(PLOINKY_ROOT, 'Agent'), PLOINKY_AGENT_ID: AUDIENCE,
    PLOINKY_AGENT_SECRET: deriveAgentRequestSecret(AUDIENCE, { encoding: 'hex' }) };

test.after(async () => {
    process.chdir(savedCwd);
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    await fs.rm(routerRoot, { recursive: true, force: true });
});

const USER = { id: 'owner-1', roles: ['user'] };
const routerRequest = (user = USER) => ({ headers: { host: 'localhost' }, socket: {}, user, authMode: 'sso' });

// Runs `mint` with the Router clock shifted by `offsetMs`.
function withClock(offsetMs, mint) {
    const RealDate = Date;
    globalThis.Date = class extends RealDate {
        constructor(...args) { super(...(args.length ? args : [RealDate.now() + offsetMs])); }
        static now() { return RealDate.now() + offsetMs; }
    };
    try { return mint(); } finally { globalThis.Date = RealDate; }
}

function mint(tabId, { user = USER, text = 'Live session owner claim', presentation = { visible: true }, offsetMs = 0 } = {}) {
    return withClock(offsetMs, () => JSON.parse(serializeWebchatEnvelopeForAgent({
        req: routerRequest(user), effectiveConfig: { agentName: 'roboTeamAgent' }, tabId, pageInstanceId: 'ls-page',
        envelope: { text, attachments: [], references: [], presentation },
    })));
}

// The raw signed arguments, exactly as the copilot keeps them at envelope arrival.
const argsOf = (raw) => ({ surface: 'webchat', tabId: raw.sourceTabId, pageInstanceId: raw.sourcePageInstanceId,
    text: raw.text, attachments: raw.attachments, references: raw.references || [], presentation: raw.presentation });

async function startOwnerIpc(t, env = AGENT_ENV) {
    const verifyOwner = await loadOwnerVerifier(env);
    assert.equal(typeof verifyOwner, 'function', 'production loader resolves the real Agent verifier');
    const { socketPath, cleanup } = await socketFixture();
    const registry = new LiveSessionsRegistry();
    const server = new LiveSessionsIpcServer({ registry, verifyOwner, log: () => {} });
    await server.listen(socketPath);
    const client = await ipcClient(socketPath);
    t.after(async () => { await client.close(); await server.close(); registry.close(); await cleanup(); });
    await client.hello();
    let claims = 0;
    const claim = async (token, args) => {
        const claimId = `claim-${claims += 1}`;
        client.send({ type: 'owner-claim', claimId, token, args });
        return client.next((message) => message.claimId === claimId);
    };
    return { registry, client, claim };
}

test('a real Router WebChat token gives an owner handle and a verified run for the signed principal', async (t) => {
    const { registry, client, claim } = await startOwnerIpc(t);
    const raw = mint('valid');
    assert.ok(raw.invocation?.token, 'the real serializer minted a token');
    const handle = await claim(raw.invocation.token, argsOf(raw));
    assert.equal(handle.type, 'owner-handle');
    const started = await client.start({ localRef: 'turn', ownerHandle: handle.ownerHandle });
    const [row] = registry.list({ principal: 'user:owner-1', canAdmin: false });
    assert.equal(row.id, started.runId);
    assert.equal(row.ownerState, 'verified');
    assert.equal(row.isOwner, true);
    assert.deepEqual(registry.list({ principal: 'user:someone-else', canAdmin: false }), []);
});

test('the claim hash covers the full request tuple; hashing only inner arguments is refused (call-shape control)', async (t) => {
    const { claim } = await startOwnerIpc(t);
    const raw = mint('tuple');
    const innerOnly = verifyRouterRequestFromHeaders({ authorization: `Bearer ${raw.invocation.token}` }, {
        env: AGENT_ENV, method: 'POST', path: '/mcp', tool: '__webchat_message__',
        rch: computeRchTool(argsOf(raw)), replayCache: createMemoryReplayCache({ maxSize: 8 }),
    });
    assert.equal(innerOnly.ok, false);
    assert.equal(innerOnly.reason, 'jwtVerify: request hash mismatch');
    assert.equal((await claim(raw.invocation.token, argsOf(raw))).type, 'owner-handle', 'the production loader hashes the full tuple');
});

test('a replayed claim is refused', async (t) => {
    const { claim } = await startOwnerIpc(t);
    const raw = mint('replay');
    assert.equal((await claim(raw.invocation.token, argsOf(raw))).type, 'owner-handle');
    assert.equal((await claim(raw.invocation.token, argsOf(raw))).type, 'owner-rejected');
});

test('changed text, presentation, tab, page, attachments or references are refused', async (t) => {
    const { claim } = await startOwnerIpc(t);
    for (const [name, change] of Object.entries({
        text: (args) => { args.text += ' changed'; },
        presentation: (args) => { args.presentation = { ...args.presentation, visible: false }; },
        presentationDropped: (args) => { delete args.presentation; },
        surface: (args) => { args.surface = 'cli'; },
        tab: (args) => { args.tabId = 'other'; },
        page: (args) => { args.pageInstanceId = 'other'; },
        attachments: (args) => { args.attachments = [{ filename: 'changed' }]; },
        references: (args) => { args.references = [{ kind: 'workspace-path', path: 'changed' }]; },
    })) {
        const raw = mint(`tamper-${name}`);
        const args = structuredClone(argsOf(raw));
        change(args);
        assert.equal((await claim(raw.invocation.token, args)).type, 'owner-rejected', name);
    }
});

test('a token for another tool or another agent audience is refused', async (t) => {
    const { claim } = await startOwnerIpc(t);
    const raw = mint('tool');
    const args = argsOf(raw);
    const otherTool = buildInvocationContextForProviderCall({ req: routerRequest(), agentName: 'roboTeamAgent', toolName: 'other_tool', toolArgs: args });
    assert.ok(otherTool?.token, 'the real minter issued the other-tool token');
    assert.equal((await claim(otherTool.token, args)).type, 'owner-rejected', 'wrong tool');
    const elsewhere = await startOwnerIpc(t, { ...AGENT_ENV, PLOINKY_AGENT_ID: 'agent:AchillesIDE/otherAgent' });
    const fresh = mint('audience');
    assert.equal((await elsewhere.claim(fresh.invocation.token, argsOf(fresh))).type, 'owner-rejected', 'wrong audience');
    assert.equal((await claim(fresh.invocation.token, argsOf(fresh))).type, 'owner-handle', 'control: the same token is valid for its audience');
    const retired = await startOwnerIpc(t, { ...AGENT_ENV, PLOINKY_AGENT_ID: 'agent:AchillesCLI/roboTeamAgent' });
    const moved = mint('retired-audience');
    assert.equal((await retired.claim(moved.invocation.token, argsOf(moved))).type, 'owner-rejected', 'retired repository audience');
    assert.equal((await claim(moved.invocation.token, argsOf(moved))).type, 'owner-handle', 'current Explorer owner');
});

test('an expired token is refused', async (t) => {
    const { claim } = await startOwnerIpc(t);
    const raw = mint('expired', { offsetMs: -120 * 1000 });
    assert.equal((await claim(raw.invocation.token, argsOf(raw))).type, 'owner-rejected');
});

test('a run started after its admitted token expired stays verified', async (t) => {
    const { registry, client, claim } = await startOwnerIpc(t);
    // Issued 57 s ago: valid now (30 s lifetime plus 30 s clock skew), expired in about 3 s.
    const raw = mint('delayed', { offsetMs: -57 * 1000 });
    const handle = await claim(raw.invocation.token, argsOf(raw));
    assert.equal(handle.type, 'owner-handle');
    await delay(5000);
    const late = verifyRouterRequestFromHeaders({ authorization: `Bearer ${raw.invocation.token}` }, {
        env: AGENT_ENV, method: 'POST', path: '/mcp', tool: '__webchat_message__',
        rch: computeRchTool({ method: 'POST', path: '/mcp', tool: '__webchat_message__', arguments: argsOf(raw) }),
        replayCache: createMemoryReplayCache({ maxSize: 8 }),
    });
    assert.equal(late.ok, false);
    assert.equal(late.reason, 'jwtVerify: token expired');
    const started = await client.start({ localRef: 'delayed', ownerHandle: handle.ownerHandle });
    const row = registry.list({ principal: 'user:owner-1', canAdmin: false }).find((item) => item.id === started.runId);
    assert.equal(row?.ownerState, 'verified');
});

test('without the Agent verifier no claim is accepted', async () => {
    const logs = [];
    assert.equal(await loadOwnerVerifier({ ...AGENT_ENV, PLOINKY_AGENT_RUNTIME_ROOT: path.join(routerRoot, 'missing-agent') }, { log: (line) => logs.push(line) }), null);
    assert.equal(logs.length, 1);
});

test('a valid token whose actor is an agent, not a direct user, proves no owner', async (t) => {
    const { claim } = await startOwnerIpc(t);
    const raw = mint('agent-actor');
    const args = argsOf(raw);
    const delegated = buildInvocationContextForProviderCall({
        req: { headers: { host: 'localhost' }, socket: {}, delegatedAgentVerified: { callerPrincipal: 'agent:AchillesIDE/otherAgent' } },
        agentName: 'roboTeamAgent', toolName: '__webchat_message__', toolArgs: args,
    });
    assert.ok(delegated?.token, 'the real minter issued an agent-actor token');
    const verified = verifyRouterRequestFromHeaders({ authorization: `Bearer ${delegated.token}` }, {
        env: AGENT_ENV, method: 'POST', path: '/mcp', tool: '__webchat_message__',
        rch: computeRchTool({ method: 'POST', path: '/mcp', tool: '__webchat_message__', arguments: args }),
        replayCache: createMemoryReplayCache({ maxSize: 8 }),
    });
    assert.equal(verified.ok, true, 'control: the token itself verifies');
    assert.equal(verified.payload.actor.kind, 'agent');
    const fresh = buildInvocationContextForProviderCall({
        req: { headers: { host: 'localhost' }, socket: {}, delegatedAgentVerified: { callerPrincipal: 'agent:AchillesIDE/otherAgent' } },
        agentName: 'roboTeamAgent', toolName: '__webchat_message__', toolArgs: args,
    });
    assert.equal((await claim(fresh.token, args)).type, 'owner-rejected');
});

test('a token replayed after its expiry but inside the clock skew is still refused', async (t) => {
    const { claim } = await startOwnerIpc(t);
    // Issued 40 s ago: exp passed 10 s ago, accepted for 20 s more by the skew.
    const raw = mint('skew-replay', { offsetMs: -40 * 1000 });
    assert.equal((await claim(raw.invocation.token, argsOf(raw))).type, 'owner-handle');
    await delay(1500);
    assert.equal((await claim(raw.invocation.token, argsOf(raw))).type, 'owner-rejected');
});

test('an unconfigured verifier is reported at startup and accepts no claim', async () => {
    for (const missing of ['PLOINKY_AGENT_SECRET', 'PLOINKY_AGENT_ID']) {
        const logs = [];
        const env = { ...AGENT_ENV };
        delete env[missing];
        assert.equal(await loadOwnerVerifier(env, { log: (line) => logs.push(line) }), null, missing);
        assert.deepEqual(logs, ['[live-sessions] owner verification is unavailable (PLOINKY_AGENT_SECRET and PLOINKY_AGENT_ID are required); IPC runs publish as owner unverified']);
    }
});
