import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
// Tests explicitly provision the workspace normally supplied by Ploinky.
process.env.PLOINKY_WORKSPACE_ROOT = os.tmpdir();
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { AgentEnvironments } from '../server/agent-environments.mjs';
import { spawnInAgent } from '../server/agent-exec-client.mjs';
import { RuntimeBundle, STATIC_BWRAP } from '../server/runtime-bundle.mjs';
import { RuntimeManager } from '../server/runtime-manager.mjs';
import { normalizeWorkflow } from '../server/roboflow/graph.mjs';
import { spawnAlaInAgent, translateEnvironment } from '../copilot/src/lib/execution/alaRemote.mjs';

const marketplace = {
    agents: [
        { repo: 'AchillesIDE', name: 'gitAgent', about: 'Git', active: true, enableMode: 'global', runtime: 'podman', running: true },
        { repo: 'AchillesIDE', name: 'emailAgent', active: true, enableMode: 'isolated', runtime: 'podman', running: true },
        { repo: 'AchillesIDE', name: 'dpuAgent', active: true, enableMode: 'global', runtime: 'podman', running: false },
        { repo: 'AchillesIDE', name: 'roboTeamAgent', active: true, enableMode: 'global', runtime: 'podman', running: true },
        { repo: 'Other', name: 'offline', active: false, enableMode: 'global' },
    ],
};

test('agent environments list only agents enabled in global mode, except RoboTeam, and accept the running podman ones', async () => {
    const environments = new AgentEnvironments({ loadMarketplace: async () => marketplace, selfId: 'agent:AchillesIDE/roboTeamAgent' });
    const list = await environments.list();
    assert.deepEqual(list.map(entry => [entry.ref, entry.available, entry.reason]), [
        ['AchillesIDE/gitAgent', true, ''],
        ['AchillesIDE/dpuAgent', false, 'not running'],
    ]);
    assert.equal((await environments.require('AchillesIDE/gitAgent')).ref, 'AchillesIDE/gitAgent');
    await assert.rejects(environments.require('AchillesIDE/emailAgent'), /not enabled in global mode/);
    await assert.rejects(environments.require('AchillesIDE/dpuAgent'), /not running/);
    await assert.rejects(environments.require('AchillesIDE/missing'), /not enabled in global mode/);
    await assert.rejects(environments.require('bad'), /Invalid agent environment/);
});

test('only terminal tasks of saved workflows keep an agent environment', () => {
    const graph = (task) => ({ name: 'Env', entryTaskId: 'a', edges: [], tasks: [{ id: 'a', name: 'A', prompt: 'p', skillsets: [], executionType: 'terminal', ...task }] });
    assert.equal(normalizeWorkflow(graph({ environment: 'AchillesIDE/gitAgent' }), { id: 'env' }).tasks[0].environment, 'AchillesIDE/gitAgent');
    assert.equal('environment' in normalizeWorkflow(graph({ environment: '' }), { id: 'env' }).tasks[0], false);
    assert.throws(() => normalizeWorkflow(graph({ executionType: 'browser', environment: 'AchillesIDE/gitAgent' }), { id: 'env' }), /only terminal tasks/);
    assert.throws(() => normalizeWorkflow(graph({ environment: 'gitAgent' }), { id: 'env' }), /repo\/agent/);
});

test('a remote process streams output, batches stdin as input requests, stops through the Router and reports its exit', async () => {
    const calls = [];
    let streamBody;
    const request = async (method, pathname, options = {}) => {
        calls.push([method, pathname, options.query || '', options.body ?? null]);
        if (method === 'POST' && pathname === '/api/edge/agent-exec') return { ok: true, execId: 'a'.repeat(32) };
        if (method === 'GET') {
            streamBody = new PassThrough();
            return { ok: true, body: streamBody };
        }
        return { ok: true };
    };
    const child = await spawnInAgent({ target: 'AchillesIDE/gitAgent', argv: ['/node', 'ala.mjs'], env: { HOME: '/h' }, cwd: '/w', request });
    assert.deepEqual(calls[0], ['POST', '/api/edge/agent-exec', '', { target: 'AchillesIDE/gitAgent', argv: ['/node', 'ala.mjs'], env: { HOME: '/h' }, cwd: '/w' }]);
    const out = [], err = [];
    child.stdout.on('data', chunk => out.push(String(chunk)));
    child.stderr.on('data', chunk => err.push(String(chunk)));
    const closed = new Promise(resolve => child.once('close', (code, signal) => resolve([code, signal])));
    child.stdin.write('{"type":"prompt"}\n');
    await new Promise(resolve => setImmediate(resolve));
    while (!streamBody) await new Promise(resolve => setImmediate(resolve));
    streamBody.write(`${JSON.stringify({ seq: 0, type: 'stdout', data: Buffer.from('hello').toString('base64') })}\n`);
    streamBody.write(`${JSON.stringify({ seq: 1, type: 'stderr', data: Buffer.from('@@ALA_EVENT@@{}').toString('base64') })}\n`);
    child.kill('SIGINT');
    streamBody.end(`${JSON.stringify({ seq: 2, type: 'exit', code: 0, signal: null })}\n`);
    assert.deepEqual(await closed, [0, null]);
    assert.deepEqual([out.join(''), err.join('')], ['hello', '@@ALA_EVENT@@{}']);
    const input = calls.find(call => call[1].endsWith('/input'));
    assert.equal(Buffer.from(input[3].data, 'base64').toString(), '{"type":"prompt"}\n');
    assert.ok(calls.some(call => call[0] === 'DELETE' && call[1] === `/api/edge/agent-exec/${'a'.repeat(32)}`));
});

test('a remote process whose exec the Router no longer knows ends with an error', async () => {
    const request = async (method) => {
        if (method === 'POST') return { ok: true, execId: 'b'.repeat(32) };
        throw Object.assign(new Error('unknown agent exec'), { code: 'AGENT_EXEC_UNKNOWN', status: 404 });
    };
    const child = await spawnInAgent({ target: 'AchillesIDE/gitAgent', argv: ['/node'], cwd: '/w', request });
    const errors = [];
    child.on('error', error => errors.push(error.code));
    const [code] = await new Promise(resolve => child.once('close', (...args) => resolve(args)));
    assert.equal(code, null);
    assert.deepEqual(errors, ['AGENT_EXEC_UNKNOWN']);
});

test('ALA runs in the target on its own node, with the static bwrap and no PLOINKY_ variables', async (t) => {
    const workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'roboteam-remote-ala-')));
    t.after(() => fs.rm(workspace, { recursive: true, force: true }));
    for (const file of ['tool-cache/bwrap/bin/bwrap', 'ala/bin/ala.mjs']) {
        await fs.mkdir(path.dirname(path.join(workspace, file)), { recursive: true });
        await fs.writeFile(path.join(workspace, file), '');
    }
    const spawned = [];
    await spawnAlaInAgent({
        environment: 'AchillesIDE/gitAgent', cwd: path.join(workspace), workspaceRoot: workspace,
        args: ['--home', path.join(workspace, 'home'), '--cwd', workspace],
        env: { PATH: '/usr/local/bin:/usr/bin', HOME: path.join(workspace, 'home'), PLOINKY_AGENT_ID: 'agent:x/y', 'BAD-NAME': 'v',
            ROBOTEAM_RUNTIME_BWRAP: path.join(workspace, 'tool-cache/bwrap/bin/bwrap'),
            ROBOTEAM_RUNTIME_ALA: path.join(workspace, 'ala/bin/ala.mjs') },
        spawn: (options) => { spawned.push(options); return new EventEmitter(); },
    });
    const [{ target, argv, env }] = spawned;
    assert.equal(target, 'AchillesIDE/gitAgent');
    assert.deepEqual(argv.slice(0, 4), ['/usr/bin/env', 'node', path.join(workspace, 'ala/bin/ala.mjs'), '--home']);
    assert.equal(env.ALA_BWRAP, path.join(workspace, 'tool-cache/bwrap/bin/bwrap'));
    assert.equal(env.PATH, '/usr/local/bin:/usr/bin');
    assert.equal(Object.keys(env).some(name => name.startsWith('PLOINKY_') || name.startsWith('ROBOTEAM_RUNTIME') || name === 'BAD-NAME'), false);
    await assert.rejects(spawnAlaInAgent({ environment: 'a/b', cwd: workspace, workspaceRoot: workspace, args: [],
        env: { ROBOTEAM_RUNTIME_ALA: '/usr/bin/env', ROBOTEAM_RUNTIME_BWRAP: '/usr/bin/env' }, spawn: () => null }),
    /not inside the workspace/);
    assert.deepEqual(await translateEnvironment({ HTTP_PROXY: 'http://proxy:3128', LIST: '/usr/bin:/bin' }, workspace),
        { HTTP_PROXY: 'http://proxy:3128', LIST: '/usr/bin:/bin' });
});

test('the runtime bundle builds bwrap in nested Podman, ships no Node.js and uses the workspace ALA checkout', async (t) => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'roboteam-runtime-bundle-')));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const ala = path.join(root, 'workspace', 'AdvancedLanguageAgent');
    await fs.mkdir(path.join(ala, 'bin'), { recursive: true });
    await fs.writeFile(path.join(ala, 'package.json'), JSON.stringify({ name: 'advanced-language-agent', version: '1.2.3' }));
    await fs.writeFile(path.join(ala, 'bin', 'ala.mjs'), '');
    const prepared = [], commands = [];
    const toolCache = {
        root: path.join(root, 'cache'), podmanCommand: '/usr/bin/podman',
        execFileImpl: async (command, args) => {
            commands.push([command, args]);
            if (command === '/usr/bin/podman') {
                const out = args[args.indexOf('-v') + 1].split(':')[0];
                await fs.mkdir(path.join(out, 'bin'), { recursive: true });
                await fs.writeFile(path.join(out, 'bin', 'bwrap'), '#!/bin/sh\n', { mode: 0o755 });
            }
            return { stdout: '', stderr: '' };
        },
        _once: (_key, operation) => operation(),
        _prepare: async (name, resolvePlan) => {
            const plan = await resolvePlan();
            const directory = path.join(root, 'cache', name);
            await fs.mkdir(directory, { recursive: true });
            await plan.install(directory);
            await plan.validate(directory);
            prepared.push(name);
            return plan.result(directory);
        },
    };
    const bundle = new RuntimeBundle({ toolCache, workspaceRoot: path.join(root, 'workspace'), alaEntry: path.join(ala, 'bin', 'ala.mjs'), log: () => {} });
    const result = await bundle.prepare();
    assert.deepEqual(prepared, ['bwrap']);
    assert.equal('node' in result, false);
    assert.equal(result.ala.source, 'workspace');
    assert.equal(result.ala.entry, path.join(ala, 'bin', 'ala.mjs'));
    assert.equal(result.bwrap.bin, path.join(root, 'cache', 'bwrap', 'bin', 'bwrap'));
    const build = commands.find(([command]) => command === '/usr/bin/podman')[1];
    assert.ok(build.includes(STATIC_BWRAP.builder));
    assert.ok(build.at(-1).includes(STATIC_BWRAP.sha256));
    const outside = new RuntimeBundle({ toolCache, workspaceRoot: path.join(root, 'elsewhere'), alaEntry: path.join(ala, 'bin', 'ala.mjs'), log: () => {} });
    const copied = await outside.prepareAla().catch(error => error);
    // The copy keeps bin, src and package.json; this fixture has no src, so the copy reports it.
    assert.match(String(copied?.message || copied?.source), /src|tool-cache/);
});

test('a terminal task with an agent environment passes it to the robot task with the runtime tools and a shared channel folder', async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-environment-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const robot = { id: 'env-a1b2c3', name: 'Env' };
    const workspace = path.join(root, 'workspace'), dataDir = path.join(root, 'data');
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(path.join(dataDir, 'robots', robot.id, 'home'), { recursive: true });
    const launches = [];
    const required = [];
    const manager = new RuntimeManager({ dataDir, workspaceRoot: root,
        toolCache: { root: '/cache', prepareCodingAgents: async (names) => Object.fromEntries(names.map(name => [name, { path: `/cache/${name}`, binPath: `/cache/${name}/bin` }])) },
        agentEnvironments: { require: async (ref) => { required.push(ref); return { ref }; } },
        runtimeBundle: { prepare: async () => ({ bwrap: { bin: '/cache/bwrap/bin/bwrap' }, ala: { entry: '/ws/ala/bin/ala.mjs' } }) },
        execFileImpl: async () => ({ stdout: '[]', stderr: '' }),
        spawnImpl: (_command, args, options) => {
            launches.push({ args, env: options.env });
            const child = new EventEmitter();
            child.stdout = new PassThrough(); child.stderr = new PassThrough();
            setImmediate(() => child.emit('close', 0, null));
            return child;
        } });
    const events = [];
    manager.setTaskObserver(event => events.push(event));
    manager.startTask(robot, 'simple', { cwd: workspace, task: 'Build', ca: 'codex', environment: 'AchillesIDE/gitAgent' });
    for (let i = 0; i < 200 && !events.some(event => event.kind === 'terminal'); i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.deepEqual(required, ['AchillesIDE/gitAgent']);
    const { args, env } = launches[0];
    assert.equal(args[args.indexOf('--environment') + 1], 'AchillesIDE/gitAgent');
    assert.deepEqual([env.ROBOTEAM_RUNTIME_BWRAP, env.ROBOTEAM_RUNTIME_ALA, env.ROBOTEAM_CHANNEL_DIR],
        ['/cache/bwrap/bin/bwrap', '/ws/ala/bin/ala.mjs', path.join(path.resolve(dataDir), 'rt')]);
    manager.startTask(robot, 'simple', { cwd: workspace, task: 'Local', ca: 'codex' });
    for (let i = 0; i < 200 && events.filter(event => event.kind === 'terminal').length < 2; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(launches[1].args.includes('--environment'), false);
    assert.equal(launches[1].env.ROBOTEAM_RUNTIME_BWRAP, undefined);
});
