import test from 'node:test';
import assert from 'node:assert/strict';
import { fstatSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
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
    for (const value of [ploinky, path.join(ploinky, 'agents'), path.join(ploinky, 'agents', 'x'), path.join(ploinky, 'repos'), link]) {
        await assert.rejects(paths.grant(value), { code: 'FOLDER_REFUSED' }, value);
    }
    assert.equal(await paths.grant(source), await fs.realpath(source));
    assert.equal(await paths.grant(path.join(ploinky, 'repos', 'skills', 'skills')), await fs.realpath(path.join(ploinky, 'repos', 'skills', 'skills')));
    // A repository may itself be one skill.
    assert.equal(await paths.grant(path.join(ploinky, 'repos', 'skills')), await fs.realpath(path.join(ploinky, 'repos', 'skills')));
});

test('grants refuse .data, .ploinky-box, its quarantined siblings and the root .env for both kinds, whatever they are below', async t => {
    const { paths, input } = await fixture(t);
    const entries = { '.data': ['emailAgent', 'roboTeamAgent/skills'], '.ploinky-box': ['state'], '.ploinky-box.old': ['state'] };
    for (const [name, children] of Object.entries(entries)) for (const child of ['', ...children]) await fs.mkdir(path.join(paths.workspaceRoot, name, child), { recursive: true });
    await fs.writeFile(path.join(paths.workspaceRoot, '.env'), 'x');
    const link = path.join(input.cwd, 'to-box'); await fs.symlink(path.join(paths.workspaceRoot, '.ploinky-box', 'state'), link);
    for (const [name, children] of Object.entries(entries)) for (const child of ['', ...children]) {
        const value = path.join(paths.workspaceRoot, name, child);
        await assert.rejects(paths.grant(value), { code: 'FOLDER_REFUSED' }, value);
        await assert.rejects(paths.grant(value, 'cwd'), { code: 'CWD_REFUSED' }, value);
    }
    await assert.rejects(paths.grant(link), { code: 'FOLDER_REFUSED' });
    // A folder that merely looks similar is an ordinary project.
    const lookalike = path.join(paths.workspaceRoot, '.ploinky-boxes'); await fs.mkdir(lookalike);
    assert.equal(await paths.grant(lookalike), lookalike);
});

test('the workspace root is refused as a working folder or grant even before private storage exists', async t => {
    const { paths, manager, input } = await fixture(t);
    await assert.rejects(paths.grant(paths.workspaceRoot, 'cwd'), { code: 'CWD_REFUSED', message: /workspace root/u });
    await assert.rejects(paths.grant(paths.workspaceRoot), { code: 'FOLDER_REFUSED', message: /workspace root/u });
    await assert.rejects(manager.start({ ...input, cwd: paths.workspaceRoot }), { code: 'CWD_REFUSED' });
    await assert.rejects(manager.start({ ...input, folders: [{ source: paths.workspaceRoot }] }), { code: 'FOLDER_REFUSED' });
});

// The ALA --folder arguments as [source, ...modifiers] lists.
function folderArguments(args) {
    const folders = [];
    for (let index = 0; index < args.length; index++) {
        if (args[index] !== '--folder') continue;
        const folder = [args[++index]];
        if (['as', 'at'].includes(args[index + 1])) folder.push(args[++index], args[++index]);
        if (args[index + 1] === 'expose') folder.push(args[++index]);
        folders.push(folder);
    }
    return folders;
}
const ignoredArguments = args => args.flatMap((value, index) => value === '--ignore' ? [args[index + 1]] : []);

async function plantWorkspaceState(workspaceRoot) {
    for (const name of ['.data', '.ploinky', '.ploinky-box']) await fs.mkdir(path.join(workspaceRoot, name), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, '.env'), 'fixture');
}

test('native ALA arguments show the workspace read-only with its private entries masked, the working folder and named folders', async t => {
    const { manager, paths, input } = await fixture(t);
    const sibling = path.join(paths.workspaceRoot, 'sibling'); const shared = path.join(paths.workspaceRoot, 'shared');
    await fs.mkdir(sibling); await fs.mkdir(shared);
    await plantWorkspaceState(paths.workspaceRoot);
    let launched, launches = 0;
    manager.buildLaunch = async options => { launches += 1; launched = options; return { command: process.execPath, args: ['-e', "process.stdin.on('data',()=>{});"], options: { detached: true, stdio: ['pipe', 'pipe', 'pipe'] } }; };
    await startReady(manager, { ...input, folders: [{ source: shared }], ignore: [] });
    // The workspace is one plain read-only folder at its canonical path, never an exposed export. A folder inside it is an export over it.
    assert.deepEqual(folderArguments(launched.args), [[paths.workspaceRoot], [shared, 'at', shared, 'expose'],
        [paths.soul(input.robotId), 'as', 'roboteam-soul']]);
    const workspace = name => path.join(paths.workspaceRoot, name);
    // The folder's own private data stays the first ignored path, as it always has been; the workspace masks follow.
    assert.deepEqual(ignoredArguments(launched.args), [path.join(input.cwd, '.roboteam'), workspace('.data'), workspace('.env'), workspace('.ploinky'), workspace('.ploinky-box')]);
    // The sibling project is reached only through the workspace, never named, and the working folder stays the only writable grant.
    assert.ok(!launched.args.includes(sibling));
    assert.equal(launched.args[launched.args.indexOf('--cwd') + 1], input.cwd);
    assert.ok(!launched.args.includes('write'));
    // A replayed start neither launches again nor builds a second set of arguments.
    assert.equal((await manager.start({ ...input, folders: [{ source: shared }], ignore: [] })).alreadyRunning, true);
    assert.equal(launches, 1);
});

test('a caller cannot grant, widen or drop the workspace view', async t => {
    const { manager, paths, input } = await fixture(t);
    await plantWorkspaceState(paths.workspaceRoot);
    const ploinky = path.join(paths.workspaceRoot, '.ploinky');
    const repository = path.join(ploinky, 'repos', 'skills', 'one');
    await fs.mkdir(repository, { recursive: true });
    await fs.mkdir(path.join(paths.workspaceRoot, '.data', 'emailAgent'), { recursive: true });
    const refused = (folder, code = 'FOLDER_REFUSED') => assert.rejects(manager.start({ ...input, runId: 'refused-' + Math.random().toString(36).slice(2, 8), folders: [folder] }), { code }, JSON.stringify(folder));
    await refused({ source: paths.workspaceRoot });
    await refused({ source: input.cwd, at: paths.workspaceRoot, expose: true });
    await refused({ source: input.cwd, at: path.dirname(paths.workspaceRoot), expose: true });
    await refused({ source: path.join(paths.workspaceRoot, '.data', 'emailAgent'), alias: 'mail', expose: true });
    await refused({ source: path.join(paths.workspaceRoot, '.ploinky-box'), alias: 'box', expose: true });
    await refused({ source: path.join(paths.workspaceRoot, '.ploinky-box'), at: path.join(paths.workspaceRoot, '.ploinky-box'), expose: true });
    await refused({ source: input.cwd, at: path.join(paths.workspaceRoot, '.ploinky-box', 'inside'), expose: true });
    // A plain grant becomes an export at its own path, which the `.ploinky` target check refuses; an alias is not a path in the workspace.
    await refused({ source: repository });
    await refused({ source: repository, at: repository, expose: true });
    await assert.rejects(manager.start({ ...input, runId: 'relative-ignore', ignore: ['relative'] }), { code: 'INVALID_INPUT' });
    // A caller's ignore list can only add masks.
    let launched;
    manager.buildLaunch = async options => { launched = options; return { command: process.execPath, args: ['-e', "process.stdin.on('data',()=>{});"], options: { detached: true, stdio: ['pipe', 'pipe', 'pipe'] } }; };
    await startReady(manager, { ...input, runId: 'aliased', folders: [{ source: repository, alias: 'skill-one', expose: true }], ignore: [] });
    assert.deepEqual(folderArguments(launched.args).slice(0, 2), [[paths.workspaceRoot], [repository, 'as', 'skill-one', 'expose']]);
    assert.deepEqual(ignoredArguments(launched.args).slice(1, 5), ['.data', '.env', '.ploinky', '.ploinky-box'].map(name => path.join(paths.workspaceRoot, name)));
    const extra = path.join(paths.workspaceRoot, 'extra'); await fs.mkdir(extra);
    await startReady(manager, { ...input, runId: 'extra-mask', ignore: [extra, path.join(paths.workspaceRoot, 'absent')] });
    assert.equal(ignoredArguments(launched.args)[0], path.join(input.cwd, '.roboteam'));
    assert.equal(ignoredArguments(launched.args).at(-1), extra);
    assert.ok(!ignoredArguments(launched.args).includes(path.join(paths.workspaceRoot, 'absent')));
});

test('a start whose workspace cannot be shown safely is refused with its reason and launches nothing', async t => {
    const { manager, paths, input, spawns } = await fixture(t);
    assert.equal(spawnSync('mkfifo', [path.join(paths.workspaceRoot, '.env')]).status, 0);
    await manager.start(input);
    await manager.get(input.runId).preparing;
    const records = (await manager.read({ runId: input.runId, after: 0, waitMs: 0 })).records;
    const text = records.map(record => Buffer.from(record.data, 'base64').toString()).join('');
    assert.match(text, /preparation ended: WORKSPACE_UNAVAILABLE: A hidden workspace entry is neither a file nor a directory/u);
    assert.equal(spawns(), 0);
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

test('ALA receives an explicit coding agent, the GUI endpoint of the run and nothing for automatic selection', async t => {
    const { manager, input } = await fixture(t);
    const launches = [], guiRequests = [];
    manager.buildLaunch = async launch => { launches.push(launch); return { command: process.execPath, args: ['-e', ''], options: { detached: true, stdio: ['pipe', 'pipe', 'pipe'] } }; };
    manager.gui = { ensureReady: async request => { guiRequests.push(request); return { mcpPort: 8100 }; } };
    const value = (args, flag) => args[args.indexOf(flag) + 1];
    const launch = async (runId, extra) => {
        await manager.start({ ...input, runId, ...extra });
        await manager.get(runId).preparing;
        return launches.at(-1);
    };
    const explicit = await launch('run-explicit', { ala: { sessionId: 'session-1', ca: 'codex' }, gui: { mode: 'desktop' } });
    assert.equal(value(explicit.args, '--ca'), 'codex');
    assert.equal(value(explicit.args, '--MCPServers'), 'desktop=http://127.0.0.1:8100/mcp');
    assert.equal(explicit.guiPort, 8100);
    assert.deepEqual(guiRequests.map(request => [request.robotId, request.mode, request.codingAgents]), [['aaa', 'desktop', ['opencode']]]);
    const automatic = await launch('run-automatic', { ala: { sessionId: 'session-2' } });
    assert.equal(automatic.args.includes('--ca'), false);
    assert.equal(automatic.args.includes('--MCPServers'), false);
    assert.equal(automatic.guiPort, undefined);
    assert.equal(guiRequests.length, 1, 'a run without a GUI never asks for one');
    const both = await launch('run-both', { ala: { sessionId: 'session-3', mcpServers: ['docs=http://127.0.0.1:1/mcp'] }, gui: { mode: 'browser' } });
    assert.equal(value(both.args, '--MCPServers'), 'docs=http://127.0.0.1:1/mcp,browser=http://127.0.0.1:8100/mcp');
    assert.equal(both.args.includes('--ca'), false);
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

test('a robot home replaced by a link to another robot home is refused and that home is left untouched', async t => {
    const { paths } = await fixture(t);
    await fs.mkdir(path.join(paths.workspaceRoot, '.data'), { recursive: true });
    const calls = [];
    const robots = new RobotManager({ paths, toolCache: { root: path.join(paths.dataDir, 'tool-cache'), prepareShellTools: async () => ({}) },
        homeOperation: async (id, operation) => { calls.push([id, operation]); },
        soulGateway: { prepare: async () => {} } });
    await robots.initialize();
    await robots.ensure({ robotId: 'bbb', name: 'other', codingAgents: ['opencode'], seed: false });
    await fs.writeFile(path.join(paths.home('bbb'), 'secret'), 'robot-b data');
    calls.length = 0;
    const before = await fs.readdir(paths.home('bbb'));
    await fs.mkdir(paths.robot('aaa'), { recursive: true });
    await fs.symlink(paths.home('bbb'), paths.home('aaa'));
    await assert.rejects(robots.ensure({ robotId: 'aaa', name: 'first', codingAgents: ['opencode'], seed: false }), { code: 'UNSAFE_STORAGE' });
    await assert.rejects(robots.delete({ robotId: 'aaa' }), { code: 'UNSAFE_STORAGE' });
    assert.deepEqual(calls, []);
    assert.deepEqual(await fs.readdir(paths.home('bbb')), before);
    assert.equal(await fs.readFile(path.join(paths.home('bbb'), 'secret'), 'utf8'), 'robot-b data');
    // The robot directory itself may not be a link either.
    await fs.rm(paths.robot('aaa'), { recursive: true });
    await fs.symlink(paths.robot('bbb'), paths.robot('aaa'));
    await assert.rejects(robots.ensure({ robotId: 'aaa', name: 'first', codingAgents: ['opencode'], seed: false }), { code: 'UNSAFE_STORAGE' });
    await assert.rejects(robots.delete({ robotId: 'aaa' }), { code: 'UNSAFE_STORAGE' });
    assert.deepEqual(calls, []);
    assert.deepEqual(await fs.readdir(paths.home('bbb')), before);
});

test('status reports the configured agent when enabled and otherwise the first enabled one', async t => {
    const { paths } = await fixture(t);
    await fs.mkdir(path.join(paths.home('aaa'), '.ala'), { recursive: true });
    const file = path.join(paths.home('aaa'), '.ala', 'config.json');
    await fs.writeFile(file, JSON.stringify({ codingAgent: 'pi', models: {}, efforts: {} }));
    const status = codingAgents => homeOperation('status', { codingAgents }, paths.home('aaa'));
    assert.equal((await status(['opencode', 'pi'])).activeAgent, 'pi');
    assert.equal((await status(['codex', 'opencode'])).activeAgent, 'codex');
    assert.equal((await status(['claude'])).activeAgent, 'claude');
    assert.equal((await homeOperation('status', {}, paths.home('aaa'))).activeAgent, 'pi');
});

test('an unavailable ALA leaves the status listing answering with every login absent, logged once, and nothing else', async t => {
    const { paths } = await fixture(t);
    await fs.mkdir(path.join(paths.home('aaa'), '.ala'), { recursive: true });
    const file = path.join(paths.home('aaa'), '.ala', 'config.json');
    await fs.writeFile(file, JSON.stringify({ codingAgent: 'pi', models: {}, efforts: {} }));
    const previous = process.env.ROBOWORK_ALA_ENTRY;
    t.after(() => { if (previous === undefined) delete process.env.ROBOWORK_ALA_ENTRY; else process.env.ROBOWORK_ALA_ENTRY = previous; });
    const logged = [];
    t.mock.method(console, 'error', (...args) => logged.push(args));
    const robots = new RobotManager({ paths, toolCache: {}, soulGateway: {},
        homeOperation: async (id, operation, input) => homeOperation(operation, input, paths.home(id)) });
    await robots.write({ id: 'aaa', name: 'a', codingAgents: ['opencode', 'pi'] });
    const logins = { codex: false, opencode: false, pi: false, claude: false };
    process.env.ROBOWORK_ALA_ENTRY = path.join(paths.dataDir, 'missing', 'bin', 'ala.mjs');
    for (let round = 0; round < 2; round++) {
        assert.deepEqual((await robots.status({ robotIds: ['aaa'], includeLogins: true })).robots,
            [{ id: 'aaa', activeAgent: 'pi', logins, gui: { state: 'stopped', mode: null, sessionUrl: null, cwd: null } }]);
    }
    assert.equal(logged.length, 1);
    assert.deepEqual((await robots.status({ robotIds: ['aaa'] })).robots[0].logins, undefined);
    // Only the status path tolerates it.
    await assert.rejects(homeOperation('config', {}, paths.home('aaa')));
    // What ALA accepts stays accepted.
    for (const accepted of ['{"codingAgent":null,"models":null}', '{"codingAgent":"omp"}', '{"models":{"pi":"m"},"efforts":{"pi":"high"}}']) {
        await fs.writeFile(file, accepted);
        assert.equal((await robots.status({ robotIds: ['aaa'] })).robots.length, 1, accepted);
    }
    // A refused or unreadable home is not an empty one.
    for (const invalid of ['{ not json', '[]', '5', '{"unknownField":1}', '{"codingAgent":"bogus"}', '{"codingAgent":"pi","models":5}', '{"efforts":{"pi":1}}',
        '{"models":{"bogus":"x"}}', '{"models":{"pi":"  "}}', '{"efforts":{"pi":"high"}}', '{"models":{"pi":"m"},"efforts":{"bogus":"high"}}', '{"models":{"pi":"m"},"efforts":{"pi":"a b"}}']) {
        await fs.writeFile(file, invalid);
        await assert.rejects(robots.status({ robotIds: ['aaa'] }), undefined, invalid);
    }
    await fs.rm(file);
    await fs.writeFile(file + '.target', '{}');
    await fs.symlink(file + '.target', file);
    await assert.rejects(robots.status({ robotIds: ['aaa'] }), /Unsafe ALA model configuration path/u);
    // ALA answering again clears the condition, so a later failure is logged again.
    await fs.rm(file);
    if (previous === undefined) delete process.env.ROBOWORK_ALA_ENTRY; else process.env.ROBOWORK_ALA_ENTRY = previous;
    assert.equal((await robots.status({ robotIds: ['aaa'] })).robots.length, 1);
    process.env.ROBOWORK_ALA_ENTRY = path.join(paths.dataDir, 'missing', 'bin', 'ala.mjs');
    await robots.status({ robotIds: ['aaa'] });
    assert.equal(logged.length, 2);
});

test('only a robot with OpenCode is seeded, and deleting a robot waits for the setup in flight', async t => {
    const { paths } = await fixture(t);
    await fs.mkdir(path.join(paths.workspaceRoot, '.data'), { recursive: true });
    const cacheRoot = path.join(paths.dataDir, 'tool-cache');
    const calls = [];
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const tools = names => ({ binPath: path.join(cacheRoot, 'bin'), agents: Object.fromEntries(names.map(name =>
        [name, { binPath: path.join(cacheRoot, name), versions: { [name]: '1.2.3' } }])) });
    const robots = new RobotManager({ paths, toolCache: { root: cacheRoot,
        prepareShellTools: async names => { calls.push(['tools', names]); await gate; return tools(names); },
        prepareOpenCodePlugin: async version => { calls.push(['plugin', version]); return { path: path.join(cacheRoot, 'plugin'), version }; } },
    homeOperation: async (id, operation, input) => { calls.push([operation, id, input.openCodePlugin ? 'template' : 'none']); return {}; },
    soulGateway: { prepare: async () => {}, remove: async () => {} } });
    robots.runs = { list: () => [] };
    await robots.initialize();
    release();
    await robots.ensure({ robotId: 'aaa', name: 'plain', codingAgents: ['codex', 'pi'] });
    assert.deepEqual(calls, [['tools', ['codex', 'pi']], ['ensure', 'aaa', 'none']], 'no plugin template without OpenCode');
    calls.length = 0;
    await robots.ensure({ robotId: 'aaa', name: 'plain', codingAgents: ['codex', 'opencode'] });
    assert.deepEqual(calls, [['tools', ['codex', 'opencode']], ['plugin', '1.2.3'], ['ensure', 'aaa', 'template']]);
    // A slow setup holds the robot's queue, so the removal starts only after it ends.
    calls.length = 0;
    let open;
    robots.toolCache.prepareShellTools = async names => { calls.push(['tools', names]); await new Promise(resolve => { open = resolve; }); return tools(names); };
    const setup = robots.ensure({ robotId: 'aaa', name: 'plain', codingAgents: ['opencode'] });
    await fs.mkdir(paths.home('aaa'), { recursive: true });
    const removal = robots.delete({ robotId: 'aaa' });
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.deepEqual(calls, [['tools', ['opencode']]], 'the removal has not touched the home');
    open();
    await setup; await removal;
    assert.deepEqual(calls.map(call => call[0]), ['tools', 'plugin', 'ensure', 'delete']);
    await assert.rejects(fs.lstat(paths.robot('aaa')), { code: 'ENOENT' });
});

test('delete cleans a robot with a bad label, keeps the active check and reports an unknown robot only when its directory is absent', async t => {
    const { paths } = await fixture(t);
    const put = async (file, text = 'x') => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text); };
    const stubs = path.join(paths.workspaceRoot, '.data', 'roboWorkAgent', 'terminal');
    const state = path.join(paths.dataDir, 'server-state');
    await put(path.join(paths.robot('aaa'), 'label'), '{ not json');
    await put(path.join(paths.home('aaa'), 'credentials'));
    await put(path.join(stubs, 'aaa', 'placeholder'));
    await put(path.join(stubs, 'bbb', 'placeholder'));
    for (const name of ['aaa.default.json', 'aaa.env.json', 'bbb.default.json']) await put(path.join(state, 'terminal', name));
    await put(path.join(state, 'model-catalog', 'aaa', 'opencode.json'));
    await put(path.join(state, 'model-catalog', 'bbb', 'opencode.json'));
    const homeCalls = [];
    const robots = new RobotManager({ paths, toolCache: {}, soulGateway: { remove: async () => {} },
        homeOperation: async (id, operation, input) => { homeCalls.push(operation); return homeOperation(operation, input, paths.home(id)); } });
    robots.runs = { list: () => [{ state: 'running' }] };
    await assert.rejects(robots.delete({ robotId: 'aaa' }), { code: 'ROBOT_ACTIVE' });
    assert.deepEqual(homeCalls, []);
    robots.runs = { list: () => [] };
    assert.deepEqual(await robots.delete({ robotId: 'aaa' }), { deleted: true });
    await assert.rejects(fs.lstat(paths.robot('aaa')), { code: 'ENOENT' });
    for (const gone of [path.join(stubs, 'aaa'), path.join(state, 'terminal', 'aaa.default.json'), path.join(state, 'terminal', 'aaa.env.json'),
        path.join(state, 'model-catalog', 'aaa')]) await assert.rejects(fs.lstat(gone), { code: 'ENOENT' });
    for (const kept of [path.join(stubs, 'bbb'), path.join(state, 'terminal', 'bbb.default.json'), path.join(state, 'model-catalog', 'bbb')]) await fs.lstat(kept);
    await assert.rejects(robots.delete({ robotId: 'aaa' }), { code: 'UNKNOWN_ROBOT' });
    // A robot directory that never got a home is still removed.
    await put(path.join(paths.robot('ccc'), 'label'), 'null');
    homeCalls.length = 0;
    assert.deepEqual(await robots.delete({ robotId: 'ccc' }), { deleted: true });
    assert.deepEqual(homeCalls, []);
});

test('a run may start in the folder RoboTeam prepares inside private project data, which a terminal or session may not open', async t => {
    const { paths } = await fixture(t);
    const generation = path.join(paths.workspaceRoot, '.roboteam', 'roboflow-generation');
    await fs.mkdir(generation, { recursive: true });
    assert.equal(await paths.grant(generation, 'cwd'), await fs.realpath(generation));
    await assert.rejects(paths.interactiveCwd(generation), { code: 'CWD_REFUSED', message: /private project data/u });
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

test('Environment ALA arguments use mounted sources for skills, callbacks and Soul, and Podman carries the workspace view and its masks', async t => {
    const { manager, paths, input } = await fixture(t);
    const skills = path.join(paths.workspaceRoot, '.ploinky', 'repos', 'skills', 'one');
    const plain = path.join(paths.workspaceRoot, 'public-files');
    await fs.mkdir(path.join(paths.workspaceRoot, 'sibling'));
    for (const directory of [skills, plain, manager.toolCache.root, paths.home(input.robotId), paths.soul(input.robotId)]) await fs.mkdir(directory, { recursive: true });
    await plantWorkspaceState(paths.workspaceRoot);
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
    const folders = folderArguments(args);
    assert.deepEqual(folders, [
        [paths.workspaceRoot],
        ['/workspace/roboteam-skill-0', 'as', 'roboteam-skill-0', 'expose'],
        [exported, 'at', exported, 'expose'], [repeated, 'at', repeated, 'expose'], [plain, 'at', plain, 'expose'],
        ['/workspace/ploinky-runtime', 'as', 'ploinky-runtime'], ['/workspace/roboflow-human-input', 'as', 'roboflow-human-input'],
        ['/workspace/own-task-failure', 'as', 'own-task-failure'], ['/workspace/roboteam-soul', 'as', 'roboteam-soul'],
    ]);
    for (const [source] of folders) assert.ok(mounts.some(([, target]) => target === source), `ALA source is not mounted: ${source}`);
    assert.ok(!mounts.some(([, target]) => target.startsWith(paths.robot(input.robotId)) || target.startsWith(paths.run(input.runId))));
    assert.equal(args[args.indexOf('--home') + 1], '/home/aaa');
    assert.ok(command.args.includes(`ALA_SESSIONS=${path.join(input.cwd, '.roboteam', '.ala')}`));
    // Inside the container ALA receives the root and the cwd's `.roboteam` only: it cannot name the /dev/null that Podman put over `.env`.
    assert.deepEqual(ignoredArguments(args), [path.join(input.cwd, '.roboteam')]);
    assert.ok(!args.includes(path.join(paths.workspaceRoot, '.env')));
    // Podman shows the workspace read-only and recursive, masks each private entry, and mounts the working folder after the root.
    assert.ok(mounts.some(([source, target, mode]) => source === paths.workspaceRoot && target === paths.workspaceRoot && mode === 'ro,rbind'));
    const tmpfs = command.args.flatMap((value, index) => command.args[index - 1] === '--tmpfs' ? [value] : []);
    assert.deepEqual(tmpfs, ['.data', '.ploinky', '.ploinky-box'].map(name => `${path.join(paths.workspaceRoot, name)}:ro,size=64k,mode=0555,nosuid,nodev,noexec,notmpcopyup`));
    assert.ok(mounts.some(([source, target, mode]) => source === '/dev/null' && target === path.join(paths.workspaceRoot, '.env') && mode === 'ro'));
    assert.ok(!mounts.some(([source]) => source === path.join(paths.workspaceRoot, 'sibling')));
    const root = command.args.findIndex((value, index) => command.args[index - 1] === '--volume' && value.startsWith(`${paths.workspaceRoot}:${paths.workspaceRoot}:`));
    const working = command.args.findIndex((value, index) => command.args[index - 1] === '--volume' && value.endsWith(`:${input.cwd}:rw`));
    assert.ok(root > 0 && working > root, 'The working folder is mounted after the workspace root');
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

const identityOf = async directory => {
    const stat = await fs.lstat(directory, { bigint: true });
    return `${stat.dev}:${stat.ino}`;
};

test('Podman receives each granted folder through a descriptor, checked against its grant, until release', async t => {
    const { paths, input, root } = await fixture(t);
    await fs.mkdir(paths.home(input.robotId), { recursive: true });
    const folder = path.join(paths.workspaceRoot, 'granted');
    await fs.mkdir(folder);
    const environment = new EnvironmentManager();
    environment.prepare = async () => ({ image: 'fixture-image', imagePath: '/usr/bin:/bin' });
    const workspace = await paths.workspaceView(input.robotId);
    const launchFor = identities => environment.buildLaunch({ environment: 'repo/agent', runId: 'r', robotId: input.robotId, home: paths.home(input.robotId),
        cwd: input.cwd, cwdIdentity: identities.cwd, workspace, toolCache: root, ala: { source: root, target: '/opt/ala', entry: '/opt/ala/bin/ala.mjs' },
        bwrap: { source: '/fixture/bwrap', target: '/opt/bwrap' }, folders: [{ source: folder, target: '/workspace/granted', readOnly: true, identity: identities.folder }], args: [] });
    const identities = { cwd: await identityOf(input.cwd), folder: await identityOf(folder) };
    const launch = await launchFor(identities);
    const volumes = launch.args.flatMap((value, index) => value === '--volume' ? [launch.args[index + 1]] : []);
    const source = target => new RegExp(`^/proc/${process.pid}/fd/(\\d+):${target}:`, 'u');
    const descriptors = [volumes.find(value => source(input.cwd).test(value)), volumes.find(value => source('/workspace/granted').test(value))].map(value => Number(/fd\/(\d+):/u.exec(value)[1]));
    const open = descriptor => { const stat = fstatSync(descriptor, { bigint: true }); return `${stat.dev}:${stat.ino}`; };
    assert.deepEqual(descriptors.map(open), [identities.cwd, identities.folder]);
    assert.ok(!volumes.some(value => value.startsWith(`${input.cwd}:`) || value.startsWith(`${folder}:`)));
    await launch.release();
    for (const descriptor of descriptors) assert.throws(() => open(descriptor), { code: 'EBADF' });
    // A swap between the grant and the launch is refused here, and neither descriptor stays open.
    await fs.rename(folder, `${folder}-moved`); await fs.symlink(input.cwd, folder);
    await assert.rejects(launchFor(identities), { code: 'FOLDER_REFUSED', message: /changed before it was mounted/u });
    // The view is required; a launch without it fails closed rather than showing a different workspace.
    await assert.rejects(environment.buildLaunch({ environment: 'repo/agent', runId: 'r', robotId: input.robotId, home: paths.home(input.robotId),
        cwd: input.cwd, toolCache: root, ala: { source: root, target: '/opt/ala', entry: '/opt/ala/bin/ala.mjs' },
        bwrap: { source: '/fixture/bwrap', target: '/opt/bwrap' } }), { code: 'ENVIRONMENT_INVALID', statusCode: 400 });
});

test('every granted directory reaches ALA and the Environment launch with the identity recorded at grant time', async t => {
    const { manager, paths, input } = await fixture(t);
    const folder = path.join(paths.workspaceRoot, 'granted');
    await fs.mkdir(folder);
    const recorded = { cwd: await identityOf(input.cwd), folder: await identityOf(folder) };
    let launchOptions;
    manager.buildLaunch = async options => { launchOptions = options; return { command: process.execPath, args: ['-e', "process.stdin.on('data',()=>{});"], options: { detached: true, stdio: ['pipe', 'pipe', 'pipe'] } }; };
    await startReady(manager, { ...input, folders: [{ source: folder, alias: 'granted' }] });
    const expected = launchOptions.args.flatMap((value, index) => value === '--expect-dir' ? [launchOptions.args[index + 1]] : []);
    assert.deepEqual(expected, [`${recorded.cwd}:${input.cwd}`, `${recorded.folder}:${folder}`]);
    let environmentOptions, released = 0;
    manager.environment = { buildLaunch: async options => { environmentOptions = options; return { command: process.execPath, args: ['-e', "process.stdin.on('data',()=>{});"], options: { detached: true, stdio: ['pipe', 'pipe', 'pipe'] }, release: async () => { released++; } }; } };
    manager.runtimeBundle = { prepare: async () => ({ ala: { path: '/fixture/ala' }, bwrap: { bin: '/fixture/bwrap' } }) };
    await startReady(manager, { ...input, runId: 'run-2', environment: 'repo/agent', folders: [{ source: folder, alias: 'granted' }] });
    assert.equal(environmentOptions.cwdIdentity, recorded.cwd);
    assert.deepEqual(environmentOptions.folders.map(({ target, identity }) => ({ target, identity })), [{ target: '/workspace/granted', identity: recorded.folder }]);
    assert.ok(environmentOptions.args.includes(`${recorded.folder}:/workspace/granted`));
    assert.equal(released, 0, 'The descriptors stay open while the container starts.');
    await Promise.all(['run-1', 'run-2'].map(runId => manager.stop({ runId, signal: 'SIGKILL' })));
    for (let attempt = 0; attempt < 300 && !released; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(released > 0);
});

test('a grant refuses a path that is no longer canonical, and a run refuses a planted private directory', async t => {
    const { manager, paths, input } = await fixture(t);
    const sibling = path.join(paths.workspaceRoot, 'sibling'), link = path.join(input.cwd, 'link');
    await fs.mkdir(sibling); await fs.symlink(sibling, link);
    // RoboTeam canonicalised this path; a swap since then must not grant what the link reaches.
    await assert.rejects(paths.grant(link), { code: 'FOLDER_REFUSED', message: /canonical/u });
    await assert.rejects(paths.grant(link, 'cwd'), { code: 'CWD_REFUSED', message: /canonical/u });
    await assert.rejects(paths.grant(`${sibling}/`), { code: 'FOLDER_REFUSED' });
    assert.equal(await paths.grant(sibling), sibling);
    for (const plant of [target => fs.symlink(sibling, target), target => fs.writeFile(target, 'x')]) {
        const target = path.join(input.cwd, '.roboteam');
        await plant(target);
        await assert.rejects(manager.start(input), { code: 'FOLDER_REFUSED', message: /\.roboteam is not a real directory/u });
        await fs.rm(target);
    }
    assert.equal(manager.list().length, 0);
});

test('a grant records the identity of the checked path, never of a link or of what a link above it reaches', async t => {
    const { paths, root } = await fixture(t);
    const parent = path.join(paths.workspaceRoot, 'parent');
    await fs.mkdir(path.join(parent, 'folder'), { recursive: true });
    const victim = path.join(root, 'victim', 'folder');
    await fs.mkdir(victim, { recursive: true });
    assert.equal(await paths.identity(path.join(parent, 'folder')), await identityOf(path.join(parent, 'folder')));
    const link = path.join(paths.workspaceRoot, 'link');
    await fs.symlink(victim, link);
    await assert.rejects(paths.identity(link), { code: 'FOLDER_REFUSED' });
    await assert.rejects(paths.identity(link, 'cwd'), { code: 'CWD_REFUSED' });
    await fs.rename(parent, `${parent}-moved`); await fs.symlink(path.dirname(victim), parent);
    await assert.rejects(paths.identity(path.join(parent, 'folder')), { code: 'FOLDER_REFUSED' });
});

async function stubAla(root) {
    const entry = path.join(root, 'ala', 'bin', 'ala.mjs');
    await fs.mkdir(path.join(root, 'ala', 'src', 'coding-agents'), { recursive: true }); await fs.mkdir(path.dirname(entry));
    await fs.writeFile(entry, ''); await fs.writeFile(path.join(root, 'ala', 'package.json'), '{"name":"advanced-language-agent"}');
    for (const name of ['config.mjs', 'coding-agents/logins.mjs']) await fs.writeFile(path.join(root, 'ala', 'src', name), '');
    await fs.writeFile(path.join(root, 'ala', 'src', 'coding-agents', 'discovery.mjs'), 'export const discoverCodingAgents = async () => [];');
    await fs.writeFile(path.join(root, 'ala', 'src', 'coding-agents', 'service.mjs'), `export const createCodingAgentService = options => ({
    listModels: async () => [{ ignoredPaths: options.ignoredPaths, folders: options.folders, workspaceIdentity: options.workspaceIdentity, masked: await import('node:fs').then(fs => (options.ignoredPaths || []).map(file => fs.statSync(file).isDirectory())) }],
    close: async () => {} });`);
    return entry;
}

test('model discovery masks private project data in a working folder and pins it to its granted identity', async t => {
    const { paths, input, root } = await fixture(t);
    const alaEntry = await stubAla(root);
    const script = fileURLToPath(new URL('../server/model-op.mjs', import.meta.url));
    await fs.mkdir(paths.home(input.robotId), { recursive: true });
    await plantWorkspaceState(paths.workspaceRoot);
    const workspace = await paths.workspaceView(input.robotId);
    const run = extra => {
        const result = spawnSync(process.execPath, [script, JSON.stringify({ alaEntry, agent: 'codex', workspace, home: paths.home(input.robotId), soul: paths.soul(input.robotId), dataDir: paths.dataDir, robotId: input.robotId, ...extra })], { encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
        return JSON.parse(result.stdout)[0];
    };
    const identity = await identityOf(input.cwd);
    const masks = ['.data', '.env', '.ploinky', '.ploinky-box'].map(name => path.join(paths.workspaceRoot, name));
    const folders = [{ source: paths.workspaceRoot }, { source: paths.soul(input.robotId), alias: 'roboteam-soul' }];
    // The query shows the same workspace as a run: the root read-only, every private entry masked, and the folder's records masked.
    assert.deepEqual(run({ cwd: input.cwd, identity }), { ignoredPaths: [path.join(input.cwd, '.roboteam'), ...masks], folders, workspaceIdentity: identity, masked: [true, true, false, true, true] });
    // The robot home holds no private project data, and the workspace masks apply there as well.
    assert.deepEqual(run({ cwd: paths.home(input.robotId) }), { ignoredPaths: masks, folders, masked: [true, false, true, true] });
    // The query refuses to start without the view.
    const missing = spawnSync(process.execPath, [script, JSON.stringify({ alaEntry, agent: 'codex', cwd: input.cwd, identity, home: paths.home(input.robotId), soul: paths.soul(input.robotId), dataDir: paths.dataDir, robotId: input.robotId })], { encoding: 'utf8' });
    assert.notEqual(missing.status, 0); assert.match(missing.stderr, /WORKSPACE_UNAVAILABLE|workspace view is required/u);
    // The identity is checked when the service is created, before the model cache reads anything a robot wrote.
    const touched = path.join(root, 'probe-touched');
    await fs.writeFile(path.join(root, 'ala', 'src', 'coding-agents', 'discovery.mjs'), `import fs from 'node:fs';
export const discoverCodingAgents = async () => [{ name: 'opencode', available: true, get binary() { fs.writeFileSync(${JSON.stringify(touched)}, ''); return '/missing'; } }];`);
    await fs.writeFile(path.join(root, 'ala', 'src', 'coding-agents', 'service.mjs'), `export const createCodingAgentService = () => { throw new Error('refused'); };`);
    const refused = spawnSync(process.execPath, [script, JSON.stringify({ alaEntry, agent: 'opencode', workspace, cwd: input.cwd, identity, home: paths.home(input.robotId), soul: paths.soul(input.robotId), dataDir: paths.dataDir, robotId: input.robotId })], { encoding: 'utf8' });
    assert.notEqual(refused.status, 0); assert.match(refused.stderr, /refused/u);
    await assert.rejects(fs.lstat(touched), { code: 'ENOENT' });
    // The operation receives the identity recorded where the path was granted.
    let launched;
    await fs.mkdir(path.join(paths.robot(input.robotId)), { recursive: true });
    await fs.writeFile(path.join(paths.robot(input.robotId), 'label'), JSON.stringify({ id: input.robotId, name: 'Robot', codingAgents: ['codex'] }));
    const robots = new RobotManager({ paths, alaEntry, toolCache: { root: path.join(paths.dataDir, 'tool-cache'), prepareCodingAgents: async () => ({}) },
        soulGateway: { prepare: async () => {} }, homeOperation: async () => {},
        captureLaunch: async launch => { launched = await fs.readFile(launch.args.at(-1).match(/'(.+launch\.sh)'/u)[1], 'utf8'); return { stdout: '[]' }; } });
    robots.require = async () => ({ id: input.robotId, codingAgents: ['codex'] });
    await robots.models({ robotId: input.robotId, agent: 'codex', cwd: input.cwd });
    assert.ok(launched.includes(`"identity":"${identity}"`), launched);
    assert.ok(launched.includes(`"workspace":{"root":${JSON.stringify(paths.workspaceRoot)},"masks":[`), launched);
    // A draft selection: the robot has only OpenCode enabled, and Codex models are still listed (DS006).
    robots.require = async () => ({ id: input.robotId, codingAgents: ['opencode'] });
    launched = '';
    await robots.models({ robotId: input.robotId, agent: 'codex', cwd: input.cwd });
    assert.ok(launched.includes('"agent":"codex"'), launched);
    await assert.rejects(robots.models({ robotId: input.robotId, agent: 'unknown', cwd: input.cwd }), /Coding agent is unavailable/u);
});

test('a refused tool reports its status, so RoboTeam can pass the reason on', async t => {
    const { manager } = await fixture(t);
    const server = createRoboWorkServer({ robots: {}, runs: manager, environment: {}, internalToken: 'private' });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    const tool = fileURLToPath(new URL('../tools/robowork.mjs', import.meta.url));
    const child = spawn(process.execPath, [tool, 'run_read'], { stdio: ['pipe', 'ignore', 'pipe'],
        env: { PATH: process.env.PATH, ROBOWORK_INTERNAL_TOKEN: 'private', ROBOWORK_SERVICE_PORT: String(server.address().port) } });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.stdin.end(JSON.stringify({ ...grant(), input: { runId: 'unknown' } }));
    const status = await new Promise(resolve => child.once('close', resolve));
    assert.equal(status, 1);
    assert.deepEqual(JSON.parse(stderr), { code: 'UNKNOWN_RUN', error: 'Unknown runId', statusCode: 404 });
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
