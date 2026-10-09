import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRoboTeamServer } from '../server/http-server.mjs';
import { RobotStore } from '../server/robot-store.mjs';

// Robot listing is authorized only from the Router-signed request. Every
// signed fixture is minted by the sibling Ploinky checkout's real HTTP-route
// minter and verified by its real Agent helper; this file fails to load if that
// checkout is missing.
const PLOINKY_ROOT = fileURLToPath(new URL('../../../ploinky/', import.meta.url));
const MASTER_KEY = '3'.repeat(64);
process.env.PLOINKY_MASTER_KEY = MASTER_KEY;
// Ploinky's signer resolves AchillesAgentLib only from an explicit source.
process.env.PLOINKY_AGENTLIB_DIR ||= path.join(PLOINKY_ROOT, 'node_modules', 'achillesAgentLib');
const { buildHttpRouteAuthInfoHeader, buildPlainAuthInfoHeader } = await import(new URL('cli/server/routerHandlers.js', `file://${PLOINKY_ROOT}`).href);
const { deriveAgentRequestSecret } = await import(new URL('cli/utils/security/masterKey.js', `file://${PLOINKY_ROOT}`).href);

const AGENT_ID = 'agent:AchillesCLI/roboTeamAgent';
const DEFINITION = { includeAuthInfo: true, issueInvocation: true, routeKey: 'roboTeamAgent', route: { repo: 'AchillesCLI', agent: 'roboTeamAgent' } };
const EXTERNAL_PREFIX = '/base-agent-additional-server/roboTeamAgent/3001';
const ENV_KEYS = ['PLOINKY_AGENT_RUNTIME_ROOT', 'PLOINKY_AGENT_ID', 'PLOINKY_AGENT_SECRET'];

function configureAgentEnv(overrides = {}) {
    const previous = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    const next = {
        PLOINKY_AGENT_RUNTIME_ROOT: path.join(PLOINKY_ROOT, 'Agent'),
        PLOINKY_AGENT_ID: AGENT_ID,
        PLOINKY_AGENT_SECRET: deriveAgentRequestSecret(AGENT_ID),
        ...overrides,
    };
    for (const key of ENV_KEYS) {
        if (next[key] === undefined) delete process.env[key];
        else process.env[key] = next[key];
    }
    return () => {
        for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    };
}

const PRINCIPALS = {
    selfRegistered: { id: 'self-1', username: 'self', email: 'self@example.test', roles: ['selfRegistered'], capabilities: ['selfregistered.dashboard.access'] },
    explorerUser: { id: 'member-1', username: 'member', email: 'member@example.test', roles: ['user'], capabilities: ['explorer.access'] },
    adminNotNamedAdmin: { id: 'owner-1', username: 'owner', email: 'owner@example.test', roles: ['admin'], capabilities: [] },
    adminRoleSpacing: { id: 'owner-2', username: 'owner2', email: 'owner2@example.test', roles: [' Admin '], capabilities: [] },
    namedAdmin: { id: 'member-2', username: 'admin', email: 'admin@example.test', roles: ['user'], capabilities: [] },
    localAdminAlias: { id: 'local:admin', username: 'admin', email: '', roles: ['user'], capabilities: [] },
    adminGuest: { id: 'owner-3', username: 'owner3', email: '', roles: ['admin', 'guest'], capabilities: ['explorer.access'] },
    upperGuest: { id: 'guest-1', username: 'guest', email: '', roles: ['GUEST'], capabilities: ['explorer.access'] },
};

function signedHeaders(user, { pathname = '/api/robots', search = '' } = {}) {
    const external = `${EXTERNAL_PREFIX}${pathname}${search}`;
    const req = { method: 'GET', url: external, headers: {}, user };
    return buildHttpRouteAuthInfoHeader(req, new URL(`http://127.0.0.1:8080${external}`), DEFINITION, { routePath: pathname });
}

async function startFixture() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'roboteam-listing-test-'));
    const robotStore = new RobotStore({ dataDir: path.join(root, 'private') });
    await robotStore.initialize();
    const workspaceRoot = path.join(root, 'workspace');
    await fs.mkdir(workspaceRoot);
    const runtimeManager = { workspaceRoot, status: () => ({ state: 'stopped' }), activePort: () => null, hasUnfinishedTasks: () => false };
    const server = createRoboTeamServer({ robotStore, runtimeManager, internalToken: 'listing-token', publicBasePath: '/rt/', mcpPort: 65534 });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const robot = await robotStore.create({ name: 'Listed Robot' });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    return {
        robot,
        get: (pathname, headers = {}) => fetch(`${baseUrl}${pathname}`, { headers }),
        close: async () => {
            await new Promise((resolve) => server.close(resolve));
            await fs.rm(root, { recursive: true, force: true });
        },
    };
}

async function expectStatus(response, status, label) {
    const body = await response.json().catch(() => null);
    assert.equal(response.status, status, `${label}: ${JSON.stringify(body)}`);
    return body;
}

test('signed robot listing follows the verified listing entitlement matrix', async (t) => {
    t.after(configureAgentEnv());
    const fixture = await startFixture();
    t.after(fixture.close);
    // Positive controls prove the fixture signs correctly and the store is not empty.
    for (const [name, canAdmin] of [['explorerUser', false], ['adminNotNamedAdmin', true], ['adminRoleSpacing', true]]) {
        const body = await expectStatus(await fixture.get('/api/robots', signedHeaders(PRINCIPALS[name])), 200, name);
        assert.equal(body.ok, true);
        assert.equal(body.canAdmin, canAdmin, `${name} canAdmin`);
        assert.deepEqual(body.robots.map((robot) => robot.id), [fixture.robot.id], `${name} sees the task-owned robot`);
    }
    for (const name of ['selfRegistered', 'namedAdmin', 'localAdminAlias', 'adminGuest', 'upperGuest']) {
        const body = await expectStatus(await fixture.get('/api/robots', signedHeaders(PRINCIPALS[name])), 403, name);
        assert.equal(body.robots, undefined, `${name} receives no robots`);
    }
});

test('unsigned, forged and tampered listing requests are rejected before any listing', async (t) => {
    t.after(configureAgentEnv());
    const fixture = await startFixture();
    t.after(fixture.close);
    assert.equal((await fixture.get('/api/robots')).status, 401);
    // A plain header is ignored even when it claims every privilege.
    const forged = { 'x-ploinky-auth-info': JSON.stringify({ user: { id: 'self-1', username: 'admin', roles: [' Admin '], capabilities: ['explorer.access'] } }) };
    await expectStatus(await fixture.get('/api/robots', forged), 401, 'forged plain header');
    await expectStatus(await fixture.get('/api/robots', buildPlainAuthInfoHeader({ user: PRINCIPALS.explorerUser })), 401, 'plain Router header');
    // A valid lesser-user token cannot borrow privileges from its unsigned body.
    const lesser = JSON.parse(signedHeaders(PRINCIPALS.selfRegistered)['x-ploinky-auth-info']);
    lesser.user = { ...lesser.user, roles: ['admin'], capabilities: ['explorer.access'] };
    await expectStatus(await fixture.get('/api/robots', { 'x-ploinky-auth-info': JSON.stringify(lesser) }), 403, 'unsigned privilege widening');

    const valid = JSON.parse(signedHeaders(PRINCIPALS.explorerUser)['x-ploinky-auth-info']);
    const [h, p, s] = valid.invocationToken.split('.');
    const forgedPayload = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url')), actor: { kind: 'user', id: 'user:self-1', roles: ['admin'], capabilities: ['explorer.access'] } })).toString('base64url');
    const variants = {
        signature: { ...valid, invocationToken: `${h}.${p}.${s.slice(0, -2)}AA` },
        payload: { ...valid, invocationToken: `${h}.${forgedPayload}.${s}` },
        method: { ...valid, invocationBody: { ...valid.invocationBody, method: 'POST' } },
        path: { ...valid, invocationBody: { ...valid.invocationBody, path: '/api/robots/other' } },
        query: { ...valid, invocationBody: { ...valid.invocationBody, search: '?all=1' } },
        body: { ...valid, invocationBody: { ...valid.invocationBody, bodyHash: 'A'.repeat(43) } },
    };
    for (const [name, authInfo] of Object.entries(variants)) {
        await expectStatus(await fixture.get('/api/robots', { 'x-ploinky-auth-info': JSON.stringify(authInfo) }), 401, name);
    }
    await expectStatus(await fixture.get('/api/robots?all=1', signedHeaders(PRINCIPALS.explorerUser)), 401, 'query not signed');
    await expectStatus(await fixture.get('/api/robots?all=1', signedHeaders(PRINCIPALS.explorerUser, { search: '?all=1' })), 200, 'signed query');
    // Audience: a token minted for another agent fails here.
    const otherAgent = buildHttpRouteAuthInfoHeader({ method: 'GET', url: `${EXTERNAL_PREFIX}/api/robots`, headers: {}, user: PRINCIPALS.explorerUser },
        new URL(`http://127.0.0.1:8080${EXTERNAL_PREFIX}/api/robots`), { ...DEFINITION, route: { repo: 'AchillesCLI', agent: 'otherAgent' } }, { routePath: '/api/robots' });
    await expectStatus(await fixture.get('/api/robots', otherAgent), 401, 'audience');
    const once = signedHeaders(PRINCIPALS.explorerUser);
    await expectStatus(await fixture.get('/api/robots', once), 200, 'first use');
    await expectStatus(await fixture.get('/api/robots', once), 401, 'replay');
});

test('missing verifier helper, secret or agent id is a setup failure, never an anonymous fallback', async (t) => {
    const fixture = await startFixture();
    t.after(fixture.close);
    for (const overrides of [
        { PLOINKY_AGENT_RUNTIME_ROOT: path.join(os.tmpdir(), 'roboteam-no-agent-runtime') },
        { PLOINKY_AGENT_SECRET: undefined },
        { PLOINKY_AGENT_ID: undefined },
    ]) {
        const restore = configureAgentEnv(overrides);
        try {
            await expectStatus(await fixture.get('/api/robots', signedHeaders(PRINCIPALS.explorerUser)), 503, JSON.stringify(Object.keys(overrides)));
        } finally { restore(); }
    }
});

test('internal robot listing requires the agent origin proof without forwarded user headers', async (t) => {
    t.after(configureAgentEnv());
    const fixture = await startFixture();
    t.after(fixture.close);
    const internal = { 'x-roboteam-internal-token': 'listing-token' };
    const own = await expectStatus(await fixture.get('/api/robots', { ...internal, 'x-roboteam-listing-origin': 'agent' }), 200, 'own-behalf agent');
    assert.equal(own.canAdmin, false);
    assert.deepEqual(own.robots.map((robot) => robot.id), [fixture.robot.id]);
    await expectStatus(await fixture.get('/api/robots', internal), 403, 'no origin proof');
    await expectStatus(await fixture.get('/api/robots', { ...internal, 'x-roboteam-listing-origin': 'user' }), 403, 'other origin');
    await expectStatus(await fixture.get('/api/robots', { ...internal, 'x-roboteam-listing-origin': 'agent', 'x-roboteam-user-id': 'member-1' }), 403, 'forwarded user id');
    await expectStatus(await fixture.get('/api/robots', { ...internal, 'x-roboteam-listing-origin': 'agent', 'x-roboteam-user-roles': '["admin"]' }), 403, 'forwarded user roles');
    await expectStatus(await fixture.get('/api/robots', { 'x-roboteam-internal-token': 'wrong-token', 'x-roboteam-listing-origin': 'agent' }), 401, 'wrong internal token');
});

test('only the exact GET /api/robots path uses the listing gate', async (t) => {
    t.after(configureAgentEnv());
    const fixture = await startFixture();
    t.after(fixture.close);
    const plain = { 'x-ploinky-auth-info': JSON.stringify({ user: { id: 'self-1', username: 'self', roles: ['selfRegistered'] } }) };
    // The session route keeps its existing plain-header handling.
    const session = await fixture.get(`/api/robots/${fixture.robot.id}/session/`, plain);
    assert.equal(session.status, 409);
    assert.equal((await fixture.get('/api/robots/', plain)).status, 404);
});
