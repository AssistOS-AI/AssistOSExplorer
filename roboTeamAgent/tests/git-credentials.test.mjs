import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRoboTeamServer } from '../server/http-server.mjs';
import { RobotStore } from '../server/robot-store.mjs';
import {
    CREDENTIALS_FORBIDDEN, RobotGitCredentials, credentialSummary, credentialUser, mayManageCredentials,
} from '../server/git-credentials.mjs';

const AGENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = 'ghp_secretTokenValue1234567890';
const GIT_AGENT = 'agent:AchillesIDE/gitAgent';
const ROBOTEAM = 'agent:AchillesIDE/roboTeamAgent';

// RoboWork's robot_git_credentials_* operations (contract B3), kept in memory. It records every call.
function fakeRoboWork() {
    const stored = new Map();
    const calls = [];
    return {
        stored,
        calls,
        async call(tool, input) {
            calls.push({ tool, input });
            if (tool === 'robot_ensure' || tool === 'robot_config_set') return {};
            if (tool === 'robot_status') return { robots: [] };
            if (tool === 'robot_git_credentials_status') {
                const entry = stored.get(input.robotId);
                return { ok: true, configured: Boolean(entry), readable: entry ? entry.readable !== false : false, metadata: entry?.metadata || null };
            }
            if (tool === 'robot_git_credentials_set') {
                const metadata = { host: 'github.com', githubLogin: input.githubLogin, name: input.name, email: input.email,
                    savedBy: input.savedBy, savedAt: '2026-11-10T10:00:00.000Z' };
                stored.set(input.robotId, { metadata, token: input.token });
                return { ok: true, metadata };
            }
            if (tool === 'robot_git_credentials_delete') return { ok: true, deleted: stored.delete(input.robotId) };
            throw new Error(`unexpected RoboWork tool ${tool}`);
        },
    };
}

async function withStore(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'roboteam-git-credentials-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const roboWork = fakeRoboWork();
    const robotStore = new RobotStore({ dataDir: path.join(root, 'private'), roboWork });
    await robotStore.initialize();
    return { root, roboWork, robotStore, credentials: new RobotGitCredentials({ robotStore, roboWork }) };
}

const alice = credentialUser({ id: 'user:alice', username: 'alice', roles: ['user'] });
const bob = credentialUser({ id: 'bob', username: 'bob', roles: ['user'] });
const admin = credentialUser({ id: 'root', username: 'root', roles: ['admin'] });

function saveInput(robotName, extra = {}) {
    return { robotName, token: TOKEN, githubLogin: 'alice-gh', name: 'Alice', email: 'alice@example.com', ...extra };
}

test('only a non-guest user with an id may act on robot credentials', () => {
    assert.equal(credentialUser({ id: '', roles: ['user'] }), null);
    assert.equal(credentialUser({ id: 'user:g1', roles: ['guest'] }), null);
    assert.equal(credentialUser({ id: 'a', roles: ['admin', 'Guest'] }), null);
    assert.deepEqual(alice, { id: 'alice', username: 'alice', roles: ['user'], canAdmin: false });
    assert.equal(admin.canAdmin, true);
    assert.equal(mayManageCredentials(alice), false);
    assert.equal(mayManageCredentials(null), false);
    assert.equal(mayManageCredentials(admin), true);
    assert.deepEqual(credentialSummary({ configured: true, readable: false, metadata: { githubLogin: 'x', savedBy: { id: 'user:a', username: 'a' }, savedAt: 'd', token: TOKEN } }),
        { configured: true, readable: false, githubLogin: 'x', savedBy: { id: 'a', username: 'a' }, savedAt: 'd' });
});

test('only administrators save, and an administrator may overwrite any credentials', async (t) => {
    const { robotStore, roboWork, credentials } = await withStore(t);
    const robot = await robotStore.create({ name: 'Builder' });
    await assert.rejects(credentials.save(alice, saveInput('Builder')), (error) => {
        assert.equal(error.code, CREDENTIALS_FORBIDDEN);
        assert.equal(error.statusCode, 403);
        assert.equal(error.message.includes(TOKEN), false);
        return true;
    });
    assert.equal(roboWork.calls.some(call => call.tool === 'robot_git_credentials_set'), false);
    const saved = await credentials.save(admin, saveInput('Builder'));
    assert.deepEqual(saved.robot, { id: robot.id, name: 'Builder', isDefault: false });
    assert.equal(saved.metadata.githubLogin, 'alice-gh');
    assert.deepEqual(saved.metadata.savedBy, { id: 'root', username: 'root' });
    assert.equal(JSON.stringify(saved).includes(TOKEN), false);
    const set = roboWork.calls.find(call => call.tool === 'robot_git_credentials_set');
    assert.deepEqual(set.input, { robotId: robot.id, token: TOKEN, githubLogin: 'alice-gh', name: 'Alice', email: 'alice@example.com',
        savedBy: { id: 'root', username: 'root' }, workspaceDefault: false });
    const otherAdmin = credentialUser({ id: 'ops', username: 'ops', roles: ['admin'] });
    await credentials.save(otherAdmin, saveInput('Builder', { githubLogin: 'ops-gh' }));
    assert.equal(roboWork.stored.get(robot.id).metadata.githubLogin, 'ops-gh');
    assert.deepEqual(roboWork.stored.get(robot.id).metadata.savedBy, { id: 'ops', username: 'ops' });
});

test('workspaceDefault is set only for the robot named default', async (t) => {
    const { robotStore, roboWork, credentials } = await withStore(t);
    const fallback = await robotStore.ensureDefaultRobot();
    await robotStore.create({ name: 'Default' });
    await robotStore.create({ name: 'default-copy' });
    for (const name of ['default', 'Default', 'default-copy']) await credentials.save(admin, saveInput(name));
    const flags = roboWork.calls.filter(call => call.tool === 'robot_git_credentials_set').map(call => call.input.workspaceDefault);
    assert.deepEqual(flags, [true, false, false]);
    const removed = await credentials.removeByName(admin, 'default');
    assert.deepEqual(removed, { ok: true, robot: { id: fallback.id, name: 'default', isDefault: true }, deleted: true });
    const deletion = roboWork.calls.find(call => call.tool === 'robot_git_credentials_delete');
    assert.deepEqual(deletion.input, { robotId: fallback.id, workspaceDefault: true });
});

test('delete is limited to administrators and is a no-op without credentials', async (t) => {
    const { robotStore, roboWork, credentials } = await withStore(t);
    const robot = await robotStore.create({ name: 'Builder' });
    assert.deepEqual(await credentials.removeByName(admin, 'Builder'), { ok: true, robot: { id: robot.id, name: 'Builder', isDefault: false }, deleted: false });
    assert.equal(roboWork.calls.some(call => call.tool === 'robot_git_credentials_delete'), false);
    await credentials.save(admin, saveInput('Builder'));
    await assert.rejects(credentials.removeByName(alice, 'Builder'), { code: CREDENTIALS_FORBIDDEN, statusCode: 403 });
    assert.equal((await credentials.removeByName(admin, 'Builder')).deleted, true);
    await assert.rejects(credentials.removeByName(admin, 'Missing'), { code: 'ROBOT_NOT_FOUND', statusCode: 404 });
});

test('targets list every robot with non-secret status, and invalid input never echoes the token', async (t) => {
    const { robotStore, credentials } = await withStore(t);
    await robotStore.ensureDefaultRobot();
    await robotStore.create({ name: 'Builder' });
    await credentials.save(admin, saveInput('Builder'));
    await assert.rejects(credentials.targets(bob), { code: CREDENTIALS_FORBIDDEN, statusCode: 403 });
    const targets = await credentials.targets(admin);
    assert.equal(targets.ok, true);
    assert.equal(targets.canAdmin, true);
    assert.equal(targets.userId, 'root');
    const byName = Object.fromEntries(targets.robots.map(robot => [robot.name, robot]));
    assert.deepEqual(byName.default.credentials, { configured: false });
    assert.equal(byName.default.isDefault, true);
    assert.deepEqual(byName.Builder.credentials, { configured: true, readable: true, githubLogin: 'alice-gh',
        savedBy: { id: 'root', username: 'root' }, savedAt: '2026-11-10T10:00:00.000Z' });
    assert.equal(JSON.stringify(targets).includes(TOKEN), false);
    for (const input of [saveInput('Builder', { token: '' }), saveInput('Builder', { token: `${TOKEN} extra` }), saveInput('Builder', { githubLogin: '' }),
        saveInput('Builder', { name: 'Al\nice' })]) {
        await assert.rejects(credentials.save(admin, input), (error) => error.statusCode === 400 && !error.message.includes(TOKEN));
    }
});

// --- MCP tool caller check (tools/control.mjs) ---

function delegatedGrant(overrides = {}) {
    return {
        sub: GIT_AGENT,
        actor: { kind: 'agent', id: GIT_AGENT, roles: [] },
        usr: { id: 'alice', username: 'alice', email: 'alice@example.com', displayName: 'alice', roles: ['user'] },
        delegation: { targetAgentId: ROBOTEAM, tools: ['robot_git_credentials_targets', 'robot_git_credentials_save', 'robot_git_credentials_delete'] },
        ...overrides,
    };
}

async function serviceStub(t, respond = () => ({ status: 200, body: { ok: true, robot: { id: 'builder-a1b2c3', name: 'Builder', isDefault: false }, metadata: {} } })) {
    const requests = [];
    const server = http.createServer((request, response) => {
        let raw = '';
        request.on('data', (chunk) => { raw += chunk; });
        request.on('end', () => {
            requests.push({ url: request.url, headers: request.headers, body: raw ? JSON.parse(raw) : {} });
            const { status, body } = respond(request);
            response.writeHead(status, { 'content-type': 'application/json' });
            response.end(JSON.stringify(body));
        });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    return { port: server.address().port, requests };
}

function runTool(port, operation, payload, env = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['tools/control.mjs', operation], {
            cwd: AGENT_ROOT,
            env: { ...process.env, ROBOTEAM_SERVICE_PORT: String(port), ROBOTEAM_INTERNAL_TOKEN: 'test-token',
                PLOINKY_AGENT_PRINCIPAL: ROBOTEAM, ROBOTEAM_GIT_CREDENTIALS_CALLER: '', ...env },
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.once('error', reject);
        child.once('close', (code) => resolve({ code, stdout, stderr }));
        child.stdin.end(JSON.stringify(payload));
    });
}

const savePayload = (grant) => ({ tool: 'robot_git_credentials_save', input: saveInput('Builder', { extra: 'dropped' }), metadata: { invocation: grant } });

test('the save tool accepts gitAgent acting for a delegated user and forwards only the documented fields', async (t) => {
    const { port, requests } = await serviceStub(t);
    const result = await runTool(port, 'git-credentials-save', savePayload(delegatedGrant()));
    assert.equal(result.code, 0, result.stderr);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, '/api/git-credentials/save');
    assert.equal(requests[0].headers['x-roboteam-internal-token'], 'test-token');
    assert.equal(requests[0].headers['x-roboteam-user-id'], 'alice');
    assert.equal(requests[0].headers['x-roboteam-user-name'], 'alice');
    assert.deepEqual(JSON.parse(requests[0].headers['x-roboteam-user-roles']), ['user']);
    assert.deepEqual(requests[0].body, { robotName: 'Builder', token: TOKEN, githubLogin: 'alice-gh', name: 'Alice', email: 'alice@example.com' });
    assert.equal(`${result.stdout}${result.stderr}`.includes(TOKEN), false);
});

test('the credential tools refuse every caller except gitAgent with a delegated non-guest user', async (t) => {
    const { port, requests } = await serviceStub(t);
    const refused = {
        directUser: delegatedGrant({ sub: 'user:alice', actor: { kind: 'user', id: 'user:alice', roles: ['admin'] }, usr: undefined, delegation: undefined }),
        otherAgent: delegatedGrant({ sub: 'agent:AchillesIDE/emailAgent', actor: { kind: 'agent', id: 'agent:AchillesIDE/emailAgent' } }),
        otherRepository: delegatedGrant({ sub: 'agent:Other/gitAgent', actor: { kind: 'agent', id: 'agent:Other/gitAgent' } }),
        mismatchedActor: delegatedGrant({ actor: { kind: 'agent', id: 'agent:AchillesIDE/emailAgent' } }),
        agentOwnBehalf: delegatedGrant({ usr: undefined, delegation: undefined }),
        withoutDelegation: delegatedGrant({ delegation: undefined }),
        guest: delegatedGrant({ usr: { id: 'guest-1', username: 'guest', roles: ['guest'] } }),
        withoutUserId: delegatedGrant({ usr: { id: '', username: 'nobody', roles: ['user'] } }),
        toolNotDelegated: delegatedGrant({ delegation: { targetAgentId: ROBOTEAM, tools: ['robot_git_credentials_targets'] } }),
        noGrant: undefined,
    };
    for (const [name, grant] of Object.entries(refused)) {
        const result = await runTool(port, 'git-credentials-save', savePayload(grant));
        assert.equal(result.code, 1, name);
        const report = JSON.parse(result.stderr.trim());
        assert.equal(report.code, 'ROBOT_CREDENTIALS_CALLER_REFUSED', name);
        assert.equal(report.statusCode, 403, name);
        assert.equal(`${result.stdout}${result.stderr}`.includes(TOKEN), false, name);
    }
    // Without a principal to derive the repository from, nobody is accepted.
    const unnamed = await runTool(port, 'git-credentials-targets', { tool: 'robot_git_credentials_targets', input: {}, metadata: { invocation: delegatedGrant() } },
        { PLOINKY_AGENT_PRINCIPAL: '', PLOINKY_AGENT_ID: '' });
    assert.equal(unnamed.code, 1);
    assert.equal(requests.length, 0);
});

test('ROBOTEAM_GIT_CREDENTIALS_CALLER names the caller exactly, and service refusals stay structured', async (t) => {
    const { port, requests } = await serviceStub(t, (request) => request.url.endsWith('/delete')
        ? { status: 403, body: { ok: false, code: CREDENTIALS_FORBIDDEN, error: 'Only administrators can configure the git credentials of robots.' } }
        : { status: 200, body: { ok: true, robots: [], canAdmin: false, userId: 'alice' } });
    const custom = 'agent:Custom/gitBridge';
    const grant = delegatedGrant({ sub: custom, actor: { kind: 'agent', id: custom } });
    const listed = await runTool(port, 'git-credentials-targets', { tool: 'robot_git_credentials_targets', input: {}, metadata: { invocation: grant } },
        { ROBOTEAM_GIT_CREDENTIALS_CALLER: custom });
    assert.equal(listed.code, 0, listed.stderr);
    assert.deepEqual(JSON.parse(listed.stdout), { ok: true, robots: [], canAdmin: false, userId: 'alice' });
    const original = await runTool(port, 'git-credentials-targets', { tool: 'robot_git_credentials_targets', input: {}, metadata: { invocation: delegatedGrant() } },
        { ROBOTEAM_GIT_CREDENTIALS_CALLER: custom });
    assert.equal(original.code, 1);
    const refused = await runTool(port, 'git-credentials-delete', { tool: 'robot_git_credentials_delete', input: { robotName: 'Builder' }, metadata: { invocation: delegatedGrant() } });
    assert.equal(refused.code, 1);
    assert.deepEqual(JSON.parse(refused.stderr.trim()), { ok: false, code: CREDENTIALS_FORBIDDEN, statusCode: 403, error: 'Only administrators can configure the git credentials of robots.' });
    assert.deepEqual(requests.map(request => [request.url, request.body]), [['/api/git-credentials/targets', {}], ['/api/git-credentials/delete', { robotName: 'Builder' }]]);
});

// --- HTTP routes ---

// A stand-in for the Agent helper that verifies Router-signed requests: the header's "signed" member is the verified payload.
async function fakeVerifierRuntime(t) {
    const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'roboteam-fake-verifier-'));
    await fs.mkdir(path.join(runtimeRoot, 'lib'));
    await fs.writeFile(path.join(runtimeRoot, 'lib', 'invocationAuth.mjs'), [
        'export function readAgentSecret() { return "secret"; }',
        'export function expectedAudienceForSelf() { return "agent:AchillesIDE/roboTeamAgent"; }',
        'export function verifyHttpRouteAuthInfoFromHeaders(headers) {',
        '    try { return { ok: true, payload: JSON.parse(headers["x-ploinky-auth-info"]).signed }; } catch { return { ok: false }; }',
        '}',
    ].join('\n'));
    const previous = process.env.PLOINKY_AGENT_RUNTIME_ROOT;
    process.env.PLOINKY_AGENT_RUNTIME_ROOT = runtimeRoot;
    t.after(async () => {
        if (previous === undefined) delete process.env.PLOINKY_AGENT_RUNTIME_ROOT;
        else process.env.PLOINKY_AGENT_RUNTIME_ROOT = previous;
        await fs.rm(runtimeRoot, { recursive: true, force: true });
    });
}

function signed(id, roles = ['user']) {
    const admin = roles.includes('admin');
    // The Router header carries the plain user beside the signed claims; only the signed claims decide here.
    return JSON.stringify({ user: { id, username: id, roles },
        signed: { sub: `user:${id}`, actor: { kind: 'user', id: `user:${id}`, roles, capabilities: admin ? [] : ['explorer.access'] } } });
}

async function startServer(t) {
    await fakeVerifierRuntime(t);
    const { root, roboWork, robotStore } = await withStore(t);
    const runtimeManager = { workspaceRoot: root, roboWork, status: () => ({ state: 'stopped' }), activePort: () => null, hasUnfinishedTasks: () => false };
    const server = createRoboTeamServer({ robotStore, runtimeManager, internalToken: 'test-token', publicBasePath: '/rt/', mcpPort: 65534 });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}`;
    const internal = (pathname, body, user = { id: 'alice', roles: ['user'] }) => fetch(`${base}${pathname}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-roboteam-internal-token': 'test-token',
            ...(user ? { 'x-roboteam-user-id': user.id, 'x-roboteam-user-roles': JSON.stringify(user.roles), 'x-roboteam-user-name': user.id } : {}) },
        body: JSON.stringify(body),
    });
    const browser = (pathname, { method = 'GET', auth } = {}) => fetch(`${base}${pathname}`, { method, headers: auth ? { 'x-ploinky-auth-info': auth } : {} });
    return { base, roboWork, robotStore, internal, browser };
}

test('internal credential routes require a forwarded administrator', async (t) => {
    const { robotStore, roboWork, internal } = await startServer(t);
    await robotStore.ensureDefaultRobot();
    const root = { id: 'root', roles: ['admin'] };
    assert.equal((await internal('/api/git-credentials/targets', {}, null)).status, 403);
    assert.equal((await internal('/api/git-credentials/targets', {}, { id: 'g', roles: ['guest'] })).status, 403);
    const userTargets = await internal('/api/git-credentials/targets', {});
    assert.equal(userTargets.status, 403);
    assert.equal((await userTargets.json()).code, CREDENTIALS_FORBIDDEN);
    const userSave = await internal('/api/git-credentials/save', saveInput('default'));
    const userSaveBody = await userSave.json();
    assert.equal(userSave.status, 403);
    assert.equal(userSaveBody.code, CREDENTIALS_FORBIDDEN);
    assert.equal(JSON.stringify(userSaveBody).includes(TOKEN), false);
    assert.equal(roboWork.calls.some(call => call.tool === 'robot_git_credentials_set'), false);
    const saved = await internal('/api/git-credentials/save', saveInput('default'), root);
    const savedBody = await saved.json();
    assert.equal(saved.status, 200, JSON.stringify(savedBody));
    assert.equal(savedBody.robot.isDefault, true);
    assert.equal(JSON.stringify(savedBody).includes(TOKEN), false);
    assert.equal(roboWork.calls.find(call => call.tool === 'robot_git_credentials_set').input.workspaceDefault, true);
    assert.equal((await internal('/api/git-credentials/delete', { robotName: 'default' })).status, 403);
    const targets = await (await internal('/api/git-credentials/targets', {}, root)).json();
    assert.equal(targets.canAdmin, true);
    assert.equal(targets.robots[0].credentials.githubLogin, 'alice-gh');
    assert.deepEqual(await (await internal('/api/git-credentials/delete', { robotName: 'default' }, root)).json(),
        { ok: true, robot: { id: targets.robots[0].id, name: 'default', isDefault: true }, deleted: true });
});

test('the dashboard shows credential status and lets only an administrator remove it', async (t) => {
    const { base, robotStore, internal, browser } = await startServer(t);
    const robot = await robotStore.ensureDefaultRobot();
    await internal('/api/git-credentials/save', saveInput('default'), { id: 'alice', roles: ['admin'] });
    const route = `/api/robots/${robot.id}/git-credentials`;

    assert.equal((await browser(route, { method: 'DELETE' })).status, 401);
    assert.equal((await fetch(`${base}${route}`, { method: 'DELETE', headers: { 'x-roboteam-internal-token': 'test-token',
        'x-roboteam-user-id': 'root', 'x-roboteam-user-roles': '["admin"]' } })).status, 403, 'internal callers use the MCP tool');
    const guest = await browser(route, { method: 'DELETE', auth: signed('guest-1', ['guest']) });
    assert.equal(guest.status, 403, await guest.text());

    const bobListing = await (await browser('/api/robots', { auth: signed('bob') })).json();
    assert.deepEqual(bobListing.robots[0].gitCredentials, { configured: true, readable: true, githubLogin: 'alice-gh',
        savedBy: { id: 'alice', username: 'alice' }, savedAt: '2026-11-10T10:00:00.000Z', canRemove: false });
    assert.equal(JSON.stringify(bobListing).includes(TOKEN), false);
    assert.equal((await (await browser('/api/robots', { auth: signed('alice') })).json()).robots[0].gitCredentials.canRemove, false, 'the saver is no exception');
    assert.equal((await (await browser('/api/robots', { auth: signed('root', ['admin']) })).json()).robots[0].gitCredentials.canRemove, true);

    const refused = await browser(route, { method: 'DELETE', auth: signed('bob') });
    assert.equal(refused.status, 403);
    assert.equal((await refused.json()).code, CREDENTIALS_FORBIDDEN);
    assert.equal((await browser(route, { method: 'DELETE', auth: signed('alice') })).status, 403);
    assert.equal((await browser('/api/robots/missing-a1b2c3/git-credentials', { method: 'DELETE', auth: signed('root', ['admin']) })).status, 404);
    const removed = await browser(route, { method: 'DELETE', auth: signed('root', ['admin']) });
    assert.equal(removed.status, 200);
    assert.equal((await removed.json()).deleted, true);
    assert.deepEqual((await (await browser('/api/robots', { auth: signed('root', ['admin']) })).json()).robots[0].gitCredentials, { configured: false, canRemove: false });
});

// --- Dashboard source and MCP configuration ---

test('robot cards render the credential line and a confirmed Remove git credentials action', async () => {
    const html = await fs.readFile(path.join(AGENT_ROOT, 'public', 'index.html'), 'utf8');
    const source = await fs.readFile(path.join(AGENT_ROOT, 'public', 'app.js'), 'utf8');
    assert.match(html, /<span class="robot-git-credentials" hidden><\/span>/);
    assert.match(html, /<button class="button secondary remove-git-credentials" type="button" hidden>Remove git credentials<\/button>/);
    // The action sits in the More actions menu outside the Delete robot section, so the default robot offers it too.
    assert.doesNotMatch(html, /robot-danger-actions" hidden>[\s\S]*remove-git-credentials[\s\S]*<\/div>\s*<\/div>\s*<\/div>/);
    assert.match(source, /const label = `GitHub: \$\{credentials\.githubLogin \|\| 'unknown account'\} · saved by \$\{saver\}\$\{date\}`;/);
    assert.match(source, /remove\.hidden = !\(configured && credentials\.canRemove === true\);/);
    assert.match(source, /if \(!confirm\(`Remove the GitHub credentials of [^`]+`\)\) return;/);
    assert.match(source, /api\(`api\/robots\/\$\{encodeURIComponent\(robot\.id\)\}\/git-credentials`, \{ method: 'DELETE' \}\)/);
    assert.match(source, /robot\.name === 'default' \? ' ploinky update will no longer use them/);
    assert.match(source, /showRobotGitCredentials\(card, robot\);/);
    assert.doesNotMatch(source, /credentials\.token|\.token\b/);
});

test('the three credential tools are authenticated-class so only a delegated gitAgent call reaches them', async () => {
    const config = JSON.parse(await fs.readFile(path.join(AGENT_ROOT, 'mcp-config.json'), 'utf8'));
    const tools = new Map(config.tools.map((tool) => [tool.name, tool]));
    const expected = { robot_git_credentials_targets: 'git-credentials-targets', robot_git_credentials_save: 'git-credentials-save',
        robot_git_credentials_delete: 'git-credentials-delete' };
    for (const [name, operation] of Object.entries(expected)) {
        const tool = tools.get(name);
        // Ploinky admits a delegated user call only for an authenticated-class tool; control.mjs then refuses every other caller.
        assert.equal(tool?.tags, undefined, `${name} must keep the authenticated default`);
        assert.deepEqual(tool.args, ['tools/control.mjs', operation]);
        assert.match(tool.description, /gitAgent acting for a signed-in user only/);
    }
    assert.deepEqual(Object.keys(tools.get('robot_git_credentials_save').inputSchema), ['robotName', 'token', 'githubLogin', 'name', 'email']);
});

test('an administrator removal of the default robot reaches RoboWork even without a visible record', async (t) => {
    const { robotStore, roboWork, credentials } = await withStore(t);
    const fallback = await robotStore.ensureDefaultRobot();
    await assert.rejects(credentials.removeByName(alice, 'default'), { code: CREDENTIALS_FORBIDDEN });
    assert.equal(roboWork.calls.some(call => call.tool === 'robot_git_credentials_delete'), false, 'a non-administrator cannot trigger the cleanup');
    await credentials.removeByName(admin, 'default');
    const deletion = roboWork.calls.find(call => call.tool === 'robot_git_credentials_delete');
    assert.deepEqual(deletion.input, { robotId: fallback.id, workspaceDefault: true });
});
