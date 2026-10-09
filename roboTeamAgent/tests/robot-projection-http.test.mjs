import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRoboTeamServer } from '../server/http-server.mjs';

// Every outward robot view (list, create, coding-agent update and run
// get/start/stop) is restricted unless the exact request is a verified
// non-guest administrator. Signed requests are minted by the sibling Ploinky
// checkout's real HTTP-route minter; this file fails to load without it.
const PLOINKY_ROOT = fileURLToPath(new URL('../../../ploinky/', import.meta.url));
process.env.PLOINKY_MASTER_KEY = '4'.repeat(64);
process.env.PLOINKY_AGENTLIB_DIR ||= path.join(PLOINKY_ROOT, 'node_modules', 'achillesAgentLib');
const { buildHttpRouteAuthInfoHeader } = await import(new URL('cli/server/routerHandlers.js', `file://${PLOINKY_ROOT}`).href);
const { deriveAgentRequestSecret } = await import(new URL('cli/utils/security/masterKey.js', `file://${PLOINKY_ROOT}`).href);
const { sha256RawBodyHash } = await import(new URL('Agent/lib/requestHash.mjs', `file://${PLOINKY_ROOT}`).href);

const AGENT_ID = 'agent:AchillesCLI/roboTeamAgent';
const DEFINITION = { includeAuthInfo: true, issueInvocation: true, routeKey: 'roboTeamAgent', route: { repo: 'AchillesCLI', agent: 'roboTeamAgent' } };
const PREFIX = '/base-agent-additional-server/roboTeamAgent/3001';
const TOKEN = 'ghp_SENTINELTOKEN0000000000000000';
// Synthetic sentinel sources: a physical path and credential-bearing URLs.
const SOURCES = {
    physical: { raw: '/sentinel-host/workspace/.ploinky/repos/private-skills', restricted: '' },
    credential: { raw: `https://${TOKEN}:x-oauth-basic@github.com/owner/skills.git?access_token=SENTINELQUERY#SENTINELFRAG`, restricted: 'https://github.com/owner/skills.git' },
    encodedUser: { raw: 'https://us%65r:p%61ss@git.example.test:8443/team/skills', restricted: 'https://git.example.test:8443/team/skills' },
    scp: { raw: 'git@github.com:owner/scp-skills.git', restricted: 'github.com:owner/scp-skills.git' },
    file: { raw: 'file:///sentinel-host/skills', restricted: '' },
};
const PRINCIPALS = {
    admin: { id: 'owner-1', username: 'owner', email: '', roles: ['admin'], capabilities: [] },
    member: { id: 'member-1', username: 'member', email: '', roles: ['user'], capabilities: ['explorer.access'] },
    namedAdmin: { id: 'member-2', username: 'admin', email: '', roles: ['user'], capabilities: ['explorer.access'] },
    adminGuest: { id: 'owner-2', username: 'owner2', email: '', roles: ['admin', 'guest'], capabilities: ['explorer.access'] },
};

function signed(user, method, pathname, body = '') {
    const external = `${PREFIX}${pathname}`;
    const req = { method, url: external, headers: {}, user };
    return buildHttpRouteAuthInfoHeader(req, new URL(`http://127.0.0.1:8080${external}`), DEFINITION, {
        bodyHash: sha256RawBodyHash(Buffer.from(body)), routePath: pathname,
    });
}

async function startFixture() {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'roboteam-projection-test-')));
    const workspaceRoot = path.join(root, 'workspace');
    await fs.mkdir(path.join(workspaceRoot, 'project', 'sub'), { recursive: true });
    const robots = new Map();
    const workflows = new Map();
    const mutations = { createRobot: 0, codingAgents: 0, createWorkflow: 0 };
    const makeRobot = (id, name) => ({
        id, name, codingAgents: ['opencode'], createdAt: '2026-10-09T00:00:00.000Z', updatedAt: '2026-10-09T00:00:00.000Z',
        skillsets: Object.entries(SOURCES).map(([key, source]) => ({ name: `repo-${key}`, source: source.raw, skills: [{ name: 'alpha', description: 'Alpha skill' }], definitions: [] })),
    });
    robots.set('first-robot-a1b2c3', makeRobot('first-robot-a1b2c3', 'First Robot'));
    const robotStore = {
        list: async () => [...robots.values()],
        get: async (id) => robots.get(id) || null,
        getByName: async (name) => [...robots.values()].find((robot) => robot.name === name) || null,
        create: async ({ name }) => { mutations.createRobot++; const robot = makeRobot('created-robot-d4e5f6', name); robots.set(robot.id, robot); return robot; },
        setCodingAgents: async (id, codingAgents) => { mutations.codingAgents++; robots.get(id).codingAgents = codingAgents; return robots.get(id); },
    };
    const roboflow = {
        refreshCoverage: async () => {},
        createWorkflow: async (workflow) => { mutations.createWorkflow++; workflows.set(workflow.id, workflow); return workflow; },
    };
    const activeCwd = path.join(workspaceRoot, 'project', 'sub');
    const runtimeManager = {
        workspaceRoot,
        status: () => ({ state: 'stopped', task: { taskId: 'task-1', state: 'completed', cwd: activeCwd, logTail: '' }, queueDepth: 0 }),
        start: async () => ({ state: 'running', mode: 'browser', task: { taskId: 'task-2', state: 'running', cwd: workspaceRoot } }),
        stop: async () => ({ state: 'stopped', task: { taskId: 'task-3', state: 'stopped', cwd: '/sentinel-host/outside' } }),
        activePort: () => null,
        hasUnfinishedTasks: () => false,
    };
    const server = createRoboTeamServer({ robotStore, runtimeManager, roboflow, skillsets: {}, internalToken: 'projection-token', publicBasePath: '/rt/', mcpPort: 65534 });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const previous = Object.fromEntries(['PLOINKY_AGENT_RUNTIME_ROOT', 'PLOINKY_AGENT_ID', 'PLOINKY_AGENT_SECRET'].map((key) => [key, process.env[key]]));
    Object.assign(process.env, { PLOINKY_AGENT_RUNTIME_ROOT: path.join(PLOINKY_ROOT, 'Agent'), PLOINKY_AGENT_ID: AGENT_ID, PLOINKY_AGENT_SECRET: deriveAgentRequestSecret(AGENT_ID) });
    const snapshot = structuredClone([...robots.values()]);
    return {
        robots, workflows, mutations, snapshot, workspaceRoot, activeCwd,
        async call(method, pathname, { headers = {}, body } = {}) {
            const response = await fetch(`${baseUrl}${pathname}`, { method, headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body });
            const json = await response.json();
            return { status: response.status, json };
        },
        close: async () => {
            await new Promise((resolve) => server.close(resolve));
            for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
            await fs.rm(root, { recursive: true, force: true });
        },
    };
}

function sourcesOf(robot) {
    return Object.fromEntries(robot.repositories.map((repository) => [repository.id.replace(/^repo-/, ''), repository.source]));
}
const RAW = Object.fromEntries(Object.entries(SOURCES).map(([key, value]) => [key, value.raw]));
const RESTRICTED = Object.fromEntries(Object.entries(SOURCES).map(([key, value]) => [key, value.restricted]));

function assertRestricted(robot, expectedCwd, label) {
    assert.deepEqual(sourcesOf(robot), RESTRICTED, `${label}: repository sources are projected`);
    if (expectedCwd === undefined) assert.equal('cwd' in robot.run.task, false, `${label}: escaping cwd is omitted`);
    else assert.equal(robot.run.task.cwd, expectedCwd, `${label}: cwd is workspace-relative`);
    const text = JSON.stringify(robot);
    for (const sentinel of [TOKEN, 'SENTINELQUERY', 'SENTINELFRAG', '/sentinel-host', 'p%61ss']) assert.equal(text.includes(sentinel), false, `${label}: ${sentinel}`);
}

function assertPrivileged(robot, expectedCwd, label) {
    assert.deepEqual(sourcesOf(robot), RAW, `${label}: administrator sees raw sources`);
    assert.equal(robot.run.task.cwd, expectedCwd, `${label}: administrator sees the physical cwd`);
}

test('robot listing projects repository sources and task cwd unless the caller is a verified administrator', async (t) => {
    const fixture = await startFixture();
    t.after(fixture.close);
    const admin = await fixture.call('GET', '/api/robots', { headers: signed(PRINCIPALS.admin, 'GET', '/api/robots') });
    assert.equal(admin.status, 200);
    assert.equal(admin.json.canAdmin, true);
    assertPrivileged(admin.json.robots[0], fixture.activeCwd, 'admin list');
    for (const name of ['member', 'namedAdmin']) {
        const response = await fixture.call('GET', '/api/robots', { headers: signed(PRINCIPALS[name], 'GET', '/api/robots') });
        assert.equal(response.status, 200, name);
        assertRestricted(response.json.robots[0], 'project/sub', `${name} list`);
    }
    const internal = await fixture.call('GET', '/api/robots', { headers: { 'x-roboteam-internal-token': 'projection-token', 'x-roboteam-listing-origin': 'agent' } });
    assert.equal(internal.status, 200);
    assertRestricted(internal.json.robots[0], 'project/sub', 'internal agent list');
    assert.deepEqual([...fixture.robots.values()], fixture.snapshot, 'stored robot configuration is unchanged');
});

test('create, coding-agent update and run responses use the same projection', async (t) => {
    const fixture = await startFixture();
    t.after(fixture.close);
    const robotId = 'first-robot-a1b2c3';
    const createBody = JSON.stringify({ name: 'Created Robot' });
    const patchBody = JSON.stringify({ codingAgents: ['codex'] });
    const runBody = JSON.stringify({ mode: 'browser' });
    const calls = [
        ['POST', '/api/robots', createBody, 'robot', 201, fixture.activeCwd, 'project/sub'],
        ['PATCH', `/api/robots/${robotId}/coding-agents`, patchBody, 'robot', 200, fixture.activeCwd, 'project/sub'],
        ['GET', `/api/robots/${robotId}/run`, undefined, 'robot', 200, fixture.activeCwd, 'project/sub'],
        ['POST', `/api/robots/${robotId}/run`, runBody, 'robot', 200, fixture.workspaceRoot, '.'],
        ['DELETE', `/api/robots/${robotId}/run`, undefined, 'robot', 200, '/sentinel-host/outside', undefined],
    ];
    for (const [method, pathname, body, field, status, rawCwd, restrictedCwd] of calls) {
        const label = `${method} ${pathname}`;
        const admin = await fixture.call(method, pathname, { body, headers: signed(PRINCIPALS.admin, method, pathname, body || '') });
        assert.equal(admin.status, status, `${label} admin`);
        assertPrivileged(admin.json[field], rawCwd, `${label} admin`);
        for (const [name, headers] of [
            ['ordinary member', signed(PRINCIPALS.member, method, pathname, body || '')],
            ['named non-admin', signed(PRINCIPALS.namedAdmin, method, pathname, body || '')],
            ['admin+guest', signed(PRINCIPALS.adminGuest, method, pathname, body || '')],
            ['unsigned admin header', { 'x-ploinky-auth-info': JSON.stringify({ user: { id: 'owner-1', username: 'owner', roles: ['admin'] } }) }],
            ['tampered body', signed(PRINCIPALS.admin, method, pathname, body === undefined ? '{}' : `${body} `)],
        ]) {
            const response = await fixture.call(method, pathname, { body, headers });
            if (['ordinary member', 'named non-admin', 'admin+guest'].includes(name) && ['/api/robots', `/api/robots/${robotId}/coding-agents`].includes(pathname)) {
                assert.equal(response.status, 403, `${label} ${name}`);
                assert.equal('robot' in response.json, false, `${label} ${name}: no robot payload`);
                continue;
            }
            assert.equal(response.status, status, `${label} ${name}`);
            assertRestricted(response.json[field], restrictedCwd, `${label} ${name}`);
        }
    }
    const created = fixture.robots.get('created-robot-d4e5f6');
    assert.equal(created.skillsets[0].source, SOURCES.physical.raw, 'stored sources stay raw');
    assert.equal(created.skillsets[1].source, SOURCES.credential.raw, 'stored credential URLs stay raw');
});

const ADMIN_MUTATIONS = [
    ['POST', '/api/robots', { name: 'Created Robot' }, 201],
    ['PATCH', '/api/robots/first-robot-a1b2c3/coding-agents', { codingAgents: ['codex'] }, 200],
    ['POST', '/api/roboflow/workflows', { id: 'workflow-1', name: 'Workflow' }, 201],
];

function internalHeaders(id, roles) {
    return { 'x-roboteam-internal-token': 'projection-token', 'x-roboteam-user-id': id, 'x-roboteam-user-roles': JSON.stringify(roles) };
}

test('administrator mutations reject name aliases, guest roles and unprivileged internal actors without side effects', async (t) => {
    const browserActors = {
        namedAdmin: PRINCIPALS.namedAdmin,
        nameFallback: { ...PRINCIPALS.member, username: '', name: 'admin' },
        normalizedName: { ...PRINCIPALS.member, username: ' AdMiN ' },
        normalizedNameFallback: { ...PRINCIPALS.member, username: '', name: ' AdMiN ' },
        localIdWithoutRoles: { id: 'local:admin', username: 'local', roles: [] },
        adminGuest: PRINCIPALS.adminGuest,
        normalizedAdminGuest: { ...PRINCIPALS.admin, roles: [' AdMiN ', ' GuEsT '] },
    };
    const callers = [
        ...Object.entries(browserActors).map(([name, actor]) => [name, (method, pathname, body) => signed(actor, method, pathname, body)]),
        ['forwarded nonadmin', () => internalHeaders('local:admin', ['user'])],
        ['forwarded admin+guest', () => internalHeaders('owner', [' ADMIN ', ' GUEST '])],
        ['internal agent only', () => ({ 'x-roboteam-internal-token': 'projection-token' })],
    ];
    for (const [name, headersFor] of callers) {
        await t.test(name, async (t) => {
            const fixture = await startFixture();
            t.after(fixture.close);
            for (const [method, pathname, input] of ADMIN_MUTATIONS) {
                const body = JSON.stringify(input);
                const headers = headersFor(method, pathname, body);
                if (name.includes('Fallback')) {
                    assert.equal(JSON.parse(headers['x-ploinky-auth-info']).user.username.trim().toLowerCase(), 'admin', 'real Router minter uses the name fallback');
                }
                const response = await fixture.call(method, pathname, { body, headers });
                assert.equal(response.status, 403, `${name}: ${method} ${pathname}`);
                assert.equal(response.json.error, 'administrator role is required');
                assert.equal('robot' in response.json, false);
                assert.deepEqual(fixture.mutations, { createRobot: 0, codingAgents: 0, createWorkflow: 0 });
                assert.deepEqual([...fixture.robots.values()], fixture.snapshot);
                assert.equal(fixture.workflows.size, 0);
            }
        });
    }
});

test('differently named administrators, local CLI roles and forwarded administrators retain mutation authority', async (t) => {
    const callers = [
        ['differently named admin', (method, pathname, body) => signed(PRINCIPALS.admin, method, pathname, body)],
        ['normalized admin role', (method, pathname, body) => signed({ ...PRINCIPALS.admin, roles: [' UsEr ', ' AdMiN '] }, method, pathname, body)],
        // Ploinky cli/commands/client.js supplies these local session roles.
        ['local CLI', (method, pathname, body) => signed({ id: 'local:admin', username: 'admin', name: 'Local CLI', email: '', roles: ['user', 'admin'] }, method, pathname, body)],
        ['forwarded admin', () => internalHeaders('another-admin', ['user', ' ADMIN '])],
    ];
    for (const [name, headersFor] of callers) {
        await t.test(name, async (t) => {
            const fixture = await startFixture();
            t.after(fixture.close);
            for (const [method, pathname, input, status] of ADMIN_MUTATIONS) {
                const body = JSON.stringify(input);
                const response = await fixture.call(method, pathname, { body, headers: headersFor(method, pathname, body) });
                assert.equal(response.status, status, `${name}: ${method} ${pathname}`);
            }
            assert.deepEqual(fixture.mutations, { createRobot: 1, codingAgents: 1, createWorkflow: 1 });
            assert.equal(fixture.robots.get('created-robot-d4e5f6').name, 'Created Robot');
            assert.deepEqual(fixture.robots.get('first-robot-a1b2c3').codingAgents, ['codex']);
            assert.deepEqual(fixture.workflows.get('workflow-1'), ADMIN_MUTATIONS[2][2]);
        });
    }
});

test('missing verifier configuration falls back to the restricted projection', async (t) => {
    const fixture = await startFixture();
    t.after(fixture.close);
    const secret = process.env.PLOINKY_AGENT_SECRET;
    delete process.env.PLOINKY_AGENT_SECRET;
    t.after(() => { process.env.PLOINKY_AGENT_SECRET = secret; });
    const pathname = '/api/robots/first-robot-a1b2c3/run';
    const response = await fixture.call('GET', pathname, { headers: signed(PRINCIPALS.admin, 'GET', pathname) });
    assert.equal(response.status, 200);
    assertRestricted(response.json.robot, 'project/sub', 'no agent secret');
});
