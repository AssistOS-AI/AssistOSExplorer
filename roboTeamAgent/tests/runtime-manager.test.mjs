import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { buildRobotRunArgs, RuntimeManager, runtimeManagerInternals } from '../server/runtime-manager.mjs';

const preparedToolCache = {
    prepareMode: async (mode) => ({ path: `/cache/${mode}`, versions: {} }),
    prepareCodex: async () => ({ path: '/cache/codex', binPath: '/cache/codex/bin', versions: {} }),
};

test('builds browser and desktop containers around the persistent robot directories', () => {
    const plan = buildRobotRunArgs({
        robot: { id: 'research-a1b2c3', name: 'Research' },
        mode: 'browser',
        dataDir: '/data',
        publicBasePath: '/base-agent-additional-server/roboTeamAgent/3001/',
        images: { browser: 'browser:image', desktop: 'desktop:image' },
        timezone: 'Europe/Bucharest',
        cwd: '/workspace/project',
        toolsPath: '/cache/browser',
    });
    assert.equal(plan.image, 'browser:image');
    assert.ok(plan.args.includes('SUBFOLDER=/base-agent-additional-server/roboTeamAgent/3001/api/robots/research-a1b2c3/session/'));
    assert.ok(plan.args.includes('/data/robots/research-a1b2c3/home:/config'));
    assert.ok(plan.args.includes('127.0.0.1::3000'));
    assert.ok(plan.args.includes('127.0.0.1::8100'));
    assert.ok(plan.args.includes('/workspace/project:/workspace'));
    assert.ok(plan.args.includes('/cache/browser:/opt/roboteam-tools:ro'));
    assert.ok(plan.args.some((value) => value.includes('--remote-debugging-port=9222')));
    assert.equal(plan.args.includes('--privileged'), false);
    assert.deepEqual(plan.args.slice(2, 6), ['--ipc', 'none', '--tmpfs', '/dev/shm:rw,size=1g,mode=1777']);

    const desktop = buildRobotRunArgs({
        robot: { id: 'research-a1b2c3', name: 'Research' },
        mode: 'desktop',
        dataDir: '/data',
        publicBasePath: '/rt/',
        images: { browser: 'browser:image', desktop: 'desktop:image' },
        timezone: 'Europe/Bucharest',
        cwd: '/workspace/project',
        toolsPath: '/cache/desktop',
        codexPath: '/cache/codex',
    });
    assert.ok(desktop.args.includes('/cache/codex:/opt/roboteam-codex:ro'));
    assert.ok(desktop.args.includes('CODEX_HOME=/config/.codex'));
    assert.ok(desktop.args.includes('PATH=/opt/roboteam-codex/bin:/lsiopy/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'));
});

test('returns task ids immediately and runs simple ALA with the robot home and requested cwd', async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'roboteam-task-test-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const dataDir = path.join(root, 'data');
    const workspace = path.join(root, 'workspace');
    const robot = { id: 'worker-a1b2c3', name: 'Worker' };
    await Promise.all([
        fs.mkdir(path.join(dataDir, 'robots', robot.id, 'home'), { recursive: true }),
        fs.mkdir(path.join(dataDir, 'robots', robot.id, 'runtime'), { recursive: true }),
        fs.mkdir(workspace, { recursive: true }),
    ]);
    let invocation;
    const spawnImpl = (command, args, options) => {
        invocation = { command, args, options };
        const child = new EventEmitter();
        child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true;
        setImmediate(() => child.emit('close', 0, null));
        return child;
    };
    const manager = new RuntimeManager({ dataDir, workspaceRoot: workspace, spawnImpl, execFileImpl: async () => ({ stdout: '[]', stderr: '' }), toolCache: preparedToolCache });
    const accepted = manager.startTask(robot, 'simple', { cwd: workspace, task: 'Do work', ca: 'codex', model: 'gpt-test' });
    assert.match(accepted.taskId, /^[0-9a-f-]{36}$/);
    assert.equal(accepted.sessionUrl, undefined);
    assert.throws(() => manager.startTask(robot, 'simple', { cwd: workspace, task: 'Second' }), /active task/);
    while (!['completed', 'failed'].includes(manager.taskStatus(robot.id).state)) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(manager.taskStatus(robot.id).state, 'completed');
    assert.equal(invocation.command, '/workspace/AdvancedLanguageAgent/bin/ala.mjs');
    assert.deepEqual(invocation.args.slice(0, 4), ['--home', path.join(dataDir, 'robots', robot.id, 'home'), '--cwd', workspace]);
    assert.ok(invocation.args.includes('--taskFile'));
    assert.deepEqual(invocation.args.slice(-4), ['--ca', 'codex', '--model', 'gpt-test']);
    assert.ok(invocation.options.env.PATH.startsWith('/cache/codex/bin:'));
    assert.equal((await fs.stat(path.join(dataDir, 'robots', robot.id, 'home', '.codex'))).isDirectory(), true);
});

test('reports the bounded ALA diagnostic when the process exits unsuccessfully', () => {
    const message = runtimeManagerInternals.alaFailureMessage(1, '\u001b[31mala: Codex is unavailable\u001b[0m\n');
    assert.equal(message, 'ALA exited with 1: ala: Codex is unavailable');
    assert.ok(runtimeManagerInternals.alaFailureMessage(1, 'x'.repeat(5000)).length < 4200);
});

test('keeps task prompts private and rejects a mismatched stop operation', async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'roboteam-stop-test-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const dataDir = path.join(root, 'data');
    const workspace = path.join(root, 'workspace');
    const robot = { id: 'private-a1b2c3', name: 'Private' };
    await Promise.all([
        fs.mkdir(path.join(dataDir, 'robots', robot.id, 'home'), { recursive: true }),
        fs.mkdir(path.join(dataDir, 'robots', robot.id, 'runtime'), { recursive: true }),
        fs.mkdir(workspace, { recursive: true }),
    ]);
    const spawnImpl = () => {
        const child = new EventEmitter();
        child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true;
        return child;
    };
    const manager = new RuntimeManager({ dataDir, workspaceRoot: workspace, spawnImpl, toolCache: preparedToolCache });
    manager.startTask(robot, 'simple', { cwd: workspace, task: 'secret prompt' });
    while (manager.taskStatus(robot.id).state === 'queued') await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal('task' in manager.taskStatus(robot.id), false);
    assert.throws(() => manager.stopTask(robot, 'desktop'), /active simple task/);
    manager.stopTask(robot, 'simple');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(manager.taskStatus(robot.id).state, 'stopped');
});

test('allows exactly one active mode per robot and removes only its exact container', async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'roboteam-slot-test-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const dataDir = path.join(root, 'data');
    const robot = { id: 'research-a1b2c3', name: 'Research' };
    await fs.mkdir(path.join(dataDir, 'robots', robot.id, 'workspace'), { recursive: true });
    const listener = http.createServer((_request, response) => {
        response.writeHead(400, { 'content-length': '0' });
        response.end();
    });
    await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
    t.after(() => listener.close());
    const port = listener.address().port;
    const calls = [];
    const execFileImpl = async (_command, args) => {
        calls.push(args);
        if (args[0] === 'ps') return { stdout: '[]', stderr: '' };
        if (args[0] === 'port') return { stdout: `127.0.0.1:${port}\n`, stderr: '' };
        if (args[0] === 'inspect') return { stdout: 'true\n', stderr: '' };
        return { stdout: '', stderr: '' };
    };
    const manager = new RuntimeManager({ dataDir, publicBasePath: '/rt/', execFileImpl, toolCache: preparedToolCache });
    await manager.initialize();
    const running = await manager.start(robot, 'desktop');
    assert.equal(running.mode, 'desktop');
    await assert.rejects(() => manager.start(robot, 'browser'), /occupied by its desktop container/);
    await manager.stop(robot.id);
    assert.deepEqual(manager.status(robot.id), { state: 'stopped', task: null });
    assert.ok(calls.some((args) => args[0] === 'rm' && args[2] === 'roboteam-desktop-research-a1b2c3'));
});

test('recreates a reused desktop when an Achilles task requests a different cwd', async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'roboteam-remount-test-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const dataDir = path.join(root, 'data');
    const workspaceRoot = path.join(root, 'workspace');
    const firstCwd = path.join(workspaceRoot, 'configured-home');
    const secondCwd = path.join(workspaceRoot, 'achilles-project');
    const robot = { id: 'remount-a1b2c3', name: 'Remount' };
    await Promise.all([
        fs.mkdir(path.join(dataDir, 'robots', robot.id, 'home'), { recursive: true }),
        fs.mkdir(path.join(dataDir, 'robots', robot.id, 'runtime'), { recursive: true }),
        fs.mkdir(firstCwd, { recursive: true }),
        fs.mkdir(secondCwd, { recursive: true }),
    ]);
    const listener = http.createServer((_request, response) => {
        response.writeHead(400, { 'content-length': '0' });
        response.end();
    });
    await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
    t.after(() => listener.close());
    const port = listener.address().port;
    const podmanCalls = [];
    const execFileImpl = async (_command, args) => {
        podmanCalls.push(args);
        if (args[0] === 'port') return { stdout: `127.0.0.1:${port}\n`, stderr: '' };
        return { stdout: '', stderr: '' };
    };
    const spawnImpl = () => {
        const child = new EventEmitter();
        child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true;
        setImmediate(() => child.emit('close', 0, null));
        return child;
    };
    const manager = new RuntimeManager({
        dataDir,
        workspaceRoot,
        publicBasePath: '/rt/',
        execFileImpl,
        spawnImpl,
        toolCache: preparedToolCache,
    });

    await manager.openDesktop(robot, firstCwd);
    const accepted = manager.startTask(robot, 'desktop', {
        cwd: secondCwd,
        task: 'Show the files in the current directory.',
        ca: 'codex',
    });
    while (!['completed', 'failed'].includes(manager.taskStatus(robot.id, accepted.taskId).state)) {
        await new Promise((resolve) => setTimeout(resolve, 5));
    }

    assert.equal(manager.taskStatus(robot.id, accepted.taskId).state, 'completed');
    assert.equal(manager.status(robot.id).state, 'running');
    assert.equal(manager.sessions.get(robot.id).cwd, secondCwd);
    const runCalls = podmanCalls.filter((args) => args[0] === 'run');
    assert.equal(runCalls.length, 2);
    assert.ok(runCalls[0].includes(`${firstCwd}:/workspace`));
    assert.ok(runCalls[1].includes(`${secondCwd}:/workspace`));
    assert.ok(podmanCalls.some((args) => (
        args[0] === 'rm'
        && args[1] === '-f'
        && args[2] === 'roboteam-desktop-remount-a1b2c3'
    )));
});

test('returns the deterministic live URL with an asynchronous GUI task', async () => {
    const manager = new RuntimeManager({
        dataDir: '/data',
        publicBasePath: '/base-agent-additional-server/roboTeamAgent/3001/',
        workspaceRoot: '/workspace',
        execFileImpl: async () => ({ stdout: '', stderr: '' }),
        toolCache: preparedToolCache,
    });
    const accepted = manager.startTask(
        { id: 'analyst-a1b2c3', name: 'Analyst' },
        'desktop',
        { cwd: '/workspace/project', task: 'Inspect the visible application.', ca: 'codex' },
    );
    assert.match(accepted.taskId, /^[0-9a-f-]{36}$/);
    assert.equal(
        accepted.sessionUrl,
        '/base-agent-additional-server/roboTeamAgent/3001/api/robots/analyst-a1b2c3/session/',
    );
    assert.equal(manager.taskStatus('analyst-a1b2c3', accepted.taskId).sessionUrl, accepted.sessionUrl);
    while (!['failed', 'stopped'].includes(manager.taskStatus('analyst-a1b2c3', accepted.taskId).state)) {
        await new Promise((resolve) => setTimeout(resolve, 1));
    }
});
