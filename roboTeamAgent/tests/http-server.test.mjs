import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRoboTeamServer } from '../server/http-server.mjs';
import { RobotStore } from '../server/robot-store.mjs';

function authHeader(userId, roles = ['user']) {
    return JSON.stringify({ user: { id: userId, username: userId, roles } });
}

async function startFixture(options = {}) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'roboteam-http-test-'));
    const dataDir = path.join(root, 'private');
    const workspaceRoot = path.join(root, 'workspace');
    await fs.mkdir(workspaceRoot);
    // The server builds its skillsets service from the configured Ploinky workspace.
    const previousWorkspaceRoot = process.env.PLOINKY_WORKSPACE_ROOT;
    process.env.PLOINKY_WORKSPACE_ROOT = workspaceRoot;
    const robotStore = new RobotStore({ dataDir });
    await robotStore.initialize();
    const runs = new Map();
    const runtimeManager = {
        workspaceRoot,
        ...(process.env.LIVE_SKILLS_ALA_ROOT ? { alaCommand: path.join(process.env.LIVE_SKILLS_ALA_ROOT, 'bin/ala.mjs') } : {}),
        status: (id) => runs.get(id) || { state: 'stopped' },
        start: async (robot, mode) => {
            const run = { state: 'running', mode, sessionUrl: `/rt/api/robots/${robot.id}/session/` };
            runs.set(robot.id, run);
            return run;
        },
        stop: async (id) => { runs.delete(id); return { state: 'stopped' }; },
        logs: async () => 'line one',
        activePort: () => null,
        hasUnfinishedTasks: () => false,
    };
    const server = createRoboTeamServer({ robotStore, runtimeManager, internalToken: 'test-token', publicBasePath: '/rt/', mcpPort: 65534, ...options });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return {
        server,
        robotStore,
        runtimeManager,
        workspaceRoot,
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        close: async () => {
            await new Promise((resolve) => server.close(resolve));
            if (previousWorkspaceRoot === undefined) delete process.env.PLOINKY_WORKSPACE_ROOT;
            else process.env.PLOINKY_WORKSPACE_ROOT = previousWorkspaceRoot;
            await fs.rm(root, { recursive: true, force: true });
        },
    };
}

test('terminal home endpoint requires administrator access', async () => {
    const fixture = await startFixture();
    try {
        const robot = await fixture.robotStore.create({ name: 'terminal-robot' });
        const url = `${fixture.baseUrl}/api/robots/${robot.id}/terminal`;
        assert.equal((await fetch(url, { method: 'POST' })).status, 401);
        assert.equal((await fetch(url, { method: 'POST', headers: { 'x-ploinky-auth-info': authHeader('user') } })).status, 403);
        assert.equal((await fetch(url, { method: 'POST', headers: { 'x-roboteam-internal-token': 'test-token' } })).status, 403);
        assert.equal(fixture.runtimeManager.status(robot.id).state, 'stopped');
    } finally { await fixture.close(); }
});

test('coding-agent settings require an administrator and accept multiple agents through the API', async t => {
    const fixture = await startFixture();
    t.after(fixture.close);
    const robot = await fixture.robotStore.create({ name: 'configured' });
    const url = `${fixture.baseUrl}/api/robots/${robot.id}/coding-agents`;
    const update = (roles, codingAgents) => fetch(url, { method: 'PATCH',
        headers: { 'content-type': 'application/json', 'x-ploinky-auth-info': authHeader('actor', roles) },
        body: JSON.stringify({ codingAgents }) });
    assert.equal((await update(['user'], ['pi'])).status, 403);
    const single = await update(['admin'], ['opencode']);
    assert.equal(single.status, 200);
    assert.deepEqual((await single.json()).robot.codingAgents, ['opencode']);
    const multiple = await update(['admin'], ['codex', 'opencode', 'pi']);
    assert.equal(multiple.status, 200);
    assert.deepEqual((await multiple.json()).robot.codingAgents, ['codex', 'opencode', 'pi']);
    await fixture.runtimeManager.start(robot, 'desktop');
    assert.equal((await update(['admin'], ['pi'])).status, 409);
});

test('robot API shares workspace robots and restricts creation to administrators', async () => {
    const fixture = await startFixture();
    try {
        assert.equal((await fetch(`${fixture.baseUrl}/api/robots`)).status, 401);
        const created = await fetch(`${fixture.baseUrl}/api/robots`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-ploinky-auth-info': authHeader('admin-a', ['admin']) },
            body: JSON.stringify({ name: 'Publisher' }),
        });
        assert.equal(created.status, 201);
        const robot = (await created.json()).robot;
        const started = await fetch(`${fixture.baseUrl}/api/robots/${robot.id}/run`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-ploinky-auth-info': authHeader('user-a') },
            body: JSON.stringify({ mode: 'browser' }),
        });
        assert.equal((await started.json()).robot.run.mode, 'browser');
        const other = await fetch(`${fixture.baseUrl}/api/robots/${robot.id}/run`, { headers: { 'x-ploinky-auth-info': authHeader('user-b') } });
        assert.equal(other.status, 200);
        const denied = await fetch(`${fixture.baseUrl}/api/robots`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-ploinky-auth-info': authHeader('user-b') },
            body: JSON.stringify({ name: 'Denied' }),
        });
        assert.equal(denied.status, 403);
    } finally {
        await fixture.close();
    }
});

test('skillset mutations are admin-only, including rejection of internal agents', async (t) => {
    const calls = [];
    const fixture = await startFixture({ skillsets: {
        add: async (...args) => calls.push(['add', ...args]),
        remove: async (...args) => calls.push(['remove', ...args]),
        setSkillsetEnabled: async (...args) => calls.push(['toggle', ...args]),
    } });
    t.after(fixture.close);
    const robot = await fixture.robotStore.create({ name: 'Skills' });
    for (const method of ['POST', 'DELETE', 'PATCH']) {
        for (const headers of [{ 'x-ploinky-auth-info': authHeader('user') }, { 'x-roboteam-internal-token': 'test-token' }]) {
            const response = await fetch(`${fixture.baseUrl}/api/robots/${robot.id}/skillsets`, {
                method, headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'docs' }),
            });
            assert.equal(response.status, 403);
        }
        const response = await fetch(`${fixture.baseUrl}/api/robots/${robot.id}/skillsets`, {
            method, headers: { 'x-ploinky-auth-info': authHeader('admin', ['admin']), 'content-type': 'application/json' },
            body: JSON.stringify({ name: 'docs', source: '/workspace/docs' }),
        });
        assert.equal(response.status, 200);
    }
    assert.equal(calls.length, 3);
    const removeUrl = `${fixture.baseUrl}/api/robots/${robot.id}/skillsets?name=repo-4d529e42-fad0-43b7-b357-95029c882355`;
    const denied = await fetch(removeUrl, { method: 'DELETE', headers: { 'x-ploinky-auth-info': authHeader('user') } });
    assert.equal(denied.status, 403);
    const removed = await fetch(removeUrl, { method: 'DELETE', headers: { 'x-ploinky-auth-info': authHeader('admin', ['admin']) } });
    assert.equal(removed.status, 200);
    assert.deepEqual(calls.at(-1), ['remove', robot.id, 'repo-4d529e42-fad0-43b7-b357-95029c882355']);
});

test('task starts validate allowed policy intent and ignore caller-supplied snapshots and policy references', async (t) => {
    const fixture = await startFixture();
    t.after(fixture.close);
    const robot = await fixture.robotStore.create({ name: 'Catalog Task' });
    // Starting a task also resolves the required human-report skill from the workspace DocumentationSkills repository.
    const documentation = path.join(fixture.workspaceRoot, 'DocumentationSkills');
    await fs.mkdir(path.join(documentation, 'skills/human-report'), { recursive: true });
    await fs.writeFile(path.join(documentation, 'skills/human-report/SKILL.md'), '---\nname: human-report\ndescription: Final report\n---\nReport instructions\n');
    fixture.runtimeManager.skillsets.repositoriesClient = {
        listRepositories: async () => [{ name: 'DocumentationSkills', source: documentation, origin: 'workspace' }],
    };
    const requests = [];
    fixture.runtimeManager.startTask = (_robot, type, request) => {
        requests.push({ type, request });
        return { taskId: 'test-task', state: 'queued' };
    };
    const start = (extra) => fetch(`${fixture.baseUrl}/api/control`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-roboteam-internal-token': 'test-token' },
        body: JSON.stringify({ operation: 'start-simple-task', robotName: robot.name,
            cwd: fixture.workspaceRoot, task: 'Review', ...extra }),
    });
    const rejected = await start({ skillSets: 'not-allowed' });
    assert.equal(rejected.status, 400);
    assert.equal(requests.length, 0);
    const accepted = await start({ skillSelection: { catalogId: 'forged', resolvedSkills: ['secret'] }, skillPolicyRef: 'forged-policy', alaSessionId: 'forged-session' });
    assert.equal(accepted.status, 202);
    assert.equal(requests.length, 1);
    const request = requests[0].request;
    assert.equal(request.skillSelection, undefined);
    assert.match(request.skillPolicyRef, /^[a-f0-9-]{36}$/);
    assert.equal(request.alaSessionId, request.skillPolicyRef);
    const skillsets = fixture.runtimeManager.skillsets;
    const policy = await skillsets.policies.read(robot.id, request.skillPolicyRef);
    assert.deepEqual(policy.selectors, { skillSets: [], skills: [] });
    await assert.rejects(fs.readdir(skillsets.live.root(robot.id)), { code: 'ENOENT' }, 'queue submission does not capture execution bytes');
});

test('internal MCP control calls require only the generated service token', async () => {
    const fixture = await startFixture();
    try {
        // Robot listing additionally requires the agent-origin proof (listing-access.test.mjs).
        assert.equal((await fetch(`${fixture.baseUrl}/api/robots`, { headers: { 'x-roboteam-internal-token': 'test-token' } })).status, 403);
        assert.equal((await fetch(`${fixture.baseUrl}/api/robots`, { headers: { 'x-roboteam-internal-token': 'test-token', 'x-roboteam-listing-origin': 'agent' } })).status, 200);
        assert.equal((await fetch(`${fixture.baseUrl}/api/robots`, { headers: { 'x-roboteam-internal-token': 'wrong' } })).status, 401);
        const control = await fetch(`${fixture.baseUrl}/api/control`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-roboteam-internal-token': 'test-token' },
            body: JSON.stringify({ operation: 'task-status', robotName: 'missing-robot' }),
        });
        assert.notEqual(control.status, 401, 'other internal operations keep the service-token path');
        assert.notEqual(control.status, 403, 'other internal operations keep the service-token path');
    } finally {
        await fixture.close();
    }
});

test('robot deletion requires an administrator role', async () => {
    const fixture = await startFixture();
    try {
        const created = await fetch(`${fixture.baseUrl}/api/robots`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-ploinky-auth-info': authHeader('admin-a', ['admin']) },
            body: JSON.stringify({ name: 'Disposable' }),
        });
        assert.equal(created.status, 201);
        const denied = await fetch(`${fixture.baseUrl}/api/control`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-ploinky-auth-info': authHeader('user-a') },
            body: JSON.stringify({ operation: 'robot-delete', robotName: 'Disposable' }),
        });
        assert.equal(denied.status, 403);
        const deleted = await fetch(`${fixture.baseUrl}/api/control`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-ploinky-auth-info': authHeader('admin-a', ['admin']) },
            body: JSON.stringify({ operation: 'robot-delete', robotName: 'Disposable' }),
        });
        assert.equal(deleted.status, 200);
    } finally {
        await fixture.close();
    }
});


test('serves the skills dialog, shared theme and local font through the authenticated application', async t => {
    const fixture = await startFixture();
    t.after(fixture.close);
    const response = await fetch(`${fixture.baseUrl}/skills-dialog.js`, {
        headers: { 'x-ploinky-auth-info': authHeader('admin', ['admin']) },
    });
    assert.equal(response.status, 200);
    const dialogs = await response.text();
    assert.match(dialogs, /export function openSkillsDialog/);
    assert.match(dialogs, /export function openCodingAgentsDialog/);
    const theme = await fetch(`${fixture.baseUrl}/`, {
        headers: { 'x-ploinky-auth-info': authHeader('admin', ['admin']) },
    });
    assert.equal(theme.status, 200);
    assert.match(await theme.text(), /assistosExplorerTheme/);
    const font = await fetch(`${fixture.baseUrl}/InterVariable.woff2`, {
        headers: { 'x-ploinky-auth-info': authHeader('admin', ['admin']) },
    });
    assert.equal(font.status, 200);
    assert.equal(font.headers.get('content-type'), 'font/woff2');
    assert.equal(Buffer.from(await font.arrayBuffer()).subarray(0, 4).toString(), 'wOF2');
});

test('robot model settings load lazily, enforce administrator access and save the chosen model', async t => {
    const calls = [];
    const fixture = await startFixture({ robotModels: {
        config: async robot => { calls.push(['config', robot.id]); return { codingAgent: 'opencode', models: { opencode: 'provider/saved' } }; },
        list: async (robot, agent) => { calls.push(['list', robot.id, agent]); return { agent, models: [{ id: 'provider/model', label: 'Example' }] }; },
    } });
    t.after(fixture.close);
    const robot = await fixture.robotStore.create({ name: 'Model Picker' });
    const base = `${fixture.baseUrl}/api/robots/${robot.id}`;
    const headers = { 'content-type': 'application/json', 'x-ploinky-auth-info': authHeader('admin', ['admin']) };
    assert.equal((await fetch(`${base}/models?agent=opencode`)).status, 401);
    assert.equal((await fetch(`${base}/models?agent=opencode`, { headers: { 'x-ploinky-auth-info': authHeader('user') } })).status, 403);
    assert.deepEqual(calls, []);
    const settings = await fetch(`${base}/coding-agents`, { headers });
    assert.equal(settings.status, 200);
    assert.equal((await settings.json()).models.opencode, 'provider/saved');
    assert.deepEqual(calls, [['config', robot.id]]);
    const models = await fetch(`${base}/models?agent=opencode`, { headers });
    assert.equal(models.status, 200);
    assert.equal((await models.json()).models[0].id, 'provider/model');
    assert.deepEqual(calls.at(-1), ['list', robot.id, 'opencode']);
    const patch = body => fetch(`${base}/coding-agents`, { method: 'PATCH', headers, body: JSON.stringify(body) });
    assert.equal((await patch({ codingAgents: ['opencode'], model: 'provider/model' })).status, 200);
    const config = JSON.parse(await fs.readFile(path.join(fixture.robotStore.robotPath(robot.id), 'home/.ala/config.json')));
    assert.equal(config.models.opencode, 'provider/model');
    assert.equal((await patch({ codingAgents: ['opencode'], model: 123 })).status, 400);
    assert.equal((await patch({ codingAgents: ['opencode', 'pi'], model: 'invalid' })).status, 400);
    fixture.runtimeManager.hasUnfinishedTasks = () => true;
    assert.equal((await patch({ codingAgents: ['opencode'], model: null })).status, 409);
});


test('robot default effort is validated and saved with its model', async t => {
    const fixture = await startFixture({ robotModels: {
        validateEffort: async (robot, agent, model, effort) => {
            if (agent !== 'opencode' || model !== 'provider/model' || effort !== 'high') {
                throw Object.assign(new Error('Unsupported effort'), { statusCode: 400 });
            }
        },
    } });
    t.after(fixture.close);
    const robot = await fixture.robotStore.create({ name: 'Effort Picker' });
    const url = `${fixture.baseUrl}/api/robots/${robot.id}/coding-agents`;
    const headers = { 'content-type': 'application/json', 'x-ploinky-auth-info': authHeader('admin', ['admin']) };
    const patch = body => fetch(url, { method: 'PATCH', headers, body: JSON.stringify(body) });
    const body = { codingAgents: ['opencode'], model: 'provider/model', effort: 'high' };
    assert.equal((await patch(body)).status, 200);
    const read = async () => JSON.parse(await fs.readFile(path.join(fixture.robotStore.robotPath(robot.id), 'home/.ala/config.json')));
    assert.equal((await read()).efforts.opencode, 'high');
    assert.equal((await patch({ ...body, effort: 'invalid' })).status, 400);
    assert.equal((await read()).efforts.opencode, 'high');
    assert.equal((await patch({ ...body, effort: null })).status, 200);
    assert.equal((await read()).efforts.opencode, undefined);
});

test('static assets revalidate with ETag and 304 while pages, config and JSON stay no-store', async t => {
    const publicDir = await fs.mkdtemp(path.join(os.tmpdir(), 'roboteam-public-test-'));
    await fs.writeFile(path.join(publicDir, 'index.html'), '<html><head></head><body></body></html>');
    await fs.writeFile(path.join(publicDir, 'app.js'), 'export const v = 1;\n');
    const fixture = await startFixture({ publicDir });
    t.after(async () => { await fixture.close(); await fs.rm(publicDir, { recursive: true, force: true }); });
    const auth = { 'x-ploinky-auth-info': authHeader('user') };
    const url = `${fixture.baseUrl}/app.js`;

    const first = await fetch(url, { headers: auth });
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('cache-control'), 'private, no-cache');
    assert.equal(first.headers.get('x-content-type-options'), 'nosniff');
    assert.ok(first.headers.get('last-modified'));
    const etag = first.headers.get('etag');
    assert.match(etag, /^W\/"/);
    assert.equal(await first.text(), 'export const v = 1;\n');

    const cached = await fetch(url, { headers: { ...auth, 'if-none-match': etag } });
    assert.equal(cached.status, 304);
    assert.equal(await cached.text(), '');
    assert.equal(cached.headers.get('etag'), etag);
    const since = await fetch(url, { headers: { ...auth, 'if-modified-since': first.headers.get('last-modified') } });
    assert.equal(since.status, 304);
    const staleTag = await fetch(url, { headers: { ...auth, 'if-none-match': '"other"', 'if-modified-since': first.headers.get('last-modified') } });
    assert.equal(staleTag.status, 200);
    await staleTag.arrayBuffer();

    await fs.writeFile(path.join(publicDir, 'app.js'), 'export const v = 22;\n');
    const changed = await fetch(url, { headers: { ...auth, 'if-none-match': etag } });
    assert.equal(changed.status, 200);
    assert.notEqual(changed.headers.get('etag'), etag);
    assert.equal(await changed.text(), 'export const v = 22;\n');

    const anonymous = await fetch(url, { headers: { 'if-none-match': etag } });
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.headers.get('etag'), null);
    await anonymous.arrayBuffer();

    for (const route of ['/', '/config.js', '/api/robots']) {
        const response = await fetch(`${fixture.baseUrl}${route}`, { headers: auth });
        assert.equal(response.headers.get('cache-control'), 'no-store', route);
        assert.equal(response.headers.get('etag'), null, route);
        await response.arrayBuffer();
    }
});
