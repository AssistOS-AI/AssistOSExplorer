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
    const makeRobot = (id, name) => ({
        id, name, codingAgents: ['opencode'], createdAt: '2026-10-09T00:00:00.000Z', updatedAt: '2026-10-09T00:00:00.000Z',
        skillsets: Object.entries(SOURCES).map(([key, source]) => ({ name: `repo-${key}`, source: source.raw, skills: [{ name: 'alpha', description: 'Alpha skill' }], definitions: [] })),
    });
    robots.set('first-robot-a1b2c3', makeRobot('first-robot-a1b2c3', 'First Robot'));
    const robotStore = {
        list: async () => [...robots.values()],
        get: async (id) => robots.get(id) || null,
        getByName: async (name) => [...robots.values()].find((robot) => robot.name === name) || null,
        create: async ({ name }) => { const robot = makeRobot('created-robot-d4e5f6', name); robots.set(robot.id, robot); return robot; },
        setCodingAgents: async (id, codingAgents) => { robots.get(id).codingAgents = codingAgents; return robots.get(id); },
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
    const server = createRoboTeamServer({ robotStore, runtimeManager, skillsets: {}, internalToken: 'projection-token', publicBasePath: '/rt/', mcpPort: 65534 });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const previous = Object.fromEntries(['PLOINKY_AGENT_RUNTIME_ROOT', 'PLOINKY_AGENT_ID', 'PLOINKY_AGENT_SECRET'].map((key) => [key, process.env[key]]));
    Object.assign(process.env, { PLOINKY_AGENT_RUNTIME_ROOT: path.join(PLOINKY_ROOT, 'Agent'), PLOINKY_AGENT_ID: AGENT_ID, PLOINKY_AGENT_SECRET: deriveAgentRequestSecret(AGENT_ID) });
    const snapshot = structuredClone([...robots.values()]);
    return {
        robots, snapshot, workspaceRoot, activeCwd,
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
        // The legacy unsigned-role gate still admits these callers to the
        // mutation, but none of them may receive privileged metadata.
        for (const [name, headers] of [
            ['named non-admin', signed(PRINCIPALS.namedAdmin, method, pathname, body || '')],
            ['admin+guest', signed(PRINCIPALS.adminGuest, method, pathname, body || '')],
            ['unsigned admin header', { 'x-ploinky-auth-info': JSON.stringify({ user: { id: 'owner-1', username: 'owner', roles: ['admin'] } }) }],
            ['tampered body', signed(PRINCIPALS.admin, method, pathname, body === undefined ? '{}' : `${body} `)],
        ]) {
            const response = await fixture.call(method, pathname, { body, headers });
            assert.equal(response.status, status, `${label} ${name}`);
            assertRestricted(response.json[field], restrictedCwd, `${label} ${name}`);
        }
    }
    const created = fixture.robots.get('created-robot-d4e5f6');
    assert.equal(created.skillsets[0].source, SOURCES.physical.raw, 'stored sources stay raw');
    assert.equal(created.skillsets[1].source, SOURCES.credential.raw, 'stored credential URLs stay raw');
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
