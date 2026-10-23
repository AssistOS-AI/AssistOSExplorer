import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRoboTeamServer } from '../server/http-server.mjs';
import { RobotStore } from '../server/robot-store.mjs';
import { signedHeaders, signedPrincipal } from './helpers/router-signed.mjs';

// Terminal profile routes on the RoboTeam service port. Requests are signed by
// the sibling Ploinky checkout's real Router minter and verified by its real
// Agent helper. Robots are written by hand (the registry reads need no /proc),
// so these cases run on every platform that can load the server.
const TOKEN = 'terminal-profiles-token';
const LIST = '/api/terminal-profiles';
const RESOLVE = '/api/terminal-profiles/resolve';
const ADMIN = { id: 'owner-1', roles: ['admin'] };
const MEMBER = { id: 'member-1', roles: ['user'] };

async function startFixture(t) {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'roboteam-profiles-')));
    const workspaceRoot = path.join(root, 'workspace');
    const dataDir = path.join(workspaceRoot, '.data', 'roboTeamAgent');
    await fs.mkdir(dataDir, { recursive: true });
    const robotStore = new RobotStore({ dataDir });
    await robotStore.initialize();
    const calls = { tools: 0, openCode: [], prepared: [] };
    const runtimeManager = {
        workspaceRoot,
        status: () => ({ state: 'stopped' }),
        activePort: () => null,
        hasUnfinishedTasks: () => false,
        toolCache: {
            root: path.join(root, 'tool-cache'),
            prepareShellTools: async () => { calls.tools += 1; return { binPath: path.join(root, 'tool-cache', 'bin') }; },
        },
        prepareOpenCode: async (id, options) => { calls.openCode.push([id, options]); },
    };
    const server = createRoboTeamServer({ robotStore, runtimeManager, skillsets: {}, internalToken: TOKEN, publicBasePath: '/rt/', mcpPort: 65534 });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    t.after(async () => {
        server.closeAllConnections?.();
        await new Promise((resolve) => server.close(resolve));
        await fs.rm(root, { recursive: true, force: true });
    });
    const robot = async (id, name) => {
        const robotRoot = path.join(dataDir, 'robots', id);
        await fs.mkdir(path.join(robotRoot, 'home'), { recursive: true });
        const now = new Date().toISOString();
        await fs.writeFile(path.join(robotRoot, 'metadata.json'),
            JSON.stringify({ schema: 'roboteam-robot-v1', id, name, codingAgents: ['opencode'], createdAt: now, updatedAt: now }));
        return { id, name, root: robotRoot, home: path.join(robotRoot, 'home'), workspaceRoot: `.data/roboTeamAgent/robots/${id}` };
    };
    // One request, signed over this exact method, path and body unless told otherwise.
    const call = async (method, target, { user, body, headers = {}, signAs } = {}) => {
        const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
        const signed = user ? signedHeaders(principal(user), method, signAs?.target ?? target, signAs?.body ?? payload ?? '') : {};
        const response = await fetch(`${baseUrl}${target}`, {
            method, headers: { ...(payload === undefined ? {} : { 'content-type': 'application/json' }), ...signed, ...headers }, body: payload,
        });
        const text = await response.text();
        let json = null;
        try { json = JSON.parse(text); } catch { json = null; }
        return { status: response.status, json, text };
    };
    const effects = async () => JSON.stringify({ tools: calls.tools, openCode: calls.openCode, tree: await tree(workspaceRoot) });
    return { root, workspaceRoot, baseUrl, robotStore, calls, robot, call, effects };
}

async function tree(directory) {
    const rows = [];
    for (const entry of await fs.readdir(directory, { withFileTypes: true, recursive: true })) {
        const full = path.join(entry.parentPath, entry.name);
        const stat = await fs.lstat(full);
        rows.push([path.relative(directory, full), stat.mode, stat.size, stat.mtimeMs, stat.ino]);
    }
    return rows.sort();
}

// A fixture user with an explicit capability list is signed as given; the others as the Router signs them.
const principal = (user) => user.capabilities ? user : signedPrincipal(user);

const ROBOT_A = 'analyst-a1b2c3';
const ROBOT_B = 'writer-d4e5f6';
const ROUTES = (id) => [
    ['GET', LIST, undefined],
    ['POST', RESOLVE, JSON.stringify({ version: 1, id })],
    ['POST', `${LIST}/${id}/prepare`, '{}'],
];

test('list, resolve and prepare refuse unsigned, forged, internal-token and non-administrator callers without any effect', async (t) => {
    const f = await startFixture(t);
    const a = await f.robot(ROBOT_A, 'Analyst');
    const before = await f.effects();
    const internal = { 'x-roboteam-internal-token': TOKEN };
    for (const [method, target, body] of ROUTES(a.id)) {
        const label = `${method} ${target}`;
        const jsonHeaders = body === undefined ? {} : { 'content-type': 'application/json' };
        // Not signed by the Router: a plain header claiming every privilege, nothing, or a wrong internal token.
        const forgedPlain = { 'x-ploinky-auth-info': JSON.stringify({ user: { id: 'owner-1', username: 'owner', roles: ['admin'] }, capabilities: ['explorer.access'] }) };
        for (const [name, headers, expected] of [
            ['unsigned', {}, 401], ['forged plain header', forgedPlain, 401], ['wrong internal token', { 'x-roboteam-internal-token': 'wrong' }, 401],
            // Internal-token callers are never an administrator here, whatever they forward or also sign.
            ['internal bare', internal, 403],
            ['internal with forwarded admin', { ...internal, 'x-roboteam-user-id': 'owner-1', 'x-roboteam-user-roles': '["admin"]' }, 403],
            ['internal with signed admin', { ...internal, ...signedHeaders(principal(ADMIN), method, target, body ?? '') }, 403],
        ]) {
            const response = await fetch(`${f.baseUrl}${target}`, { method, headers: { ...jsonHeaders, ...headers }, body });
            assert.equal(response.status, expected, `${label} ${name}`);
        }
        // Signed, but not an administrator.
        for (const [name, user] of [
            ['entitled member', MEMBER],
            ['admin with guest role', { id: 'owner-2', roles: ['admin', 'guest'] }],
            ['guest', { id: 'guest-1', roles: ['GUEST'] }],
            ['role-less', { id: 'bare-1', roles: [] }],
            ['self registered without the Explorer capability', { id: 'self-1', username: 'self', roles: ['selfRegistered'], capabilities: ['selfregistered.dashboard.access'] }],
        ]) {
            const response = await f.call(method, target, { user, body });
            assert.equal(response.status, 403, `${label} ${name}: ${response.text}`);
        }
        // A valid non-administrator token whose unsigned user fields claim the admin role.
        const widened = JSON.parse(signedHeaders(principal(MEMBER), method, target, body ?? '')['x-ploinky-auth-info']);
        widened.user = { ...widened.user, roles: ['admin'] };
        const forgedAdmin = await f.call(method, target, { body, headers: { 'x-ploinky-auth-info': JSON.stringify(widened) } });
        assert.equal(forgedAdmin.status, 403, `${label} forged compatibility admin: ${forgedAdmin.text}`);
        assert.deepEqual(forgedAdmin.json, { ok: false, error: 'administrator access by a signed-in user is required' });
        // A signature minted for another body or route is no authority for this one.
        const wrongBody = await f.call(method, target, { user: ADMIN, body, signAs: { body: '{"other":true}' } });
        assert.equal(wrongBody.status, 401, `${label} signed for another body`);
        const wrongRoute = await f.call(method, target, { user: ADMIN, body, signAs: { target: '/api/summary' } });
        assert.equal(wrongRoute.status, 401, `${label} signed for another route`);
    }
    assert.equal(await f.effects(), before, 'no refused request changed anything');
});

test('a signed administrator lists profiles sorted by label', async (t) => {
    const f = await startFixture(t);
    assert.deepEqual((await f.call('GET', LIST, { user: ADMIN })).json, { ok: true, profiles: [] });
    await f.robot(ROBOT_B, 'writer');
    await f.robot(ROBOT_A, 'Analyst');
    const response = await f.call('GET', LIST, { user: ADMIN });
    assert.equal(response.status, 200);
    assert.deepEqual(response.json, { ok: true, profiles: [{ id: ROBOT_A, label: 'Analyst' }, { id: ROBOT_B, label: 'writer' }] });
    // Only the listed methods exist.
    for (const method of ['POST', 'DELETE', 'PUT']) {
        assert.equal((await f.call(method, LIST, { user: ADMIN, body: method === 'POST' ? '{}' : undefined })).status, 404, method);
    }
});

test('resolve answers read-only and refuses unknown ids, malformed bodies and unsafe homes', async (t) => {
    const f = await startFixture(t);
    const a = await f.robot(ROBOT_A, 'Analyst');
    const before = await f.effects();
    const resolve = (body, options = {}) => f.call('POST', RESOLVE, { user: ADMIN, body, ...options });
    const ok = await resolve({ version: 1, id: a.id });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.json, { allowed: true, profile: { id: a.id, label: 'Analyst', home: `robots/${a.id}/home` } });
    for (const id of ['unknown-robot-000', 'x', '../analyst-a1b2c3', `${a.id}/home`, 'ANALYST-A1B2C3', '']) {
        const refused = await resolve({ version: 1, id });
        assert.equal(refused.status, 200, id);
        assert.deepEqual(refused.json, { allowed: false }, id);
    }
    for (const body of ['', 'not json', '[]', 'null', '{}', { id: a.id }, { version: 2, id: a.id }, { version: 1, id: 7 }, { version: 1, id: a.id, extra: true }]) {
        assert.equal((await resolve(body)).status, 400, JSON.stringify(body));
    }
    assert.equal((await resolve(JSON.stringify({ version: 1, id: a.id, pad: 'x'.repeat(70 * 1024) }))).status, 400, 'body limit');
    assert.equal(f.calls.tools, 0, 'resolve never prepares tools');
    assert.equal(await f.effects(), before, 'resolve changed nothing');

    // A home replaced by a symlink is refused, and resolving still changes nothing.
    const outside = path.join(f.root, 'outside');
    await fs.mkdir(outside);
    await fs.rename(a.home, path.join(f.root, 'saved-home'));
    await fs.symlink(outside, a.home);
    const swapped = await resolve({ version: 1, id: a.id });
    assert.deepEqual([swapped.status, swapped.json], [200, { allowed: false }]);
    assert.deepEqual(await fs.readdir(outside), []);
    await fs.rm(a.home);
    assert.deepEqual((await resolve({ version: 1, id: a.id })).json, { allowed: false }, 'missing home');
});

test('prepare runs the shell preparation for a signed administrator and returns the robot root', async (t) => {
    const f = await startFixture(t);
    const a = await f.robot(ROBOT_A, 'Analyst');
    for (const body of ['{}', '']) {
        const response = await f.call('POST', `${LIST}/${a.id}/prepare`, { user: ADMIN, body });
        assert.equal(response.status, 200, response.text);
        assert.deepEqual(response.json, { ok: true, id: a.id, label: 'Analyst', root: a.workspaceRoot });
    }
    assert.equal(f.calls.tools, 2);
    assert.deepEqual(f.calls.openCode[0], [a.id, { prepare: true }]);
    assert.match(await fs.readFile(path.join(a.home, '.roboteam-env.sh'), 'utf8'), /CODEX_HOME/);
    assert.match(await fs.readFile(path.join(a.home, '.bashrc'), 'utf8'), /roboteam-env\.sh/);
    // Unknown robots, bad bodies and other methods do nothing.
    const toolsBefore = f.calls.tools;
    assert.equal((await f.call('POST', `${LIST}/unknown-robot-000/prepare`, { user: ADMIN, body: '{}' })).status, 404);
    assert.equal((await f.call('POST', `${LIST}/${a.id}/prepare`, { user: ADMIN, body: { home: '/etc' } })).status, 400);
    assert.equal((await f.call('POST', `${LIST}/${a.id}/prepare`, { user: ADMIN, body: '[]' })).status, 400);
    assert.equal((await f.call('GET', `${LIST}/${a.id}/prepare`, { user: ADMIN })).status, 404);
    assert.equal((await f.call('POST', `${LIST}/${a.id}`, { user: ADMIN, body: '{}' })).status, 404);
    assert.equal(f.calls.tools, toolsBefore);
});

test('prepare keeps the home and configuration symlink refusals', async (t) => {
    const f = await startFixture(t);
    const a = await f.robot(ROBOT_A, 'Analyst');
    const outside = path.join(f.root, 'outside');
    await fs.mkdir(outside);
    await fs.rename(a.home, path.join(f.root, 'saved-home'));
    await fs.symlink(outside, a.home);
    const refused = await f.call('POST', `${LIST}/${a.id}/prepare`, { user: ADMIN, body: '{}' });
    assert.equal(refused.status, 500);
    assert.deepEqual(refused.json, { ok: false, error: 'request failed' });
    assert.deepEqual(await fs.readdir(outside), [], 'nothing was written through the symlink');
    // A symlinked shell configuration directory is refused as before.
    await fs.rm(a.home);
    await fs.rename(path.join(f.root, 'saved-home'), a.home);
    await fs.symlink(outside, path.join(a.home, '.codex'));
    const config = await f.call('POST', `${LIST}/${a.id}/prepare`, { user: ADMIN, body: '{}' });
    assert.equal(config.status, 500);
    assert.deepEqual(await fs.readdir(outside), []);
});

test('the former robot terminal route is gone', async (t) => {
    const f = await startFixture(t);
    const a = await f.robot(ROBOT_A, 'Analyst');
    const before = await f.effects();
    for (const user of [ADMIN, MEMBER]) {
        const response = await f.call('POST', `/api/robots/${a.id}/terminal`, { user, body: '{}' });
        assert.equal(response.status, 404);
        assert.deepEqual(response.json, { ok: false, error: 'not found' });
    }
    assert.equal(f.calls.tools, 0);
    assert.equal(await f.effects(), before);
});
