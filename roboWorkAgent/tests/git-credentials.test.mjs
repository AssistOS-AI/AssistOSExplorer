import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createDecipheriv, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { GitCredentialStore, MIRROR_SCHEMA, validateIdentity } from '../server/git-credentials.mjs';
import { createGitCredentialSockets } from '../server/git-credential-socket.mjs';
import { setGitHomeConfig, deleteGitHomeConfig, gitConfigValue, withInclude, GIT_INCLUDE_PATH } from '../server/git-home-config.mjs';
import { homeOperation } from '../server/home-op.mjs';
import { RobotPaths } from '../server/robot-paths.mjs';
import { RobotManager } from '../server/robot-manager.mjs';
import { createRoboWorkServer } from '../server/http-server.mjs';
import { invoke } from '../tools/robowork.mjs';

const TOKEN = 'ghp_sentinelGitToken0123456789';
const HELPER = fileURLToPath(new URL('../server/git-credential-helper.mjs', import.meta.url));
const subject = 'agent:AchillesIDE/roboTeamAgent';
const controller = { invocation: { sub: subject, actor: { kind: 'agent', id: subject } } };
const savedInput = { robotId: 'robot-a', token: TOKEN, githubLogin: 'octocat', name: 'Octo Cat', email: 'octo@example.com',
    savedBy: { id: 'user-1', username: 'alice' } };

async function tempRoot(t, prefix = 'rw-git-') {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    return root;
}

const keys = () => ({ ROBOWORK_CREDENTIALS_KEY: randomBytes(32).toString('hex'), ROBOWORK_GIT_MIRROR_KEY: randomBytes(32).toString('hex') });

function request(socketPath, { method = 'POST', url = '/credential', body } = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request({ socketPath, path: url, method }, res => {
            let text = ''; res.on('data', chunk => { text += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, body: text }));
        });
        req.on('error', reject);
        req.end(body === undefined ? undefined : JSON.stringify(body));
    });
}

function run(command, args, { input = '', env = {} } = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { env: { PATH: process.env.PATH, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = '', stderr = '';
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.on('error', reject);
        child.on('close', code => resolve({ code, stdout, stderr }));
        // A command that does not read its input closes the pipe early.
        child.stdin.on('error', () => {});
        child.stdin.end(input);
    });
}

async function fakeCredentialServer(t, root, handler) {
    const socketPath = path.join(root, 'fake.sock');
    const requests = [];
    const server = http.createServer(async (req, res) => {
        let text = ''; for await (const chunk of req) text += chunk;
        requests.push({ method: req.method, url: req.url, body: text });
        handler(req, res, text);
    });
    await new Promise(resolve => server.listen(socketPath, resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    return { socketPath, requests };
}

test('the store encrypts a robot credential, binds it to the robot and reports an unreadable record without its token', async t => {
    const root = await tempRoot(t);
    const env = keys();
    const store = new GitCredentialStore({ dataDir: root, env });
    const metadata = { host: 'github.com', githubLogin: 'octocat', name: 'Octo', email: 'o@example.com', savedBy: { id: 'u1', username: 'alice' }, savedAt: 'now' };
    await store.write('robot-a', metadata, TOKEN);
    const raw = await fs.readFile(store.file('robot-a'), 'utf8');
    assert.equal(raw.includes(TOKEN), false, 'the token is not stored in clear text');
    assert.equal((await fs.stat(store.file('robot-a'))).mode & 0o777, 0o600);
    assert.equal((await fs.stat(store.directory)).mode & 0o777, 0o700);
    const record = JSON.parse(raw);
    assert.equal(record.schema, 'robowork-git-credentials-v1');
    assert.equal(record.robotId, 'robot-a');
    assert.equal(record.secret.alg, 'aes-256-gcm');
    assert.deepEqual(await store.read('robot-a'), { configured: true, readable: true, metadata, secret: { username: 'x-access-token', token: TOKEN }, location: 'robot' });
    assert.deepEqual(await store.ids(), ['robot-a']);
    // A record copied under another robot's name, a different key or a changed byte is configured but unreadable.
    await fs.writeFile(store.file('robot-b'), raw.replace('"robotId":"robot-a"', '"robotId":"robot-b"'));
    assert.equal((await store.read('robot-b')).readable, false);
    const other = new GitCredentialStore({ dataDir: root, env: { ROBOWORK_CREDENTIALS_KEY: 'another-key' } });
    assert.deepEqual(await other.read('robot-a'), { configured: true, readable: false, metadata, secret: null, location: 'robot' });
    const tampered = { ...record, secret: { ...record.secret, data: Buffer.from('x').toString('base64') } };
    await fs.writeFile(store.file('robot-a'), JSON.stringify(tampered));
    assert.equal((await store.read('robot-a')).readable, false);
    await fs.writeFile(store.file('robot-a'), 'not json');
    assert.equal((await store.read('robot-a')).readable, false);
    assert.equal((await store.read('robot-c')).configured, false);
    assert.equal(await store.remove('robot-a'), true);
    assert.equal(await store.remove('robot-a'), false);
    // Without a key, or with a template Ploinky did not expand, storage reports unavailable instead of failing the service.
    for (const value of [undefined, '', '{{generatedSecret:ROBOWORK_CREDENTIALS_KEY}}']) {
        const missing = new GitCredentialStore({ dataDir: root, env: { ROBOWORK_CREDENTIALS_KEY: value } });
        assert.equal(missing.available, false);
        await assert.rejects(missing.write('robot-a', metadata, TOKEN), { code: 'GIT_CREDENTIALS_UNAVAILABLE' });
    }
});

test('the workspace git credential file has the A2 format and AAD and is written only when configured', async t => {
    const root = await tempRoot(t);
    const env = { ...keys(), ROBOWORK_GIT_MIRROR_DIR: path.join(root, 'mirror') };
    const store = new GitCredentialStore({ dataDir: path.join(root, 'data'), env });
    assert.equal(await store.writeWorkspaceToken(TOKEN), true);
    assert.deepEqual(await store.readWorkspaceToken(), { username: 'x-access-token', token: TOKEN });
    const file = path.join(root, 'mirror', 'credentials.json');
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    const raw = await fs.readFile(file, 'utf8');
    assert.equal(raw.includes(TOKEN), false);
    const mirror = JSON.parse(raw);
    assert.deepEqual(Object.keys(mirror).sort(), ['alg', 'data', 'iv', 'schema', 'tag']);
    assert.equal(mirror.schema, MIRROR_SCHEMA);
    assert.equal(mirror.schema, 'ploinky-git-credentials-v1');
    assert.equal(mirror.alg, 'aes-256-gcm');
    assert.equal(Buffer.from(mirror.iv, 'base64').length, 12);
    assert.equal(Buffer.from(mirror.tag, 'base64').length, 16);
    // The reader Ploinky implements: the hex key and the fixed AAD string.
    const open = aad => {
        const decipher = createDecipheriv('aes-256-gcm', Buffer.from(env.ROBOWORK_GIT_MIRROR_KEY, 'hex'), Buffer.from(mirror.iv, 'base64'));
        decipher.setAAD(Buffer.from(aad, 'utf8'));
        decipher.setAuthTag(Buffer.from(mirror.tag, 'base64'));
        return JSON.parse(Buffer.concat([decipher.update(Buffer.from(mirror.data, 'base64')), decipher.final()]).toString('utf8'));
    };
    const plain = open('ploinky-git-credentials-v1');
    assert.deepEqual(Object.keys(plain).sort(), ['host', 'token', 'updatedAt', 'username']);
    assert.equal(plain.host, 'github.com');
    assert.equal(plain.username, 'x-access-token');
    assert.equal(plain.token, TOKEN);
    assert.ok(!Number.isNaN(Date.parse(plain.updatedAt)));
    assert.throws(() => open('other-aad'));
    assert.deepEqual((await fs.readdir(path.join(root, 'mirror'))), ['credentials.json'], 'no temporary file remains');
    assert.equal(await store.removeWorkspaceToken(), true);
    assert.equal(await store.readWorkspaceToken(), null);
    await assert.rejects(fs.access(file));
    for (const changed of [{ ROBOWORK_GIT_MIRROR_DIR: undefined }, { ROBOWORK_GIT_MIRROR_KEY: undefined },
        { ROBOWORK_GIT_MIRROR_DIR: '{{GIT_CREDENTIALS_CONTAINER_PATH}}' }, { ROBOWORK_GIT_MIRROR_KEY: '{{GIT_CREDENTIALS_KEY}}' },
        { ROBOWORK_GIT_MIRROR_KEY: 'abcd' }, { ROBOWORK_GIT_MIRROR_DIR: 'relative/dir' }]) {
        const disabled = new GitCredentialStore({ dataDir: path.join(root, 'data'), env: { ...env, ...changed } });
        assert.equal(disabled.mirrorAvailable, false);
        assert.equal(await disabled.writeWorkspaceToken(TOKEN), false);
        assert.equal(await disabled.readWorkspaceToken(), null);
    }
    await assert.rejects(fs.access(file));
});

test('the git credential operations are internal tools that only the exact RoboTeam controller may call', async t => {
    const config = JSON.parse(await fs.readFile(new URL('../mcp-config.json', import.meta.url), 'utf8'));
    const names = ['robot_git_credentials_status', 'robot_git_credentials_set', 'robot_git_credentials_delete'];
    for (const name of names) {
        const tool = config.tools.find(entry => entry.name === name);
        assert.ok(tool, name);
        assert.deepEqual(tool.tags, ['internal']);
        assert.deepEqual(tool.args, ['tools/robowork.mjs', name]);
    }
    const calls = [];
    const robots = Object.fromEntries(['gitCredentialsStatus', 'gitCredentialsSet', 'gitCredentialsDelete']
        .map(method => [method, async input => { calls.push({ method, input }); return { ok: true }; }]));
    const server = createRoboWorkServer({ robots, runs: {}, environment: {}, internalToken: 'fixture-capability' });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    const env = { ROBOWORK_INTERNAL_TOKEN: 'fixture-capability', ROBOWORK_SERVICE_PORT: String(server.address().port) };
    const refused = [{}, { invocation: { sub: 'user:a', actor: { kind: 'user', id: 'user:a' } } },
        { invocation: { sub: 'agent:AchillesIDE/gitAgent', actor: { kind: 'agent', id: 'agent:AchillesIDE/gitAgent' } } },
        { invocation: { ...controller.invocation, usr: { id: 'user-1' } } }, { ...controller, user: { id: 'user-1' } }];
    for (const name of names) {
        for (const metadata of refused) await assert.rejects(invoke({ tool: name, input: savedInput, metadata }, name, { env }), { code: 'CALLER_REFUSED' });
        assert.deepEqual(await invoke({ tool: name, input: savedInput, metadata: controller }, name, { env }), { ok: true });
    }
    assert.deepEqual(calls.map(call => call.method), ['gitCredentialsStatus', 'gitCredentialsSet', 'gitCredentialsDelete']);
    // The loopback route still requires the per-launch capability.
    const response = await fetch(`http://127.0.0.1:${env.ROBOWORK_SERVICE_PORT}/internal/robot_git_credentials_status`, { method: 'POST', body: '{}' });
    assert.equal(response.status, 403);
});

test('the home git configuration holds name, email and the helper, includes it once and refuses line injection', async t => {
    const home = await tempRoot(t);
    await fs.writeFile(path.join(home, '.gitconfig'), '[core]\n\teditor = vim');
    await setGitHomeConfig(home, { name: 'Octo "Cat" \\ X', email: 'octo@example.com' });
    await setGitHomeConfig(home, { name: 'Octo "Cat" \\ X', email: 'octo@example.com' });
    const gitconfig = await fs.readFile(path.join(home, '.gitconfig'), 'utf8');
    assert.equal(gitconfig, `[core]\n\teditor = vim\n[include]\n    path = ${GIT_INCLUDE_PATH}\n`);
    assert.equal(withInclude(gitconfig), gitconfig);
    const config = await fs.readFile(path.join(home, '.config/roboteam/git/config'), 'utf8');
    assert.match(config, /^\[credential "https:\/\/github\.com"\]\n {4}helper =\n {4}helper = "!node \\"\$HOME\/\.config\/roboteam\/git\/credential-helper\.mjs\\""\n {4}useHttpPath = false$/mu);
    assert.equal((await fs.stat(path.join(home, '.config/roboteam/git/config'))).mode & 0o777, 0o600);
    assert.deepEqual(await fs.readFile(path.join(home, '.config/roboteam/git/credential-helper.mjs')), await fs.readFile(HELPER));
    // Git itself reads the values back through the include.
    const gitEnv = { HOME: home, GIT_CONFIG_NOSYSTEM: '1' };
    assert.equal((await run('git', ['config', '--global', '--includes', 'user.name'], { env: gitEnv })).stdout, 'Octo "Cat" \\ X\n');
    assert.equal((await run('git', ['config', '--global', '--includes', 'core.editor'], { env: gitEnv })).stdout, 'vim\n');
    assert.equal((await run('git', ['config', '--global', '--includes', '--get-all', 'credential.https://github.com.helper'], { env: gitEnv })).stdout,
        '\n!node "$HOME/.config/roboteam/git/credential-helper.mjs"\n');
    // A missing ~/.gitconfig is created; no token is ever written to the home.
    const fresh = await tempRoot(t);
    await homeOperation('git_config_set', { name: 'A', email: '' }, fresh);
    assert.equal(await fs.readFile(path.join(fresh, '.gitconfig'), 'utf8'), `[include]\n    path = ${GIT_INCLUDE_PATH}\n`);
    assert.doesNotMatch(await fs.readFile(path.join(fresh, '.config/roboteam/git/config'), 'utf8'), /email/u);
    for (const value of ['Octo\nCat', 'x\r[core]', 'a\0b', 'tab\tvalue']) {
        assert.throws(() => gitConfigValue(value));
        assert.throws(() => validateIdentity({ name: value, email: '' }), { code: 'INVALID_INPUT' });
        assert.throws(() => validateIdentity({ name: '', email: value }), { code: 'INVALID_INPUT' });
        await assert.rejects(setGitHomeConfig(fresh, { name: value }));
        await assert.rejects(setGitHomeConfig(fresh, { email: value }));
    }
    // A planted link is never written through.
    const linked = await tempRoot(t);
    await fs.writeFile(path.join(linked, 'target'), 'kept');
    await fs.symlink(path.join(linked, 'target'), path.join(linked, '.gitconfig'));
    await assert.rejects(setGitHomeConfig(linked, { name: 'A' }));
    assert.equal(await fs.readFile(path.join(linked, 'target'), 'utf8'), 'kept');
    await homeOperation('git_config_delete', {}, home);
    await assert.rejects(fs.access(path.join(home, '.config/roboteam/git/config')));
    await assert.rejects(fs.access(path.join(home, '.config/roboteam/git/credential-helper.mjs')));
    assert.equal(await fs.readFile(path.join(home, '.gitconfig'), 'utf8'), gitconfig);
    assert.deepEqual(await deleteGitHomeConfig(await tempRoot(t)), { ok: true });
});

test('the helper prints a credential only for get on https github.com and stays silent otherwise', async t => {
    const root = await tempRoot(t, 'rwh-');
    let status = 200;
    const { socketPath, requests } = await fakeCredentialServer(t, root, (req, res) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(status === 200 ? { username: 'x-access-token', password: TOKEN } : { error: 'Not found' }));
    });
    const env = { ROBOTEAM_GIT_CREDENTIALS_SOCKET: socketPath };
    const helper = (operation, input) => run(process.execPath, [HELPER, operation], { input, env });
    assert.deepEqual(await helper('get', 'protocol=https\nhost=github.com\npath=owner/repo.git\n\n'),
        { code: 0, stdout: `username=x-access-token\npassword=${TOKEN}\n`, stderr: '' });
    assert.deepEqual(JSON.parse(requests[0].body), { protocol: 'https', host: 'github.com' }, 'only protocol and host are sent');
    assert.equal(requests[0].url, '/credential');
    assert.equal(requests.length, 1);
    for (const operation of ['store', 'erase']) {
        assert.deepEqual(await helper(operation, `protocol=https\nhost=github.com\nusername=x\npassword=${TOKEN}\n\n`), { code: 0, stdout: '', stderr: '' });
    }
    for (const input of ['protocol=http\nhost=github.com\n\n', 'protocol=https\nhost=gitlab.com\n\n', 'protocol=https\nhost=github.com.evil\n\n']) {
        assert.deepEqual(await helper('get', input), { code: 0, stdout: '', stderr: '' });
    }
    assert.equal(requests.length, 1, 'store, erase and other hosts never reach the socket');
    status = 404;
    assert.deepEqual(await helper('get', 'protocol=https\nhost=github.com\n\n'), { code: 0, stdout: '', stderr: '' });
    const missing = await run(process.execPath, [HELPER, 'get'], { input: 'protocol=https\nhost=github.com\n\n', env: { ROBOTEAM_GIT_CREDENTIALS_SOCKET: path.join(root, 'none.sock') } });
    assert.deepEqual(missing, { code: 0, stdout: '', stderr: '' });
});

test('the robot socket serves only https github.com from a readable credential, logs without the token and is owner-only', async t => {
    const root = await tempRoot(t);
    const store = new GitCredentialStore({ dataDir: path.join(root, 'data'), env: keys() });
    const soul = path.join(root, 'soul');
    await fs.mkdir(soul);
    const logs = [];
    const sockets = createGitCredentialSockets({ store, log: message => logs.push(message) });
    t.after(() => sockets.close());
    await sockets.prepare('robot-a', soul);
    const socketPath = path.join(soul, 'git-credentials.sock');
    assert.equal((await fs.lstat(socketPath)).mode & 0o777, 0o600);
    const good = { protocol: 'https', host: 'github.com' };
    assert.equal((await request(socketPath, { body: good })).status, 404, 'no stored credential');
    await store.write('robot-a', { host: 'github.com' }, TOKEN);
    assert.deepEqual(JSON.parse((await request(socketPath, { body: good })).body), { username: 'x-access-token', password: TOKEN });
    for (const attempt of [{ body: { protocol: 'http', host: 'github.com' } }, { body: { protocol: 'https', host: 'gitlab.com' } },
        { body: { protocol: 'https', host: 'GitHub.com' } }, { body: {} }, { body: 'text' }, { method: 'GET' }, { url: '/other', body: good }]) {
        const response = await request(socketPath, attempt);
        assert.equal(response.status, 404, JSON.stringify(attempt));
        assert.equal(response.body.includes(TOKEN), false);
    }
    assert.deepEqual(logs, ['git credential served robot=robot-a host=github.com']);
    assert.equal(logs.join('\n').includes(TOKEN), false);
    // An unreadable record is not served.
    const other = new GitCredentialStore({ dataDir: path.join(root, 'data'), env: keys() });
    const otherSockets = createGitCredentialSockets({ store: other, log: () => {} });
    const otherSoul = path.join(root, 'soul-b');
    await fs.mkdir(otherSoul);
    await otherSockets.prepare('robot-a', otherSoul);
    assert.equal((await request(path.join(otherSoul, 'git-credentials.sock'), { body: good })).status, 404);
    await otherSockets.close();
    // A removal takes effect at once, and closing the socket unlinks it.
    await store.remove('robot-a');
    assert.equal((await request(socketPath, { body: good })).status, 404);
    await sockets.remove('robot-a');
    await assert.rejects(fs.lstat(socketPath), { code: 'ENOENT' });
    // A stale socket file is replaced, and a regular file in its place is refused.
    await sockets.prepare('robot-a', soul);
    await sockets.remove('robot-a');
    await fs.writeFile(socketPath, 'planted');
    await assert.rejects(sockets.prepare('robot-a', soul));
    assert.equal(await fs.readFile(socketPath, 'utf8'), 'planted');
});

async function managerFixture(t, { env = keys(), homeOperation: homeOp } = {}) {
    const root = await tempRoot(t);
    const workspaceRoot = path.join(root, 'workspace');
    await fs.mkdir(workspaceRoot);
    const paths = new RobotPaths({ dataDir: path.join(root, 'data'), workspaceRoot });
    const store = new GitCredentialStore({ dataDir: paths.dataDir, env: { ...env, ROBOWORK_GIT_MIRROR_DIR: path.join(root, 'mirror') } });
    const logs = [];
    const sockets = createGitCredentialSockets({ store, log: message => logs.push(message) });
    t.after(() => sockets.close());
    const homeCalls = [];
    const robots = new RobotManager({ paths, toolCache: {}, alaEntry: '/unused', soulGateway: { prepare: async () => {}, remove: async () => {} },
        homeOperation: homeOp || (async (id, operation, input) => { homeCalls.push({ id, operation, input }); return { ok: true }; }),
        gitCredentials: { store, sockets }, log: message => logs.push(message) });
    await robots.initialize();
    for (const directory of [paths.robot('robot-a'), paths.home('robot-a'), path.join(paths.robot('robot-a'), 'run'), paths.soul('robot-a')]) await fs.mkdir(directory, { recursive: true });
    await robots.write({ id: 'robot-a', name: 'default', codingAgents: ['opencode'] });
    return { root, paths, store, sockets, robots, homeCalls, logs };
}

test('set keeps the default robot token only in the workspace file, configures the home without it and opens the socket', async t => {
    const { root, paths, store, robots, homeCalls, logs } = await managerFixture(t);
    const result = await robots.gitCredentialsSet({ ...savedInput, workspaceDefault: true });
    assert.equal(JSON.stringify(result).includes(TOKEN), false, 'the token is never returned');
    assert.equal(result.ok, true);
    assert.equal(result.mirrored, true);
    assert.deepEqual({ ...result.metadata, savedAt: undefined }, { host: 'github.com', githubLogin: 'octocat', name: 'Octo Cat',
        email: 'octo@example.com', savedBy: { id: 'user-1', username: 'alice' }, savedAt: undefined });
    assert.equal(path.dirname(store.file('robot-a')), path.join(paths.dataDir, 'credentials'));
    assert.deepEqual(homeCalls, [{ id: 'robot-a', operation: 'git_config_set', input: { name: 'Octo Cat', email: 'octo@example.com' } }]);
    assert.equal(JSON.stringify(homeCalls).includes(TOKEN), false, 'the home helper never receives the token');
    assert.equal(logs.join('\n').includes(TOKEN), false);
    const status = await robots.gitCredentialsStatus({ robotId: 'robot-a' });
    assert.deepEqual({ ...status, metadata: undefined }, { ok: true, configured: true, readable: true, metadata: undefined, location: 'workspace', available: true });
    // The default robot's record points to the workspace file and holds no secret of its own.
    const record = JSON.parse(await fs.readFile(store.file('robot-a'), 'utf8'));
    assert.equal(record.location, 'workspace');
    assert.equal('secret' in record, false);
    assert.equal(JSON.stringify(status).includes(TOKEN), false);
    const served = await request(path.join(paths.soul('robot-a'), 'git-credentials.sock'), { body: { protocol: 'https', host: 'github.com' } });
    assert.equal(JSON.parse(served.body).password, TOKEN);
    await fs.access(path.join(root, 'mirror', 'credentials.json'));
    // A non-default save leaves the mirror alone; invalid input is refused before anything is stored.
    await fs.rm(path.join(root, 'mirror', 'credentials.json'));
    assert.equal((await robots.gitCredentialsSet(savedInput)).mirrored, undefined);
    await assert.rejects(fs.access(path.join(root, 'mirror', 'credentials.json')));
    for (const changed of [{ token: 'has space' }, { token: 'line\nbreak' }, { token: '' }, { name: 'a\nb' }, { email: 'a\r\nb' },
        { savedBy: null }, { savedBy: { username: 'x' } }, { workspaceDefault: 'yes' }, { robotId: '../x' }]) {
        await assert.rejects(robots.gitCredentialsSet({ ...savedInput, ...changed }), { code: 'INVALID_INPUT' }, JSON.stringify(changed));
    }
    await assert.rejects(robots.gitCredentialsSet({ ...savedInput, robotId: 'robot-z' }), { code: 'UNKNOWN_ROBOT' });
    assert.equal((await store.read('robot-z')).configured, false);
});

test('delete removes the record, the home configuration, the socket and the default mirror, and is idempotent', async t => {
    const { root, paths, store, robots, homeCalls } = await managerFixture(t);
    await robots.gitCredentialsSet({ ...savedInput, workspaceDefault: true });
    homeCalls.length = 0;
    assert.deepEqual(await robots.gitCredentialsDelete({ robotId: 'robot-a', workspaceDefault: true }), { ok: true, deleted: true });
    assert.equal((await store.read('robot-a')).configured, false);
    await assert.rejects(fs.lstat(path.join(paths.soul('robot-a'), 'git-credentials.sock')), { code: 'ENOENT' });
    await assert.rejects(fs.access(path.join(root, 'mirror', 'credentials.json')));
    assert.deepEqual(homeCalls, [{ id: 'robot-a', operation: 'git_config_delete', input: {} }]);
    assert.deepEqual(await robots.gitCredentialsDelete({ robotId: 'robot-a', workspaceDefault: false }), { ok: true, deleted: false });
});

test('deleting a robot deletes its credentials and closes its socket; startup reopens sockets for stored credentials', async t => {
    const { paths, store, sockets, robots } = await managerFixture(t);
    await robots.gitCredentialsSet(savedInput);
    await sockets.remove('robot-a');
    assert.equal(sockets.has('robot-a'), false);
    await robots.restoreGitCredentials();
    assert.equal(sockets.has('robot-a'), true);
    await fs.access(path.join(paths.soul('robot-a'), 'git-credentials.sock'));
    await robots.delete({ robotId: 'robot-a' });
    assert.equal(sockets.has('robot-a'), false);
    assert.equal((await store.read('robot-a')).configured, false);
    await assert.rejects(fs.access(paths.robot('robot-a')));
    // A stored record for a robot RoboWork no longer has does not stop startup.
    await store.write('robot-b', { host: 'github.com' }, TOKEN);
    await robots.restoreGitCredentials();
    assert.equal(sockets.has('robot-b'), false);
});

test('without a storage key the service still answers status and refuses set as unavailable', async t => {
    const { robots } = await managerFixture(t, { env: {} });
    assert.deepEqual(await robots.gitCredentialsStatus({ robotId: 'robot-a' }), { ok: true, configured: false, readable: false, metadata: null, location: null, available: false });
    await assert.rejects(robots.gitCredentialsSet(savedInput), { code: 'GIT_CREDENTIALS_UNAVAILABLE' });
    const bare = new RobotManager({ paths: robots.paths, toolCache: {}, homeOperation: async () => {}, soulGateway: {}, alaEntry: '/unused' });
    assert.equal((await bare.gitCredentialsStatus({ robotId: 'robot-a' })).configured, false);
    await assert.rejects(bare.gitCredentialsSet(savedInput), { code: 'GIT_CREDENTIALS_UNAVAILABLE' });
});

test('git uses the configured helper end to end and the robot environment carries no credential key', async t => {
    const root = await tempRoot(t, 'rwe-');
    const home = path.join(root, 'home');
    await fs.mkdir(home);
    await setGitHomeConfig(home, { name: 'Octo', email: 'octo@example.com' });
    const { socketPath } = await fakeCredentialServer(t, root, (req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ username: 'x-access-token', password: TOKEN }));
    });
    const env = { HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', ROBOTEAM_GIT_CREDENTIALS_SOCKET: socketPath };
    const filled = await run('git', ['credential', 'fill'], { input: 'protocol=https\nhost=github.com\npath=o/r.git\n\n', env });
    assert.equal(filled.code, 0, filled.stderr);
    assert.match(filled.stdout, new RegExp(`^username=x-access-token$`, 'mu'));
    assert.match(filled.stdout, new RegExp(`^password=${TOKEN}$`, 'mu'));
    const other = await run('git', ['credential', 'fill'], { input: 'protocol=https\nhost=gitlab.com\n\n', env });
    assert.notEqual(other.code, 0, 'another host gets no credential and no prompt');
    const { nativeEnvironment } = await import('../server/native-environment.mjs');
    const robotEnv = nativeEnvironment({ PATH: '/usr/bin', ...keys(), ROBOWORK_GIT_MIRROR_DIR: '/git-credentials' }, '/home/robot-a');
    for (const name of ['ROBOWORK_CREDENTIALS_KEY', 'ROBOWORK_GIT_MIRROR_KEY', 'ROBOWORK_GIT_MIRROR_DIR']) assert.equal(name in robotEnv, false, name);
});

test('a default robot save falls back to its own record when the workspace file is not configured', async t => {
    const env = { ...keys(), ROBOWORK_GIT_MIRROR_KEY: undefined };
    const { robots, store } = await managerFixture(t, { env });
    const result = await robots.gitCredentialsSet({ ...savedInput, workspaceDefault: true });
    assert.equal(result.mirrored, false);
    const status = await robots.gitCredentialsStatus({ robotId: 'robot-a' });
    assert.equal(status.location, 'robot');
    assert.equal(status.readable, true);
    assert.equal(store.mirrorAvailable, false);
});

test('a default robot whose workspace file disappeared reads as configured but unreadable and serves nothing', async t => {
    const { root, paths, robots } = await managerFixture(t);
    await robots.gitCredentialsSet({ ...savedInput, workspaceDefault: true });
    await fs.rm(path.join(root, 'mirror', 'credentials.json'));
    const status = await robots.gitCredentialsStatus({ robotId: 'robot-a' });
    assert.equal(status.configured, true);
    assert.equal(status.readable, false);
    const served = await request(path.join(paths.soul('robot-a'), 'git-credentials.sock'), { body: { protocol: 'https', host: 'github.com' } });
    assert.equal(served.status, 404);
});

test('delete removes the token first, so a failing home cleanup leaves no usable token, and a retry finishes', async t => {
    let failDelete = true;
    const homeOperation = async (id, operation) => {
        if (operation === 'git_config_delete' && failDelete) throw Object.assign(new Error('home failed'), { code: 'HOME_OPERATION_FAILED' });
        return { ok: true };
    };
    const { root, store, robots } = await managerFixture(t, { homeOperation });
    await robots.gitCredentialsSet({ ...savedInput, workspaceDefault: true });
    await assert.rejects(robots.gitCredentialsDelete({ robotId: 'robot-a', workspaceDefault: true }), { code: 'HOME_OPERATION_FAILED' });
    await assert.rejects(fs.access(path.join(root, 'mirror', 'credentials.json')));
    assert.equal((await store.read('robot-a')).configured, false);
    failDelete = false;
    assert.deepEqual(await robots.gitCredentialsDelete({ robotId: 'robot-a', workspaceDefault: true }), { ok: true, deleted: false });
});

test('delete follows the record to the workspace file even without the default flag', async t => {
    const { root, robots } = await managerFixture(t);
    await robots.gitCredentialsSet({ ...savedInput, workspaceDefault: true });
    assert.deepEqual(await robots.gitCredentialsDelete({ robotId: 'robot-a' }), { ok: true, deleted: true });
    await assert.rejects(fs.access(path.join(root, 'mirror', 'credentials.json')));
});
