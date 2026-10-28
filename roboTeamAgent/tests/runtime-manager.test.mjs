import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
// Tests explicitly provision the workspace normally supplied by Ploinky.
process.env.PLOINKY_WORKSPACE_ROOT = os.tmpdir();
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { buildRobotRunArgs, RuntimeManager, runtimeManagerInternals } from '../server/runtime-manager.mjs';
import { CHROMIUM_LAUNCHER } from '../server/desktop-launchers.mjs';
import { CONTAINER_FIREWALL_RULES } from '../server/proxy-pool/container-firewall.mjs';
import { DESKTOP_TASK_INSTRUCTIONS } from '../copilot/src/lib/prompts.mjs';
import { emailInstructions } from '../server/robot-email.mjs';

const preparedToolCache = {
    root: '/cache',
    prepareShellTools: async (names = ['codex', 'opencode', 'pi']) => ({ root: '/cache', path: '/cache/shell-generations/test',
        binPath: '/cache/shell-generations/test/bin', agents: Object.fromEntries(names.map(name => [name, { path: `/cache/${name}`, binPath: `/cache/${name}/bin` }])) }),
    prepareMode: async (mode) => ({ path: `/cache/${mode}`, versions: {} }),
    prepareCodex: async () => ({ path: '/cache/codex', binPath: '/cache/codex/bin', versions: {} }),
    prepareCodingAgents: async (names = ['codex', 'opencode', 'pi']) => Object.fromEntries(names.map((name) => [name, {
        path: `/cache/${name}`,
        binPath: `/cache/${name}/bin`,
        versions: {},
    }])),
};

test('runtime initialization awaits the storage initializer before engine checks and managed cleanup', async () => {
    const calls = [];
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    const manager = new RuntimeManager({
        toolCache: preparedToolCache,
        execFileImpl: async (command, args, options) => {
            calls.push({ command, args, options });
            if (command === '/usr/local/bin/roboteam-podman-init') await pending;
            return { stdout: args[0] === 'ps' ? '[{"Id":"owned-container"}]' : '', stderr: '' };
        },
    });
    const initialized = manager.initialize();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls.map(call => [call.command, call.args]), [['/usr/local/bin/roboteam-podman-init', []]]);
    assert.equal(calls[0].options.timeout, 30000);
    release();
    await initialized;
    assert.deepEqual(calls.map(call => [call.command, call.args]), [
        ['/usr/local/bin/roboteam-podman-init', []],
        ['/usr/bin/podman', ['info']],
        ['/usr/bin/podman', ['ps', '-a', '--filter', 'label=io.assistos.roboteam.robot=1', '--format', 'json']],
        ['/usr/bin/podman', ['rm', '-f', 'owned-container']],
    ]);
    calls.length = 0;
    await manager.initialize();
    assert.equal(calls[0].command, '/usr/local/bin/roboteam-podman-init');
});

for (const failure of [
    Object.assign(new Error('initializer missing'), { code: 'ENOENT' }),
    Object.assign(new Error('initializer failed'), { code: 1 }),
    Object.assign(new Error('initializer timed out'), { code: 'ETIMEDOUT', killed: true }),
]) {
    test(`runtime initialization rejects ${failure.message} before engine access`, async () => {
        const calls = [];
        const manager = new RuntimeManager({
            toolCache: preparedToolCache,
            execFileImpl: async (command, args) => {
                calls.push({ command, args });
                if (command === '/usr/local/bin/roboteam-podman-init') throw failure;
                return { stdout: '[]', stderr: '' };
            },
        });
        await assert.rejects(manager.initialize(), error => error === failure);
        assert.deepEqual(calls, [{ command: '/usr/local/bin/roboteam-podman-init', args: [] }]);
    });
}

test('builds browser and desktop containers around the persistent robot directories', () => {
    const plan = buildRobotRunArgs({
        robot: { id: 'research-a1b2c3', name: 'Research' },
        mode: 'browser',
        dataDir: '/data',
        publicBasePath: '/base-agent-additional-server/roboTeamAgent/3001/',
        images: { browser: 'browser:image', desktop: 'desktop:image' },
        timezone: 'Europe/Bucharest',
        cwd: '/workspace/project',
        workspaceRoot: '/workspace',
        toolsPath: '/cache/browser',
    });
    assert.equal(plan.image, 'browser:image');
    assert.ok(plan.args.includes('SUBFOLDER=/base-agent-additional-server/roboTeamAgent/3001/api/robots/research-a1b2c3/session/'));
    assert.ok(plan.args.includes('/data/robots/research-a1b2c3/home:/config'));
    assert.ok(plan.args.includes('127.0.0.1::3000'));
    assert.ok(plan.args.includes('127.0.0.1::8100'));
    assert.ok(plan.args.includes('/workspace:/workspace:ro'));
    assert.ok(plan.args.includes('/workspace/project:/workspace/project:rw'));
    assert.equal(plan.args[plan.args.indexOf('-w') + 1], '/workspace/project');
    assert.ok(plan.args.includes('/cache/browser:/opt/roboteam-tools:ro'));
    assert.ok(plan.args.some((value) => value.includes('--remote-debugging-port=9222')));
    assert.equal(plan.args.includes('--privileged'), false);
    assert.deepEqual(plan.args.slice(2, 8), ['--log-driver', 'k8s-file', '--ipc', 'none', '--tmpfs', '/dev/shm:rw,size=1g,mode=1777']);

    const desktop = buildRobotRunArgs({
        robot: { id: 'research-a1b2c3', name: 'Research' },
        mode: 'desktop',
        dataDir: '/data',
        publicBasePath: '/rt/',
        images: { browser: 'browser:image', desktop: 'desktop:image' },
        timezone: 'Europe/Bucharest',
        cwd: '/workspace/project',
        workspaceRoot: '/workspace',
        toolsPath: '/cache/desktop',
        shellTools: { root: '/cache', path: '/cache/shell-generations/test', binPath: '/cache/shell-generations/test/bin',
            agents: { codex: { path: '/cache/codex' } } },
    });
    assert.ok(desktop.args.includes('/cache/codex:/cache/codex:ro'));
    assert.ok(desktop.args.includes('/cache/shell-generations/test:/cache/shell-generations/test:ro'));
    assert.equal(desktop.args.includes('/cache:/data/tool-cache:ro'), false);
    assert.ok(desktop.args.includes('CODEX_HOME=/config/.codex'));
    assert.ok(desktop.args.includes('PATH=/cache/shell-generations/test/bin:/lsiopy/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'));
    assert.deepEqual(desktop.args.slice(2, 4), ['--log-driver', 'k8s-file']);
});

test('mounts the opened workspace root once and writable when cwd is the root', () => {
    const plan = buildRobotRunArgs({
        robot: { id: 'research-a1b2c3', name: 'Research' },
        mode: 'browser',
        dataDir: '/data',
        publicBasePath: '/base/',
        images: { browser: 'browser:image', desktop: 'desktop:image' },
        timezone: 'Europe/Bucharest',
        cwd: '/workspace',
        workspaceRoot: '/workspace',
        toolsPath: '/cache/browser',
    });
    assert.ok(plan.args.includes('/workspace:/workspace:rw'));
    assert.equal(plan.args.includes('/workspace:/workspace:ro'), false);
    assert.equal(plan.args.filter((value) => value === '/workspace:/workspace:rw').length, 1);
    assert.equal(plan.args[plan.args.indexOf('-w') + 1], '/workspace');
});

test('reads only the active GUI container log', async () => {
    const calls = [];
    const manager = new RuntimeManager({
        execFileImpl: async (_command, args) => {
            calls.push(args);
            return { stdout: 'desktop stdout\n', stderr: 'desktop stderr\n' };
        },
        toolCache: preparedToolCache,
    });
    manager.sessions.set('worker-a1b2c3', {
        robotId: 'worker-a1b2c3',
        mode: 'desktop',
        state: 'running',
        containerName: 'roboteam-desktop-worker-a1b2c3',
    });
    manager.tasks.set('old-task', { taskId: 'old-task', robotId: 'idle-a1b2c3', logTail: 'ALA output' });
    manager.latestTask.set('idle-a1b2c3', 'old-task');

    assert.equal(await manager.logs('worker-a1b2c3', 250), 'desktop stdout\ndesktop stderr\n');
    assert.deepEqual(calls, [['logs', '--tail', '250', 'roboteam-desktop-worker-a1b2c3']]);
    assert.equal(await manager.logs('idle-a1b2c3'), '');
});

test('a robot named by an email address is told its identity in browser and desktop tasks only', async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'roboteam-email-task-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const dataDir = path.join(root, 'data');
    const workspace = path.join(root, 'workspace');
    const robot = { id: 'mailer-a1b2c3', name: 'mailer@example.com' };
    await Promise.all([
        fs.mkdir(path.join(dataDir, 'robots', robot.id, 'home'), { recursive: true }),
        fs.mkdir(workspace, { recursive: true }),
    ]);
    const listener = http.createServer((_request, response) => response.end());
    await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
    t.after(() => listener.close());
    const port = listener.address().port;
    const written = [];
    const spawnImpl = () => {
        const child = new EventEmitter();
        child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true;
        child.stdin = new PassThrough(); let text = '';
        child.stdin.on('data', (chunk) => { text += chunk; });
        setImmediate(() => { written.push(JSON.parse(text.split('\n')[0])); child.emit('close', 0, null); });
        return child;
    };
    const manager = new RuntimeManager({ dataDir, workspaceRoot: root, spawnImpl, toolCache: preparedToolCache,
        execFileImpl: async (_command, args) => ({ stdout: args[0] === 'port' ? `127.0.0.1:${port}\n` : '[]', stderr: '' }) });
    t.after(() => manager.stopAll());
    const run = async (type) => {
        const before = written.length;
        const accepted = manager.startTask(robot, type, { cwd: workspace, task: 'Write to the client', ca: 'codex', systemPrompt: 'Route it' });
        while (!['completed', 'failed'].includes(manager.taskStatus(robot.id, accepted.taskId).state)) await new Promise((resolve) => setTimeout(resolve, 5));
        assert.equal(written.length, before + 1, `the ${type} task wrote its prompt`);
        return written.at(-1);
    };

    assert.equal((await run('simple')).systemPrompt, 'Route it', 'a terminal task works outside Chromium and is not told the address');
    assert.equal((await run('browser')).systemPrompt, `${emailInstructions('mailer@example.com')}\n\nRoute it`);
    assert.match(emailInstructions('mailer@example.com'), /You are the robot mailer@example\.com/u);
});

test('runs independent CLI sessions for one robot concurrently', async (t) => {
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
    const invocations = [];
    const children = [];
    const spawnImpl = (command, args, options) => {
        invocations.push({ command, args, options });
        const child = new EventEmitter();
        child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true;
        child.stdin = new PassThrough(); child.written = '';
        child.stdin.on('data', (chunk) => { child.written += chunk; });
        children.push(child);
        return child;
    };
    const manager = new RuntimeManager({ dataDir, workspaceRoot: root, spawnImpl, execFileImpl: async () => ({ stdout: '[]', stderr: '' }), toolCache: preparedToolCache });
    const first = manager.startTask(robot, 'simple', { cwd: workspace, task: 'Do work', ca: 'codex', model: 'gpt-test', effort: 'low', systemPrompt: 'Route it' });
    const second = manager.startTask(robot, 'simple', { cwd: workspace, task: 'Second', ca: 'codex', mcpServers: 'roboTeamAgent=http://127.0.0.1:7000/mcp' });
    assert.match(first.taskId, /^[0-9a-f-]{36}$/);
    assert.equal(first.sessionUrl, undefined);
    assert.equal(first.queuePosition, 0);
    assert.equal(second.queuePosition, 0);
    while (children.length < 2) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(children.length, 2);
    assert.equal(manager.taskStatus(robot.id, second.taskId).state, 'running');
    assert.equal(manager.taskStatus(robot.id, second.taskId).queuePosition, 0);
    assert.throws(() => manager.stopTask(robot, 'simple'), /specify taskId/);
    const firstIndex = invocations.findIndex(({ args }) => args[args.indexOf('--session-id') + 1] === first.taskId);
    const firstInvocation = invocations[firstIndex];
    const secondInvocation = invocations.find(({ args }) => args[args.indexOf('--session-id') + 1] === second.taskId);
    assert.equal(secondInvocation.args[secondInvocation.args.indexOf('--MCPServers') + 1], 'roboTeamAgent=http://127.0.0.1:7000/mcp');
    children[firstIndex].stderr.write('working\n');
    children[firstIndex].stdout.write('first result\n');
    children[firstIndex].emit('close', 0, null);
    while (manager.taskStatus(robot.id, first.taskId).state !== 'completed') await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(manager.taskStatus(robot.id, first.taskId).state, 'completed');
    assert.equal(manager.taskStatus(robot.id, first.taskId).logTail, 'working\n');
    assert.equal(manager.taskStatus(robot.id, first.taskId).result, 'first result\n');
    assert.equal(manager.taskStatus(robot.id, second.taskId).state, 'running');
    children[1 - firstIndex].emit('close', 0, null);
    while (manager.taskStatus(robot.id, second.taskId).state !== 'completed') await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(firstInvocation.command, process.execPath);
    assert.match(firstInvocation.args[0], /robot-task.mjs$/);
    assert.equal(firstInvocation.args[3], '--home');
    assert.equal(firstInvocation.args[4], await fs.realpath(path.join(dataDir, 'robots', robot.id, 'home')));
    assert.deepEqual(firstInvocation.args.slice(5, 7), ['--cwd', workspace]);
    // The task prompt is the runner's first stdin record, not a file.
    assert.equal(firstInvocation.args.includes('--taskFile'), false);
    assert.deepEqual(JSON.parse(children[firstIndex].written.split('\n')[0]), { type: 'prompt', prompt: 'Do work', systemPrompt: 'Route it' });
    assert.equal(firstInvocation.args[firstInvocation.args.indexOf('--ca') + 1], 'codex');
    assert.equal(firstInvocation.args[firstInvocation.args.indexOf('--session-id') + 1], first.taskId);
    assert.deepEqual(firstInvocation.args.slice(-4), ['--model', 'gpt-test', '--effort', 'low']);
    assert.equal(secondInvocation.args.includes('--effort'), false);
    assert.ok(firstInvocation.options.env.PATH.startsWith('/cache/codex/bin:'));
    assert.equal(firstInvocation.options.env.ALA_EVENT_STREAM, '1');
    assert.equal((await fs.stat(path.join(dataDir, 'robots', robot.id, 'home', '.codex'))).isDirectory(), true);
    assert.equal((await fs.stat(path.join(dataDir, 'robots', robot.id, 'home', '.config', 'opencode'))).isDirectory(), true);
    assert.equal((await fs.stat(path.join(dataDir, 'robots', robot.id, 'home', '.pi', 'agent'))).isDirectory(), true);
});

test('places the selected OpenCode and Pi caches on the ALA path', async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'roboteam-agent-path-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const dataDir = path.join(root, 'data');
    const workspace = path.join(root, 'workspace');
    const robot = { id: 'agent-path-a1b2c3', name: 'Agent Path' };
    await Promise.all([
        fs.mkdir(path.join(dataDir, 'robots', robot.id, 'home'), { recursive: true }),
        fs.mkdir(path.join(dataDir, 'robots', robot.id, 'runtime'), { recursive: true }),
        fs.mkdir(workspace, { recursive: true }),
    ]);
    const invocations = [];
    const manager = new RuntimeManager({
        dataDir,
        workspaceRoot: root,
        toolCache: preparedToolCache,
        spawnImpl: (_command, args, options) => {
            invocations.push({ args, options });
            const child = new EventEmitter();
            child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true;
            setImmediate(() => child.emit('close', 0, null));
            return child;
        },
    });
    const opencode = manager.startTask(robot, 'simple', { cwd: workspace, task: 'OpenCode task', ca: 'opencode' });
    while (manager.taskStatus(robot.id, opencode.taskId).state !== 'completed') await new Promise((resolve) => setTimeout(resolve, 5));
    const pi = manager.startTask(robot, 'simple', { cwd: workspace, task: 'Pi task', ca: 'pi' });
    while (manager.taskStatus(robot.id, pi.taskId).state !== 'completed') await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(invocations[0].options.env.PATH.startsWith('/cache/opencode/bin:'));
    assert.ok(invocations[1].options.env.PATH.startsWith('/cache/pi/bin:'));
});

test('preserves explicit GUI agents and leaves automatic selection to the robot home', async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'roboteam-gui-agent-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const dataDir = path.join(root, 'data');
    const workspace = path.join(root, 'workspace');
    await fs.mkdir(workspace, { recursive: true });
    const listener = http.createServer((_request, response) => response.end());
    await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
    t.after(() => listener.close());
    const port = listener.address().port;
    const invocations = [];
    const manager = new RuntimeManager({
        dataDir,
        workspaceRoot: root,
        publicBasePath: '/rt/',
        execFileImpl: async (_command, args) => {
            if (args[0] === 'port') return { stdout: `127.0.0.1:${port}\n`, stderr: '' };
            return { stdout: '', stderr: '' };
        },
        spawnImpl: (_command, args, options) => {
            invocations.push({ args, env: options.env });
            const child = new EventEmitter();
            child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true;
            setImmediate(() => child.emit('close', 0, null));
            return child;
        },
        toolCache: preparedToolCache,
    });
    t.after(() => manager.stopAll());

    const openCodeRobot = { id: 'gui-opencode-a1b2c3', name: 'OpenCode GUI', codingAgents: ['opencode'] };
    const accepted = manager.startTask(openCodeRobot, 'desktop', { cwd: workspace, task: 'Show the desktop.', ca: 'opencode' });
    while (!['completed', 'failed'].includes(manager.taskStatus(openCodeRobot.id, accepted.taskId).state)) {
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(manager.taskStatus(openCodeRobot.id, accepted.taskId).state, 'completed',
        manager.taskStatus(openCodeRobot.id, accepted.taskId).error);
    assert.equal(invocations.length, 1);
    assert.equal(invocations[0].args[invocations[0].args.indexOf('--ca') + 1], 'opencode');
    assert.equal(invocations[0].args[invocations[0].args.indexOf('--MCPServers') + 1], `desktop=http://127.0.0.1:${port}/mcp`);
    assert.equal(invocations[0].env.OPENCODE_BIN, '/cache/opencode/bin/opencode');

    const piRobot = { id: 'gui-pi-a1b2c3', name: 'Pi GUI', codingAgents: ['pi'] };
    const inherited = manager._newTask(piRobot, 'browser', { cwd: workspace, task: 'Browse.', ca: 'auto' });
    await manager._runTask(piRobot, inherited);
    assert.equal(inherited.state, 'completed', inherited.error);
    assert.equal(invocations.length, 2);
    assert.equal(invocations[1].args.includes('--ca'), false);
    assert.equal(invocations[1].env.PI_BIN, '/cache/pi/bin/pi');
    assert.equal(invocations[1].args[invocations[1].args.indexOf('--MCPServers') + 1], `browser=http://127.0.0.1:${port}/mcp`);

    const autoRobot = { id: 'gui-auto-a1b2c3', name: 'Auto GUI', codingAgents: ['codex', 'opencode'] };
    const auto = manager._newTask(autoRobot, 'desktop', { cwd: workspace, task: 'Auto.', ca: 'auto' });
    await manager._runTask(autoRobot, auto);
    assert.equal(auto.state, 'completed', auto.error);
    assert.equal(invocations[2].args.includes('--ca'), false);
    assert.equal(invocations[2].args.includes('--model'), false);
    assert.equal(invocations[2].args.includes('--effort'), false);
});

test('extracts visible coding-agent messages from the ALA event stream', () => {
    let output = '';
    const parser = runtimeManagerInternals.createAlaProgressParser((text) => { output += text; });
    parser.push(Buffer.from('ala diagnostic\n@@ALA_EVENT@@{"type":"coding-agent-message","agent":"codex","message":"first '));
    parser.push(Buffer.from('message\\n"}\n@@ALA_EVENT@@{"type":"coding-agent-final","message":"duplicate"}\n'));
    parser.finish();
    assert.equal(output, 'ala diagnostic\nfirst message\n');
});

test('automatic MCP tasks expose only the robot selection and cannot prepare a disabled backend', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'roboteam-selected-task-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const cwd = path.join(root, 'project');
    await fs.mkdir(cwd);
    const robot = { id: 'selected-abc123', name: 'Selected', codingAgents: ['opencode'] };
    const invocations = [];
    const manager = new RuntimeManager({ dataDir: root, workspaceRoot: root,
        toolCache: preparedToolCache,
        spawnImpl: (_command, args, options) => {
            invocations.push({ args, env: options.env });
            const child = new EventEmitter();
            child.stdout = new PassThrough(); child.stderr = new PassThrough();
            setImmediate(() => child.emit('close', 0, null));
            return child;
        },
    });
    t.after(() => manager.stopAll());
    assert.equal(await manager.resolveCwd(root), await fs.realpath(root));
    const task = manager._newTask(robot, 'simple', { cwd, task: 'Read the project' });
    await manager._runTask(robot, task);
    assert.equal(task.state, 'completed', task.error);
    assert.equal(invocations.length, 1);
    const { args, env } = invocations[0];
    assert.equal(args.includes('--ca'), false);
    assert.equal(env.OPENCODE_BIN, '/cache/opencode/bin/opencode');
    assert.equal(env.CODEX_BIN, undefined);
    assert.equal(env.PI_BIN, undefined);
    const disabled = manager._newTask(robot, 'simple', { cwd, task: 'Read the project', ca: 'codex' });
    await manager._runTask(robot, disabled);
    assert.equal(disabled.state, 'failed');
    assert.match(disabled.error, /not enabled/);
    assert.equal(invocations.length, 1);
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
        child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => { queueMicrotask(() => child.emit('close', null, 'SIGTERM')); return true; };
        return child;
    };
    const manager = new RuntimeManager({ dataDir, workspaceRoot: root, spawnImpl, toolCache: preparedToolCache });
    let execution;
    const runTask = manager._runTask.bind(manager);
    t.mock.method(manager, '_runTask', (...args) => { execution = runTask(...args); return execution; });
    manager.startTask(robot, 'simple', { cwd: workspace, task: 'secret prompt' });
    while (manager.taskStatus(robot.id).state === 'queued') await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal('task' in manager.taskStatus(robot.id), false);
    assert.throws(() => manager.stopTask(robot, 'desktop', manager.taskStatus(robot.id).taskId), /active simple task/);
    manager.stopTask(robot, 'simple');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(manager.taskStatus(robot.id).state, 'paused');
    await execution; // Finish asynchronous preparation before removing its home.
    await manager.stopAll();
});

test('can stop one parallel CLI task without interrupting another', async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'roboteam-stop-queued-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const dataDir = path.join(root, 'data');
    const workspace = path.join(root, 'workspace');
    const robot = { id: 'stop-queue-a1b2c3', name: 'Stop Queue' };
    await Promise.all([
        fs.mkdir(path.join(dataDir, 'robots', robot.id, 'home'), { recursive: true }),
        fs.mkdir(path.join(dataDir, 'robots', robot.id, 'runtime'), { recursive: true }),
        fs.mkdir(workspace, { recursive: true }),
    ]);
    const children = [];
    const manager = new RuntimeManager({
        dataDir,
        workspaceRoot: root,
        toolCache: preparedToolCache,
        spawnImpl: () => {
            const child = new EventEmitter();
            child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true;
            children.push(child);
            return child;
        },
    });
    const first = manager.startTask(robot, 'simple', { cwd: workspace, task: 'First' });
    const second = manager.startTask(robot, 'simple', { cwd: workspace, task: 'Second' });
    while (children.length < 2) await new Promise((resolve) => setTimeout(resolve, 5));
    manager.stopTask(robot, 'simple', second.taskId);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(manager.taskStatus(robot.id, first.taskId).state, 'running');
    assert.equal(manager.taskStatus(robot.id, second.taskId).state, 'paused');
    for (const child of children) child.emit('close', 0, null);
    while (manager.taskStatus(robot.id, first.taskId).state !== 'completed') await new Promise((resolve) => setTimeout(resolve, 5));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(children.length, 2);
});

test('holds the robot queue during manual GUI control and resumes the interrupted task first', async () => {
    const robot = { id: 'manual-a1b2c3', name: 'Manual' };
    const killed = [];
    const manager = new RuntimeManager({ toolCache: preparedToolCache });
    const interrupted = {
        taskId: '11111111-1111-4111-8111-111111111111',
        alaSessionId: '22222222-2222-4222-8222-222222222222',
        robotId: robot.id,
        type: 'desktop',
        state: 'running',
        createdAt: new Date().toISOString(),
        request: { cwd: '/workspace/project', task: 'Inspect the application.', ca: 'codex' },
        logTail: '',
        logSeq: 0,
        logTruncated: false,
        result: '',
        error: null,
        child: { kill: (signal) => { killed.push(signal); return true; } },
        cancelRequested: false,
    };
    const waiting = {
        ...interrupted,
        taskId: 'waiting-task',
        alaSessionId: '33333333-3333-4333-8333-333333333333',
        state: 'queued',
        request: { cwd: '/workspace/project', task: 'Run after resume.', ca: 'codex' },
        child: null,
    };
    manager.tasks.set(interrupted.taskId, interrupted);
    manager.tasks.set(waiting.taskId, waiting);
    manager.latestTask.set(robot.id, interrupted.taskId);
    manager.activeTasks.set(robot.id, interrupted.taskId);
    manager.taskQueues.set(robot.id, [waiting.taskId]);

    manager.takeControl(robot, interrupted.taskId);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(manager.manualControl.get(robot.id), interrupted.taskId);
    assert.deepEqual(killed, ['SIGTERM']);
    assert.equal(manager.taskStatus(robot.id, interrupted.taskId).state, 'paused');
    await manager._drainTaskQueue(robot);
    assert.equal(manager.taskStatus(robot.id, waiting.taskId).state, 'queued');

    interrupted.child = null;
    const resumed = await manager.resumeTask(robot, interrupted.taskId);
    const resumedInternal = manager.tasks.get(resumed.taskId);
    assert.equal(manager.manualControl.has(robot.id), false);
    assert.deepEqual(manager.taskQueues.get(robot.id), [resumed.taskId, waiting.taskId]);
    assert.match(resumedInternal.request.task, /^Continue\./u);
    assert.equal(resumedInternal.request.alaSessionId, interrupted.alaSessionId);
    assert.equal(resumedInternal.request.resumeSession, true);
    assert.match(resumedInternal.request.task, /Inspect the current visible desktop or browser state/u);
    assert.equal(resumedInternal.request.cwd, interrupted.request.cwd);
    manager.shuttingDown = true;
});

test('restores a completed Simple conversation after restart without repeating its original prompt', async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'roboteam-resume-record-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const robot = { id: 'resume-a1b2c3', name: 'Resume' };
    const project = path.join(root, 'project');
    await fs.mkdir(project);
    const first = new RuntimeManager({ dataDir: root, toolCache: preparedToolCache });
    const taskId = '12345678-1234-4123-8123-123456789abc';
    await first._saveTask({ taskId, robotId: robot.id, type: 'simple', state: 'completed',
        alaSessionId: taskId, request: { cwd: project, task: 'original task', ca: 'pi' } });
    const second = new RuntimeManager({ dataDir: root, toolCache: preparedToolCache });
    second._drainTaskQueue = async () => {};
    second.shuttingDown = true;
    const continued = await second.resumeTask(robot, taskId, 'now add tests');
    const request = second.tasks.get(continued.taskId).request;
    assert.equal(request.task, 'now add tests');
    assert.equal(request.alaSessionId, taskId);
    assert.equal(request.resumeSession, true);
    assert.equal(request.ca, 'pi');
    second.tasks.get(continued.taskId).state = 'completed';
    const resumed = await second.resumeTask(robot, taskId);
    assert.equal(second.tasks.get(resumed.taskId).request.task, 'Continue.');
    await assert.rejects(second.resumeTask({ id: 'another-robot' }, taskId), /no matching task/);
});

test('active message delivery waits for an ALA receipt and starting tasks queue input', async () => {
    const robot = { id: 'message-a1b2c3', name: 'Message' };
    const manager = new RuntimeManager({ toolCache: preparedToolCache });
    const task = { taskId: 'active-id', robotId: robot.id, state: 'starting', pendingMessages: [] };
    manager.tasks.set(task.taskId, task);
    assert.equal((await manager.sendTaskMessage(robot, task.taskId, 'first')).delivery, 'queued');
    assert.equal(task.pendingMessages[0].message, 'first');
    task.controlReady = true;
    task.state = 'running';
    task.child = { stdin: { write(line) {
        const command = JSON.parse(line);
        assert.equal(command.message, 'live');
        const waiter = manager.messageWaiters.get(command.id);
        clearTimeout(waiter.timer);
        manager.messageWaiters.delete(command.id);
        waiter.resolve({ delivery: 'delivered' });
    } } };
    assert.equal((await manager.sendTaskMessage(robot, task.taskId, 'live')).delivery, 'delivered');
    task.state = 'completed';
    await assert.rejects(manager.sendTaskMessage(robot, task.taskId, 'too late'), /no longer running/);
});

test('an explicit GUI stop does not enter manual-control mode', async () => {
    const robot = { id: 'stop-gui-a1b2c3', name: 'Stop GUI' };
    const manager = new RuntimeManager({ toolCache: preparedToolCache });
    const active = {
        taskId: 'explicit-stop-task',
        robotId: robot.id,
        type: 'browser',
        state: 'running',
        createdAt: new Date().toISOString(),
        request: { cwd: '/workspace/project', task: 'Inspect the page.', ca: 'codex' },
        logTail: '',
        logSeq: 0,
        logTruncated: false,
        result: '',
        error: null,
        child: { kill: () => true },
        cancelRequested: false,
    };
    manager.tasks.set(active.taskId, active);
    manager.latestTask.set(robot.id, active.taskId);
    manager.activeTasks.set(robot.id, active.taskId);

    manager.stopTask(robot, 'browser', active.taskId);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(manager.taskStatus(robot.id, active.taskId).state, 'paused');
    assert.equal(manager.manualControl.has(robot.id), false);
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
    const manager = new RuntimeManager({ dataDir, workspaceRoot: root, publicBasePath: '/rt/', execFileImpl, toolCache: preparedToolCache });
    await manager.initialize();
    const running = await manager.start(robot, 'desktop');
    assert.equal(running.mode, 'desktop');
    const robotRoot = path.join(dataDir, 'robots', robot.id);
    assert.equal(manager.sessions.get(robot.id).cwd, robotRoot);
    const launch = calls.find(args => args[0] === 'run');
    assert.ok(launch.includes(`${robotRoot}:${robotRoot}:rw`));
    assert.ok(launch.includes(`${root}:${root}:ro`));
    assert.ok(launch.includes(`ROBOTEAM_WORKING_DIRECTORY=${robotRoot}`));
    assert.equal(launch[launch.indexOf('-w') + 1], robotRoot);
    await assert.rejects(fs.stat(path.join(robotRoot, '.roboteam-homes')), { code: 'ENOENT' });
    await assert.rejects(() => manager.start(robot, 'browser'), /occupied by its desktop container/);
    await manager.stop(robot.id);
    assert.deepEqual(manager.status(robot.id), { state: 'stopped', task: null, queueDepth: 0 });
    assert.ok(calls.some((args) => args[0] === 'rm' && args[2] === 'roboteam-desktop-research-a1b2c3'));
});

test('recreates a reused desktop when an Achilles task requests a different cwd', async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'roboteam-remount-test-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const dataDir = path.join(root, 'workspace', '.data', 'roboTeamAgent');
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
    let written = '';
    const spawnImpl = () => {
        const child = new EventEmitter();
        child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true;
        child.stdin = new PassThrough(); child.stdin.on('data', (chunk) => { written += chunk; });
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
    // The coding agent's shell is not the desktop; the prompt says so and the desktop shows Chromium.
    assert.deepEqual(JSON.parse(written.split('\n')[0]), { type: 'prompt', prompt: 'Show the files in the current directory.', systemPrompt: DESKTOP_TASK_INSTRUCTIONS });
    assert.equal(await fs.readFile(path.join(dataDir, 'robots', robot.id, 'home', 'Desktop', 'chromium.desktop'), 'utf8'), CHROMIUM_LAUNCHER);
    const runCalls = podmanCalls.filter((args) => args[0] === 'run');
    assert.equal(runCalls.length, 2);
    assert.ok(runCalls[0].includes(`${firstCwd}:${firstCwd}:rw`));
    assert.ok(runCalls[1].includes(`${secondCwd}:${secondCwd}:rw`));
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
    while (!['failed', 'paused'].includes(manager.taskStatus('analyst-a1b2c3', accepted.taskId).state)) {
        await new Promise((resolve) => setTimeout(resolve, 1));
    }
});

test('replaces the retained GUI container when the next queued task needs another mode', async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'roboteam-mode-queue-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const dataDir = path.join(root, 'data');
    const workspace = path.join(root, 'workspace');
    const robot = { id: 'queue-a1b2c3', name: 'Queue' };
    await Promise.all([
        fs.mkdir(path.join(dataDir, 'robots', robot.id, 'home'), { recursive: true }),
        fs.mkdir(path.join(dataDir, 'robots', robot.id, 'runtime'), { recursive: true }),
        fs.mkdir(workspace, { recursive: true }),
    ]);
    const listener = http.createServer((_request, response) => response.end());
    await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
    t.after(() => listener.close());
    const port = listener.address().port;
    const podmanCalls = [];
    const children = [];
    const manager = new RuntimeManager({
        dataDir,
        workspaceRoot: root,
        execFileImpl: async (_command, args) => {
            podmanCalls.push(args);
            if (args[0] === 'port') return { stdout: `127.0.0.1:${port}\n`, stderr: '' };
            return { stdout: '', stderr: '' };
        },
        spawnImpl: () => {
            const child = new EventEmitter();
            child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true;
            children.push(child);
            return child;
        },
        toolCache: preparedToolCache,
    });
    const desktop = manager.startTask(robot, 'desktop', { cwd: workspace, task: 'Desktop', ca: 'codex' });
    const browser = manager.startTask(robot, 'browser', { cwd: workspace, task: 'Browser', ca: 'codex' });
    while (children.length < 1) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(manager.taskStatus(robot.id, browser.taskId).state, 'queued');
    children[0].emit('close', 0, null);
    while (children.length < 2) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(manager.taskStatus(robot.id, desktop.taskId).state, 'completed');
    assert.equal(manager.sessions.get(robot.id).mode, 'browser');
    assert.ok(podmanCalls.some((args) => args[0] === 'rm' && args[2] === `roboteam-desktop-${robot.id}`));
    children[1].emit('close', 0, null);
    while (manager.taskStatus(robot.id, browser.taskId).state !== 'completed') await new Promise((resolve) => setTimeout(resolve, 5));
});

test('new GUI work clears manual control after every previous GUI task was paused', async () => {
    const robot = { id: 'restart-a1b2c3', name: 'Restart' };
    const manager = new RuntimeManager({ toolCache: preparedToolCache });
    const active = manager._newTask(robot, 'browser', { cwd: '/workspace' });
    active.state = 'running';
    active.child = { kill() {} };
    manager.activeTasks.set(robot.id, active.taskId);
    const waiting = manager.startTask(robot, 'browser', { cwd: '/workspace' });
    manager.takeControl(robot, active.taskId);
    manager.stopTask(robot, null, waiting.taskId);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(manager.manualControl.has(robot.id), true);
    // An unrelated CLI conversation must not keep the GUI pause alive.
    manager._newTask(robot, 'simple', {}).state = 'running';
    const executed = [];
    manager._runTask = async (_robot, task) => { executed.push(task.taskId); task.state = 'completed'; };
    const next = manager.startTask(robot, 'browser', { cwd: '/workspace' });
    assert.equal(manager.manualControl.has(robot.id), false);
    await manager._drainTaskQueue(robot);
    assert.deepEqual(executed, []); // Old process still holds the execution slot.
    manager.activeTasks.delete(robot.id);
    await manager._drainTaskQueue(robot);
    assert.deepEqual(executed, [next.taskId]);
    manager.shuttingDown = true;
});

test('new work keeps manual control while a previous GUI task is still queued', async () => {
    const robot = { id: 'paused-a1b2c3', name: 'Paused' };
    const manager = new RuntimeManager({ toolCache: preparedToolCache });
    manager.manualControl.set(robot.id, 'interrupted');
    const old = manager._newTask(robot, 'desktop', {});
    manager.taskQueues.set(robot.id, [old.taskId]);
    const next = manager.startTask(robot, 'browser', {});
    await manager._drainTaskQueue(robot);
    assert.equal(manager.manualControl.has(robot.id), true);
    assert.equal(manager.taskStatus(robot.id, next.taskId).blockedReason, 'manual-control');
    assert.equal(manager.taskStatus(robot.id, next.taskId).state, 'queued');
    manager.shuttingDown = true;
});

test('workflow callback channel is scoped to each runtime attempt and removed before terminal notification', async t => {
    const { requireHumanInput } = await import('../copilot/src/skills/require-human-input/scripts/run.mjs');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-human-'));
    const robot = { id: 'human-a1b2c3', name: 'Human' };
    const workspace = path.join(root, 'workspace');
    const dataDir = path.join(root, 'data');
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(path.join(dataDir, 'robots', robot.id, 'home'), { recursive: true });
    const children = [];
    const callbacks = [];
    const terminal = [];
    const manager = new RuntimeManager({ dataDir, workspaceRoot: root, toolCache: preparedToolCache,
        execFileImpl: async () => ({ stdout: '[]', stderr: '' }),
        spawnImpl: (_command, _args, options) => {
            const child = new EventEmitter();
            child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true;
            children.push({ child, directory: options.env.ROBOTEAM_HUMAN_INPUT_DIRECTORY });
            return child;
        } });
    manager.requestHumanInput = async (taskId, input) => { callbacks.push({ taskId, input }); return { id: 'question' }; };
    manager.setTaskObserver(event => { if (event.kind === 'terminal') terminal.push(event); });
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const first = manager.startTask(robot, 'simple', { cwd: workspace, task: 'Ask', ca: 'codex', allowsHumanInput: true });
    for (let i = 0; i < 200 && children.length < 1; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(children.length, 1);
    const question = { question: 'Q?', options: ['A', 'B', 'C'] };
    await requireHumanInput(question, { directory: children[0].directory });
    assert.equal(callbacks[0].taskId, first.taskId);
    children[0].child.emit('close', 0);
    for (let i = 0; i < 200 && terminal.length < 1; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(terminal.length, 1);
    await assert.rejects(fs.stat(children[0].directory), { code: 'ENOENT' });
    const second = await manager.resumeTask(robot, first.taskId, 'My answer to your question is: A');
    for (let i = 0; i < 200 && children.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(children.length, 2);
    assert.notEqual(children[1].directory, children[0].directory);
    await requireHumanInput(question, { directory: children[1].directory });
    assert.equal(callbacks[1].taskId, second.taskId);
    children[1].child.emit('close', 0);
    for (let i = 0; i < 200 && terminal.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(terminal.length, 2);
    await assert.rejects(fs.stat(children[1].directory), { code: 'ENOENT' });
});

test('reported task failure never publishes completed even when the wrapper exits zero', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-failure-'));
    const robot = { id: 'failure-a1b2c3', name: 'Failure' };
    const workspace = path.join(root, 'workspace'), dataDir = path.join(root, 'data');
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(path.join(dataDir, 'robots', robot.id, 'home'), { recursive: true });
    const events = [], launches = [];
    const manager = new RuntimeManager({ dataDir, workspaceRoot: root, toolCache: preparedToolCache,
        execFileImpl: async () => ({ stdout: '[]', stderr: '' }),
        spawnImpl: (_command, args) => {
            launches.push(args);
            const child = new EventEmitter();
            child.stdout = new PassThrough(); child.stderr = new PassThrough();
            setImmediate(() => {
                child.stderr.write('@@ALA_EVENT@@' + JSON.stringify({ type: 'task-failed', message: 'Missing deployment access.' }) + '\n');
                child.emit('close', 0, null);
            });
            return child;
        } });
    manager.setTaskObserver(event => events.push(event));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const started = manager.startTask(robot, 'simple', { cwd: workspace, task: 'Deploy', ca: 'codex', workflowRunId: 'flow_test' });
    for (let i = 0; i < 200 && !events.some(event => event.kind === 'terminal'); i++) await new Promise(resolve => setTimeout(resolve, 5));
    const terminal = events.filter(event => event.kind === 'terminal');
    assert.equal(terminal.length, 1);
    assert.equal(terminal[0].state, 'failed');
    assert.equal(terminal[0].forcedFailure, true);
    assert.equal(terminal[0].error, 'Missing deployment access.');
    assert.equal(manager.taskStatus(robot.id, started.taskId).state, 'failed');
    assert.equal(events.some(event => event.state === 'completed' || event.state === 'paused'), false);
    assert.ok(launches[0].includes('--workflow-execution'));
    await manager.resumeTask(robot, started.taskId, 'Try again');
    for (let i = 0; i < 200 && events.filter(event => event.kind === 'terminal').length < 2; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(launches.length, 2);
    assert.ok(launches[1].includes('--workflow-execution'));
    assert.ok(launches[1].includes('--resume-session'));
    manager.startTask(robot, 'simple', { cwd: workspace, task: 'Standalone', ca: 'codex' });
    for (let i = 0; i < 200 && events.filter(event => event.kind === 'terminal').length < 3; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(launches.length, 3);
    assert.equal(launches[2].includes('--workflow-execution'), false);
});

test('puts a proxied workstation behind its own relay and the managed Chromium policy', async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'roboteam-proxy-gui-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const listener = http.createServer((_request, response) => response.end());
    await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
    t.after(() => listener.close());
    const port = listener.address().port;
    const calls = [], relays = [], leases = [];
    let upstream = { id: 'pxp_0123456789abcdef', scheme: 'http', host: '198.51.100.7', port: 6001, username: 'u', password: 'p' };
    const manager = new RuntimeManager({
        dataDir: path.join(root, 'data'),
        workspaceRoot: root,
        proxyPool: { lease: async (...args) => { leases.push(args); return { upstream, locale: { timezone: 'Europe/Berlin', locale: 'de_DE.UTF-8', lang: 'de-DE' } }; }, release: async () => true },
        createRelay: (target) => {
            const relay = { target, closed: false, port: 45000 + relays.length, listen: async () => relay.port, close: async () => { relay.closed = true; } };
            relays.push(relay);
            return relay;
        },
        execFileImpl: async (command, args) => {
            calls.push(command === '/usr/bin/podman' ? args : [command, ...args]);
            if (args[0] === 'port') return { stdout: `127.0.0.1:${port}\n`, stderr: '' };
            if (args[0] === 'inspect') return { stdout: '/run/netns/netns-test\n', stderr: '' };
            return { stdout: '', stderr: '' };
        },
        toolCache: preparedToolCache,
    });
    t.after(() => manager.stopAll());
    const robot = { id: 'proxied-a1b2c3', name: 'Proxied', codingAgents: ['opencode'] };

    await manager.start(robot, 'browser');
    assert.deepEqual(leases[0], ['proxied-a1b2c3', 'Proxied'], 'the lease names the robot for the pool page');
    const run = calls.find(args => args[0] === 'create');
    assert.equal(calls.some(args => args[0] === 'run'), false, 'a proxied browser is created, not started, before its firewall');
    assert.equal(run[run.indexOf('--network') + 1], 'pasta:-T,3128:45000');
    // The firewall is loaded into the initialized container's network namespace before it starts.
    const rulesFile = path.join(root, 'data', 'proxy-pool', 'container-firewall.nft');
    const order = calls.map(args => args[0]);
    assert.deepEqual(order.slice(order.indexOf('create'), order.indexOf('start') + 1), ['create', 'init', 'inspect', '/usr/bin/nsenter', 'start']);
    assert.deepEqual(calls.find(args => args[0] === '/usr/bin/nsenter'), ['/usr/bin/nsenter', '--net=/run/netns/netns-test', '/usr/bin/nft', '-f', rulesFile]);
    assert.equal(await fs.readFile(rulesFile, 'utf8'), CONTAINER_FIREWALL_RULES);
    // The policy lives under the manager's data directory, never the production /data.
    const policyFile = path.join(root, 'data', 'proxy-pool', 'chromium-proxy-policy.json');
    assert.ok(run.includes(`${policyFile}:/etc/chromium/policies/managed/roboteam-proxy.json:ro`));
    assert.deepEqual(JSON.parse(await fs.readFile(policyFile, 'utf8')), {
        ProxySettings: { ProxyMode: 'fixed_servers', ProxyServer: 'http://127.0.0.1:3128' },
        WebRtcIPHandling: 'disable_non_proxied_udp',
    });
    assert.ok(run.includes('TZ=Europe/Berlin'));
    assert.ok(run.includes('LC_ALL=de_DE.UTF-8'));
    assert.ok(run.some(value => value.startsWith('CHROME_CLI=') && value.includes('--lang=de-DE')));
    assert.equal(relays[0].target, upstream);
    assert.doesNotMatch(run.join(' '), /198\.51\.100\.7|\bu:p\b/u);

    await manager.start(robot, 'browser');
    assert.equal(calls.filter(args => args[0] === 'create').length, 1, 'the same proxy reuses the running workstation');
    upstream = { ...upstream, id: 'pxp_fedcba9876543210', host: '198.51.100.8' };
    await manager.start(robot, 'browser');
    assert.equal(relays[0].closed, true);
    assert.equal(calls.filter(args => args[0] === 'create').length, 2, 'a different proxy replaces the workstation');
    await manager.stop(robot.id);
    assert.equal(relays[1].closed, true);
});

test('a proxied desktop keeps its network for other programs and a failed firewall stops the browser', async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'roboteam-proxy-firewall-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const listener = http.createServer((_request, response) => response.end());
    await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
    t.after(() => listener.close());
    const port = listener.address().port;
    const calls = [], relays = [];
    const manager = new RuntimeManager({
        dataDir: path.join(root, 'data'),
        workspaceRoot: root,
        proxyPool: { lease: async () => ({ upstream: { id: 'pxp_0123456789abcdef', scheme: 'http', host: '198.51.100.7', port: 6001, username: 'u', password: 'p' },
            locale: { timezone: 'Europe/Berlin', locale: 'de_DE.UTF-8', lang: 'de-DE' } }), release: async () => true },
        createRelay: () => {
            const relay = { closed: false, listen: async () => 45000, close: async () => { relay.closed = true; } };
            relays.push(relay);
            return relay;
        },
        execFileImpl: async (command, args) => {
            calls.push(command === '/usr/bin/podman' ? args : [command, ...args]);
            if (command === '/usr/bin/nsenter') throw new Error('nft: Operation not permitted');
            if (args[0] === 'port') return { stdout: `127.0.0.1:${port}\n`, stderr: '' };
            if (args[0] === 'inspect') return { stdout: '/run/netns/netns-test\n', stderr: '' };
            return { stdout: '', stderr: '' };
        },
        toolCache: preparedToolCache,
    });
    t.after(() => manager.stopAll());

    const desktop = { id: 'desktop-a1b2c3', name: 'Desktop', codingAgents: ['opencode'] };
    await manager.start(desktop, 'desktop');
    const desktopRun = calls.find(args => args[1] === '-d');
    assert.deepEqual(desktopRun?.slice(0, 2), ['run', '-d']);
    assert.ok(desktopRun.includes('TZ=Europe/Berlin'));
    assert.ok(desktopRun.includes('LC_ALL=de_DE.UTF-8'));
    assert.ok(desktopRun.includes('LANG=de_DE.UTF-8'));
    assert.equal(calls.some(args => args[0] === '/usr/bin/nsenter'), false);
    await manager.stop(desktop.id);

    const browser = { id: 'browser-a1b2c3', name: 'Browser', codingAgents: ['opencode'] };
    await assert.rejects(manager.start(browser, 'browser'), /Operation not permitted/u);
    assert.equal(calls.some(args => args[0] === 'start'), false, 'the browser never starts without its firewall');
    assert.ok(calls.some(args => args[0] === 'rm' && args[2] === 'roboteam-browser-browser-a1b2c3'));
    assert.equal(relays.at(-1).closed, true);
    assert.equal(manager.status(browser.id).state, 'stopped');
});

test('an active pool without a free proxy keeps the workstation from starting', async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'roboteam-proxy-none-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const calls = [];
    const manager = new RuntimeManager({
        dataDir: path.join(root, 'data'),
        workspaceRoot: root,
        proxyPool: { lease: async () => { throw Object.assign(new Error('No free proxy is available in the shared proxy pool.'), { statusCode: 409 }); } },
        createRelay: () => assert.fail('no relay without a proxy'),
        execFileImpl: async (_command, args) => { calls.push(args); return { stdout: '', stderr: '' }; },
        toolCache: preparedToolCache,
    });
    await assert.rejects(manager.start({ id: 'unproxied-a1b2c3', name: 'Waiting', codingAgents: ['opencode'] }, 'desktop'),
        error => error.statusCode === 409);
    assert.equal(calls.some(args => args[0] === 'run'), false);
    assert.equal(manager.status('unproxied-a1b2c3').state, 'stopped');
});

test('without a proxy lease the workstation connects directly with the service timezone', async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'roboteam-proxy-direct-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const listener = http.createServer((_request, response) => response.end());
    await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
    t.after(() => listener.close());
    const port = listener.address().port;
    const calls = [];
    const manager = new RuntimeManager({
        dataDir: path.join(root, 'data'),
        workspaceRoot: root,
        // What the proxyAgent client answers when the agent is missing, unreachable or has no usable proxy.
        proxyPool: { lease: async () => null, release: async () => false },
        createRelay: () => assert.fail('no relay without a proxy'),
        execFileImpl: async (_command, args) => {
            calls.push(args);
            if (args[0] === 'port') return { stdout: `127.0.0.1:${port}\n`, stderr: '' };
            return { stdout: '', stderr: '' };
        },
        toolCache: preparedToolCache,
    });
    t.after(() => manager.stopAll());
    await manager.start({ id: 'direct-a1b2c3', name: 'Direct', codingAgents: ['opencode'] }, 'browser');
    const run = calls.find(args => args[0] === 'run');
    assert.equal(run[run.indexOf('--network') + 1], 'pasta');
    assert.ok(run.includes('TZ=UTC'));
    assert.equal(run.some(value => value.startsWith('LC_ALL=')), false);
    assert.equal(run.some(value => value.includes('roboteam-proxy.json')), false);
});

test('with Use Proxy off the workstation connects directly without asking for a lease', async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'roboteam-proxy-off-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const listener = http.createServer((_request, response) => response.end());
    await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
    t.after(() => listener.close());
    const port = listener.address().port;
    const calls = [];
    const manager = new RuntimeManager({
        dataDir: path.join(root, 'data'),
        workspaceRoot: root,
        proxyPool: { lease: async () => assert.fail('no lease while Use Proxy is off'), release: async () => false },
        createRelay: () => assert.fail('no relay without a proxy'),
        execFileImpl: async (_command, args) => {
            calls.push(args);
            if (args[0] === 'port') return { stdout: `127.0.0.1:${port}\n`, stderr: '' };
            return { stdout: '', stderr: '' };
        },
        toolCache: preparedToolCache,
    });
    t.after(() => manager.stopAll());
    assert.equal(await manager.proxySettings.useProxy(), true);
    await manager.proxySettings.setUseProxy(false);
    await manager.start({ id: 'proxyoff-a1b2c3', name: 'Direct', codingAgents: ['opencode'] }, 'browser');
    const run = calls.find(args => args[0] === 'run');
    assert.equal(run[run.indexOf('--network') + 1], 'pasta');
    assert.ok(run.includes('TZ=UTC'));
});

// Live Sessions observation: admission, exactly-once terminal, private owner
// and phase association, transcript identifiers and typed message outcomes.
test('queued admission is observed with owner and phase association, without a state event or startedAt', async () => {
    const robot = { id: 'admit-a1b2c3', name: 'Admit' };
    const manager = new RuntimeManager({ toolCache: preparedToolCache });
    manager.shuttingDown = true;
    const events = [];
    manager.setTaskObserver((event) => events.push(event));
    const queued = manager.startTask(robot, 'browser', { cwd: '/workspace/project', task: 'Look', ownerPrincipal: 'user:alice',
        workflowRunId: `flow_${'a'.repeat(24)}`, workflowInstanceId: `inv_${'b'.repeat(24)}` });
    assert.deepEqual(events, [{ kind: 'admitted', robotId: robot.id, robotName: 'Admit', taskId: queued.taskId, type: 'browser', state: 'queued',
        cwd: '/workspace/project', ownerPrincipal: 'user:alice', workflowRunId: `flow_${'a'.repeat(24)}`, workflowInstanceId: `inv_${'b'.repeat(24)}` }]);
    const status = manager.taskStatus(robot.id, queued.taskId);
    assert.equal(status.startedAt, undefined);
    for (const key of ['ownerPrincipal', 'workflowInstanceId', 'transcriptRef', 'terminalEmitted']) assert.equal(Object.hasOwn(status, key), false, key);
    // Only a signed user principal is kept; anything else is the system owner.
    for (const owner of ['alice', 'user:', '', null, 7, { id: 'user:alice' }]) {
        events.length = 0;
        manager.startTask(robot, 'simple', { cwd: '/workspace/project', task: 'x', ownerPrincipal: owner });
        assert.equal(events[0].ownerPrincipal, null, JSON.stringify(owner));
        assert.equal(events[0].workflowRunId, null);
        assert.equal(events[0].workflowInstanceId, null);
    }
});

test('a queued GUI task cancelled before it runs ends with exactly one terminal event', async () => {
    const robot = { id: 'cancel-a1b2c3', name: 'Cancel' };
    const manager = new RuntimeManager({ toolCache: preparedToolCache });
    const active = manager._newTask(robot, 'browser', { cwd: '/workspace' });
    active.state = 'running';
    active.child = { kill() {} };
    manager.activeTasks.set(robot.id, active.taskId);
    const events = [];
    manager.setTaskObserver((event) => events.push(event));
    const waiting = manager.startTask(robot, 'browser', { cwd: '/workspace', task: 'Later' });
    const stop = manager.stopTask(robot, null, waiting.taskId);
    await new Promise((resolve) => setImmediate(resolve));
    manager.stopTask(robot, null, waiting.taskId);
    await new Promise((resolve) => setImmediate(resolve));
    manager.activeTasks.delete(robot.id);
    await manager._drainTaskQueue(robot);
    const terminal = events.filter((event) => event.kind === 'terminal' && event.taskId === waiting.taskId);
    assert.equal(terminal.length, 1);
    assert.deepEqual(terminal[0], { kind: 'terminal', robotId: robot.id, taskId: waiting.taskId, state: 'paused', result: '', error: null });
    assert.equal(events.some((event) => event.taskId === stop.taskId), false, 'helper stop records are never observed');
    manager.shuttingDown = true;
});

test('a CLI task stopped before or after its run starts reports one terminal event', async (t) => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-stop-order-')));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const robot = { id: 'order-a1b2c3', name: 'Order' };
    const dataDir = path.join(root, 'data');
    await fs.mkdir(path.join(dataDir, 'robots', robot.id, 'home'), { recursive: true });
    // Run first, then stop: the run's finally reports the pause.
    const manager = new RuntimeManager({ dataDir, workspaceRoot: root, toolCache: preparedToolCache,
        execFileImpl: async () => ({ stdout: '[]', stderr: '' }), spawnImpl: () => { throw new Error('never spawned'); } });
    const events = [];
    manager.setTaskObserver((event) => events.push(event));
    const first = manager.startTask(robot, 'simple', { cwd: root, task: 'x', ca: 'codex' });
    manager.stopTask(robot, 'simple', first.taskId);
    for (let i = 0; i < 200 && !events.some((event) => event.kind === 'terminal'); i++) await new Promise((resolve) => setTimeout(resolve, 5));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(events.filter((event) => event.kind === 'terminal').map((event) => [event.taskId, event.state]), [[first.taskId, 'paused']]);
    // Stop first, then the queued run: the stop reports it and the run never starts.
    events.length = 0;
    manager.shuttingDown = true;
    const second = manager.startTask(robot, 'simple', { cwd: root, task: 'y', ca: 'codex' });
    manager.stopTask(robot, 'simple', second.taskId);
    await new Promise((resolve) => setImmediate(resolve));
    manager.shuttingDown = false;
    await manager._runTask(robot, manager.tasks.get(second.taskId));
    assert.deepEqual(events.filter((event) => event.kind === 'terminal').map((event) => [event.taskId, event.state]), [[second.taskId, 'paused']]);
    assert.equal(events.some((event) => event.kind === 'state'), false);
});

test('shutdown reports queued work once and running work through its own exit', async () => {
    const robot = { id: 'shutdown-a1b2c3', name: 'Shutdown' };
    const manager = new RuntimeManager({ toolCache: preparedToolCache, soulGateway: { close: async () => {} } });
    manager.shuttingDown = true;
    const events = [];
    manager.setTaskObserver((event) => events.push(event));
    const queued = manager.startTask(robot, 'desktop', { cwd: '/workspace', task: 'Later' });
    await manager.stopAll();
    await manager.stopAll();
    assert.deepEqual(events.filter((event) => event.kind === 'terminal').map((event) => [event.taskId, event.state]), [[queued.taskId, 'paused']]);
});

test('the first turn-started event binds the task transcript to its own session; nothing else is accepted', async (t) => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-transcript-')));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const robot = { id: 'transcript-a1b2c3', name: 'Transcript' };
    const dataDir = path.join(root, 'data');
    await fs.mkdir(path.join(dataDir, 'robots', robot.id, 'home'), { recursive: true });
    const turn = '11111111-2222-4333-8444-555555555555';
    const message = '66666666-7777-4888-8999-aaaaaaaaaaaa';
    const manager = new RuntimeManager({ dataDir, workspaceRoot: root, toolCache: preparedToolCache,
        execFileImpl: async () => ({ stdout: '[]', stderr: '' }),
        spawnImpl: () => {
            const child = new EventEmitter();
            child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true;
            setImmediate(() => {
                const event = (value) => child.stderr.write(`@@ALA_EVENT@@${JSON.stringify(value)}\n`);
                event({ type: 'turn-started', session: { sessionId: 'other' }, userMessageId: 'x', assistantMessageId: 'not-a-uuid', turnId: turn });
                event({ type: 'turn-started', session: { big: 'metadata' }, userMessageId: 'x', assistantMessageId: message, turnId: turn });
                event({ type: 'turn-started', assistantMessageId: '00000000-0000-4000-8000-000000000000', turnId: turn });
                child.emit('close', 0, null);
            });
            return child;
        } });
    const events = [];
    manager.setTaskObserver((event) => events.push(event));
    const started = manager.startTask(robot, 'simple', { cwd: root, task: 'x', ca: 'codex' });
    assert.equal(manager.taskTranscriptRef(robot.id, started.taskId), null, 'no transcript before the turn starts');
    for (let i = 0; i < 200 && !events.some((event) => event.kind === 'terminal'); i++) await new Promise((resolve) => setTimeout(resolve, 5));
    const task = manager.tasks.get(started.taskId);
    assert.deepEqual(manager.taskTranscriptRef(robot.id, started.taskId), { cwd: task.request.cwd, sessionId: task.alaSessionId, assistantMessageId: message });
    assert.equal(manager.taskTranscriptRef('other-robot', started.taskId), null);
    assert.equal(Object.hasOwn(manager.taskStatus(robot.id, started.taskId), 'transcriptRef'), false);
    assert.equal(events.some((event) => JSON.stringify(event).includes('metadata')), false, 'the event body is never forwarded');
});

test('task message failures carry typed live outcomes and keep their messages', async () => {
    const robot = { id: 'typed-a1b2c3', name: 'Typed' };
    const manager = new RuntimeManager({ toolCache: preparedToolCache, messageTimeoutMs: 20 });
    const outcome = async (promise) => { try { await promise; return 'resolved'; } catch (error) { return [error.liveOutcome, error.message]; } };
    assert.deepEqual(await outcome(manager.sendTaskMessage(robot, 'missing', 'x')), ['run_ended', 'Task is no longer running; continue it instead.']);
    const task = { taskId: 'typed-task', robotId: robot.id, state: 'running', pendingMessages: [], controlReady: true };
    manager.tasks.set(task.taskId, task);
    const written = [];
    task.child = { stdin: { write(line) { written.push(JSON.parse(line)); } } };
    const rejected = manager.sendTaskMessage(robot, task.taskId, 'reject me');
    const waiter = manager.messageWaiters.get(written[0].id);
    clearTimeout(waiter.timer);
    manager.messageWaiters.delete(written[0].id);
    waiter.reject(manager._messageFailure('rejected', 'Busy.'));
    assert.deepEqual(await outcome(rejected), ['rejected', 'Busy.']);
    assert.deepEqual(await outcome(manager.sendTaskMessage(robot, task.taskId, 'nobody answers')),
        ['unknown', 'Message acknowledgement timed out; delivery is unknown.']);
    task.controlReady = false;
    task.pendingMessages = Array.from({ length: 100 }, () => ({}));
    assert.deepEqual(await outcome(manager.sendTaskMessage(robot, task.taskId, 'full')), ['rejected', 'Task message queue is full.']);
    // An empty or oversized message is never delivered: rejected, with the same text.
    assert.deepEqual(await outcome(manager.sendTaskMessage(robot, task.taskId, ' ')), ['rejected', 'Message must contain 1 to 32768 characters.']);
    assert.deepEqual(await outcome(manager.sendTaskMessage(robot, task.taskId, 'x'.repeat(32769))), ['rejected', 'Message must contain 1 to 32768 characters.']);
});

test('a message pending when the task ends is reported as run_ended', async (t) => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-ended-message-')));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const robot = { id: 'ended-a1b2c3', name: 'Ended' };
    const dataDir = path.join(root, 'data');
    await fs.mkdir(path.join(dataDir, 'robots', robot.id, 'home'), { recursive: true });
    let child;
    const manager = new RuntimeManager({ dataDir, workspaceRoot: root, toolCache: preparedToolCache,
        execFileImpl: async () => ({ stdout: '[]', stderr: '' }),
        spawnImpl: () => {
            child = new EventEmitter();
            child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true;
            child.stdin = { on() {}, write() {} };
            setImmediate(() => child.stderr.write(`@@ALA_EVENT@@${JSON.stringify({ type: 'session-ready' })}\n`));
            return child;
        } });
    const started = manager.startTask(robot, 'simple', { cwd: root, task: 'x', ca: 'codex' });
    for (let i = 0; i < 200 && !manager.tasks.get(started.taskId)?.controlReady; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    const pending = manager.sendTaskMessage(robot, started.taskId, 'late');
    child.emit('close', 0, null);
    await assert.rejects(pending, (error) => error.liveOutcome === 'run_ended' && error.message === 'Task ended before the message was acknowledged.');
});

test('owner and phase association persist with the execution record and survive resume unchanged', async (t) => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-owner-record-')));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const robot = { id: 'owner-a1b2c3', name: 'Owner' };
    const project = path.join(root, 'project');
    await fs.mkdir(project);
    const owned = '12345678-1234-4123-8123-123456789abc';
    const legacy = '12345678-1234-4123-8123-123456789abd';
    const first = new RuntimeManager({ dataDir: root, workspaceRoot: root, toolCache: preparedToolCache, ownerKey: 'boot-secret' });
    const task = first._newTask(robot, 'simple', { cwd: project, task: 'original', ca: 'pi', runtimeTaskId: owned, ownerPrincipal: 'user:alice',
        workflowRunId: `flow_${'c'.repeat(24)}`, workflowInstanceId: `inv_${'d'.repeat(24)}` });
    task.state = 'completed';
    await first._saveTask(task);
    await first._saveTask({ taskId: legacy, robotId: robot.id, type: 'simple', state: 'completed', alaSessionId: legacy,
        request: { cwd: project, task: 'old', ca: 'pi', ownerPrincipal: 'user:alice' } });
    const second = new RuntimeManager({ dataDir: root, workspaceRoot: root, toolCache: preparedToolCache, ownerKey: 'boot-secret' });
    second.shuttingDown = true;
    const events = [];
    second.setTaskObserver((event) => events.push(event));
    const resumed = await second.resumeTask(robot, owned, 'continue');
    await second.resumeTask(robot, legacy, 'continue');
    assert.notEqual(resumed.taskId, owned, 'a continuation is a new attempt with its own id');
    assert.deepEqual(events.map((event) => [event.ownerPrincipal, event.workflowRunId, event.workflowInstanceId]), [
        ['user:alice', `flow_${'c'.repeat(24)}`, null],
        [null, null, null],
    ], 'the bound owner survives; an unbound legacy owner is the system owner; phase association is never inherited');
});

test('a persisted owner that was tampered with, moved or written under another boot key is the system owner', async (t) => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-owner-tamper-')));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const robot = { id: 'tamper-a1b2c3', name: 'Tamper' };
    const project = path.join(root, 'project');
    await fs.mkdir(project);
    const writer = new RuntimeManager({ dataDir: root, workspaceRoot: root, toolCache: preparedToolCache, ownerKey: 'boot-secret' });
    const ids = ['22345678-1234-4123-8123-123456789ab1', '22345678-1234-4123-8123-123456789ab2', '22345678-1234-4123-8123-123456789ab3'];
    for (const id of ids) {
        const task = writer._newTask(robot, 'simple', { cwd: project, task: 'x', ca: 'pi', runtimeTaskId: id, ownerPrincipal: 'user:alice' });
        task.state = 'completed';
        await writer._saveTask(task);
    }
    const file = (id) => path.join(project, '.roboteam', 'tasks', id, 'executions', `${id}.json`);
    const tampered = JSON.parse(await fs.readFile(file(ids[0]), 'utf8'));
    assert.equal(typeof tampered.ownerBinding, 'string');
    tampered.request.ownerPrincipal = 'user:mallory';
    await fs.writeFile(file(ids[0]), JSON.stringify(tampered));
    const moved = JSON.parse(await fs.readFile(file(ids[1]), 'utf8'));
    moved.ownerBinding = JSON.parse(await fs.readFile(file(ids[2]), 'utf8')).ownerBinding.replace(/^./u, (c) => (c === 'A' ? 'B' : 'A'));
    await fs.writeFile(file(ids[1]), JSON.stringify(moved));
    const reader = new RuntimeManager({ dataDir: root, workspaceRoot: root, toolCache: preparedToolCache, ownerKey: 'boot-secret' });
    reader.shuttingDown = true;
    const events = [];
    reader.setTaskObserver((event) => events.push(event));
    await reader.resumeTask(robot, ids[0], 'go');
    await reader.resumeTask(robot, ids[1], 'go');
    await reader.resumeTask(robot, ids[2], 'go');
    assert.deepEqual(events.map((event) => event.ownerPrincipal), [null, null, 'user:alice']);
    const restarted = new RuntimeManager({ dataDir: root, workspaceRoot: root, toolCache: preparedToolCache, ownerKey: 'next-boot-secret' });
    restarted.shuttingDown = true;
    const later = [];
    restarted.setTaskObserver((event) => later.push(event));
    await restarted.resumeTask(robot, ids[2], 'go');
    assert.equal(later[0].ownerPrincipal, null, 'a binding from another service start proves nothing');
});

test('an attempt reports at most one terminal event whichever paths reach it', () => {
    const robot = { id: 'once-a1b2c3', name: 'Once' };
    const manager = new RuntimeManager({ toolCache: preparedToolCache });
    const events = [];
    manager.setTaskObserver((event) => events.push(event));
    const task = manager._newTask(robot, 'simple', {});
    manager._emitTaskTerminal(task, { state: 'paused', result: '', error: null });
    manager._emitTaskTerminal(task, { state: 'failed', result: '', error: 'late' });
    assert.deepEqual(events, [{ kind: 'terminal', robotId: robot.id, taskId: task.taskId, state: 'paused', result: '', error: null }]);
});

// A stop that lands before the child is spawned ends the attempt: no spawn,
// paused, exactly one terminal event.
async function cancellableFixture(t, { gateEnsure = false } = {}) {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-cancel-window-')));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const robot = { id: 'window-a1b2c3', name: 'Window' };
    const dataDir = path.join(root, 'data');
    await fs.mkdir(path.join(dataDir, 'robots', robot.id, 'home'), { recursive: true });
    const spawns = [];
    let release, ensured;
    const ensureCalled = new Promise((resolve) => { ensured = resolve; });
    const gate = new Promise((resolve) => { release = resolve; });
    const manager = new RuntimeManager({ dataDir, workspaceRoot: root, toolCache: preparedToolCache,
        execFileImpl: async () => ({ stdout: '[]', stderr: '' }),
        skillsets: { policies: { ensure: async () => { ensured(); if (gateEnsure) await gate; } } },
        spawnImpl: () => {
            const child = new EventEmitter();
            child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true;
            spawns.push(child);
            setImmediate(() => child.emit('close', 0, null));
            return child;
        } });
    return { root, robot, manager, spawns, release, ensureCalled };
}

test('a stop while the task awaits its skill policy prevents the spawn and reports one paused terminal', async (t) => {
    const { LiveSessionsRegistry } = await import('../server/live-sessions/registry.mjs');
    const { RuntimeLiveSource, composeTaskObservers } = await import('../server/live-sessions/runtime-source.mjs');
    const { root, robot, manager, spawns, release, ensureCalled } = await cancellableFixture(t, { gateEnsure: true });
    const registry = new LiveSessionsRegistry({ log: () => {} });
    const source = new RuntimeLiveSource({ registry, runtimeManager: manager, robotStore: { get: async () => robot }, workspaceRoot: root });
    const events = [];
    manager.setTaskObserver(composeTaskObservers((event) => events.push(event), [(event) => source.onRuntimeTaskEvent(event)]));
    const started = manager.startTask(robot, 'simple', { cwd: root, task: 'x', ca: 'codex', ownerPrincipal: 'user:alice' });
    await ensureCalled;
    const [row] = registry.list({ principal: 'user:alice', canAdmin: false });
    assert.deepEqual(await registry.stop(row.id, { principal: 'user:alice', canAdmin: false }), { ok: true });
    await new Promise((resolve) => setImmediate(resolve));
    release();
    for (let i = 0; i < 200 && !events.some((event) => event.kind === 'terminal'); i++) await new Promise((resolve) => setTimeout(resolve, 5));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(spawns.length, 0, 'the cancelled attempt never spawns');
    assert.equal(manager.taskStatus(robot.id, started.taskId).state, 'paused');
    assert.deepEqual(events.filter((event) => event.kind === 'terminal').map((event) => event.state), ['paused']);
    assert.equal(events.some((event) => event.kind === 'state' && event.state === 'running'), false);
    assert.equal(registry.list({ principal: 'user:alice', canAdmin: false })[0].status, 'stopped');
    assert.equal((await registry.stop(row.id, { principal: 'user:alice', canAdmin: false })).status, 409, 'an ended row cannot be stopped again');
});

test('a stop after the running transition but before the spawn prevents the spawn', async (t) => {
    const { root, robot, manager, spawns } = await cancellableFixture(t);
    const events = [];
    manager.setTaskObserver((event) => {
        events.push(event);
        if (event.kind === 'state' && event.state === 'running') manager.stopTask(robot, 'simple', event.taskId);
    });
    const started = manager.startTask(robot, 'simple', { cwd: root, task: 'x', ca: 'codex' });
    for (let i = 0; i < 200 && !events.some((event) => event.kind === 'terminal'); i++) await new Promise((resolve) => setTimeout(resolve, 5));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(spawns.length, 0);
    assert.equal(manager.taskStatus(robot.id, started.taskId).state, 'paused');
    assert.deepEqual(events.filter((event) => event.kind === 'terminal').map((event) => event.state), ['paused']);
});

test('each continuation is a new attempt: own id, phase only when RoboFlow resumes it, and old terminals never end it', async (t) => {
    const { LiveSessionsRegistry } = await import('../server/live-sessions/registry.mjs');
    const { RuntimeLiveSource, composeTaskObservers } = await import('../server/live-sessions/runtime-source.mjs');
    const robot = { id: 'attempt-a1b2c3', name: 'Attempt' };
    const manager = new RuntimeManager({ toolCache: preparedToolCache });
    manager.shuttingDown = true;
    const registry = new LiveSessionsRegistry({ log: () => {} });
    const source = new RuntimeLiveSource({ registry, runtimeManager: manager, robotStore: { get: async () => robot }, workspaceRoot: '/workspace' });
    const events = [];
    manager.setTaskObserver(composeTaskObservers((event) => events.push(event), [(event) => source.onRuntimeTaskEvent(event)]));
    const phaseId = '33333333-1234-4123-8123-123456789abc';
    const flow = `flow_${'e'.repeat(24)}`;
    const instance = `inv_${'f'.repeat(24)}`;
    manager.startTask(robot, 'simple', { cwd: '/workspace', task: 'phase', runtimeTaskId: phaseId, alaSessionId: '44444444-1234-4123-8123-123456789abc',
        workflowRunId: flow, workflowInstanceId: instance, ownerPrincipal: 'user:alice' });
    assert.throws(() => manager.startTask(robot, 'simple', { cwd: '/workspace', task: 'again', runtimeTaskId: phaseId }), /already in use/);
    manager.tasks.get(phaseId).state = 'paused';
    // A continuation through the robot control API: a new id, a robot-task row.
    const viaControl = await manager.resumeTask(robot, phaseId, 'go on');
    assert.notEqual(viaControl.taskId, phaseId);
    const controlEvent = events.find((event) => event.kind === 'admitted' && event.taskId === viaControl.taskId);
    assert.deepEqual([controlEvent.workflowRunId, controlEvent.workflowInstanceId, controlEvent.ownerPrincipal], [flow, null, 'user:alice']);
    // A late terminal of the earlier attempt ends only its own row.
    source.onRuntimeTaskEvent({ kind: 'terminal', taskId: phaseId, state: 'paused', result: '', error: null });
    const rows = registry.list({ principal: 'user:alice', canAdmin: false });
    const kinds = Object.fromEntries(rows.map((row) => [row.kind, row.status]));
    assert.deepEqual(kinds, { 'workflow-phase': 'stopped', 'robot-task': 'waiting' });
    // RoboFlow's own continuation names its phase explicitly.
    manager.tasks.get(viaControl.taskId).state = 'paused';
    const viaRoboFlow = await manager.resumeTask(robot, viaControl.taskId, 'go', { runtimeTaskId: '55555555-1234-4123-8123-123456789abc', workflowInstanceId: instance });
    const flowEvent = events.find((event) => event.kind === 'admitted' && event.taskId === viaRoboFlow.taskId);
    assert.deepEqual([flowEvent.workflowRunId, flowEvent.workflowInstanceId, flowEvent.ownerPrincipal], [flow, instance, 'user:alice']);
});
