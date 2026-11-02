import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { authorizeCaller } from '../server/caller.mjs';
import { RobotPaths } from '../server/robot-paths.mjs';
import { RunManager } from '../server/run-manager.mjs';
import { RunChannels } from '../server/run-channels.mjs';
import { nativeEnvironment } from '../server/native-environment.mjs';
import { createRoboWorkServer } from '../server/http-server.mjs';
import { EnvironmentManager } from '../server/environment.mjs';
import { buildPrivateLaunch } from '../server/launch.mjs';
import { RobotManager } from '../server/robot-manager.mjs';
import { homeOperation } from '../server/home-op.mjs';
import { RobotStore } from '../../roboTeamAgent/server/robot-store.mjs';

async function startReady(manager, input) { const result = await manager.start(input); await manager.get(input.runId).preparing; return result; }

const subject = 'agent:AchillesIDE/roboTeamAgent';
const grant = () => ({ metadata: { invocation: { sub: subject, actor: { id: subject, kind: 'agent' } } } });

test('only the exact controller acting for itself is accepted', () => {
    assert.doesNotThrow(() => authorizeCaller(grant()));
    for (const payload of [{}, { metadata: { invocation: { sub: 'user:a', actor: { kind: 'user', id: 'user:a' } } } },
        { metadata: { invocation: { sub: 'agent:other', actor: { id: 'agent:other', kind: 'agent' } } } },
        { metadata: { invocation: { ...grant().metadata.invocation, usr: { id: 'user:a' } } } },
        { metadata: { invocation: { ...grant().metadata.invocation, delegation: { user: 'a' } } } },
        { metadata: { ...grant().metadata, user: { id: 'a' } } }]) {
        assert.throws(() => authorizeCaller(payload), { code: 'CALLER_REFUSED' });
    }
});

async function fixture(t, { logCap, program = "process.stdin.on('data',b=>process.stdout.write(b));" } = {}) {
    const root = await fs.realpath(await fs.mkdtemp('/tmp/rw-'));
    const workspaceRoot = path.join(root, 'workspace');
    const cwd = path.join(workspaceRoot, 'project');
    const dataDir = path.join(root, 'data');
    await fs.mkdir(cwd, { recursive: true }); await fs.mkdir(dataDir);
    const paths = new RobotPaths({ dataDir, workspaceRoot });
    let spawns = 0;
    const manager = new RunManager({ paths, logCap, alaEntry: '/unused',
        robots: { require: async id => ({ id, codingAgents: ['opencode'] }) },
        toolCache: { root: path.join(dataDir, 'tool-cache'), prepareCodingAgents: async () => ({}) },
        buildLaunch: async () => { spawns += 1; return { command: process.execPath, args: ['-e', program], options: { detached: true, stdio: ['pipe', 'pipe', 'pipe'] } }; },
    });
    await manager.initialize(); t.after(async () => { await manager.close(); await fs.rm(root, { recursive: true, force: true }); });
    const input = { runId: 'run-1', robotId: 'aaa', cwd, ala: { sessionId: 'session-1' }, folders: [], ignore: [], channels: [], tag: { kind: 'copilot', ownerPrincipal: 'user:a' } };
    return { root, paths, manager, input, spawns: () => spawns };
}

test('cwd and folder grants reject private storage, ancestors and symlink aliases', async t => {
    const { paths, input } = await fixture(t);
    await fs.mkdir(path.join(paths.workspaceRoot, '.data', '.private'), { recursive: true });
    await fs.mkdir(path.join(paths.workspaceRoot, '.ploinky'), { recursive: true });
    const alias = path.join(input.cwd, 'alias'); await fs.symlink(paths.dataDir, alias);
    for (const value of [paths.dataDir, alias, paths.workspaceRoot, path.join(paths.workspaceRoot, '.data'), path.join(paths.workspaceRoot, '.ploinky')]) {
        await assert.rejects(paths.grant(value, 'cwd'), { code: 'CWD_REFUSED' });
    }
    await assert.rejects(paths.grant(alias), { code: 'FOLDER_REFUSED' });
    assert.equal(await paths.grant(input.cwd, 'cwd'), input.cwd);
});

test('folder grants refuse .ploinky except below a registered repository', async t => {
    const { paths, input } = await fixture(t);
    const ploinky = path.join(paths.workspaceRoot, '.ploinky');
    const source = path.join(ploinky, 'repos', 'skills', 'skills', 'one');
    await fs.mkdir(source, { recursive: true }); await fs.mkdir(path.join(ploinky, 'agents', 'x'), { recursive: true });
    const link = path.join(input.cwd, 'to-ploinky'); await fs.symlink(path.join(ploinky, 'agents', 'x'), link);
    for (const value of [ploinky, path.join(ploinky, 'agents'), path.join(ploinky, 'agents', 'x'), path.join(ploinky, 'repos'), path.join(ploinky, 'repos', 'skills'), link]) {
        await assert.rejects(paths.grant(value), { code: 'FOLDER_REFUSED' }, value);
    }
    assert.equal(await paths.grant(source), await fs.realpath(source));
    assert.equal(await paths.grant(path.join(ploinky, 'repos', 'skills', 'skills')), await fs.realpath(path.join(ploinky, 'repos', 'skills', 'skills')));
});

test('the workspace root is refused as a working folder or grant even before private storage exists', async t => {
    const { paths, manager, input } = await fixture(t);
    await assert.rejects(paths.grant(paths.workspaceRoot, 'cwd'), { code: 'CWD_REFUSED', message: /workspace root/u });
    await assert.rejects(paths.grant(paths.workspaceRoot), { code: 'FOLDER_REFUSED', message: /workspace root/u });
    await assert.rejects(manager.start({ ...input, cwd: paths.workspaceRoot }), { code: 'CWD_REFUSED' });
    await assert.rejects(manager.start({ ...input, folders: [{ source: paths.workspaceRoot }] }), { code: 'FOLDER_REFUSED' });
});

test('native ALA arguments grant the working folder and named folders, never the workspace or a sibling project', async t => {
    const { manager, paths, input } = await fixture(t);
    const sibling = path.join(paths.workspaceRoot, 'sibling'); const shared = path.join(paths.workspaceRoot, 'shared');
    await fs.mkdir(sibling); await fs.mkdir(shared);
    await fs.mkdir(path.join(paths.workspaceRoot, '.data'), { recursive: true }); await fs.mkdir(path.join(paths.workspaceRoot, '.ploinky'));
    await fs.writeFile(path.join(paths.workspaceRoot, '.env'), 'fixture');
    let launched;
    manager.buildLaunch = async options => { launched = options; return { command: process.execPath, args: ['-e', "process.stdin.on('data',()=>{});"], options: { detached: true, stdio: ['pipe', 'pipe', 'pipe'] } }; };
    await startReady(manager, { ...input, folders: [{ source: shared }], ignore: [] });
    const folders = launched.args.flatMap((value, index) => value === '--folder' ? [launched.args[index + 1]] : []);
    assert.equal(folders[0], shared);
    for (const hidden of [paths.workspaceRoot, sibling, path.join(paths.workspaceRoot, '.data'), path.join(paths.workspaceRoot, '.ploinky'), path.join(paths.workspaceRoot, '.env')]) {
        assert.ok(!launched.args.includes(hidden), `Unexpected ALA argument: ${hidden}`);
    }
    assert.deepEqual(launched.args.flatMap((value, index) => value === '--ignore' ? [launched.args[index + 1]] : []), [path.join(input.cwd, '.roboteam')]);
    assert.equal(launched.args[launched.args.indexOf('--cwd') + 1], input.cwd);
});

test('concurrent run_start is idempotent; stdin/output, durable replay and unknown ids', async t => {
    const { manager, input, spawns, paths } = await fixture(t);
    const starts = await Promise.all([manager.start(input), manager.start(input)]);
    await manager.get(input.runId).preparing;
    assert.equal(spawns(), 1); assert.equal(starts.filter(value => value.alreadyRunning).length, 1);
    await manager.input({ runId: input.runId, data: Buffer.from('hello\n').toString('base64') });
    let result;
    for (let attempt = 0; attempt < 20; attempt++) {
        result = await manager.read({ runId: input.runId, after: 0, waitMs: 100 });
        if (result.records.some(record => record.stream === 'stdout')) break;
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(result.records.filter(record => record.stream === 'stdout').map(record => Buffer.from(record.data, 'base64').toString()).join(''), 'hello\n');
    assert.equal(result.next, result.records.at(-1).seq);
    await assert.rejects(manager.read({ runId: 'missing' }), { code: 'UNKNOWN_RUN' });
    await assert.rejects(manager.read({ runId: input.runId, after: -1 }), { code: 'INVALID_INPUT' });
    await assert.rejects(manager.start({ ...input, runId: '../bad' }), { code: 'INVALID_INPUT' });
    await assert.rejects(manager.start({ ...input, runId: 'bad-folder', folders: [null] }), { code: 'INVALID_INPUT' });
    await assert.rejects(manager.input({ runId: input.runId, close: 'yes' }), { code: 'INVALID_INPUT' });
    await manager.input({ runId: input.runId, close: true });
    await manager.close();
    const restored = new RunManager({ paths }); await restored.initialize();
    assert.deepEqual((await restored.read({ runId: input.runId })).records, result.records);
    assert.deepEqual(restored.list()[0].tag, input.tag);
});

test('read accepts interface wait values but never holds more than 100 ms plus scheduler tolerance', async t => {
    const { manager, input } = await fixture(t);
    await startReady(manager, input);
    const start = performance.now();
    await manager.read({ runId: input.runId, after: 0, waitMs: 5000 });
    assert.ok(performance.now() - start < 1000);
    await manager.close();
    assert.equal(manager.get(input.runId).meta.state, 'interrupted');
});

test('log cap stops a noisy process and persists the cap outcome', async t => {
    const { manager, input } = await fixture(t, { logCap: 65536, program: "setInterval(()=>process.stdout.write(Buffer.alloc(32768,65)),1);" });
    await startReady(manager, input);
    for (let attempt = 0; attempt < 50 && manager.get(input.runId).meta.state === 'running'; attempt++) await new Promise(resolve => setTimeout(resolve, 20));
    const run = manager.get(input.runId);
    await run.finishing;
    assert.equal(run.meta.logCapped, true); assert.equal(run.meta.state, 'exited');
    assert.ok((await fs.stat(path.join(run.directory, 'log.ndjson'))).size <= 65536);
});

test('callback capability gates access and relays pending/replied JSON', async t => {
    const { paths } = await fixture(t);
    const channels = new RunChannels({ directory: path.join(paths.dataDir, 'channels'), definitions: [{ name: 'human-input', context: {} }] });
    const [mount] = await channels.prepare(); t.after(() => channels.close());
    const { token } = JSON.parse(await fs.readFile(path.join(mount.source, 'context.json'), 'utf8'));
    const request = capability => new Promise((resolve, reject) => {
        const req = http.request({ socketPath: path.join(mount.source, 'request.sock'), method: 'POST', path: '/require-human-input',
            headers: { 'x-task-capability': capability } }, res => { let text = ''; res.on('data', chunk => { text += chunk; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) })); });
        req.on('error', reject); req.end(JSON.stringify({ question: 'Continue?' }));
    });
    assert.equal((await request('wrong')).status, 403);
    const response = request(token);
    for (let attempt = 0; attempt < 30 && !channels.list().length; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    const [callback] = channels.list(); assert.equal(callback.body.question, 'Continue?');
    await channels.reply({ id: callback.id, status: 200, body: { answer: 'yes' } });
    assert.deepEqual(await response, { status: 200, body: { answer: 'yes' } }); assert.equal(channels.list().length, 0);
});

test('native environment excludes service credentials and unrelated variables', () => {
    const env = nativeEnvironment({ PATH: '/bin', PLOINKY_AGENT_SECRET: 'forbidden', ROBOWORK_INTERNAL_TOKEN: 'forbidden', API_KEY: 'forbidden', NODE_OPTIONS: '--bad' }, '/home/aaa');
    assert.equal(env.HOME, '/home/aaa'); assert.equal(env.USER, 'aaa'); assert.equal(env.ALA_SANDBOX_HOME, '/home/aaa');
    assert.ok(!Object.keys(env).some(key => /SECRET|TOKEN|KEY|PLOINKY|NODE_OPTIONS/u.test(key)));
});

test('lightweight robot ensure completes on a cold cache without downloads and retains config on repeated calls', async t => {
    const { paths } = await fixture(t);
    await fs.mkdir(path.join(paths.workspaceRoot, '.data'), { recursive: true });
    await fs.mkdir(path.join(paths.home('aaa'), '.ala'), { recursive: true });
    const config = { codingAgent: 'opencode', models: { opencode: 'kept-model' }, efforts: { opencode: 'high' } };
    const file = path.join(paths.home('aaa'), '.ala', 'config.json');
    await fs.writeFile(file, JSON.stringify(config));
    let downloads = 0;
    const homes = [], sockets = [];
    const never = () => { downloads++; return new Promise(() => {}); };
    const robots = new RobotManager({ paths, toolCache: { root: path.join(paths.dataDir, 'tool-cache'),
        prepareShellTools: never, prepareOpenCodePlugin: never },
    homeOperation: async (id, operation, input) => { homes.push({ id, operation, input }); return homeOperation(operation, input, paths.home(id)); },
    soulGateway: { prepare: async directory => { sockets.push(directory); } } });
    await robots.initialize();
    const input = { robotId: 'aaa', name: 'default', codingAgents: ['opencode'], seed: false };
    let timer;
    try {
        await Promise.race([robots.ensure(input), new Promise((resolve, reject) => {
            timer = setTimeout(() => reject(new Error('Lightweight startup waited for cold native tools')), 500);
        })]);
    } finally { clearTimeout(timer); }
    const record = await robots.require('aaa');
    await Promise.all([robots.ensure(input), robots.ensure(input)]);
    assert.equal(downloads, 0);
    assert.deepEqual(await robots.require('aaa'), record);
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), config);
    assert.equal(homes.length, 3);
    assert.ok(homes.every(entry => entry.operation === 'ensure' && !entry.input.openCodePlugin));
    assert.ok(sockets.every(directory => directory === paths.soul('aaa')));
    const shell = await fs.readFile(path.join(paths.home('aaa'), '.roboteam-env.sh'), 'utf8');
    assert.ok(shell.includes(path.join(paths.dataDir, 'tool-cache', 'shell-selections', 'shell', 'bin')));
    assert.equal((await fs.stat(path.join(paths.workspaceRoot, '.data', 'roboWorkAgent', 'terminal', 'aaa'))).isDirectory(), true);
    const history = path.join(paths.workspaceRoot, '.data', 'roboWorkAgent', 'terminal', 'aaa', '.bash_history');
    await fs.writeFile(history, 'old outer-shell history');
    await robots.ensure(input);
    assert.equal(await fs.readFile(history, 'utf8'), 'old outer-shell history');
    assert.deepEqual(await robots.require('aaa'), record);
});

test('full robot ensure still prepares native tools and plugin templates before home preparation', async t => {
    const { paths } = await fixture(t);
    await fs.mkdir(path.join(paths.workspaceRoot, '.data'), { recursive: true });
    const calls = [];
    const cacheRoot = path.join(paths.dataDir, 'tool-cache');
    const tools = { binPath: path.join(cacheRoot, 'shell-selections', 'shell-opencode', 'bin'),
        agents: { opencode: { binPath: path.join(cacheRoot, 'opencode', 'bin'), versions: { opencode: '1.2.3' } } } };
    const template = { path: path.join(cacheRoot, 'plugin'), version: '1.2.3' };
    const robots = new RobotManager({ paths, toolCache: { root: cacheRoot,
        prepareShellTools: async agents => { calls.push(['tools', agents]); return tools; },
        prepareOpenCodePlugin: async version => { calls.push(['plugin', version]); return template; } },
    homeOperation: async (id, operation, input) => { calls.push(['home', id, operation, input]); },
    soulGateway: { prepare: async () => {} } });
    await robots.initialize();
    await robots.ensure({ robotId: 'aaa', name: 'default', codingAgents: ['opencode'] });
    assert.deepEqual(calls.slice(0, 2), [['tools', ['opencode']], ['plugin', '1.2.3']]);
    assert.equal(calls[2][3].openCodePlugin, template);
    assert.equal(calls[2][3].binPath, tools.binPath);
});

test('registry creation requests lightweight setup without replacing its stored default record', async t => {
    const { paths } = await fixture(t);
    const calls = [];
    const store = new RobotStore({ dataDir: path.join(paths.workspaceRoot, '.data', 'roboTeamAgent'),
        roboWork: { call: async (tool, input) => { calls.push({ tool, input }); } } });
    // The public registry lock needs Linux /proc; this is its shared creation body.
    const first = await store._create({ name: 'default' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].tool, 'robot_ensure');
    assert.equal(calls[0].input.seed, false);
    assert.deepEqual(await store.getByName('default'), first);
    assert.deepEqual(await store.getByName('default'), first);
    assert.equal(calls.length, 1);
    const config = JSON.parse(await fs.readFile(new URL('../mcp-config.json', import.meta.url), 'utf8'));
    assert.equal(config.tools.find(tool => tool.name === 'robot_ensure').inputSchema.seed.type, 'boolean');
});

test('environment stop checks the exact container label and robot before signalling', async t => {
    const { manager } = await fixture(t);
    const calls = [];
    manager.execFileImpl = async (command, args) => {
        calls.push(args);
        return { stdout: JSON.stringify({ 'robowork.environment': 'true', 'robowork.robot': 'aaa' }) };
    };
    const run = { meta: { robotId: 'aaa' }, containerName: 'robowork-env-' + 'a'.repeat(24) };
    await manager.stopEnvironment(run, 'SIGTERM');
    assert.equal(calls.at(-1)[0], 'kill');
    calls.length = 0;
    await assert.rejects(manager.stopEnvironment({ ...run, meta: { robotId: 'bbb' } }, 'SIGTERM'), { code: 'ENVIRONMENT_STOP_FAILED' });
    assert.ok(!calls.some(args => args[0] === 'kill'));
});

test('Environment ALA arguments use mounted sources for skills, callbacks and Soul without private source binds', async t => {
    const { manager, paths, input } = await fixture(t);
    const skills = path.join(paths.workspaceRoot, '.data', 'roboTeamAgent', 'skills');
    const plain = path.join(paths.workspaceRoot, 'public-files');
    await fs.mkdir(path.join(paths.workspaceRoot, 'sibling'));
    for (const directory of [skills, plain, manager.toolCache.root, paths.home(input.robotId), paths.soul(input.robotId)]) await fs.mkdir(directory, { recursive: true });
    const environment = new EnvironmentManager();
    environment.prepare = async () => ({ image: 'fixture-image', imagePath: '/usr/local/bin:/usr/bin:/bin' });
    manager.environment = environment;
    manager.runtimeBundle = { prepare: async () => ({ ala: { path: '/fixture/ala' }, bwrap: { bin: '/fixture/bwrap' } }) };
    let command;
    manager.spawnImpl = (executable, args) => {
        command = { executable, args };
        return spawn(process.execPath, ['-e', "process.stdin.on('data',()=>{});"], { detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    };
    manager.execFileImpl = async () => { throw Object.assign(new Error('No fixture container'), { code: 1 }); };
    const exported = path.join(input.cwd, '.agents', 'skills');
    const repeated = path.join(input.cwd, '.claude', 'skills');
    await startReady(manager, { ...input, environment: 'repo/agent', folders: [
        { source: skills, alias: 'roboteam-skill-0', expose: true },
        { source: skills, at: exported, expose: true },
        { source: skills, at: repeated, expose: true },
        { source: plain },
    ], channels: [{ name: 'ploinky-runtime' }, { name: 'human-input' }, { name: 'task-failure', alias: 'own-task-failure' }] });
    const args = command.args.slice(command.args.indexOf('/opt/robowork-ala/bin/ala.mjs') + 1);
    const mounts = command.args.flatMap((value, index) => value === '--volume' ? [command.args[index + 1].split(':')] : []);
    const folderArguments = [];
    for (let index = 0; index < args.length; index++) {
        if (args[index] !== '--folder') continue;
        const folder = [args[++index]];
        if (['as', 'at'].includes(args[index + 1])) folder.push(args[++index], args[++index]);
        if (args[index + 1] === 'expose') folder.push(args[++index]);
        folderArguments.push(folder);
    }
    assert.deepEqual(folderArguments, [
        ['/workspace/roboteam-skill-0', 'as', 'roboteam-skill-0', 'expose'],
        [exported, 'at', exported, 'expose'], [repeated, 'at', repeated, 'expose'], [plain],
        ['/workspace/ploinky-runtime', 'as', 'ploinky-runtime'], ['/workspace/roboflow-human-input', 'as', 'roboflow-human-input'],
        ['/workspace/own-task-failure', 'as', 'own-task-failure'], ['/workspace/roboteam-soul', 'as', 'roboteam-soul'],
    ]);
    for (const [source] of folderArguments) assert.ok(mounts.some(([, target]) => target === source), `ALA source is not mounted: ${source}`);
    assert.ok(!mounts.some(([, target]) => target.startsWith(paths.robot(input.robotId)) || target.startsWith(paths.run(input.runId))));
    assert.equal(args[args.indexOf('--home') + 1], '/home/aaa');
    assert.ok(command.args.includes(`ALA_SESSIONS=${path.join(input.cwd, '.roboteam', '.ala')}`));
    assert.ok(args.some((value, index) => value === '--ignore' && args[index + 1] === path.join(input.cwd, '.roboteam')));
    // The workspace is neither mounted nor named, and no private child needs a mask.
    assert.ok(!mounts.some(([source, target]) => source === paths.workspaceRoot || target === paths.workspaceRoot));
    assert.ok(!mounts.some(([source]) => source === path.join(paths.workspaceRoot, 'sibling')));
    assert.ok(!command.args.includes('--tmpfs'));
    assert.deepEqual(args.flatMap((value, index) => value === '--ignore' ? [args[index + 1]] : []), [path.join(input.cwd, '.roboteam')]);
});

test('native ALA host receives the controller-derived transcript directory through the actual launch allowlist', async t => {
    const { manager, paths, input } = await fixture(t);
    let launch;
    manager.buildLaunch = async options => { launch = await buildPrivateLaunch(options); return launch; };
    manager.spawnImpl = () => spawn(process.execPath, ['-e', "process.stdin.on('data',()=>{});"], { detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    await startReady(manager, input);
    assert.equal(launch.options.env.ALA_SESSIONS, path.join(input.cwd, '.roboteam', '.ala'));
    const wrapper = await fs.readFile(path.join(paths.run(input.runId), 'launch.sh'), 'utf8');
    assert.ok(wrapper.includes("'--ignore' '" + path.join(input.cwd, '.roboteam') + "'"));
    assert.ok(!Object.keys(launch.options.env).some(key => key.startsWith('PLOINKY_')));
});

test('resident HTTP service refuses missing token and returns stable operation errors', async t => {
    const { manager } = await fixture(t);
    const server = createRoboWorkServer({ robots: {}, runs: manager, environment: {}, internalToken: 'private' });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    const url = `http://127.0.0.1:${server.address().port}/internal/run_read`;
    const refused = await fetch(url, { method: 'POST', body: '{}' }); assert.equal(refused.status, 403);
    const unknown = await fetch(url, { method: 'POST', headers: { 'x-robowork-internal-token': 'private' }, body: JSON.stringify({ runId: 'unknown' }) });
    assert.equal(unknown.status, 404); assert.equal((await unknown.json()).code, 'UNKNOWN_RUN');
});
